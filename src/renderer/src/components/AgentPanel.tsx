import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { setApp, useApp } from '../lib/app-store'
import { SessionView, usePS, useStore } from '../lib/project-store'
import { fmtTokens, timeAgo } from '../lib/utils'
import {
  AgentPills, ContextChip, finalAnswer, Item, messageText, QueueList, TurnItems, TurnUndo, useAttachments, useAutosize, useComposerInsert, useFileDrop, useMentions, Working
} from './chat/parts'
import { UnifiedChat } from './chat/UnifiedChat'
import { AgentLogo, Icon } from './Icons'

const SUGGESTIONS = [
  'Explícame la arquitectura de este proyecto',
  'Revisa los cambios sin commitear y busca bugs',
  'Añade tests para el fichero abierto',
  '¿Qué debería refactorizar primero?'
]

// ---------- chat con un agente ----------

// Los mensajes de la conversación por turnos: los pasos de cada turno terminado se pliegan, y «deshacer» al final
// de cada turno que tocó ficheros
function withUndo(session: SessionView) {
  const out: ReactNode[] = []
  const items = session.items ?? []
  const starts = items.flatMap((it, i) => (it.type === 'user' && !it.steering ? [i] : []))
  if (!starts.length) return items.map((it) => <Item key={it.id} item={it} session={session} />)
  for (const it of items.slice(0, starts[0])) out.push(<Item key={it.id} item={it} session={session} />)
  starts.forEach((start, n) => {
    const user = items[start]
    const last = n === starts.length - 1
    const done = !(last && session.running)
    out.push(<Item key={user.id} item={user} session={session} />)
    out.push(<TurnItems key={`turn-${user.id}`} items={items.slice(start + 1, starts[n + 1])} session={session} done={done} />)
    if (done && user.at !== undefined) out.push(<TurnUndo key={`undo-${user.id}`} sessionId={session.id} at={user.at} answer={finalAnswer(items.slice(start + 1, starts[n + 1]))} />)
  })
  return out
}

function ChatView({ session, agent }: { session?: SessionView; agent: AgentId }) {
  const ps = usePS()
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !session) return
    const saved = ps.state.chatScroll[session.id]
    stick.current = saved === undefined || saved < 0
    el.scrollTop = stick.current ? el.scrollHeight : saved
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, !!session?.items])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [session?.items, session?.running])

  if (!session || (session.items && session.items.length === 0 && !session.running))
    return (
      <div className="chat-empty">
        <div className={`chat-empty-logo agent-${agent}`}>
          <AgentLogo agent={agent} size={28} />
        </div>
        <div className="chat-empty-title">¿En qué trabajamos con {AGENT_NAMES[agent]}?</div>
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggestion" onClick={() => (session ? ps.sendPrompt(session.id, s) : ps.ask(agent, s))}>
              {s}
              <Icon.send size={12} />
            </button>
          ))}
        </div>
      </div>
    )

  if (!session.items) return <div className="chat-empty muted">Cargando conversación…</div>

  return (
    <div
      className="chat"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        clearTimeout(saveTimer.current)
        const value = stick.current ? -1 : el.scrollTop
        saveTimer.current = setTimeout(() => ps.set((s) => ({ chatScroll: { ...s.chatScroll, [session.id]: value } })), 400)
      }}
    >
      <div className="chat-inner">
        {withUndo(session)}
        {session.running && <Working session={session} />}
      </div>
    </div>
  )
}

