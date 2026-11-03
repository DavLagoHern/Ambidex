import { useCallback, useEffect, useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { AGENTS } from '@shared/types'
import { api } from '../lib/api'
import {
  activate, askText, attempt, closeProject, forgetProject, getApp, pickAndOpenProject, projectStore, reorderProjects, restartToUpdate, setApp, updateProject, useApp
} from '../lib/app-store'
import { ProjectProvider } from '../lib/project-store'
import { LayoutControls } from './Dock'
import { AgentLogo, Icon } from './Icons'

const COLORS = [
  { c: '#e8825f', n: 'Coral' },
  { c: '#f0616d', n: 'Rojo' },
  { c: '#f07fa0', n: 'Rosa' },
  { c: '#c792ea', n: 'Violeta' },
  { c: '#9aa5ff', n: 'Índigo' },
  { c: '#5fb3e8', n: 'Azul' },
  { c: '#5fd4c4', n: 'Turquesa' },
  { c: '#8bd17c', n: 'Verde' },
  { c: '#c5d95f', n: 'Lima' },
  { c: '#f2c46d', n: 'Ámbar' },
  { c: '#d9a066', n: 'Arena' },
  { c: '#a0a8b8', n: 'Gris' }
]

// Selector de color de un proyecto: se aplica al momento y se ve en la pestaña, la línea bajo ellas y el espacio de trabajo
function ColorPopover({ p, x, y, onClose }: { p: ProjectMeta; x: number; y: number; onClose: () => void }) {
  useEffect(() => {
    const down = (e: MouseEvent) => !(e.target as HTMLElement).closest('.color-pop') && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const custom = !COLORS.some((k) => k.c === p.color)
  return (
    <div className="color-pop" style={{ left: Math.min(x, window.innerWidth - 196), top: y }}>
      <div className="color-pop-title">Color de {p.name}</div>
      <div className="color-grid">
        {COLORS.map((k) => (
          <button
            key={k.c}
            className={`color-swatch ${k.c === p.color ? 'on' : ''}`}
            style={{ background: k.c }}
            title={k.n}
            onClick={() => updateProject(p.id, { color: k.c })}
          />
        ))}
        <label className={`color-swatch custom ${custom ? 'on' : ''}`} style={custom ? { background: p.color } : undefined} title="Otro color…">
          {!custom && <Icon.palette size={12} />}
          <input type="color" value={p.color} onChange={(e) => updateProject(p.id, { color: e.target.value })} />
        </label>
      </div>
    </div>
  )
}

async function tabMenu(p: ProjectMeta, askColor: (p: ProjectMeta) => void) {
  const choice = await api.contextMenu([
    { id: 'pin', label: p.pinned ? 'Desfijar pestaña' : 'Fijar pestaña' },
    { id: 'rename', label: 'Renombrar…' },
    { id: 'color', label: 'Color…' },
    { type: 'separator' },
    { id: 'reveal', label: 'Mostrar en Finder' },
    { id: 'vscode', label: 'Abrir en VS Code' },
    { id: 'copy', label: 'Copiar ruta' },
    { type: 'separator' },
    { id: 'close', label: 'Cerrar pestaña' },
    { id: 'close-others', label: 'Cerrar las demás', enabled: getApp().openIds.length > 1 },
    { type: 'separator' },
    { id: 'forget', label: 'Quitar de Ambidex…' }
  ])
  switch (choice) {
    case 'pin':
      return updateProject(p.id, { pinned: !p.pinned })
    case 'rename': {
      const name = await askText('Nombre del proyecto', '', p.name)
      return name && updateProject(p.id, { name })
    }
    case 'color':
      return askColor(p)
    case 'reveal':
      return attempt(() => api.reveal(p.path))
    case 'vscode':
      return attempt(() => api.openInVSCode(p.path))
    case 'copy':
      return navigator.clipboard.writeText(p.path)
    case 'close':
      return closeProject(p.id)
    case 'close-others':
      for (const id of getApp().openIds.filter((x) => x !== p.id && !getApp().projects.find((q) => q.id === x)?.pinned)) await closeProject(id)
      return activate(p.id)
    case 'forget':
      return forgetProject(p.id)
  }
}

function ProjectTab({ p, active, index, askColor }: { p: ProjectMeta; active: boolean; index: number; askColor: (p: ProjectMeta, rect: DOMRect) => void }) {
  // el selector devuelve un string para que la instantánea sea estable
  const busyKey = useApp((s) =>
    Object.values(s.running)
      .filter((r) => r.projectId === p.id)
      .map((r) => r.agent)
      .join(',')
  )
  const busy = busyKey ? busyKey.split(',') : []
  const changes = useApp((s) => s.changes[p.id] ?? 0)
  const finished = useApp((s) => s.finished[p.id])
  const [drag, setDrag] = useState<'before' | 'after' | null>(null)
  const agents = AGENTS.filter((a) => busy.includes(a))

  return (
    <div
      className={`ptab ${active ? 'active' : ''} ${p.pinned ? 'pinned' : ''} ${drag ? `drop-${drag}` : ''}`}
      style={{ ['--proj' as string]: p.color }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-ambidex-tab', p.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-ambidex-tab')) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setDrag(e.clientX < r.left + r.width / 2 ? 'before' : 'after')
      }}
      onDragLeave={() => setDrag(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-ambidex-tab')
        const where = drag
        setDrag(null)
        if (!id || id === p.id) return
        e.preventDefault()
        const ids = getApp().openIds.filter((x) => x !== id)
        const at = ids.indexOf(p.id) + (where === 'after' ? 1 : 0)
        ids.splice(at, 0, id)
        reorderProjects(ids)
      }}
      onMouseDown={(e) => {
        if (e.button === 1) closeProject(p.id)
        else if (e.button === 0) activate(p.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        tabMenu(p, (q) => askColor(q, rect))
      }}
      title={`${p.path}${index < 9 ? `  (⌘${index + 1})` : ''}`}
    >
      <span className="ptab-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
      {!p.pinned && <span className="ptab-name ellipsis">{p.name}</span>}
      {agents.length > 0 && (
        <span className="ptab-agents" title={`${busy.length} agente${busy.length === 1 ? '' : 's'} trabajando`}>
          {agents.map((a) => (
            <span key={a} className={`ptab-agent agent-${a}`}>
              <AgentLogo agent={a} size={10} />
            </span>
          ))}
        </span>
      )}
      {finished && agents.length === 0 && (
        <span
          className={`ptab-done ${finished}`}
          title={finished === 'error' ? 'Un agente terminó con error mientras no lo mirabas' : 'Un agente ha terminado mientras no lo mirabas'}
        />
      )}
      {!p.pinned && changes > 0 && agents.length === 0 && (
        <span className="ptab-changes" title={`${changes} cambios sin commit`}>
          {changes > 99 ? '99+' : changes}
        </span>
      )}
      {!p.pinned && (
        <button className="ptab-close" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeProject(p.id)} title="Cerrar pestaña">
          <Icon.x size={12} />
        </button>
      )}
    </div>
  )
}

