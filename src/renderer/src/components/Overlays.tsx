import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentId } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { activate, activeStore, forgetProject, openProjectPath, pickAndOpenProject, refreshAgents, setApp, toast, useApp } from '../lib/app-store'
import { COMMANDS, runCommand } from '../lib/commands'
import { api } from '../lib/api'
import { attempt } from '../lib/app-store'
import { timeAgo, uid } from '../lib/utils'
import { AgentLogo, Icon, IconName } from './Icons'

const TerminalView = lazy(() => import('./Terminal').then((m) => ({ default: m.TerminalView })))

// ---------- paleta de comandos ----------

interface PaletteItem {
  id: string
  group: string
  title: string
  detail?: string
  shortcut?: string
  icon?: IconName
  agent?: AgentId
  color?: string
  run: () => void
}

function score(text: string, q: string) {
  if (!q) return 1
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 3
  if (t.includes(q)) return 2
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

export function CommandPalette() {
  const projects = useApp((s) => s.projects)
  const openIds = useApp((s) => s.openIds)
  const activeId = useApp((s) => s.activeId)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const close = () => setApp({ overlay: null })

  const items = useMemo(() => {
    const ps = activeStore()
    const out: PaletteItem[] = COMMANDS.filter((c) => c.id !== 'palette' && (!c.needsProject || ps)).map((c) => ({
      id: 'cmd:' + c.id,
      group: c.group,
      title: c.title,
      shortcut: c.shortcut,
      icon: c.icon,
      run: () => runCommand(c.id)
    }))
    for (const p of [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
      if (p.id === activeId) continue
      out.push({
        id: 'proj:' + p.id,
        group: 'Proyectos',
        title: p.name,
        detail: openIds.includes(p.id) ? 'abierto' : p.path,
        color: p.color,
        run: () => (openIds.includes(p.id) ? activate(p.id) : openProjectPath(p.path))
      })
    }
    if (ps)
      for (const s of Object.values(ps.state.sessions).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40))
        out.push({ id: 'chat:' + s.id, group: 'Conversaciones', title: s.title, detail: timeAgo(s.updatedAt / 1000), agent: s.agent, run: () => ps.focusSession(s.id) })
    return out
  }, [projects, openIds, activeId])

  const ql = q.trim().toLowerCase()
  const results = items
    .map((it) => [it, Math.max(score(it.title, ql), score(it.group + ' ' + it.title, ql) - 0.5)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => (ql ? b[1] - a[1] : 0))
    .map(([it]) => it)
    .slice(0, 80)

  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const choose = (it?: PaletteItem) => {
    if (!it) return
    close()
    it.run()
  }

  let lastGroup = ''
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon.command size={15} />
          <input
            autoFocus
            placeholder="Escribe un comando, un proyecto o una conversación…"
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel(Math.min(sel + 1, results.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setSel(Math.max(sel - 1, 0)))
              if (e.key === 'Enter') choose(results[sel])
            }}
          />
        </div>
        <div className="palette-list" ref={list}>
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            const I = it.icon ? Icon[it.icon] : null
            return (
              <div key={it.id}>
                {header && <div className="palette-group">{header}</div>}
                <div className={`palette-item ${i === sel ? 'selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(it)}>
                  {it.agent ? <AgentLogo agent={it.agent} size={14} /> : it.color ? <span className="proj-dot" style={{ background: it.color }} /> : I ? <I size={14} /> : <span style={{ width: 14 }} />}
                  <span className="palette-title ellipsis">{it.title}</span>
                  {it.detail && <span className="muted small ellipsis">{it.detail}</span>}
                  {it.shortcut && <kbd>{it.shortcut}</kbd>}
                </div>
              </div>
            )
          })}
          {!results.length && <div className="empty small">Sin resultados</div>}
        </div>
      </div>
    </div>
  )
}

// ---------- explorador de proyectos ----------

export function ProjectsOverlay() {
  const projects = useApp((s) => s.projects)
  const openIds = useApp((s) => s.openIds)
  const running = useApp((s) => s.running)
  const [q, setQ] = useState('')
  const close = () => setApp({ overlay: null })
  const ql = q.toLowerCase()
  const list = [...projects]
    .filter((p) => !ql || `${p.name} ${p.path}`.toLowerCase().includes(ql))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

  return (
    <div className="overlay center" onMouseDown={close}>
      <div className="modal projects-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row gap" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Proyectos</h3>
          <button className="btn primary" onClick={() => (close(), pickAndOpenProject())}>
            <Icon.folderOpen size={13} /> Abrir carpeta…
          </button>
        </div>
        <div className="search-input">
          <Icon.search size={13} />
          <input autoFocus placeholder="Buscar proyectos…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && close()} />
        </div>
        <div className="projects-list">
          {list.map((p) => {
            const isOpen = openIds.includes(p.id)
            const busy = Object.values(running).filter((r) => r.projectId === p.id).length
            return (
              <div
                key={p.id}
                className={`project-row ${p.exists ? '' : 'missing'}`}
                onClick={() => {
                  if (!p.exists) return toast('La carpeta ya no existe', 'error')
                  close()
                  if (isOpen) activate(p.id)
                  else openProjectPath(p.path)
                }}
              >
                <span className="proj-avatar" style={{ background: p.color }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row gap">
                    <b className="ellipsis">{p.name}</b>
                    {isOpen && <span className="badge">abierto</span>}
                    {p.pinned && <Icon.pin size={11} className="muted" />}
                    {busy > 0 && <span className="badge accent">{busy} trabajando</span>}
                    {!p.exists && <span className="badge danger">no encontrado</span>}
                  </div>
                  <div className="muted small ellipsis">{p.path}</div>
                </div>
                <span className="muted small">{timeAgo(p.lastOpenedAt / 1000)}</span>
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {p.exists && (
                    <button className="icon-btn" title="Mostrar en Finder" onClick={() => attempt(() => api.reveal(p.path))}>
                      <Icon.folderOpen size={13} />
                    </button>
                  )}
                  <button className="icon-btn" title="Quitar de Ambidex (no borra ficheros)" onClick={() => forgetProject(p.id)}>
                    <Icon.trash size={13} />
                  </button>
                </span>
              </div>
            )
          })}
          {!list.length && (
            <div className="empty">
              <Icon.folder size={22} />
              <p>{q ? 'Sin resultados' : 'Todavía no has abierto ningún proyecto.'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- login oficial de los CLI ----------

export function LoginModal() {
  const agent = useApp((s) => s.loginAgent)
  const [id, setId] = useState(() => `login-${uid()}`)
  const [exited, setExited] = useState<number | null>(null)
  const info = useApp((s) => s.agentInfo.find((a) => a.agent === agent))

  useEffect(() => {
    setId(`login-${uid()}`)
    setExited(null)
  }, [agent])

  if (!agent) return null
  const close = () => {
    setApp({ loginAgent: null })
    refreshAgents(true)
  }
  return (
    <div className="overlay center">
      <div className="modal login-modal">
        <div className="row gap" style={{ marginBottom: 6 }}>
          <AgentLogo agent={agent} size={20} />
          <h3 style={{ margin: 0, flex: 1 }}>Iniciar sesión en {AGENT_NAMES[agent]}</h3>
          <button className="icon-btn" onClick={close}>
            <Icon.x size={16} />
          </button>
        </div>
        <p className="muted small">
          Este es el proceso oficial de <code>{agent === 'claude' ? 'claude auth login' : 'codex login'}</code> en una terminal real. Sigue las instrucciones
          (normalmente se abre el navegador). Ambidex no ve ni guarda tus credenciales.
        </p>
        <div className="login-term">
          <Suspense fallback={null}>
            <TerminalView id={id} cwd="" visible login={agent} onExit={(code) => setExited(code)} />
          </Suspense>
        </div>
        <div className="modal-actions">
          {exited !== null && (
            <span className={`small ${exited === 0 ? 'ok' : 'del'}`} style={{ marginRight: 'auto' }}>
              {exited === 0 ? 'Proceso terminado.' : `El proceso terminó con código ${exited}.`}
              {info?.auth?.loggedIn ? ' Sesión iniciada.' : ''}
            </span>
          )}
          <button className="btn primary" onClick={close}>
            {exited !== null ? 'Hecho' : 'Cerrar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- avisos ----------

// Una imagen de la conversación a pantalla completa; clic o Esc para cerrar
export function Lightbox() {
  const url = useApp((s) => s.lightbox)
  useEffect(() => {
    if (!url) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setApp({ lightbox: null })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url])
  if (!url) return null
  return (
    <div className="overlay center lightbox" onMouseDown={() => setApp({ lightbox: null })}>
      <img src={url} alt="" />
    </div>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <Icon.alert size={14} /> : t.kind === 'success' ? <Icon.ok size={14} /> : <Icon.info size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