function SessionHeader({ agent, session, compact }: { agent: AgentId; session?: SessionView; compact?: boolean }) {
  const ps = usePS()
  const sessions = useStore((s) => s.sessions)
  const workspace = useStore((s) => s.workspace)
  const info = useApp((s) => s.agentInfo.find((a) => a.agent === agent))
  const [open, setOpen] = useState(false)
  const list = Object.values(sessions)
    .filter((s) => s.agent === agent && !s.threadId && !s.orchestrationId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const t = session?.totals

  return (
    <div className="session-header">
      <AgentLogo agent={agent} size={15} />
      <div className="dropdown" style={{ flex: 1, minWidth: 0 }}>
        <button
          className="btn ghost session-btn"
          onClick={() => setOpen(!open)}
          title={t && t.turns ? `${t.turns} turnos · ${fmtTokens(t.input)} entrada · ${fmtTokens(t.output)} salida · ${fmtTokens(t.cached)} caché` : undefined}
        >
          {session?.running && <span className="conversation-loading" role="img" aria-label="Agente trabajando" title="El agente sigue trabajando"><Icon.spinner size={12} className="spin" /></span>}
          <span className="ellipsis">{session?.title ?? (compact ? AGENT_NAMES[agent] : 'Nueva conversación')}</span>
          <Icon.chevronDown size={12} />
        </button>
        {open && (
          <div className="menu wide" onMouseLeave={() => setOpen(false)}>
            <div className="menu-item" onClick={() => (setOpen(false), ps.newSession(agent))}>
              <span>
                <Icon.plus size={13} /> Nueva conversación
              </span>
            </div>
            {list.length > 0 && <div className="menu-sep">Historial con {AGENT_NAMES[agent]}</div>}
            <div className="menu-scroll">
              {list.map((s) => (
                <div key={s.id} className={`menu-item ${s.id === session?.id ? 'selected' : ''}`} onClick={() => (setOpen(false), ps.focusSession(s.id))}>
                  <span className="conversation-title">
                    {s.running && <span className="conversation-loading" role="img" aria-label="Agente trabajando" title="El agente sigue trabajando"><Icon.spinner size={12} className="spin" /></span>} <span className="ellipsis">{s.title}</span>
                    {s.worktree && <span className="badge accent">{s.worktree.branch}</span>}
                  </span>
                  <span className="muted small">{timeAgo(s.updatedAt / 1000)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {session?.worktree && session.cwd !== workspace && (
        <button className="chip on" title={`Trabaja en ${session.cwd} (${session.worktree.branch}). Clic para abrirlo como workspace`} onClick={() => ps.setWorkspace(session.cwd)}>
          <Icon.layers size={11} /> {!compact && session.worktree.branch}
        </button>
      )}
      {info && !info.path && (
        <button className="chip danger" onClick={() => setApp({ overlay: 'settings', settingsSection: 'agents' })}>
          CLI no encontrado
        </button>
      )}
      {info?.auth && !info.auth.loggedIn && (
        <button className="chip warn" onClick={() => setApp({ loginAgent: agent })}>
          <Icon.login size={11} /> Iniciar sesión
        </button>
      )}
      {agent === 'claude' && session?.agentSessionId && (
        <button
          className="icon-btn"
          disabled={session.running}
          title="Compactar: Claude resume lo hablado y sigue con menos contexto (cada paso relee menos tokens)"
          onClick={() => ps.compactSession(session.id)}
        >
          <Icon.layers size={14} />
        </button>
      )}
      <button className="icon-btn" title="Nueva conversación (⌘N)" onClick={() => ps.newSession(agent)}>
        <Icon.plus size={15} />
      </button>
    </div>
  )
}

function Composer({ agent, compact }: { agent: AgentId; compact?: boolean }) {
  const ps = usePS()
  const session = useStore((s) => s.sessions[s.active[agent] ?? ''])
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  useAutosize(ta, text)
  const mentions = useMentions(ta, text, setText, false)
  const att = useAttachments()
  const drop = useFileDrop((fn) => setText(fn), att.add)
  useComposerInsert(ta, setText, att.addReady)

  useEffect(() => {
    const focus = (e: Event) => {
      const target = (e as CustomEvent).detail
      if ((!target || target === agent) && ta.current?.offsetParent) ta.current.focus()
    }
    window.addEventListener('focus-composer', focus)
    return () => window.removeEventListener('focus-composer', focus)
  }, [agent])

  const running = !!session?.running
  // añade información al turno activo; el motor conserva en cola lo que llegue al cerrar.
  const send = () => {
    const msg = messageText(text, att.paths)
    if (!msg) return
    if (session) ps.sendPrompt(session.id, msg, true, att.paths)
    else ps.ask(agent, msg, { images: att.paths })
    setText('')
    att.clear()
  }

  return (
    <div className={`composer ${drop.over ? 'drop' : ''}`} {...drop.handlers}>
      {mentions.popup}
      <div className="composer-box">
        {att.strip}
        <textarea
          ref={ta}
          rows={2}
          value={text}
          onPaste={att.onPaste}
          placeholder={running ? `${AGENT_NAMES[agent]} está trabajando: añade información a su tarea` : `Pide algo a ${AGENT_NAMES[agent]}…  @ ficheros · / tus prompts`}
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
          <AgentPills agent={agent} session={session} compact={compact} />
          <ContextChip />
          <span style={{ flex: 1 }} />
          {att.button}
          {running && session && (
            <button className="send-btn stop" title="Detener" onClick={() => ps.cancelSession(session.id)}>
              <Icon.stop size={12} />
            </button>
          )}
          <button className={`send-btn agent-${agent}`} disabled={!text.trim() && !att.count} onClick={send} title={running ? 'Añadir al turno actual sin detenerlo (↵)' : 'Enviar (↵)'}>
            <Icon.up size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

function AgentColumn({ agent, compact, composer = true }: { agent: AgentId; compact?: boolean; composer?: boolean }) {
  const session = useStore((s) => s.sessions[s.active[agent] ?? ''])
  const queue = useStore((s) => s.queue)
  const mine = useMemo(() => (session ? queue.filter((q) => q.sessionId === session.id && !q.threadId) : []), [queue, session?.id])
  return (
    <div className={`agent-col agent-${agent}`}>
      <SessionHeader agent={agent} session={session} compact={compact} />
      <ChatView session={session} agent={agent} />
      <QueueList items={mine} />
      {composer && <Composer agent={agent} compact={compact} />}
    </div>
  )
}

// Misma tarea a los dos en la vista lado a lado
function SharedComposer() {
  const ps = usePS()
  const active = useStore((s) => s.active)
  const sessions = useStore((s) => s.sessions)
  const [text, setText] = useState('')
  const [isolate, setIsolate] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useAutosize(ta, text)
  const mentions = useMentions(ta, text, setText, true)
  const att = useAttachments()
  const drop = useFileDrop((fn) => setText(fn), att.add)
  useComposerInsert(ta, setText, att.addReady)
  const runningIds = (['claude', 'codex'] as AgentId[]).map((a) => active[a]).filter((id): id is string => !!id && !!sessions[id]?.running)
  const send = () => {
    const msg = messageText(text, att.paths)
    if (!msg) return
    ps.sendToBoth(msg, isolate, att.paths)
    setText('')
    att.clear()
  }
  return (
    <div className={`composer shared ${drop.over ? 'drop' : ''}`} {...drop.handlers}>
      {mentions.popup}
      <div className="composer-box">
        {att.strip}
        <textarea
          ref={ta}
          rows={2}
          value={text}
          onPaste={att.onPaste}
          placeholder="La misma tarea para los dos…  (@claude o @codex al principio para enviarla solo a uno)"
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
          <label className={`pill toggle ${isolate ? 'on' : ''}`} title="Cada agente trabaja en su propio git worktree y rama para que no se pisen">
            <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
            <Icon.layers size={12} /> Worktrees aislados
          </label>
          <ContextChip />
          <span style={{ flex: 1 }} />
          {att.button}
          {runningIds.length > 0 && (
            <button className="send-btn stop" title="Detener los dos" onClick={() => runningIds.forEach(ps.cancelSession)}>
              <Icon.stop size={12} />
            </button>
          )}
          <button className="send-btn both" disabled={!text.trim() && !att.count} onClick={send} title="Enviar a los dos (↵)">
            <Icon.up size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

// Conversación de un paso del equipo, en un panel lateral
function Drawer() {
  const ps = usePS()
  const id = useStore((s) => s.drawer)
  const session = useStore((s) => (s.drawer ? s.sessions[s.drawer] : undefined))
  useEffect(() => {
    if (id) ps.loadMessages(id)
  }, [id])
  if (!id || !session) return null
  return (
    <div className="drawer">
      <div className="session-header">
        <AgentLogo agent={session.agent} size={15} />
        <b className="ellipsis" style={{ flex: 1 }}>
          {session.title}
        </b>
        <button className="icon-btn" onClick={() => ps.set({ drawer: null })} title="Cerrar">
          <Icon.x size={15} />
        </button>
      </div>
      <ChatView session={session} agent={session.agent} />
    </div>
  )
}

const MODES: { id: 'claude' | 'codex' | 'ambos'; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude', hint: 'Chat con Claude Code (⌥⌘1)' },
  { id: 'codex', label: 'Codex', hint: 'Chat con Codex (⌥⌘2)' },
  { id: 'ambos', label: 'Ambos', hint: 'Los dos a la vez: un chat que se organiza solo o dos lado a lado (⌥⌘3)' }
]

export function AgentPanel() {
  const ps = usePS()
  const requestedView = useStore((s) => s.agentView)
  const enabled = useApp((s) => s.settings?.enabledAgents)
  const single = enabled?.length === 1 ? enabled[0] : undefined
  const view = single ?? requestedView
  const compare = useStore((s) => s.compare)
  const busyKey = useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.running)
      // Las sesiones del chat conjunto y del equipo pertenecen a Ambos,
      // aunque sea uno de los agentes quien esté ejecutando el turno.
      .map((x) => x.threadId || x.orchestrationId ? 'ambos' : x.agent)
      .join(',')
  )
  const mode = view === 'auto' || view === 'both' ? 'ambos' : view
  const webOpen = useStore((s) => s.web.open)
  const webTabs = useStore((s) => s.web.tabs.length)

  return (
    <div className="agent-panel">
      <div className="agent-tabs">
        <div className="modebar">
          {MODES.filter((m) => !single || m.id === single).map((m) => (
            <button
              key={m.id}
              className={`mode-btn m-${m.id} ${mode === m.id ? 'on' : ''}`}
              title={m.hint}
              onClick={() => ps.set({ agentView: m.id === 'ambos' ? (view === 'both' ? 'both' : 'auto') : m.id })}
            >
              {m.id === 'ambos' ? (
                <span className="duo-mini">
                  <AgentLogo agent="claude" size={12} />
                  <AgentLogo agent="codex" size={12} />
                </span>
              ) : (
                <AgentLogo agent={m.id} size={14} />
              )}
              <span className="lbl">{m.label}</span>
              {busyKey.includes(m.id) && (
                <span
                  className={`pulse small agent-${m.id}`}
                  role="status"
                  aria-label="En curso"
                  title={`En curso en ${m.label}`}
                />
              )}
            </button>
          ))}
          {/* en una ventana de panel la Web está en la ventana principal */}
          {!ps.secondary && (
            <>
            <span className="modebar-sep" />
            <button
              className={`mode-btn m-web ${webOpen ? 'open' : ''}`}
              title={webOpen ? 'Cerrar el visor web (las pestañas se guardan)' : 'Visor web: los enlaces del chat y tu localhost se abren aquí, junto al chat'}
              onClick={() => ps.toggleWeb()}
            >
              <Icon.globe size={14} />
              <span className="lbl">Web</span>
              {webTabs > 1 && <span className="mode-count">{webTabs}</span>}
            </button>
            </>
          )}
        </div>
        {mode === 'ambos' && (
          <div className="seg layout-seg">
            <button className={view === 'auto' ? 'on' : ''} onClick={() => ps.set({ agentView: 'auto' })} title="Un solo chat: el motor reparte los mensajes o los pone a trabajar en equipo">
              <Icon.chat size={12} /> <span className="lbl">Un chat</span>
            </button>
            <button className={view === 'both' ? 'on' : ''} onClick={() => ps.set({ agentView: 'both' })} title="Dos chats lado a lado">
              <Icon.split size={12} /> <span className="lbl">Lado a lado</span>
            </button>
          </div>
        )}
        <span style={{ flex: 1 }} />
        {view === 'both' && (
          <label className={`pill toggle ${compare ? 'on' : ''}`} title="Un único cuadro de texto que envía la misma tarea a los dos">
            <input type="checkbox" checked={compare} onChange={(e) => ps.set({ compare: e.target.checked })} />
            <Icon.split size={12} /> <span className="lbl">Misma tarea a los dos</span>
          </label>
        )}
      </div>
      <div className="agent-views">
        {view === 'auto' && <UnifiedChat />}
        {view === 'both' && (
          <div className="both-wrap">
            <div className="agent-both">
              <AgentColumn agent="claude" compact composer={!compare} />
              <AgentColumn agent="codex" compact composer={!compare} />
            </div>
            {compare && <SharedComposer />}
          </div>
        )}
        {(view === 'claude' || view === 'codex') && <AgentColumn key={view} agent={view} />}
        <Drawer />
      </div>
    </div>
  )
}
