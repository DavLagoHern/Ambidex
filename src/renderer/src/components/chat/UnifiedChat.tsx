import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, ChatItem, RouteDecision } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { ORCH_MODES, OrchMode, Orchestration } from '@shared/orchestrator'
import { EFFORT_NAMES } from '@shared/router'
import { api } from '../../lib/api'
import { askText, confirmAsync, toast, useApp } from '../../lib/app-store'
import { PendingSend, SessionView, Target, usePS, useStore } from '../../lib/project-store'
import { timeAgo } from '../../lib/utils'
import { AgentLogo, Icon } from '../Icons'
import {
  AgentPills, ContextChip, ContextChipView, CopyButton, finalAnswer, messageText, QueueList, SentImages, TurnItems, TurnUndo, useAttachments, useAutosize, useComposerInsert, useFileDrop, useMentions,
  useModelLabel, Working
} from './parts'
import { TeamCard } from './TeamCard'

interface Turn {
  kind: 'turn'
  key: string
  at: number
  session: SessionView
  user: Extract<ChatItem, { type: 'user' }>
  items: ChatItem[]
  last: boolean
}

interface TeamEntry {
  kind: 'team'
  key: string
  at: number
  o: Orchestration
}

// Turnos de las dos sesiones del hilo + trabajos del equipo, en orden cronológico
function buildTimeline(sessions: SessionView[], orchs: Orchestration[]): (Turn | TeamEntry)[] {
  const out: (Turn | TeamEntry)[] = []
  for (const s of sessions) {
    const items = s.items ?? []
    const turns: Turn[] = []
    for (const it of items) {
      if (it.type === 'user' && (!it.steering || !turns.length)) turns.push({ kind: 'turn', key: it.id, at: it.at, session: s, user: it, items: [], last: false })
      else turns.at(-1)?.items.push(it)
    }
    if (turns.length) turns[turns.length - 1].last = true
    out.push(...turns)
  }
  for (const o of orchs) out.push({ kind: 'team', key: o.id, at: o.createdAt, o })
  return out.sort((a, b) => a.at - b.at)
}

// El motivo sin repetir lo que ya dice la primera fila: fuera el razonamiento y, del modelo, solo su porqué
function routeWhy(route: RouteDecision): string {
  if (route.method === 'manual') return 'Elegido por ti'
  if (route.method === 'mention') return 'Mencionado con @'
  return route.reason
    .split(' · ')
    .flatMap((seg, i) => {
      if (/^razonamiento /.test(seg)) return []
      const paren = i > 0 && seg.match(/^.+ \(([^)]+)\)$/)
      return [paren ? paren[1] : seg]
    })
    .join(' · ')
}

function RouteChip({ route, agent }: { route?: RouteDecision; agent: AgentId }) {
  const short = useModelLabel()
  return (
    <div className="route-info" title={route?.reason}>
      <span className={`route-chip agent-${agent}`}>
        <span className="muted">→</span> <AgentLogo agent={agent} size={11} /> {AGENT_NAMES[agent]}
        {route?.model && <span className="route-model"> · {short(agent, route.model)}</span>}
        {route?.effort && <span className="route-model"> · razonamiento {EFFORT_NAMES[route.effort] ?? route.effort}</span>}
        {route?.method === 'jev' && <span className="route-jev">Jev</span>}
      </span>
      {route && <span className="route-why">{routeWhy(route)}</span>}
    </div>
  )
}

function TurnView({ t }: { t: Turn }) {
  const s = t.session
  return (
    <div className="turn">
      <div className="msg-user-wrap">
        <SentImages paths={t.user.images} />
        <div className="msg-user-line">
          <CopyButton text={t.user.text} title="Copiar el mensaje" className="icon-btn msg-copy" />
          <div className="msg-user">{t.user.text}</div>
        </div>
        <div className="row gap msg-user-meta">
          {t.user.context && <ContextChipView context={t.user.context} />}
          <RouteChip route={t.user.route} agent={s.agent} />
        </div>
      </div>
      <div className={`reply agent-${s.agent}`}>
        <div className="reply-head">
          <AgentLogo agent={s.agent} size={14} /> <b>{AGENT_NAMES[s.agent]}</b>
        </div>
        <TurnItems items={t.items} session={s} done={!(t.last && s.running)} />
        {t.last && s.running ? <Working session={s} /> : <TurnUndo sessionId={s.id} at={t.user.at} answer={finalAnswer(t.items)} />}
      </div>
    </div>
  )
}

