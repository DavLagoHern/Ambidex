import type { AgentId } from '@shared/types'
import type { IconName } from '../components/Icons'
import {
  activate, activeStore, closeProject, cycleProject, getApp, pickAndOpenProject, refreshAgents, saveSettings, setApp
} from './app-store'
import { PRESETS } from './dock'
import type { SidebarView } from './project-store'

export interface Command {
  id: string
  title: string
  group: 'General' | 'Proyecto' | 'Agentes' | 'Ver' | 'Git'
  shortcut?: string
  icon?: IconName
  needsProject?: boolean
  run: () => void
}

const ps = () => activeStore()

const sidebar = (view: SidebarView) => () => {
  const s = ps()
  if (!s) return
  s.set((st) => ({ sidebar: view, panels: { ...st.panels, sidebar: true } }))
}

const newChat = (agent?: AgentId) => () => {
  const s = ps()
  if (!s) return
  const view = s.state.agentView
  if (!agent && view === 'auto') {
    s.newThread().then(() => window.dispatchEvent(new CustomEvent('focus-composer', { detail: 'auto' })))
    return
  }
  const a = agent ?? (view === 'claude' || view === 'codex' ? view : (getApp().settings?.defaultAgent ?? 'claude'))
  if (agent) s.set({ agentView: agent })
  s.newSession(a).then(() => window.dispatchEvent(new CustomEvent('focus-composer', { detail: a })))
}

