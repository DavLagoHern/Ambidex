import { useSyncExternalStore } from 'react'
import type { AgentId, AgentInfo, AgentLimits, AppUpdate, CliUpdate, ProjectMeta, ProjectPatch, Settings, JevStatus } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { api, on } from './api'
import { ProjectStore, WINDOW_ID } from './project-store'
import { errMsg, uid } from './utils'

export type Overlay = 'palette' | 'files' | 'projects' | 'settings' | 'gitOutput' | null

export interface PickItem {
  value: string
  label: string
  detail?: string
}

export interface Toast {
  id: string
  text: string
  kind: 'info' | 'error' | 'success'
}

export interface AppState {
  ready: boolean
  projects: ProjectMeta[]
  openIds: string[]
  activeId: string | null
  // proyectos cuyo espacio de trabajo ya se ha montado (se mantienen vivos al cambiar de pestaña)
  mounted: string[]
  settings: Settings | null
  theme: 'dark' | 'light'
  agentInfo: AgentInfo[]
  agentsLoading: boolean
  limits: Partial<Record<AgentId, AgentLimits>>
  // sesión → proyecto, de los agentes que están trabajando ahora
  running: Record<string, { projectId: string; agent: AgentId; runId: string }>
  changes: Record<string, number>
  // proyectos donde un agente terminó mientras no los mirabas (se limpia al entrar)
  finished: Record<string, 'ok' | 'error'>
  toasts: Toast[]
  overlay: Overlay
  settingsSection: string
  // imagen a pantalla completa (data URL)
  lightbox: string | null
  loginAgent: AgentId | null
  setupOpen: boolean
  picker: { title: string; items: PickItem[]; resolve: (v: string | null) => void } | null
  dialog: { title: string; placeholder?: string; value?: string; resolve: (v: string | null) => void } | null
  // modelo local del enrutado
  jev: JevStatus | null
  // versiones nuevas de los CLI
  cliUpdates: Partial<Record<AgentId, CliUpdate>>
  // versión nueva de Ambidex (se trae y compila sola; se instala al reiniciar)
  appUpdate: AppUpdate | null
}

let state: AppState = {
  ready: false,
  projects: [],
  openIds: [],
  activeId: null,
  mounted: [],
  settings: null,
  theme: 'dark',
  agentInfo: [],
  agentsLoading: false,
  limits: {},
  running: {},
  changes: {},
  finished: {},
  toasts: [],
  overlay: null,
  settingsSection: 'agents',
  lightbox: null,
  loginAgent: null,
  setupOpen: false,
  jev: null,
  cliUpdates: {},
  appUpdate: null,
  picker: null,
  dialog: null
}

const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const getApp = () => state

export function setApp(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  listeners.forEach((l) => l())
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state))
}

// ---------- stores por proyecto ----------

const stores = new Map<string, ProjectStore>()

export const projectStore = (id: string | null | undefined) => (id ? stores.get(id) : undefined)
export const activeStore = () => projectStore(state.activeId)

function ensureStore(meta: ProjectMeta): ProjectStore {
  let ps = stores.get(meta.id)
  if (!ps) {
    ps = new ProjectStore(meta)
    stores.set(meta.id, ps)
    ps.init().catch((e) => toast(`No se pudo cargar ${meta.name}: ${errMsg(e)}`, 'error'))
  }
  return ps
}

// ---------- avisos y diálogos ----------

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = uid()
  setApp((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-4) }))
  setTimeout(() => setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3200)
}

export async function attempt<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (okText) toast(okText, 'success')
    return r
  } catch (e) {
    toast(errMsg(e), 'error')
    return undefined
  }
}

// Selector con filtro (estilo quick pick)
export function pick(title: string, items: PickItem[]): Promise<string | null> {
  return new Promise((resolve) =>
    setApp({
      picker: {
        title,
        items,
        resolve: (v) => {
          setApp({ picker: null })
          resolve(v)
        }
      }
    })
  )
}

export function askText(title: string, placeholder?: string, value?: string): Promise<string | null> {
  return new Promise((resolve) =>
    setApp({
      dialog: {
        title,
        placeholder,
        value,
        resolve: (v) => {
          setApp({ dialog: null })
          resolve(v)
        }
      }
    })
  )
}

// Confirmación nativa de macOS
export const confirmAsync = (message: string, detail?: string, danger = false) => api.confirm(message, detail, danger)

// ---------- tema ----------

const media = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme() {
  const pref = state.settings?.theme ?? 'dark'
  const theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = theme
  if (theme !== state.theme) setApp({ theme })
}
media.addEventListener('change', applyTheme)

export async function saveSettings(patch: Partial<Settings>) {
  const settings = await api.saveSettings(patch)
  setApp({ settings })
  applyTheme()
  if ('claudePath' in patch || 'codexPath' in patch || 'stripApiKeys' in patch) refreshAgents(true)
  return settings
}

// ---------- agentes ----------

