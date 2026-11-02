import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentId, ChatItem, ExternalSession, SearchHit } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { api } from '../lib/api'
import { askText, attempt, confirmAsync, toast } from '../lib/app-store'
import { usePS, useStore } from '../lib/project-store'
import { errMsg, fmtTokens, timeAgo } from '../lib/utils'
import { ORCH_STATUS } from './chat/TeamCard'
import { AgentLogo, Icon } from './Icons'
import { Markdown } from './Markdown'

// Vista previa de una conversación de fuera (solo lectura) con el botón para seguirla aquí.
// Va en la raíz de la ventana: dentro del panel lateral, los otros paneles quedarían por encima.
function ExternalPreview(props: { s: ExternalSession; onClose: () => void; onContinue: () => void }) {
  return createPortal(<ExternalPreviewBody {...props} />, document.body)
}

function ExternalPreviewBody({ s, onClose, onContinue }: { s: ExternalSession; onClose: () => void; onContinue: () => void }) {
  const ps = usePS()
  const [items, setItems] = useState<ChatItem[] | null>(null)
  useEffect(() => {
    api.external
      .read(ps.id, s.agent, s.id)
      .then(setItems)
      .catch((e) => (toast(errMsg(e), 'error'), onClose()))
  }, [s.id])
  const shown = (items ?? []).slice(-80)
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="ext-reader ext-chat" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ext-reader-head">
          <AgentLogo agent={s.agent} size={15} />
          <b className="ellipsis">{s.title}</b>
          <span className="ext-source">{s.source}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="Cerrar" onClick={onClose}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="ext-reader-body chat-inner">
          {!items && <div className="muted small">Leyendo la conversación…</div>}
          {items && items.length > shown.length && <div className="muted small">… {items.length - shown.length} mensajes antes</div>}
          {shown.map((it) =>
            it.type === 'user' ? (
              <div key={it.id} className="msg-user-wrap">
                <div className="msg-user">{it.text}</div>
              </div>
            ) : it.type === 'assistant' ? (
              <div key={it.id} className={`msg-assistant agent-${s.agent}`}>
                <Markdown text={it.text} />
              </div>
            ) : it.type === 'tool' ? (
              <div key={it.id} className="ext-tool mono tiny muted ellipsis">
                <Icon.tool size={11} /> {it.name} {it.input}
              </div>
            ) : null
          )}
        </div>
        <div className="web-issues-foot">
          {s.live && <span className="muted small">Sigue abierta en {s.source}: aquí continuará en una copia, sin pisarla.</span>}
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!items} onClick={onContinue}>
            <Icon.chat size={13} /> Continuar en Ambidex
          </button>
        </div>
      </div>
    </div>
  )
}

// Conversaciones de Claude Code y Codex que empezaste en la terminal, VS Code… en esta carpeta
function ExternalSessions() {
  const ps = usePS()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ExternalSession[] | null>(null)
  const [preview, setPreview] = useState<ExternalSession | null>(null)
  const load = () => api.external.list(ps.id).then(setList, () => setList([]))
  useEffect(() => {
    if (open) load()
  }, [open])
  const cont = async (s: ExternalSession) => {
    const meta = await attempt(() => api.external.import(ps.id, s.agent, s.id))
    if (!meta) return
    setPreview(null)
    ps.upsertSession(meta)
    ps.set({ agentView: s.agent })
    ps.focusSession(meta.id)
    load()
  }
  return (
    <div className="ext-sessions">
      <button className="menu-sep ext-sessions-head" onClick={() => setOpen(!open)}>
        {open ? <Icon.chevronDown size={11} /> : <Icon.chevronRight size={11} />} Fuera de la app
        {open && list && <span className="count">{list.length}</span>}
        {open && (
          <span className="icon-btn" title="Volver a buscar" onClick={(e) => (e.stopPropagation(), load())}>
            <Icon.refresh size={11} />
          </span>
        )}
      </button>
      {open && !list && <div className="muted tiny" style={{ padding: '2px 12px' }}>Buscando…</div>}
      {open && list && !list.length && (
        <div className="muted tiny" style={{ padding: '2px 12px 8px' }}>
          No hay conversaciones de {AGENT_NAMES.claude} ni de {AGENT_NAMES.codex} empezadas fuera de la app en esta carpeta.
        </div>
      )}
      {open &&
        list?.map((s) => (
          <div key={`${s.agent}:${s.id}`} className="chat-row" onClick={() => setPreview(s)} title="Ver y continuar aquí">
            <AgentLogo agent={s.agent} size={13} />
            <div className="chat-row-main">
              <div className="ellipsis chat-row-title">{s.title}</div>
              <div className="muted tiny ellipsis">
                {s.source} · {timeAgo(s.updatedAt / 1000)}
                {s.live && <span className="ext-live"> · abierta ahora</span>}
              </div>
            </div>
          </div>
        ))}
      {preview && <ExternalPreview s={preview} onClose={() => setPreview(null)} onContinue={() => cont(preview)} />}
    </div>
  )
}