export const COMMANDS: Command[] = [
  { id: 'open-project', title: 'Abrir proyecto…', group: 'General', shortcut: '⌘O', icon: 'folderOpen', run: () => pickAndOpenProject() },
  { id: 'projects', title: 'Explorador de proyectos', group: 'General', shortcut: '⇧⌘O', icon: 'folder', run: () => setApp({ overlay: 'projects' }) },
  { id: 'settings', title: 'Ajustes', group: 'General', shortcut: '⌘,', icon: 'settings', run: () => setApp({ overlay: 'settings' }) },
  { id: 'palette', title: 'Paleta de comandos', group: 'General', shortcut: '⌘K', icon: 'command', run: () => setApp({ overlay: 'palette' }) },
  { id: 'agents-refresh', title: 'Volver a detectar Claude Code y Codex', group: 'Agentes', icon: 'refresh', run: () => refreshAgents(true) },
  { id: 'login-claude', title: 'Iniciar sesión en Claude Code', group: 'Agentes', icon: 'login', run: () => setApp({ loginAgent: 'claude' }) },
  { id: 'login-codex', title: 'Iniciar sesión en Codex', group: 'Agentes', icon: 'login', run: () => setApp({ loginAgent: 'codex' }) },
  {
    id: 'toggle-theme',
    title: 'Cambiar tema claro / oscuro',
    group: 'Ver',
    icon: 'sun',
    run: () => saveSettings({ theme: getApp().theme === 'dark' ? 'light' : 'dark' })
  },

  { id: 'quick-open', title: 'Ir a fichero…', group: 'Proyecto', shortcut: '⌘P', icon: 'file', needsProject: true, run: () => setApp({ overlay: 'files' }) },
  { id: 'new-chat', title: 'Nueva conversación', group: 'Agentes', shortcut: '⌘N', icon: 'chat', needsProject: true, run: newChat() },
  { id: 'new-chat-claude', title: 'Nueva conversación con Claude', group: 'Agentes', icon: 'sparkles', needsProject: true, run: newChat('claude') },
  { id: 'new-chat-codex', title: 'Nueva conversación con Codex', group: 'Agentes', icon: 'prompt', needsProject: true, run: newChat('codex') },
  { id: 'view-claude', title: 'Ver solo Claude', group: 'Agentes', shortcut: '⌥⌘1', needsProject: true, run: () => ps()?.set({ agentView: 'claude' }) },
  { id: 'view-codex', title: 'Ver solo Codex', group: 'Agentes', shortcut: '⌥⌘2', needsProject: true, run: () => ps()?.set({ agentView: 'codex' }) },
  { id: 'view-both', title: 'Ambos: un chat con los dos', group: 'Agentes', shortcut: '⌥⌘3', icon: 'workflow', needsProject: true, run: () => ps()?.set({ agentView: 'auto' }) },
  { id: 'view-split', title: 'Ambos: dos chats lado a lado', group: 'Agentes', icon: 'split', needsProject: true, run: () => ps()?.set({ agentView: 'both' }) },
  {
    id: 'team',
    title: 'Encargar una tarea al equipo (Claude + Codex)',
    group: 'Agentes',
    icon: 'workflow',
    needsProject: true,
    run: () => {
      ps()?.set({ agentView: 'auto', target: 'team' })
      setTimeout(() => window.dispatchEvent(new CustomEvent('focus-composer', { detail: 'auto' })), 50)
    }
  },
  { id: 'focus-chat', title: 'Ir al chat', group: 'Agentes', shortcut: '⌘L', needsProject: true, run: () => window.dispatchEvent(new Event('focus-composer')) },

  { id: 'toggle-sidebar', title: 'Mostrar/ocultar barra lateral', group: 'Ver', shortcut: '⌘B', icon: 'panelLeft', needsProject: true, run: () => ps()?.togglePanel('sidebar') },
  { id: 'toggle-right', title: 'Mostrar/ocultar el panel de agentes', group: 'Ver', shortcut: '⌥⌘B', icon: 'activity', needsProject: true, run: () => ps()?.togglePanel('right') },
  { id: 'toggle-web', title: 'Mostrar/ocultar el visor web', group: 'Ver', icon: 'globe', needsProject: true, run: () => ps()?.toggleWeb() },
  { id: 'web-new-tab', title: 'Web: pestaña nueva', group: 'Ver', icon: 'globe', needsProject: true, run: () => ps()?.addWebTab() },
  { id: 'toggle-bottom', title: 'Mostrar/ocultar la terminal', group: 'Ver', shortcut: '⌘J', icon: 'terminal', needsProject: true, run: () => ps()?.togglePanel('bottom') },
  { id: 'reset-layout', title: 'Restablecer el diseño de los paneles', group: 'Ver', icon: 'layout', needsProject: true, run: () => ps()?.resetDock() },
  ...(
    [
      ['chat', 'el chat'],
      ['terminal', 'la terminal'],
      ['editor', 'el editor'],
      ['agents', 'los agentes']
    ] as const
  ).map(([p, label]): Command => ({ id: `popout-${p}`, title: `Abrir ${label} en una ventana nueva`, group: 'Ver', icon: 'popout', needsProject: true, run: () => ps()?.popOut(p) })),
  ...PRESETS.map(
    (p): Command => ({ id: `layout-${p.name}`, title: `Diseño: ${p.name}`, group: 'Ver', icon: 'layout', needsProject: true, run: () => ps()?.applyLayout(p) })
  ),
  {
    id: 'toggle-layout',
    title: 'Alternar disposición chat / código',
    group: 'Ver',
    shortcut: '⌘E',
    icon: 'code',
    needsProject: true,
    run: () => {
      const s = ps()
      if (s) s.setLayout(s.state.layout === 'chat' ? 'code' : 'chat')
    }
  },
  { id: 'dev-server', title: 'Arrancar el servidor de desarrollo', group: 'Proyecto', icon: 'play', needsProject: true, run: () => ps()?.runDevServer() },
  { id: 'new-terminal', title: 'Nueva terminal', group: 'Proyecto', shortcut: '⇧⌘T', icon: 'terminal', needsProject: true, run: () => ps()?.newTerminal() },
  {
    id: 'toggle-terminal',
    title: 'Terminal',
    group: 'Proyecto',
    shortcut: '⌃`',
    icon: 'terminal',
    needsProject: true,
    run: () => {
      const s = ps()
      if (!s) return
      if (s.state.panels.bottom && s.state.bottomTab !== 'log') s.togglePanel('bottom', false)
      else if (!s.state.terminals.length) s.newTerminal()
      else s.set((st) => ({ panels: { ...st.panels, bottom: true }, bottomTab: st.bottomTab === 'log' || !st.bottomTab ? st.terminals[0].id : st.bottomTab }))
    }
  },
  { id: 'show-log', title: 'Ver registro de ejecuciones', group: 'Proyecto', icon: 'log', needsProject: true, run: () => ps()?.set((st) => ({ bottomTab: 'log', panels: { ...st.panels, bottom: true } })) },
  { id: 'sidebar-chats', title: 'Conversaciones', group: 'Ver', shortcut: '⇧⌘C', icon: 'chat', needsProject: true, run: sidebar('chats') },
  { id: 'sidebar-explorer', title: 'Explorador de ficheros', group: 'Ver', shortcut: '⇧⌘E', icon: 'files', needsProject: true, run: sidebar('explorer') },
  { id: 'sidebar-git', title: 'Control de código (Git)', group: 'Git', shortcut: '⇧⌘G', icon: 'git', needsProject: true, run: sidebar('git') },
  { id: 'sidebar-history', title: 'Historial de commits', group: 'Git', shortcut: '⇧⌘H', icon: 'history', needsProject: true, run: sidebar('history') },
  { id: 'sidebar-search', title: 'Buscar en el proyecto', group: 'Ver', shortcut: '⇧⌘F', icon: 'search', needsProject: true, run: sidebar('search') },
  { id: 'git-refresh', title: 'Refrescar estado de Git', group: 'Git', icon: 'refresh', needsProject: true, run: () => ps()?.refreshGit() },
  { id: 'git-output', title: 'Ver salida de Git', group: 'Git', icon: 'log', run: () => setApp({ overlay: 'gitOutput' }) },

  { id: 'next-project', title: 'Proyecto siguiente', group: 'General', shortcut: '⌃⇥', run: () => cycleProject(1) },
  { id: 'prev-project', title: 'Proyecto anterior', group: 'General', shortcut: '⌃⇧⇥', run: () => cycleProject(-1) },
  {
    id: 'close-project',
    title: 'Cerrar pestaña de proyecto',
    group: 'General',
    shortcut: '⇧⌘W',
    needsProject: true,
    run: () => {
      const id = getApp().activeId
      if (id) closeProject(id)
    }
  }
]