// Mensaje recién enviado: se ve ya, mientras el motor decide a quién va (antes de que exista el turno real)
// Mismo aspecto que el mensaje ya enviado: cuando llega el real ocupa su sitio sin saltos ni textos provisionales.
function PendingTurn({ p }: { p: PendingSend }) {
  const target = useStore((s) => s.target)
  return (
    <div className="turn">
      <div className="msg-user-wrap">
        <SentImages paths={p.images} />
        <div className="msg-user-line">
          <CopyButton text={p.text} title="Copiar el mensaje" className="icon-btn msg-copy" />
          <div className="msg-user">{p.text}</div>
        </div>
        {!p.error && <div className="row gap msg-user-meta"><span className="route-chip">{target === 'auto' ? 'Jev está pensando…' : 'Preparando…'}</span></div>}
        {p.error && (
          <span className="route-chip" title={p.error}>
            <Icon.fail size={11} /> No confirmado <CopyButton text={p.text} className="icon-btn" title="Copiar el mensaje para recuperarlo" />
          </span>
        )}
      </div>
    </div>
  )
}

const stripMention = (t: string) => t.replace(/^@(claude|codex)\b\s*/i, '') || t

function TeamEntryView({ o }: { o: Orchestration }) {
  return (
    <div className="turn">
      <div className="msg-user-wrap">
        <div className="msg-user">{o.request}</div>
        <span className="route-chip team">
          <span className="muted">→</span> <Icon.workflow size={11} /> Equipo · {ORCH_MODES.find((m) => m.id === o.mode)?.title}
        </span>
      </div>
      <TeamCard o={o} />
    </div>
  )
}

function EmptyUnified({ onPick }: { onPick: (text: string, target?: Target) => void }) {
  return (
    <div className="chat-empty unified-empty">
      <div className="duo-logo">
        <AgentLogo agent="claude" size={22} />
        <AgentLogo agent="codex" size={22} />
      </div>
      <div className="chat-empty-title">Claude y Codex en una sola conversación</div>
      <div className="how">
        <div className="how-item">
          <Icon.zap size={15} />
          <div>
            <b>Escribe sin más.</b> El motor elige quién responde según el tipo de tarea, quién está libre y el uso de cada plan. Te dice por qué.
          </div>
        </div>
        <div className="how-item">
          <Icon.at size={15} />
          <div>
            <b>@claude o @codex</b> al principio para elegir tú, o cambia el destino abajo a la izquierda.
          </div>
        </div>
        <div className="how-item">
          <Icon.workflow size={15} />
          <div>
            <b>Equipo</b> para tareas grandes: se reparten el trabajo, cada uno en su rama, se revisan entre ellos y tú apruebas el resultado.
          </div>
        </div>
      </div>
      <div className="suggestions">
        <button className="suggestion" onClick={() => onPick('Explícame la arquitectura de este proyecto')}>
          Explícame la arquitectura de este proyecto <Icon.send size={12} />
        </button>
        <button className="suggestion" onClick={() => onPick('Revisa los cambios sin commitear y busca bugs')}>
          Revisa los cambios sin commitear y busca bugs <Icon.send size={12} />
        </button>
        <button className="suggestion" onClick={() => onPick('', 'team')}>
          Encargar una tarea grande al equipo… <Icon.workflow size={12} />
        </button>
      </div>
    </div>
  )
}

const TARGETS: { id: Target; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'El motor elige el agente en cada mensaje' },
  { id: 'claude', label: 'Claude', hint: 'Todo a Claude Code' },
  { id: 'codex', label: 'Codex', hint: 'Todo a Codex' },
  { id: 'team', label: 'Equipo', hint: 'Los dos se organizan: plan, reparto, revisión cruzada y tu aprobación' }
]