export async function refreshAgents(force = false) {
  setApp({ agentsLoading: true })
  try {
    setApp({ agentInfo: await api.agentInfo(force) })
  } catch (e) {
    toast(errMsg(e), 'error')
  } finally {
    setApp({ agentsLoading: false })
  }
}

// ---------- proyectos ----------

let saveActiveTimer: ReturnType<typeof setTimeout> | undefined

function seen(finished: AppState['finished'], id: string | null): AppState['finished'] {
  if (!id || !(id in finished)) return finished
  const next = { ...finished }
  delete next[id]
  return next
}

// al volver a la ventana, el proyecto que tienes delante ya está visto
window.addEventListener('focus', () => state.activeId && state.activeId in state.finished && setApp((s) => ({ finished: seen(s.finished, s.activeId) })))

export function activate(id: string) {
  const meta = state.projects.find((p) => p.id === id)
  if (!meta) return
  ensureStore(meta)
  setApp((s) => ({ activeId: id, mounted: s.mounted.includes(id) ? s.mounted : [...s.mounted, id], finished: seen(s.finished, id) }))
  clearTimeout(saveActiveTimer)
  saveActiveTimer = setTimeout(() => api.saveSettings({ activeProjectId: id }).then((settings) => setApp({ settings })), 400)
}

export async function openProjectPath(path: string) {
  const meta = await attempt(() => api.projects.open(path))
  if (!meta) return
  setApp((s) => ({
    projects: [...s.projects.filter((p) => p.id !== meta.id), meta],
    openIds: s.openIds.includes(meta.id) ? s.openIds : [...s.openIds, meta.id]
  }))
  activate(meta.id)
}

export async function pickAndOpenProject() {
  const p = await api.pickFolder()
  if (p) await openProjectPath(p)
}

export async function closeProject(id: string) {
  const ps = stores.get(id)
  const busy = Object.values(state.running).filter((r) => r.projectId === id).length
  if (busy && !(await confirmAsync('Hay agentes trabajando en este proyecto', 'Seguirán trabajando en segundo plano y podrás ver el resultado al volver a abrirlo.'))) return
  if (ps?.hasDirtyFiles() && !(await confirmAsync('Hay ficheros sin guardar', 'Se perderán los cambios no guardados del editor.', true))) return
  ps?.dispose()
  stores.delete(id)
  await attempt(() => api.projects.close(id))
  setApp((s) => {
    const idx = s.openIds.indexOf(id)
    const openIds = s.openIds.filter((x) => x !== id)
    const activeId = s.activeId === id ? (openIds[Math.min(idx, openIds.length - 1)] ?? null) : s.activeId
    return {
      openIds,
      mounted: s.mounted.filter((x) => x !== id),
      activeId,
      projects: s.projects.map((p) => (p.id === id ? { ...p, isOpen: false } : p))
    }
  })
  if (state.activeId) activate(state.activeId)
}

export async function reorderProjects(ids: string[]) {
  setApp({ openIds: ids })
  await attempt(() => api.projects.reorder(ids))
}

export async function updateProject(id: string, patch: ProjectPatch) {
  const meta = await attempt(() => api.projects.update(id, patch))
  if (!meta) return
  setApp((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...meta, exists: p.exists } : p)) }))
  stores.get(id)?.setMeta(meta)
  // las fijadas van primero
  if ('pinned' in patch) {
    const projects = getApp().projects
    const sorted = [...state.openIds].sort((a, b) => Number(!!projects.find((p) => p.id === b)?.pinned) - Number(!!projects.find((p) => p.id === a)?.pinned))
    reorderProjects(sorted)
  }
}

