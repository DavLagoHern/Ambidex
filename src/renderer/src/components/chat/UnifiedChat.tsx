import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, ChatItem, RouteDecision } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { ORCH_MODES, OrchMode, Orchestration } from '@shared/orchestrator'
import { api } from '../../lib/api'
import { askText, confirmAsync, toast } from '../../lib/app-store'
import { SessionView, Target, usePS, useStore } from '../../lib/project-store'
import { timeAgo } from '../../lib/utils'
import { AgentLogo, Icon } from '../Icons'
import {
  AgentPills, ContextChip, ContextChipView, Item, messageText, QueueList, SentImages, TurnUndo, useAttachments, useAutosize, useComposerInsert, useFileDrop, useMentions, Working
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
      if (it.type === 'user') turns.push({ kind: 'turn', key: it.id, at: it.at, session: s, user: it, items: [], last: false })
      else turns.at(-1)?.items.push(it)
    }
    if (turns.length) turns[turns.length - 1].last = true
    out.push(...turns)
  }
  for (const o of orchs) out.push({ kind: 'team', key: o.id, at: o.createdAt, o })
  return out.sort((a, b) => a.at - b.at)
}

function RouteChip({ route, agent }: { route?: RouteDecision; agent: AgentId }) {
  return (
    <span className={`route-chip agent-${agent}`} title={route?.reason}>
      <span className="muted">→</span> <AgentLogo agent={agent} size={11} /> {AGENT_NAMES[agent]}
      {route && <span className="muted"> · {route.method === 'manual' ? 'elegido por ti' : route.method === 'mention' ? 'mencionado' : route.reason.split('→')[0].trim()}</span>}
      {route?.method === 'jev' && <span className="route-jev">Jev</span>}
    </span>
  )
}

function TurnView({ t }: { t: Turn }) {
  const s = t.session
  return (
    <div className="turn">
      <div className="msg-user-wrap">
        <SentImages paths={t.user.images} />
        <div className="msg-user">{t.user.text}</div>
        <div className="row gap" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {t.user.context && <ContextChipView context={t.user.context} />}
          <RouteChip route={t.user.route} agent={s.agent} />
        </div>
      </div>
      <div className={`reply agent-${s.agent}`}>
        <div className="reply-head">
          <AgentLogo agent={s.agent} size={14} /> <b>{AGENT_NAMES[s.agent]}</b>
        </div>
        {t.items.map((it) => (
          <Item key={it.id} item={it} session={s} />
        ))}
        {t.last && s.running ? <Working session={s} /> : <TurnUndo sessionId={s.id} at={t.user.at} />}
      </div>
    </div>
  )
}

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

const BIG_TASK = /(completo|completa|sistema de|frontend.*backend|backend.*frontend|end[- ]to[- ]end|con (tests|pruebas)|y (tests|pruebas)|varias? (pantallas|partes)|refactoriza todo|migra (todo|el proyecto))/i

function UnifiedComposer({ threadId }: { threadId: string | null }) {
  const ps = usePS()
  const target = useStore((s) => s.target)
  const teamMode = useStore((s) => s.teamMode)
  const thread = useStore((s) => (threadId ? s.threads[threadId] : undefined))
  const claudeSession = useStore((s) => (thread?.sessions.claude ? s.sessions[thread.sessions.claude] : undefined))
  const codexSession = useStore((s) => (thread?.sessions.codex ? s.sessions[thread.sessions.codex] : undefined))
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<RouteDecision | null>(null)
  const [menu, setMenu] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useAutosize(ta, text)
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

  // a quién irá el mensaje, mientras se escribe
  useEffect(() => {
    if (target !== 'auto') return setPreview(null)
    // las respuestas que llegan tarde (de un texto anterior) se descartan
    let alive = true
    const t = setTimeout(
      () =>
        api.threads
          .preview(threadId, text || 'hola')
          .then((d) => alive && setPreview(d))
          .catch(() => alive && setPreview(null)),
      200
    )
    return () => ((alive = false), clearTimeout(t))
  }, [text, target, threadId, claudeSession?.running, codexSession?.running])

  const agent: AgentId | null = target === 'claude' || target === 'codex' ? target : target === 'auto' ? (preview?.agent ?? null) : null
  const session = agent === 'claude' ? claudeSession : agent === 'codex' ? codexSession : undefined
  const busy = !!session?.running
  const send = () => {
    const msg = messageText(text, att.paths)
    if (!msg) return
    if (target === 'team' && att.count) toast('El equipo trabaja con texto: las imágenes no se le envían', 'info')
    ps.sendUnified(msg, target, target === 'team' ? undefined : att.paths)
    setText('')
    att.clear()
  }
  const big = target === 'auto' && (text.length > 260 || BIG_TASK.test(text))
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
                ? `${agent ? AGENT_NAMES[agent] : 'El agente'} está trabajando: tu mensaje quedará en cola`
                : 'Escribe a Claude y Codex…  @ ficheros o agentes · / tus prompts'
          }
          onChange={(e) => (setText(e.target.value), mentions.trackCaret())}
          onKeyUp={mentions.trackCaret}
          onClick={mentions.trackCaret}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-bar">
          <div className="dropdown">
            <button className={`target-btn t-${target}`} onClick={() => setMenu(!menu)} title={T.hint}>
              {target === 'team' ? <Icon.workflow size={13} /> : target === 'auto' ? <Icon.zap size={13} /> : <AgentLogo agent={target} size={13} />}
              {T.label}
              {target === 'auto' && preview && (
                <span className="target-preview" title={preview.reason}>
                  → <AgentLogo agent={preview.agent} size={11} /> {AGENT_NAMES[preview.agent]}
                  {preview.method === 'jev' && <span className="route-jev">Jev</span>}
                </span>
              )}
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
            agent && <AgentPills agent={agent} session={session} compact />
          )}
          {big && (
            <button className="chip warn" onClick={() => ps.set({ target: 'team' })} title="Que lo planifiquen y se lo repartan">
              <Icon.workflow size={11} /> ¿Tarea grande? Usa Equipo
            </button>
          )}
          <ContextChip />
          <span style={{ flex: 1 }} />
          {target !== 'team' && att.button}
          {busy && session && (
            <button className="send-btn stop" title="Detener" onClick={() => ps.cancelSession(session.id)}>
              <Icon.stop size={12} />
            </button>
          )}
          <button
            className={`send-btn ${target === 'team' ? 'both' : agent ? `agent-${agent}` : 'both'}`}
            disabled={!text.trim() && !att.count}
            onClick={send}
            title={target === 'team' ? 'Encargar al equipo (↵)' : busy ? 'Poner en cola (↵)' : 'Enviar (↵)'}
          >
            {busy ? <Icon.clock size={14} /> : <Icon.up size={15} />}
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

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [timeline])
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
      {timeline.length === 0 ? (
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
          </div>
        </div>
      )}
      <QueueList items={myQueue} />
      <UnifiedComposer threadId={threadId} />
    </div>
  )
}