function dayLabel(ts: number) {
  const d = new Date(ts)
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
  return days === 0 ? 'Hoy' : days === 1 ? 'Ayer' : days < 7 ? 'Esta semana' : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

type Entry =
  | { kind: 'thread'; id: string; title: string; updatedAt: number; running: boolean; agents: AgentId[]; turns: number }
  | { kind: 'session'; id: string; title: string; updatedAt: number; running: boolean; agent: AgentId; turns: number; tokens: number }

// Historial de conversaciones del proyecto: con los dos (Ambos) y con cada agente
export function ChatsPanel() {
  const ps = usePS()
  const sessions = useStore((s) => s.sessions)
  const threads = useStore((s) => s.threads)
  const orchs = useStore((s) => s.orchs)
  const active = useStore((s) => s.active)
  const activeThread = useStore((s) => s.activeThread)
  const view = useStore((s) => s.agentView)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'both' | AgentId>('all')

  // búsqueda en SQLite: cubre todo el historial, también lo no cargado
  useEffect(() => {
    if (!q.trim()) return setHits(null)
    const t = setTimeout(() => api.sessions.search(ps.id, q).then(setHits).catch(() => setHits([])), 180)
    return () => clearTimeout(t)
  }, [q, ps.id])

  const snippet = new Map<string, string>()
  for (const h of hits ?? []) {
    const s = sessions[h.sessionId]
    snippet.set(s?.threadId ?? h.sessionId, h.snippet)
  }

  const entries: Entry[] = []
  for (const t of Object.values(threads)) {
    const ss = Object.values(t.sessions)
      .map((id) => (id ? sessions[id] : undefined))
      .filter((s): s is NonNullable<typeof s> => !!s)
    entries.push({
      kind: 'thread',
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      running: ss.some((s) => s.running),
      agents: ss.map((s) => s.agent),
      turns: ss.reduce((n, s) => n + s.messageCount, 0)
    })
  }
  for (const s of Object.values(sessions)) {
    if (s.threadId || s.orchestrationId) continue
    entries.push({ kind: 'session', id: s.id, title: s.title, updatedAt: s.updatedAt, running: s.running, agent: s.agent, turns: s.messageCount, tokens: s.totals.input + s.totals.output })
  }
  const list = entries
    .filter((e) => filter === 'all' || (filter === 'both' ? e.kind === 'thread' : e.kind === 'session' && e.agent === filter))
    .filter((e) => !hits || snippet.has(e.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const groups: [string, Entry[]][] = []
  for (const e of list) {
    const label = dayLabel(e.updatedAt)
    const g = groups.find(([l]) => l === label)
    if (g) g[1].push(e)
    else groups.push([label, [e]])
  }

  const live = Object.values(orchs).filter((o) => !['integrated', 'discarded', 'cancelled'].includes(o.status))

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Conversaciones</span>
        <span className="row-actions always">
          <button className="icon-btn" title="Nueva con los dos" onClick={() => ps.newThread()}>
            <span className="duo-mini">
              <AgentLogo agent="claude" size={11} />
              <AgentLogo agent="codex" size={11} />
            </span>
          </button>
          <button className="icon-btn" title="Nueva con Claude" onClick={() => (ps.set({ agentView: 'claude' }), ps.newSession('claude'))}>
            <AgentLogo agent="claude" size={13} />
          </button>
          <button className="icon-btn" title="Nueva con Codex" onClick={() => (ps.set({ agentView: 'codex' }), ps.newSession('codex'))}>
            <AgentLogo agent="codex" size={13} />
          </button>
        </span>
      </div>
      <div className="panel-tools">
        <div className="search-input">
          <Icon.search size={13} />
          <input placeholder="Buscar en el historial…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          {(
            [
              ['all', 'Todas'],
              ['both', 'Ambos'],
              ['claude', 'Claude'],
              ['codex', 'Codex']
            ] as const
          ).map(([f, l]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {live.length > 0 && !hits && (
          <div>
            <div className="menu-sep">Equipo trabajando</div>
            {live.map((o) => (
              <div key={o.id} className="chat-row" onClick={() => (o.threadId ? ps.focusThread(o.threadId) : ps.set({ agentView: 'auto' }))}>
                <Icon.workflow size={14} />
                <div className="chat-row-main">
                  <div className="ellipsis chat-row-title">{o.request}</div>
                  <div className="tiny ellipsis">
                    <span className={`status-chip ${ORCH_STATUS[o.status].cls}`}>{ORCH_STATUS[o.status].label}</span> {o.tasks.filter((t) => t.status === 'done').length}/{o.tasks.length} tareas
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!hits && <ExternalSessions />}
        {list.length === 0 && (
          <div className="empty">
            <Icon.chat size={22} />
            <p>{hits ? 'Sin resultados' : 'Aún no hay conversaciones en este proyecto.'}</p>
          </div>
        )}
        {groups.map(([label, items]) => (
          <div key={label}>
            <div className="menu-sep">{label}</div>
            {items.map((e) => {
              const isActive = e.kind === 'thread' ? view === 'auto' && activeThread === e.id : view === e.agent && active[e.agent] === e.id
              return (
                <div
                  key={e.id}
                  className={`chat-row ${isActive ? 'active' : ''}`}
                  onClick={() => (e.kind === 'thread' ? ps.focusThread(e.id) : (ps.set({ agentView: e.agent }), ps.focusSession(e.id)))}
                >
                  {e.kind === 'thread' ? (
                    <span className="duo-mini">
                      <AgentLogo agent="claude" size={11} />
                      <AgentLogo agent="codex" size={11} />
                    </span>
                  ) : (
                    <AgentLogo agent={e.agent} size={13} />
                  )}
                  <div className="chat-row-main">
                    <div className="ellipsis chat-row-title">
                      {e.running && <span className="pulse small" />} {e.title}
                    </div>
                    <div className="muted tiny ellipsis">
                      {snippet.get(e.id) ?? (
                        <>
                          {timeAgo(e.updatedAt / 1000)} · {e.turns} mensaje{e.turns === 1 ? '' : 's'}
                          {e.kind === 'session' && e.tokens > 0 && <> · {fmtTokens(e.tokens)} tokens</>}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                    <button
                      className="icon-btn"
                      title="Renombrar"
                      onClick={async () => {
                        const t = await askText('Renombrar conversación', '', e.title)
                        if (!t) return
                        if (e.kind === 'thread') ps.renameThread(e.id, t)
                        else ps.updateSession(e.id, { title: t })
                      }}
                    >
                      <Icon.edit size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Borrar"
                      disabled={e.running}
                      onClick={async () => {
                        if (!(await confirmAsync(`¿Borrar "${e.title}"?`, 'Se borra el historial de esta conversación en la app.', true))) return
                        if (e.kind === 'thread') ps.deleteThread(e.id)
                        else ps.deleteSession(e.id)
                      }}
                    >
                      <Icon.trash size={12} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