let lastWarm = 0

function UnifiedComposer({ threadId }: { threadId: string | null }) {
  const ps = usePS()
  const target = useStore((s) => s.target)
  const teamMode = useStore((s) => s.teamMode)
  const thread = useStore((s) => (threadId ? s.threads[threadId] : undefined))
  const claudeSession = useStore((s) => (thread?.sessions.claude ? s.sessions[thread.sessions.claude] : undefined))
  const codexSession = useStore((s) => (thread?.sessions.codex ? s.sessions[thread.sessions.codex] : undefined))
  const [text, setText] = useState('')
  const defaultAgent = useApp((s) => s.settings?.defaultAgent ?? 'claude')
  // modelo y razonamiento elegidos para un agente que aún no tiene conversación en este hilo
  const [pins, setPins] = useState<Partial<Record<AgentId, { model?: string; effort?: string }>>>({})
  useEffect(() => setPins({}), [threadId])
  const [menu, setMenu] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useAutosize(ta, text)
  // al empezar a escribir se despierta Jev (tarda ~4 s en arrancar): así decide él al enviar y no las reglas
  const typing = text.length > 0
  useEffect(() => {
    if (!typing || target === 'team' || Date.now() - lastWarm < 60_000) return
    lastWarm = Date.now()
    api.jev.warm().catch(() => {})
  }, [typing, target])
  const mentions = useMentions(ta, text, setText, true)
  const att = useAttachments()
  const drop = useFileDrop((fn) => setText(fn), att.add)
  useComposerInsert(ta, setText, att.addReady)

  useEffect(() => {
    const focus = (e: Event) => {
      const t = (e as CustomEvent).detail
      if ((!t || t === 'auto') && ta.current?.offsetParent) ta.current.focus()
    }
    window.addEventListener('focus-composer', focus)
    return () => window.removeEventListener('focus-composer', focus)
  }, [])

  // En Auto no se adivina a quién irá mientras escribes (cambiaría a cada tecla): se ven los ajustes del último que
  // respondió en esta conversación (o del agente por defecto) y el motor decide al enviar.
  const lastAgent: AgentId =
    claudeSession && codexSession ? (claudeSession.updatedAt >= codexSession.updatedAt ? 'claude' : 'codex') : claudeSession ? 'claude' : codexSession ? 'codex' : defaultAgent
  const agent: AgentId | null = target === 'claude' || target === 'codex' ? target : target === 'auto' ? lastAgent : null
  const session = agent === 'claude' ? claudeSession : agent === 'codex' ? codexSession : undefined
  // con un agente trabajando, el mensaje va a la cola y desde allí eliges a quién va (o lo reparte Jev)
  const busy = target === 'auto' ? !!(claudeSession?.running || codexSession?.running) : !!session?.running
  const worker: AgentId | undefined = target === 'auto' ? (claudeSession?.running ? 'claude' : codexSession?.running ? 'codex' : undefined) : agent ?? undefined
  const send = (separate = false) => {
    const msg = messageText(text, att.paths)
    if (!msg) return
    if (target === 'team' && att.count) toast('El equipo trabaja con texto: las imágenes no se le envían', 'info')
    const pick = (k: 'model' | 'effort') => Object.fromEntries(Object.entries(pins).flatMap(([a, p]) => (p?.[k] ? [[a, p[k]]] : [])))
    ps.sendUnified(msg, target, target === 'team' ? undefined : att.paths, pick('model'), pick('effort'), { separate })
    setText('')
    att.clear()
  }
  const T = TARGETS.find((x) => x.id === target)!

  return (
    <div className={`composer ${drop.over ? 'drop' : ''} ${target === 'team' ? 'team' : ''}`} {...drop.handlers}>
      {mentions.popup}
      <div className="composer-box">
        {att.strip}
        <textarea
          ref={ta}
          rows={2}
          value={text}
          onPaste={att.onPaste}
          placeholder={
            target === 'team'
              ? 'Describe la tarea para el equipo: qué quieres conseguir, alcance y criterios…'
              : busy
                ? `${worker ? AGENT_NAMES[worker] : 'El agente'} está trabajando: tu mensaje irá a la cola y desde allí eliges a quién va`
                : 'Escribe a Claude y Codex…  @ ficheros o agentes · / tus prompts'
          }
          onChange={(e) => (setText(e.target.value), mentions.trackCaret())}
          onKeyUp={mentions.trackCaret}
          onClick={mentions.trackCaret}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(e.metaKey || e.ctrlKey)
            }
          }}
        />
        <div className="composer-bar">
          <div className="dropdown">
            <button className={`target-btn t-${target}`} onClick={() => setMenu(!menu)} title={T.hint}>
              {target === 'team' ? <Icon.workflow size={13} /> : target === 'auto' ? <Icon.zap size={13} /> : <AgentLogo agent={target} size={13} />}
              {T.label}
              <Icon.chevronDown size={11} />
            </button>
            {menu && (
              <div className="menu up" onMouseLeave={() => setMenu(false)}>
                {TARGETS.map((x) => (
                  <div key={x.id} className={`menu-item ${x.id === target ? 'selected' : ''}`} onClick={() => (ps.set({ target: x.id }), setMenu(false))}>
                    <span>
                      {x.id === 'team' ? <Icon.workflow size={13} /> : x.id === 'auto' ? <Icon.zap size={13} /> : <AgentLogo agent={x.id as AgentId} size={13} />}
                      <b>{x.label}</b>
                    </span>
                    <span className="muted small">{x.hint}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {target === 'team' ? (
            <label className="pill" title="Cómo se organiza el equipo">
              <Icon.workflow size={12} />
              <select value={teamMode} onChange={(e) => ps.set({ teamMode: e.target.value as OrchMode })}>
                {ORCH_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            agent && (
              <AgentPills
                agent={agent}
                session={session}
                compact
                unified
                pin={{
                  model: pins[agent]?.model ?? '',
                  effort: pins[agent]?.effort ?? '',
                  set: (k, v) => setPins((p) => ({ ...p, [agent]: { ...p[agent], [k]: v } }))
                }}
              />
            )
          )}
          <ContextChip />
          <span style={{ flex: 1 }} />
          {target !== 'team' && att.button}
          {session?.running && (
            <button className="send-btn stop" title="Detener" onClick={() => ps.cancelSession(session.id)}>
              <Icon.stop size={12} />
            </button>
          )}
          {busy && target !== 'team' && (
            <button className="send-btn ghost" disabled={!text.trim() && !att.count} onClick={() => send(true)} title="Lanzar como tarea aparte, en una conversación nueva (⌘↵)">
              <Icon.plus size={15} />
            </button>
          )}
          <button
            className={`send-btn ${target === 'team' ? 'both' : agent ? `agent-${agent}` : 'both'}`}
            disabled={!text.trim() && !att.count}
            onClick={() => send()}
            title={target === 'team' ? 'Encargar al equipo (↵)' : busy ? 'Poner en cola (↵)' : 'Enviar (↵)'}
          >
            {busy && target !== 'team' ? <Icon.clock size={14} /> : <Icon.up size={15} />}
          </button>
        </div>
      </div>
      {target === 'team' && <div className="composer-hint">{ORCH_MODES.find((m) => m.id === teamMode)?.detail} Nada llega a tu rama sin tu aprobación.</div>}
    </div>
  )
}

function ThreadHeader() {
  const ps = usePS()
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThread)
  const active = activeId ? threads[activeId] : undefined
  const [open, setOpen] = useState(false)
  const list = Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div className="session-header">
      <span className="duo-mini">
        <AgentLogo agent="claude" size={12} />
        <AgentLogo agent="codex" size={12} />
      </span>
      <div className="dropdown" style={{ flex: 1, minWidth: 0 }}>
        <button className="btn ghost session-btn" onClick={() => setOpen(!open)}>
          <span className="ellipsis">{active?.title ?? 'Nueva conversación'}</span>
          <Icon.chevronDown size={12} />
        </button>
        {open && (
          <div className="menu wide" onMouseLeave={() => setOpen(false)}>
            <div className="menu-item" onClick={() => (setOpen(false), ps.newThread())}>
              <span>
                <Icon.plus size={13} /> Nueva conversación
              </span>
            </div>
            {list.length > 0 && <div className="menu-sep">Conversaciones con los dos</div>}
            <div className="menu-scroll">
              {list.map((t) => (
                <div key={t.id} className={`menu-item ${t.id === activeId ? 'selected' : ''}`} onClick={() => (setOpen(false), ps.focusThread(t.id))}>
                  <span className="ellipsis">{t.title}</span>
                  <span className="muted small">{timeAgo(t.updatedAt / 1000)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {active && (
        <>
          {active.sessions.claude && (
            <button
              className="icon-btn"
              title="Compactar: Claude resume lo hablado y sigue con menos contexto (Codex compacta su parte solo, según Ajustes)"
              onClick={() => ps.compactThread(active.id)}
            >
              <Icon.layers size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            title="Renombrar"
            onClick={async () => {
              const t = await askText('Renombrar conversación', '', active.title)
              if (t) ps.renameThread(active.id, t)
            }}
          >
            <Icon.edit size={13} />
          </button>
          <button className="icon-btn" title="Borrar conversación" onClick={async () => (await confirmAsync(`¿Borrar "${active.title}"?`, undefined, true)) && ps.deleteThread(active.id)}>
            <Icon.trash size={13} />
          </button>
        </>
      )}
      <button className="icon-btn" title="Nueva conversación (⌘N)" onClick={() => ps.newThread()}>
        <Icon.plus size={15} />
      </button>
    </div>
  )
}

export function UnifiedChat() {
  const ps = usePS()
  const threadId = useStore((s) => s.activeThread)
  const thread = useStore((s) => (s.activeThread ? s.threads[s.activeThread] : undefined))
  const claude = useStore((s) => (thread?.sessions.claude ? s.sessions[thread.sessions.claude] : undefined))
  const codex = useStore((s) => (thread?.sessions.codex ? s.sessions[thread.sessions.codex] : undefined))
  const orchs = useStore((s) => s.orchs)
  const queue = useStore((s) => s.queue)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const threadOrchs = useMemo(() => Object.values(orchs).filter((o) => o.threadId && o.threadId === threadId), [orchs, threadId])
  const timeline = useMemo(() => buildTimeline([claude, codex].filter((s): s is SessionView => !!s), threadOrchs), [claude, codex, threadOrchs])
  const myQueue = useMemo(() => queue.filter((q) => q.threadId && q.threadId === threadId), [queue, threadId])
  // pendientes de este hilo; en cuanto llega el turno real (mismo texto) dejan de pintarse para no duplicar
  const allPending = useStore((s) => s.pending)
  const pending = useMemo(
    () =>
      allPending.filter(
        (p) =>
          (p.threadId === threadId || p.threadId === null) &&
          !timeline.some((e) => e.kind === 'turn' && [e.user, ...e.items].some((i) => i.type === 'user' && i.at >= p.at - 2000 && (i.text === p.text || i.text === stripMention(p.text))))
      ),
    [allPending, timeline, threadId]
  )

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [timeline, pending])
  useLayoutEffect(() => {
    stick.current = true
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [threadId])

  const pick = async (text: string, target?: Target) => {
    if (target) ps.set({ target })
    if (text) await ps.sendUnified(text, target ?? ps.state.target)
    else window.dispatchEvent(new CustomEvent('focus-composer', { detail: 'auto' }))
  }

  return (
    <div className="agent-col unified">
      <ThreadHeader />
      {timeline.length === 0 && pending.length === 0 ? (
        <EmptyUnified onPick={pick} />
      ) : (
        <div
          className="chat"
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div className="chat-inner">
            {timeline.map((e) => (e.kind === 'turn' ? <TurnView key={e.key} t={e} /> : <TeamEntryView key={e.key} o={e.o} />))}
            {pending.map((p) => <PendingTurn key={p.id} p={p} />)}
          </div>
        </div>
      )}
      <QueueList items={myQueue} />
      <UnifiedComposer threadId={threadId} />
    </div>
  )
}