// Versión nueva de Ambidex: mientras se descarga y compila, un indicador discreto; lista, el botón para reiniciar
function AppUpdateButton() {
  const u = useApp((s) => s.appUpdate)
  if (!u) return null
  if (u.state === 'pulling' || u.state === 'building')
    return (
      <button className="tb-btn icon" onClick={() => setApp({ overlay: 'settings', settingsSection: 'agents' })} title={`Actualizando Ambidex: ${u.message ?? 'descargando…'}`}>
        <Icon.spinner size={14} className="spin" />
      </button>
    )
  if (u.state !== 'ready') return null
  return (
    <button
      className="tb-btn update-ready"
      onClick={restartToUpdate}
      title={`Ambidex ${u.version ?? ''}${u.commits ? ` · ${u.commits} cambio${u.commits === 1 ? '' : 's'} nuevo${u.commits === 1 ? '' : 's'}` : ''}. Se instala al reiniciar (o al cerrar la app).`}
    >
      <Icon.refresh size={13} /> Versión nueva · Reiniciar
    </button>
  )
}

function AgentStatus() {
  const infos = useApp((s) => s.agentInfo)
  const loading = useApp((s) => s.agentsLoading)
  return (
    <button className="tb-btn agents-status" onClick={() => setApp({ overlay: 'settings', settingsSection: 'agents' })} title="Estado de Claude Code y Codex">
      {AGENTS.map((a) => {
        const i = infos.find((x) => x.agent === a)
        const ok = !!i?.path && !!i.auth?.loggedIn
        return (
          <span key={a} className={`agent-dot ${loading && !i ? 'pending' : ok ? 'ok' : 'warn'}`}>
            <AgentLogo agent={a} size={12} />
          </span>
        )
      })}
    </button>
  )
}

export function TabBar() {
  const projects = useApp((s) => s.projects)
  const openIds = useApp((s) => s.openIds)
  const activeId = useApp((s) => s.activeId)
  const tabs = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectMeta => !!p)
  const store = projectStore(activeId)
  const [colorFor, setColorFor] = useState<{ id: string; x: number; y: number } | null>(null)
  const colorProject = colorFor && projects.find((p) => p.id === colorFor.id)
  const closeColor = useCallback(() => setColorFor(null), [])

  return (
    <div className="tabbar">
      <div className="tabbar-drag" />
      <div className="ptabs">
        {tabs.map((p, i) => (
          <ProjectTab key={p.id} p={p} active={p.id === activeId} index={i} askColor={(q, r) => setColorFor({ id: q.id, x: r.left, y: r.bottom + 6 })} />
        ))}
        <button className="ptab-new" onClick={pickAndOpenProject} title="Abrir proyecto (⌘O)">
          <Icon.plus size={14} />
        </button>
      </div>
      <div className="tabbar-right">
        {store && (
          <ProjectProvider key={store.id} value={store}>
            <LayoutControls />
          </ProjectProvider>
        )}
        <button className="tb-btn search-btn" onClick={() => setApp({ overlay: 'palette' })} title="Paleta de comandos">
          <Icon.search size={13} /> <span>Buscar o ejecutar…</span> <kbd>⌘K</kbd>
        </button>
        <button className="tb-btn icon" onClick={() => setApp({ overlay: 'projects' })} title="Proyectos (⇧⌘O)">
          <Icon.folder size={15} />
        </button>
        <AppUpdateButton />
        <AgentStatus />
        <button className="tb-btn icon" onClick={() => setApp({ overlay: 'settings' })} title="Ajustes (⌘,)">
          <Icon.settings size={15} />
        </button>
      </div>
      {colorFor && colorProject && <ColorPopover p={colorProject} x={colorFor.x} y={colorFor.y} onClose={closeColor} />}
    </div>
  )
}