export function runCommand(id: string) {
  const c = COMMANDS.find((x) => x.id === id)
  if (!c) return
  if (c.needsProject && !activeStore()) return
  c.run()
}

// Atajos que gestiona el renderer (el resto los registra el menú de macOS).
// Se escuchan en fase de captura para que Monaco y xterm no se los queden.
export function handleKey(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase()
  const meta = e.metaKey
  if (e.ctrlKey && e.key === '`') return run(e, 'toggle-terminal')
  if (e.ctrlKey && e.key === 'Tab') return run(e, e.shiftKey ? 'prev-project' : 'next-project')
  if (!meta || e.ctrlKey) return false
  if (e.altKey && ['1', '2', '3'].includes(e.code.replace('Digit', ''))) return run(e, ['view-claude', 'view-codex', 'view-both'][+e.code.replace('Digit', '') - 1])
  if (e.altKey) return false
  if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
    const ids = getApp().openIds
    const id = e.key === '9' ? ids.at(-1) : ids[+e.key - 1]
    if (id) activate(id)
    e.preventDefault()
    return true
  }
  if (!e.shiftKey && k === 'k') return run(e, 'palette')
  if (!e.shiftKey && k === 'p') return run(e, 'quick-open')
  // dentro del visor web, ⌘L es la barra de direcciones
  if (!e.shiftKey && k === 'l' && !(document.activeElement as HTMLElement | null)?.closest('.webpanel')) return run(e, 'focus-chat')
  if (e.shiftKey) {
    const map: Record<string, string> = { c: 'sidebar-chats', e: 'sidebar-explorer', g: 'sidebar-git', h: 'sidebar-history', f: 'sidebar-search' }
    if (map[k]) return run(e, map[k])
  }
  return false
}

function run(e: KeyboardEvent, id: string) {
  e.preventDefault()
  e.stopPropagation()
  runCommand(id)
  return true
}
