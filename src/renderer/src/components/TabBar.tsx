import { useState } from 'react'
import type { ProjectMeta } from '@shared/types'
import { AGENTS } from '@shared/types'
import { api } from '../lib/api'
import {
  activate, askText, attempt, closeProject, forgetProject, getApp, pickAndOpenProject, projectStore, reorderProjects, setApp, updateProject, useApp
} from '../lib/app-store'
import { ProjectProvider } from '../lib/project-store'
import { LayoutControls } from './Dock'
import { AgentLogo, Icon } from './Icons'

const COLORS = ['#e8825f', '#5fb3e8', '#8bd17c', '#c792ea', '#f2c46d', '#5fd4c4', '#f07fa0', '#9aa5ff']

async function tabMenu(p: ProjectMeta) {
  const choice = await api.contextMenu([
    { id: 'pin', label: p.pinned ? 'Desfijar pestaña' : 'Fijar pestaña' },
    { id: 'rename', label: 'Renombrar…' },
    { id: 'color', label: 'Cambiar color' },
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
      return updateProject(p.id, { color: COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length] })
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

function ProjectTab({ p, active, index }: { p: ProjectMeta; active: boolean; index: number }) {
  // el selector devuelve un string para que la instantánea sea estable
  const busyKey = useApp((s) =>
    Object.values(s.running)
      .filter((r) => r.projectId === p.id)
      .map((r) => r.agent)
      .join(',')
  )
  const busy = busyKey ? busyKey.split(',') : []
  const changes = useApp((s) => s.changes[p.id] ?? 0)
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
      onContextMenu={(e) => (e.preventDefault(), tabMenu(p))}
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

  return (
    <div className="tabbar">
      <div className="tabbar-drag" />
      <div className="ptabs">
        {tabs.map((p, i) => (
          <ProjectTab key={p.id} p={p} active={p.id === activeId} index={i} />
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
        <AgentStatus />
        <button className="tb-btn icon" onClick={() => setApp({ overlay: 'settings' })} title="Ajustes (⌘,)">
          <Icon.settings size={15} />
        </button>
      </div>
    </div>
  )
}