export async function forgetProject(id: string) {
  const meta = state.projects.find((p) => p.id === id)
  if (!meta) return
  if (!(await confirmAsync(`¿Quitar "${meta.name}" de Ambidex?`, 'Se borrarán sus conversaciones y su historial de la app. Los ficheros del proyecto no se tocan.', true))) return
  if (state.openIds.includes(id)) await closeProject(id)
  if (await attempt(() => api.projects.forget(id), 'Proyecto quitado')) setApp((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  else setApp({ projects: await api.projects.list() })
}

export function cycleProject(dir: 1 | -1) {
  const { openIds, activeId } = state
  if (openIds.length < 2 || !activeId) return
  const i = openIds.indexOf(activeId)
  activate(openIds[(i + dir + openIds.length) % openIds.length])
}

// Instala la versión nueva ya compilada: la app se cierra y se vuelve a abrir actualizada (si hay agentes
// trabajando, el proceso principal pregunta antes de cerrar)
export const restartToUpdate = () => attempt(() => api.self.restart())

export function setChanges(projectId: string, n: number) {
  if (state.changes[projectId] !== n) setApp((s) => ({ changes: { ...s.changes, [projectId]: n } }))
}

// ---------- arranque ----------

let started = false

// Avisos del proceso principal que mantienen al día los proyectos (en la ventana principal y en las de panel)
function bindData() {
  on('session:items', (p) => stores.get(p.projectId)?.applyItems(p.sessionId, p.items))
  on('web:agent', (p) => stores.get(p.projectId)?.set({ webAgent: { agent: p.agent, action: p.action, at: Date.now() } }))
  on('session:meta', (meta) => stores.get(meta.projectId)?.upsertSession(meta))
  on('run:status', (run) => {
    setApp((s) => {
      const running = { ...s.running }
      let finished = s.finished
      if (run.status === 'running') running[run.sessionId] = { projectId: run.projectId, agent: run.agent, runId: run.id }
      // un aviso tardío de un turno ya terminado no quita el «trabajando» del turno que corre ahora
      else if (running[run.sessionId]?.runId === run.id) {
        delete running[run.sessionId]
        // terminó algo que no estabas mirando: punto en su pestaña (un fallo no lo tapa un acierto posterior)
        const away = run.projectId !== s.activeId || !document.hasFocus()
        if (away && (run.status === 'completed' || run.status === 'failed'))
          finished = { ...finished, [run.projectId]: finished[run.projectId] === 'error' || run.status === 'failed' ? 'error' : 'ok' }
      }
      return { running, finished }
    })
    stores.get(run.projectId)?.onRun(run)
  })
  on('limits', (l) => setApp((s) => ({ limits: { ...s.limits, [l.agent]: l } })))
  on('jev:status', (j) => setApp({ jev: j }))
  on('cli:update', (u) => {
    setApp((s) => ({ cliUpdates: { ...s.cliUpdates, [u.agent]: u } }))
    // versión nueva: otra versión y, en Codex, quizá otros modelos
    if (u.state === 'updated') refreshAgents()
  })
  on('self:update', (u) => setApp({ appUpdate: u }))
  on('fs:changed', (p) => stores.get(p.projectId)?.onFsChanged(p.paths))
  on('thread:meta', (t) => stores.get(t.projectId)?.upsertThread(t))
  on('queue:changed', (q) => stores.get(q.projectId)?.setQueue(q.items))
  on('orch:update', (o) => stores.get(o.projectId)?.upsertOrch(o))
  on('panel:sync', (p) => p.origin !== WINDOW_ID && stores.get(p.projectId)?.applyRemote(p.patch))
}

// Una ventana con un solo panel de un proyecto (chat, terminal, editor o agentes sacados de la principal)
export async function initPanel(projectId: string): Promise<ProjectStore | undefined> {
  if (started) return stores.get(projectId)
  started = true
  bindData()
  const [settings, projects, limits] = await Promise.all([api.getSettings(), api.projects.list(), api.agentLimits()])
  const meta = projects.find((p) => p.id === projectId)
  if (!meta) return undefined
  const ps = new ProjectStore(meta, { secondary: true })
  stores.set(projectId, ps)
  setApp({ settings, projects, limits, openIds: [projectId], activeId: projectId, ready: true })
  applyTheme()
  await ps.init()
  refreshAgents()
  return ps
}

export async function initApp(runCommand: (cmd: string) => void) {
  if (started) return
  started = true
  bindData()
  // un agente abre la Web de su proyecto; un panel vuelve de su ventana
  on('web:agent-open', (p) => stores.get(p.projectId)?.openWeb(p.url))
  on('panel:closed', (p) => stores.get(p.projectId)?.set((s) => ({ popped: s.popped.filter((x) => x !== p.panel) })))
  on('menu', ({ command }) => runCommand(command))
  on('cli:update', (u) => u.state === 'updated' && toast(`${AGENT_NAMES[u.agent]} actualizado a la ${u.installed}`, 'success'))
  on('open-path', ({ path }) => openProjectPath(path))
  on('focus-project', ({ projectId, sessionId }) => {
    activate(projectId)
    if (sessionId) setTimeout(() => stores.get(projectId)?.focusSession(sessionId), 50)
  })

  const [settings, projects, limits] = await Promise.all([api.getSettings(), api.projects.list(), api.agentLimits()])
  const openIds = projects.filter((p) => p.isOpen).sort((a, b) => a.tabOrder - b.tabOrder).map((p) => p.id)
  setApp({ settings, projects, limits, openIds, ready: true, setupOpen: !settings.setupComplete && projects.length === 0 })
  applyTheme()
  api.self
    .status()
    .then((u) => setApp({ appUpdate: u }))
    .catch(() => {})
  const first = openIds.includes(settings.activeProjectId ?? '') ? settings.activeProjectId! : openIds[0]
  if (first) activate(first)
  refreshAgents()

  // contador de cambios Git de las pestañas que aún no se han montado
  for (const p of projects.filter((x) => x.isOpen && x.id !== first && x.exists))
    api.git
      .status(p.gitRoot ?? p.path)
      .then((st) => st.isRepo && setChanges(p.id, st.files.length))
      .catch(() => {})
}
