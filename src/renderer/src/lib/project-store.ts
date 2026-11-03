import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  AgentId, ChatItem, DevScript, GitStatus, ProjectMeta, QueuedMessage, RouteDecision, RunInfo, SessionCreate, SessionMeta, SessionPatch, ThreadMeta
} from '@shared/types'
import type { OrchMode, OrchStart, Orchestration, PlanTask } from '@shared/orchestrator'
import { AGENT_NAMES } from '@shared/types'
import { isWebUrl, type WebTab } from '@shared/web'
import { api } from './api'
import { attempt, getApp, saveSettings, setChanges, toast } from './app-store'
import { defaultDock, DockNode, DockPanel, FOLDABLE, LayoutShow, LegacySizes, upgradeDock } from './dock'
import { basename, errMsg, relPath, toolName, uid } from './utils'

// ---------- tipos ----------

export type Tab =
  | { id: string; kind: 'file'; path: string; title: string; line?: number }
  | { id: string; kind: 'diff'; cwd: string; rel: string; mode: 'unstaged' | 'staged' | 'head'; title: string }
  | { id: string; kind: 'commit'; cwd: string; hash: string; title: string }
  | { id: string; kind: 'refdiff'; cwd: string; rel: string; from: string; to: string; title: string }

export type SessionView = SessionMeta & { items?: ChatItem[]; loading?: boolean }

export type SidebarView = 'chats' | 'explorer' | 'git' | 'history' | 'search'
// claude / codex: chat con un agente · auto: un chat con los dos (enrutado y equipo) · both: los dos lado a lado
export type AgentView = AgentId | 'auto' | 'both'

// destino del composer del chat único
export type Target = 'auto' | AgentId | 'team'

export interface ActivityEntry {
  id: string
  at: number
  agent: AgentId
  sessionId: string
  kind: 'tool' | 'files' | 'error' | 'run' | 'permission'
  text: string
  detail?: string
  status?: 'running' | 'done' | 'error'
}

// visibilidad de los paneles; dónde está cada uno y su tamaño lo guarda `dock`
export interface Panels {
  sidebar: boolean
  right: boolean
  // el panel «Actividad» (antes iba dentro de Agentes)
  activity: boolean
  bottom: boolean
}

// visor web del proyecto: pestañas propias junto al chat
export interface WebState {
  open: boolean
  tabs: WebTab[]
  active: string | null
}

export interface TerminalTab {
  id: string
  title: string
  cwd: string
  // servidor de desarrollo: script de package.json que se lanzó al abrirla
  dev?: string
}

export interface PendingSend {
  id: string
  // null: la conversación se está creando
  threadId: string | null
  text: string
  images?: string[]
  at: number
  error?: string
}

export interface ProjectState {
  meta: ProjectMeta
  loaded: boolean
  workspace: string
  sidebar: SidebarView
  tabs: Tab[]
  activeTab: string | null
  dirty: Record<string, boolean>
  git: GitStatus | null
  repos: string[]
  repo: string | null
  repoStatus: Record<string, GitStatus>
  gitTick: number
  fsTick: number
  changed: string[]
  sessions: Record<string, SessionView>
  active: Partial<Record<AgentId, string>>
  agentView: AgentView
  compare: boolean
  layout: 'chat' | 'code'
  panels: Panels
  dock: DockNode
  bottomTab: string
  logRun: string | null
  terminals: TerminalTab[]
  includeContext: boolean
  chatScroll: Record<string, number>
  runs: RunInfo[]
  activity: ActivityEntry[]
  threads: Record<string, ThreadMeta>
  activeThread: string | null
  queue: QueuedMessage[]
  // mensajes ya enviados que el motor aún está enrutando: se ven al instante, antes de que decida
  pending: PendingSend[]
  orchs: Record<string, Orchestration>
  target: Target
  teamMode: OrchMode
  // conversación abierta en el panel lateral (pasos del equipo)
  drawer: string | null
  web: WebState
  // un agente está usando la Web del proyecto (lo último que hizo)
  webAgent: { agent: AgentId; action: string; at: number } | null
  // paneles que se ven en otra ventana (no se guarda: al reabrir vuelven a la principal)
  popped: DockPanel[]
  // paneles plegados (solo se ve su cabecera)
  folded: DockPanel[]
}

// identifica esta ventana en los cambios que se comparten con las demás ventanas del proyecto
export const WINDOW_ID = uid()

// Lo que se guarda en SQLite para restaurar el proyecto tal cual
const UI_KEYS = [
  'workspace', 'sidebar', 'tabs', 'activeTab', 'repo', 'active', 'agentView', 'compare', 'layout', 'panels', 'dock', 'bottomTab', 'terminals',
  'includeContext', 'chatScroll', 'activeThread', 'target', 'teamMode', 'web', 'folded'
] as const
type UiState = Partial<Pick<ProjectState, (typeof UI_KEYS)[number]>>

const DEFAULT_PANELS: Panels = { sidebar: true, right: true, activity: true, bottom: false }

// Un proyecto nuevo empieza con la última disposición que hayas montado en cualquier otro
const LAST_DOCK = 'codeai.dock' // nombre de cuando la app se llamaba Code AI
function lastDock(): DockNode | null {
  try {
    const t = JSON.parse(localStorage.getItem(LAST_DOCK) ?? 'null')
    return upgradeDock(t)
  } catch {
    return null
  }
}
function rememberDock(t: DockNode) {
  try {
    localStorage.setItem(LAST_DOCK, JSON.stringify(t))
  } catch {
    // sin almacenamiento local, cada proyecto nuevo empieza con la disposición de siempre
  }
}

const NO_FILES: string[] = []

// las pestañas web guardadas solo vuelven si son http(s); las vacías no se restauran
function restoreWeb(w?: WebState): WebState {
  const tabs = (w?.tabs ?? []).filter((t) => t && typeof t.id === 'string' && isWebUrl(t.url) && t.url !== 'about:blank').map(({ id, url, title }) => ({ id, url, title }))
  const active = tabs.find((t) => t.id === w?.active)?.id ?? tabs[0]?.id ?? null
  return { open: !!w?.open && tabs.length > 0, tabs, active }
}

// ---------- store ----------

export class ProjectStore {
  state: ProjectState
  private listeners = new Set<() => void>()
  private saveTimer?: ReturnType<typeof setTimeout>
  private gitTimer?: ReturnType<typeof setTimeout>
  private filesCache: { tick: number; ws: string; list: string[] } | null = null
  private activityIndex = new Map<string, string>() // itemId → activityId
  private disposed = false

  // editor activo (para adjuntar el fichero/selección como contexto)
  editorRef: { current: { path: string; getSelection: () => { text: string; from: number; to: number } | null } | null } = { current: null }

  // una ventana con solo un panel del proyecto: no guarda el estado ni vigila los ficheros (lo hace la principal)
  readonly secondary: boolean
  private applyingRemote = false

  constructor(meta: ProjectMeta, opts: { secondary?: boolean } = {}) {
    this.secondary = !!opts.secondary
    this.state = {
      meta,
      loaded: false,
      workspace: meta.path,
      sidebar: 'chats',
      tabs: [],
      activeTab: null,
      dirty: {},
      git: null,
      repos: [],
      repo: null,
      repoStatus: {},
      gitTick: 0,
      fsTick: 0,
      changed: NO_FILES,
      sessions: {},
      active: {},
      agentView: 'auto',
      compare: false,
      layout: 'chat',
      panels: DEFAULT_PANELS,
      dock: defaultDock(),
      bottomTab: '',
      logRun: null,
      terminals: [],
      includeContext: true,
      chatScroll: {},
      runs: [],
      activity: [],
      threads: {},
      activeThread: null,
      queue: [],
      pending: [],
      orchs: {},
      target: 'auto',
      teamMode: getApp().settings?.orchMode ?? 'C',
      drawer: null,
      web: { open: false, tabs: [], active: null },
      webAgent: null,
      popped: [],
      folded: []
    }
  }

  get id() {
    return this.state.meta.id
  }

  get root() {
    return this.state.meta.path
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  get = () => this.state

  set = (patch: Partial<ProjectState> | ((s: ProjectState) => Partial<ProjectState>)) => {
    if (this.disposed) return
    const p = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...p }
    this.listeners.forEach((l) => l())
    if (this.state.loaded && !this.secondary && UI_KEYS.some((k) => k in p)) this.scheduleSave()
    // las terminales son las mismas en todas las ventanas del proyecto
    if (this.state.loaded && !this.applyingRemote && ('terminals' in p || 'bottomTab' in p))
      api.panel.sync(this.id, WINDOW_ID, { terminals: this.state.terminals, bottomTab: this.state.bottomTab }).catch(() => {})
  }

  applyRemote(patch: Partial<ProjectState>) {
    this.applyingRemote = true
    try {
      this.set(patch)
    } finally {
      this.applyingRemote = false
    }
  }

  // Saca un panel a su propia ventana (al cerrarla vuelve aquí)
  async popOut(p: DockPanel) {
    if (p === 'editor' && this.hasDirtyFiles()) return toast('Guarda los ficheros con cambios antes de sacar el editor a otra ventana', 'error')
    this.set((s) => ({ popped: s.popped.includes(p) ? s.popped : [...s.popped, p] }))
    await api.panel.open(this.id, p).catch((e) => {
      this.set((s) => ({ popped: s.popped.filter((x) => x !== p) }))
      toast(errMsg(e), 'error')
    })
  }

  setMeta(meta: ProjectMeta) {
    this.set((s) => ({ meta: { ...s.meta, ...meta } }))
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveUi(), 500)
  }

  private saveUi() {
    if (this.secondary) return
    const ui: UiState = {}
    for (const k of UI_KEYS) (ui as Record<string, unknown>)[k] = this.state[k]
    api.projects.saveUi(this.id, ui).catch(() => {})
  }

  // ---------- ciclo de vida ----------

  async init() {
    const [ui, sessions, runs, threads, queue, orchs] = await Promise.all([
      api.projects.getUi(this.id).catch(() => ({})) as Promise<UiState>,
      api.sessions.list(this.id),
      api.runs.recent(this.id, 30).catch(() => [] as RunInfo[]),
      api.threads.list(this.id).catch(() => [] as ThreadMeta[]),
      api.queue.list(this.id).catch(() => [] as QueuedMessage[]),
      api.orch.list(this.id).catch(() => [] as Orchestration[])
    ])
    const map: Record<string, SessionView> = {}
    for (const s of sessions) map[s.id] = s
    const active: Partial<Record<AgentId, string>> = {}
    // la conversación abierta de cada agente es siempre suelta: una de «Ambos» o del equipo (de versiones anteriores) no
    for (const [a, id] of Object.entries(ui.active ?? {})) if (id && map[id] && !map[id].threadId && !map[id].orchestrationId) active[a as AgentId] = id
    const workspace = ui.workspace && (ui.workspace === this.root || ui.workspace.startsWith('/')) ? ui.workspace : this.root
    // la línea de tiempo se reconstruye a partir de las ejecuciones guardadas
    const activity = runs.flatMap((r) =>
      r.status === 'running' ? [] : [{ ...runEntry(r, r.endedAt ?? r.startedAt, false), id: uid() }, { ...runEntry(r, r.startedAt, true), id: uid(), status: 'done' as const }]
    )
    const threadMap: Record<string, ThreadMeta> = {}
    for (const t of threads) threadMap[t.id] = t
    const orchMap: Record<string, Orchestration> = {}
    for (const o of orchs) orchMap[o.id] = o
    const activeThread = ui.activeThread && threadMap[ui.activeThread] ? ui.activeThread : (threads[0]?.id ?? null)
    this.set({
      ...ui,
      threads: threadMap,
      orchs: orchMap,
      queue,
      activeThread,
      activity,
      workspace,
      folded: Array.isArray(ui.folded) ? ui.folded.filter((p) => FOLDABLE.includes(p)) : [],
      panels: {
        sidebar: ui.panels?.sidebar ?? DEFAULT_PANELS.sidebar,
        right: ui.panels?.right ?? DEFAULT_PANELS.right,
        // proyectos de antes: la actividad se veía con los agentes
        activity: ui.panels?.activity ?? ui.panels?.right ?? DEFAULT_PANELS.activity,
        bottom: ui.panels?.bottom ?? DEFAULT_PANELS.bottom
      },
      // los proyectos de antes conservan los tamaños que tenían sus paneles
      dock: upgradeDock(ui.dock) ?? (ui.panels ? defaultDock(ui.panels as LegacySizes) : (lastDock() ?? defaultDock())),
      // un servidor de desarrollo no se vuelve a lanzar solo al reabrir: queda la terminal
      terminals: (ui.terminals ?? []).map(({ dev, ...t }) => (dev ? { ...t, title: `${dev} (cerrado)` } : t)),
      chatScroll: ui.chatScroll ?? {},
      sessions: map,
      active,
      runs,
      // los editores se reabren; diffs y commits también (se recalculan al mostrarse)
      tabs: ui.tabs ?? [],
      web: restoreWeb(ui.web),
      loaded: true
    })
    for (const id of Object.values(active)) if (id) this.loadMessages(id)
    if (activeThread) this.loadThread(activeThread)
    if (this.state.meta.exists !== false) {
      if (!this.secondary) await api.watch(this.id, workspace).catch(() => {})
      await this.discoverRepos()
    }
  }

  dispose() {
    clearTimeout(this.saveTimer)
    this.saveUi()
    this.disposed = true
    if (!this.secondary) api.unwatch(this.id).catch(() => {})
  }

  hasDirtyFiles() {
    return Object.values(this.state.dirty).some(Boolean)
  }

  // ---------- layout ----------

  togglePanel(k: 'sidebar' | 'right' | 'activity' | 'bottom', value?: boolean) {
    this.set((s) => {
      const next = value ?? !s.panels[k]
      const patch: Partial<ProjectState> = { panels: { ...s.panels, [k]: next } }
      if (k === 'bottom' && next && !s.terminals.length && !s.bottomTab) {
        const t = this.makeTerminal()
        patch.terminals = [t]
        patch.bottomTab = t.id
      }
      return patch
    })
  }

  isShown(p: DockPanel) {
    const s = this.state
    if (p === 'sidebar') return s.panels.sidebar
    if (p === 'agents') return s.panels.right
    if (p === 'activity') return s.panels.activity
    if (p === 'terminal') return s.panels.bottom
    if (p === 'web') return s.web.open
    if (p === 'editor') return s.layout === 'code' || s.tabs.length > 0
    return true
  }

  toggleDock(p: DockPanel, value?: boolean) {
    // el editor se ve mientras haya ficheros abiertos; la disposición «código» lo deja siempre a la vista
    if (p === 'editor') return this.setLayout((value ?? this.state.layout !== 'code') ? 'code' : 'chat')
    const next = value ?? !this.isShown(p)
    if (p === 'sidebar') this.togglePanel('sidebar', next)
    else if (p === 'agents') this.togglePanel('right', next)
    else if (p === 'activity') this.togglePanel('activity', next)
    else if (p === 'terminal') this.togglePanel('bottom', next)
    else if (p === 'web' && next !== this.state.web.open) this.toggleWeb()
  }

  toggleFold(p: DockPanel) {
    this.set((s) => ({ folded: s.folded.includes(p) ? s.folded.filter((x) => x !== p) : [...s.folded, p] }))
  }

  setDock(dock: DockNode) {
    this.set({ dock })
    rememberDock(dock)
  }

  // dónde está cada panel y cuáles se ven, para guardarlo como diseño
  currentLayout(): { dock: DockNode; show: LayoutShow } {
    const s = this.state
    return { dock: s.dock, show: { sidebar: s.panels.sidebar, terminal: s.panels.bottom, web: s.web.open, agents: s.panels.right, activity: s.panels.activity, code: s.layout === 'code' } }
  }

  applyLayout(l: { dock: unknown; show: LayoutShow }) {
    const dock = upgradeDock(l.dock)
    if (!dock) return
    this.setDock(dock)
    this.set((s) => ({ panels: { sidebar: l.show.sidebar, right: l.show.agents, activity: l.show.activity ?? l.show.agents, bottom: s.panels.bottom }, layout: l.show.code ? 'code' : 'chat' }))
    this.toggleDock('terminal', l.show.terminal)
    this.toggleDock('web', l.show.web)
  }

  resetDock() {
    this.setDock(defaultDock())
  }

  setLayout(layout: 'chat' | 'code') {
    this.set({ layout })
  }

  // ---------- visor web ----------

  // Abre el visor; con una URL, la muestra (reutiliza la pestaña si ya está abierta)
  openWeb(url?: string) {
    // en una ventana de panel no hay visor: se abre en la ventana principal
    if (this.secondary) return void (url && api.panel.openWeb(this.id, url).catch(() => {}))
    this.set((s) => {
      const w = s.web
      if (!url || !isWebUrl(url)) {
        if (w.tabs.length) return { web: { ...w, open: true, active: w.active ?? w.tabs[0].id } }
        const t = { id: uid(), url: 'about:blank' }
        return { web: { open: true, tabs: [t], active: t.id } }
      }
      const same = w.tabs.find((t) => t.url === url || t.url === url + '/')
      if (same) return { web: { ...w, open: true, active: same.id } }
      const t = { id: uid(), url }
      return { web: { open: true, tabs: [...w.tabs, t], active: t.id } }
    })
  }

  toggleWeb() {
    if (this.state.web.open) this.set((s) => ({ web: { ...s.web, open: false } }))
    else this.openWeb()
  }

  addWebTab(url = 'about:blank') {
    const t = { id: uid(), url: isWebUrl(url) ? url : 'about:blank' }
    this.set((s) => ({ web: { open: true, tabs: [...s.web.tabs, t], active: t.id } }))
  }

  selectWebTab(id: string) {
    this.set((s) => ({ web: { ...s.web, active: id } }))
  }

  // cerrar la última pestaña cierra el visor
  closeWebTab(id: string) {
    this.set((s) => {
      const i = s.web.tabs.findIndex((t) => t.id === id)
      const tabs = s.web.tabs.filter((t) => t.id !== id)
      const active = s.web.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.web.active
      return { web: { open: tabs.length > 0 && s.web.open, tabs, active } }
    })
  }

  updateWebTab(id: string, patch: Partial<Omit<WebTab, 'id'>>) {
    this.set((s) => ({ web: { ...s.web, tabs: s.web.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) } }))
  }

  // ---------- terminales ----------

  private makeTerminal(): TerminalTab {
    const n = this.state.terminals.length + 1
    return { id: `t-${uid()}`, title: `zsh ${n}`, cwd: this.state.workspace }
  }

  newTerminal() {
    const t = this.makeTerminal()
    this.set((s) => ({ terminals: [...s.terminals, t], bottomTab: t.id, panels: { ...s.panels, bottom: true } }))
  }

  devScripts(): Promise<DevScript[]> {
    return api.devScripts(this.state.workspace).catch(() => [])
  }

  // Arranca un script de desarrollo en su propia terminal (o enseña la que ya lo tiene)
  async runDevServer(name?: string) {
    const scripts = await this.devScripts()
    const s = name ? scripts.find((x) => x.name === name) : scripts[0]
    if (!s) return toast('No encuentro un script de desarrollo en package.json (dev, start, serve…)', 'error')
    const running = this.state.terminals.find((t) => t.dev === s.name)
    if (running) return this.set((st) => ({ bottomTab: running.id, panels: { ...st.panels, bottom: true } }))
    const t: TerminalTab = { id: `t-${uid()}`, title: s.name, cwd: this.state.workspace, dev: s.name }
    this.set((st) => ({ terminals: [...st.terminals, t], bottomTab: t.id, panels: { ...st.panels, bottom: true } }))
  }

  closeTerminal(id: string) {
    this.set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      return { terminals, bottomTab: s.bottomTab === id ? (terminals.at(-1)?.id ?? 'log') : s.bottomTab }
    })
  }

  // ---------- pestañas del editor ----------

  openTab(tab: Tab) {
    this.set((s) => {
      const existing = s.tabs.find((t) => t.id === tab.id)
      const tabs = existing ? s.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...s.tabs, tab]
      return { tabs, activeTab: tab.id }
    })
  }

  openFile = (path: string, line?: number) => this.openTab({ id: `file:${path}`, kind: 'file', path, title: basename(path), line })

  openDiff = (cwd: string, rel: string, mode: 'unstaged' | 'staged' | 'head') => {
    const label = mode === 'staged' ? 'preparado' : mode === 'head' ? 'vs HEAD' : 'cambios'
    this.openTab({ id: `diff:${mode}:${cwd}:${rel}`, kind: 'diff', cwd, rel, mode, title: `${basename(rel)} (${label})` })
  }

  openCommit = (cwd: string, hash: string, subject: string) =>
    this.openTab({ id: `commit:${hash}`, kind: 'commit', cwd, hash, title: `${hash.slice(0, 7)} ${subject}`.slice(0, 40) })

  closeTab = (id: string) => {
    this.set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTab = s.activeTab === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTab
      return { tabs, activeTab }
    })
  }

  setDirty(path: string, dirty: boolean) {
    if (!!this.state.dirty[path] !== dirty) this.set((s) => ({ dirty: { ...s.dirty, [path]: dirty } }))
  }

  // Ficheros del workspace (relativos) para ⌘P y menciones @; se invalida con cambios en disco
  async fileList(): Promise<string[]> {
    const { workspace: ws, repos, fsTick } = this.state
    if (this.filesCache && this.filesCache.ws === ws && this.filesCache.tick === fsTick) return this.filesCache.list
    const lists = await Promise.all(
      (repos.length ? repos : [ws]).map((r) =>
        api.git
          .listFiles(r)
          .then((l) => l.map((f) => relPath(ws, `${r}/${f}`)))
          .catch(() => [] as string[])
      )
    )
    const list = [...new Set(lists.flat())]
    this.filesCache = { tick: fsTick, ws, list }
    return list
  }

  // ---------- git ----------

  async setWorkspace(path: string) {
    this.set({ workspace: path, tabs: [], activeTab: null, dirty: {} })
    if (!this.secondary) await api.watch(this.id, path).catch(() => {})
    await this.discoverRepos()
    this.set((s) => ({ fsTick: s.fsTick + 1 }))
  }

  async discoverRepos() {
    const ws = this.state.workspace
    const repos = await api.git.findRepos(ws).catch(() => [] as string[])
    const cur = this.state.repo
    const repo = cur && repos.includes(cur) ? cur : repos.includes(ws) ? ws : (repos[0] ?? ws)
    this.set({ repos, repo })
    await this.refreshGit()
  }

  setRepo = (path: string) => {
    this.set((s) => ({ repo: path, git: s.repoStatus[path] ?? null }))
    this.refreshGit()
  }

  async addRepoToProject(path: string) {
    const s = getApp().settings
    if (!s) return
    if (!path.startsWith(this.root + '/') && path !== this.root) {
      const extra = { ...(s.extraRepos ?? {}) }
      extra[this.root] = [...new Set([...(extra[this.root] ?? []), path])]
      await saveSettings({ extraRepos: extra })
    }
    await this.discoverRepos()
    this.setRepo(path)
  }

  async removeRepoFromProject(path: string) {
    const s = getApp().settings
    if (!s) return
    const extra = { ...(s.extraRepos ?? {}) }
    extra[this.root] = (extra[this.root] ?? []).filter((p) => p !== path)
    await saveSettings({ extraRepos: extra })
    await this.discoverRepos()
  }

  // Repositorio que contiene una ruta absoluta (el más profundo)
  repoFor = (path: string): string => {
    const { repos, repo, workspace } = this.state
    const match = repos.filter((r) => path === r || path.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0]
    return match ?? repo ?? workspace
  }

  refreshGit = async () => {
    const { repos, workspace } = this.state
    const list = repos.length ? repos : [workspace]
    const statuses = await Promise.all(list.map((r) => api.git.status(r).catch(() => null)))
    const repoStatus: Record<string, GitStatus> = {}
    list.forEach((r, i) => {
      if (statuses[i]) repoStatus[r] = statuses[i]!
    })
    const repo = this.state.repo ?? list[0]
    this.set((s) => ({ repoStatus, git: repoStatus[repo] ?? { isRepo: false, ahead: 0, behind: 0, files: [] }, gitTick: s.gitTick + 1 }))
    setChanges(this.id, Object.values(repoStatus).reduce((n, st) => n + st.files.length, 0))
  }

  onFsChanged(paths: string[]) {
    this.set((s) => ({ changed: paths, fsTick: s.fsTick + 1 }))
    clearTimeout(this.gitTimer)
    this.gitTimer = setTimeout(this.refreshGit, 250)
  }

  // ---------- conversaciones ----------

  async newSession(agent: AgentId, opts: Omit<SessionCreate, 'agent'> = {}): Promise<string | undefined> {
    const meta = await attempt(() => api.sessions.create(this.id, { agent, cwd: opts.cwd ?? this.state.workspace, ...opts }))
    if (!meta) return undefined
    this.set((s) => ({ sessions: { ...s.sessions, [meta.id]: { ...meta, items: [] } }, active: { ...s.active, [agent]: meta.id } }))
    return meta.id
  }

  async updateSession(id: string, patch: SessionPatch) {
    const meta = await attempt(() => api.sessions.update(id, patch))
    if (meta) this.upsertSession(meta)
  }

  async deleteSession(id: string) {
    if (!(await attempt(() => api.sessions.remove(id).then(() => true)))) return
    this.set((st) => {
      const s = st.sessions[id]
      const sessions = { ...st.sessions }
      delete sessions[id]
      const active = { ...st.active }
      if (s && active[s.agent] === id) delete active[s.agent]
      return { sessions, active }
    })
  }

  async loadMessages(id: string) {
    const s = this.state.sessions[id]
    if (!s || s.items || s.loading) return
    this.patchSession(id, { loading: true })
    try {
      const items = await api.sessions.messages(id)
      this.patchSession(id, { items, loading: false })
    } catch (e) {
      this.patchSession(id, { loading: false, items: [] })
      toast(errMsg(e), 'error')
    }
  }

  // Ir a una conversación desde fuera del chat (tarjetas de agentes, actividad, ejecuciones, paleta). «Ambos» es su
  // propio tipo de conversación: una sesión que vive dentro de un hilo de Ambos abre ese hilo, y la de una tarea
  // del equipo, su hilo con el panel de la tarea; nunca se abre como si fuera una conversación suelta del agente.
  focusSession = (id: string) => {
    const s = this.state.sessions[id]
    if (!s) return
    if (s.threadId && this.state.threads[s.threadId]) return this.focusThread(s.threadId)
    if (s.orchestrationId) {
      const threadId = this.state.orchs[s.orchestrationId]?.threadId
      if (threadId && this.state.threads[threadId]) this.focusThread(threadId)
      else this.set({ agentView: 'auto' })
      this.set({ drawer: id })
      this.loadMessages(id)
      return
    }
    this.set((st) => ({ active: { ...st.active, [s.agent]: id }, agentView: st.agentView === 'both' ? 'both' : s.agent }))
    this.loadMessages(id)
  }

  private patchSession(id: string, patch: Partial<SessionView>) {
    this.set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id], ...patch } } } : {}))
  }

  private contextBlock(): string {
    if (!this.state.includeContext) return ''
    const tab = this.state.tabs.find((t) => t.id === this.state.activeTab)
    if (!tab || tab.kind !== 'file') return ''
    const rel = relPath(this.state.workspace, tab.path)
    const sel = this.editorRef.current?.path === tab.path ? this.editorRef.current.getSelection() : null
    if (sel && sel.text.trim()) return `<contexto>\nFichero abierto: ${rel} (líneas ${sel.from}-${sel.to} seleccionadas)\n\`\`\`\n${sel.text}\n\`\`\`\n</contexto>`
    return `<contexto>Fichero abierto en el editor: ${rel}</contexto>`
  }

  async sendPrompt(sessionId: string, prompt: string, withContext = true, images?: string[]) {
    const s = this.state.sessions[sessionId]
    if (!s || !prompt.trim()) return
    if (!s.items) await this.loadMessages(sessionId)
    this.patchSession(sessionId, { running: true })
    try {
      await api.sessions.send(sessionId, prompt, withContext ? this.contextBlock() || undefined : undefined, images)
    } catch (e) {
      if (!s.running) this.patchSession(sessionId, { running: false })
      toast(errMsg(e), 'error')
    }
  }

  // Envía a la conversación activa del agente (o crea una nueva si no hay o está ocupada)
  async ask(agent: AgentId, prompt: string, opts: { fresh?: boolean; cwd?: string; withContext?: boolean; images?: string[] } = {}) {
    let id = opts.fresh ? undefined : this.state.active[agent]
    if (!id || this.state.sessions[id]?.running) id = await this.newSession(agent, opts.cwd ? { cwd: opts.cwd } : {})
    if (id) await this.sendPrompt(id, prompt, opts.withContext ?? true, opts.images)
    return id
  }

  // La misma tarea a los dos agentes. "@claude …" o "@codex …" al principio la envía solo a uno.
  async sendToBoth(prompt: string, isolate: boolean, images?: string[]) {
    const m = prompt.match(/^@(claude|codex)\b\s*/i)
    const agents: AgentId[] = m ? [m[1].toLowerCase() as AgentId] : ['claude', 'codex']
    const text = m ? prompt.slice(m[0].length) : prompt
    const ctx = this.contextBlock()
    const ids: string[] = []
    for (const agent of agents) {
      let id: string | undefined
      if (isolate) {
        const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
        const wt = await attempt(() => api.git.addWorktree(this.state.repo ?? this.state.workspace, `${agent}-${stamp}`))
        if (!wt) return
        id = await this.newSession(agent, { cwd: wt.path, worktree: { path: wt.path, branch: wt.branch ?? '' } })
      } else {
        id = this.state.active[agent]
        if (!id || this.state.sessions[id]?.running) id = await this.newSession(agent)
      }
      if (id) ids.push(id)
    }
    await Promise.all(
      ids.map(async (id) => {
        this.patchSession(id, { running: true })
        await this.loadMessages(id)
        await api.sessions.send(id, text, ctx || undefined, images).catch((e) => {
          this.patchSession(id, { running: false })
          toast(errMsg(e), 'error')
        })
      })
    )
  }

  // Compactar: Claude resume lo hablado y sigue con menos contexto. En Ambos se compacta la parte de Claude; la de
  // Codex se compacta sola según Ajustes.
  compactSession = (sessionId: string) => attempt(() => api.sessions.compact(sessionId))
  compactThread = async (threadId: string) => {
    const t = this.state.threads[threadId]
    const sid = t?.sessions.claude
    if (!sid) return toast('En esta conversación no ha hablado Claude: Codex compacta solo su parte (Ajustes → Agentes)', 'info')
    await this.compactSession(sid)
    if (t.sessions.codex) toast('Compactando la parte de Claude. Codex compacta la suya solo, según Ajustes → Agentes', 'info')
  }

  cancelSession = (sessionId: string) => {
    api.sessions.cancel(sessionId).catch((e) => toast(errMsg(e), 'error'))
  }

  // ---------- chat único (Ambos) ----------

  loadThread(id: string) {
    const t = this.state.threads[id]
    if (!t) return
    for (const sid of Object.values(t.sessions)) if (sid) this.loadMessages(sid)
  }

  async newThread(): Promise<string | undefined> {
    const t = await attempt(() => api.threads.create(this.id))
    if (!t) return undefined
    this.set((s) => ({ threads: { ...s.threads, [t.id]: t }, activeThread: t.id, agentView: s.agentView === 'both' ? 'both' : 'auto' }))
    return t.id
  }

  focusThread = (id: string) => {
    this.set((s) => ({ activeThread: id, agentView: 'auto', drawer: null }))
    this.loadThread(id)
  }

  async renameThread(id: string, title: string) {
    const t = await attempt(() => api.threads.rename(id, title))
    if (t) this.upsertThread(t)
  }

  async deleteThread(id: string) {
    if (!(await attempt(() => api.threads.remove(id).then(() => true)))) return
    this.set((s) => {
      const threads = { ...s.threads }
      delete threads[id]
      return { threads, activeThread: s.activeThread === id ? (Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null) : s.activeThread }
    })
  }

  upsertThread(t: ThreadMeta) {
    this.set((s) => ({ threads: { ...s.threads, [t.id]: t } }))
    // las sesiones nuevas del hilo se cargan para verlas en el chat único
    for (const sid of Object.values(t.sessions)) if (sid && this.state.sessions[sid] && !this.state.sessions[sid].items) this.loadMessages(sid)
  }

  // Envía desde el chat único: el motor decide el agente (o lo fija el usuario) o arranca el equipo
  async sendUnified(
    text: string,
    target: Target,
    images?: string[],
    models?: Partial<Record<AgentId, string>>,
    efforts?: Partial<Record<AgentId, string>>,
    opts: { separate?: boolean } = {}
  ): Promise<RouteDecision | undefined> {
    let id = this.state.activeThread
    if (id && !this.state.threads[id]) id = null
    // «tarea aparte»: conversación nueva, sin tocar lo que está haciendo la actual
    if (opts.separate) id = null
    if (target === 'team') {
      id ??= (await this.newThread()) ?? null
      if (!id) return undefined
      await this.startTeam(text, this.state.teamMode, id)
      return undefined
    }
    // el mensaje se ve ya, con su indicador; el motor decide mientras tanto
    const p: PendingSend = { id: uid(), threadId: id, text, images: images?.length ? images : undefined, at: Date.now() }
    let failed = false
    const drop = () => {
      if (!failed) this.set((s) => ({ pending: s.pending.filter((x) => x.id !== p.id) }))
    }
    // con el agente trabajando va directo a la cola (aparece allí al momento): sin línea provisional
    const sessions = id ? this.state.threads[id]?.sessions : undefined
    const running = (a: AgentId) => !!(sessions?.[a] && this.state.sessions[sessions[a]!]?.running)
    const busy = target === 'auto' ? running('claude') || running('codex') : running(target)
    if (!busy) this.set((s) => ({ pending: [...s.pending, p] }))
    try {
      id ??= (await this.newThread()) ?? null
      if (!id) return undefined
      const tid = id
      p.threadId = tid
      this.set((s) => ({ pending: s.pending.map((x) => (x.id === p.id ? { ...x, threadId: tid } : x)) }))
      const context = this.contextBlock() || undefined
      const r = await api.threads.send(id, text, { agent: target === 'auto' ? undefined : target, context, images, models, efforts })
      return r.decision
    } catch (e) {
      failed = true
      this.set((s) => ({ pending: s.pending.map((x) => x.id === p.id ? { ...x, error: errMsg(e) } : x) }))
      toast(errMsg(e), 'error')
      return undefined
    } finally {
      drop()
    }
  }

  // ---------- cola ----------

  async enqueue(target: { sessionId?: string; threadId?: string }, prompt: string, images?: string[]) {
    await attempt(() => api.queue.add({ projectId: this.id, ...target, prompt, context: this.contextBlock() || undefined, images }))
  }

  removeQueued = (id: string) => attempt(() => api.queue.remove(id))
  updateQueued = (id: string, prompt: string) => attempt(() => api.queue.update(id, prompt))
  // «Enviar ya»: añade información al turno activo sin detenerlo.
  // «Al otro agente»: lo atiende el que no está trabajando (o se le añade a su turno si también trabaja).
  sendQueuedNow = async (id: string, to: 'current' | 'other' = 'current') => {
    const q = this.state.queue.find((x) => x.id === id)
    if (!q) return
    await attempt(() => api.queue.sendNow(id, to))
  }

  setQueue(items: QueuedMessage[]) {
    this.set({ queue: items })
  }

  // ---------- equipo (orquestador) ----------

  async startTeam(request: string, mode: OrchMode, threadId?: string) {
    const s = getApp().settings
    const req: OrchStart = {
      request,
      mode,
      options: { maxRounds: s?.orchMaxRounds ?? 2, approvePlan: s?.orchApprovePlan ?? true, parallel: s?.orchParallel ?? 2, implementer: s?.defaultAgent }
    }
    const o = await attempt(() => api.orch.start(this.id, req, threadId))
    if (o) this.upsertOrch(o)
    return o
  }

  upsertOrch(o: Orchestration) {
    const prev = this.state.orchs[o.id]
    this.set((s) => ({ orchs: { ...s.orchs, [o.id]: o } }))
    if (prev && prev.status !== o.status && ['awaiting_plan', 'awaiting_approval', 'needs_user'].includes(o.status)) {
      const text = o.status === 'awaiting_plan' ? 'El plan del equipo está listo para tu aprobación' : o.status === 'awaiting_approval' ? 'El equipo ha terminado: revisa y aprueba los cambios' : 'El equipo necesita tu ayuda'
      toast(text, 'info')
    }
  }

  approvePlan = (id: string, tasks?: PlanTask[]) => attempt(() => api.orch.approvePlan(id, tasks))
  cancelOrch = (id: string) => attempt(() => api.orch.cancel(id))
  resumeOrch = (id: string) => attempt(() => api.orch.resume(id))
  discardOrch = (id: string) => attempt(() => api.orch.discard(id))
  cleanupOrch = (id: string) => attempt(() => api.orch.cleanup(id), 'Worktrees eliminados')

  async integrateOrch(id: string, opts: { candidate?: AgentId; strategy: 'squash' | 'merge' }) {
    const ok = await attempt(() => api.orch.integrate(id, opts).then(() => true))
    if (ok) {
      await this.refreshGit()
      this.set((s) => ({ fsTick: s.fsTick + 1 }))
    }
  }

  openRefDiff = (cwd: string, rel: string, from: string, to: string) =>
    this.openTab({ id: `refdiff:${from}:${to}:${rel}`, kind: 'refdiff', cwd, rel, from, to, title: `${basename(rel)} (propuesta)` })

  // ---------- eventos del proceso principal ----------

  upsertSession(meta: SessionMeta) {
    this.set((st) => ({ sessions: { ...st.sessions, [meta.id]: { ...st.sessions[meta.id], ...meta } } }))
  }

  applyItems(sessionId: string, upserts: ChatItem[]) {
    const s = this.state.sessions[sessionId]
    if (!s) return
    if (s.items) {
      const items = s.items.slice()
      for (const it of upserts) {
        let idx = -1
        for (let i = items.length - 1; i >= 0; i--)
          if (items[i].id === it.id) {
            idx = i
            break
          }
        if (idx >= 0) items[idx] = it
        else items.push(it)
      }
      this.patchSession(sessionId, { items, updatedAt: Date.now() })
    }
    this.trackActivity(s, upserts)
  }

  onRun(run: RunInfo) {
    const prev = this.state.runs.find((r) => r.id === run.id)
    this.set((st) => ({ runs: [run, ...st.runs.filter((r) => r.id !== run.id)].slice(0, 50) }))
    // un aviso tardío de un turno ya terminado (p. ej. con su punto de control) no toca el turno que corre ahora
    const cur = this.state.sessions[run.sessionId]?.runId
    if (run.status !== 'running' && (!cur || cur === run.id)) this.patchSession(run.sessionId, { running: false, runId: undefined })
    const startKey = `run:${run.id}`
    if (run.status === 'running') {
      const id = uid()
      this.activityIndex.set(startKey, id)
      this.pushActivity({ ...runEntry(run, run.startedAt, true), id })
      return
    }
    // una actualización de un turno ya terminado (p. ej. su punto de control) no es un evento nuevo
    if (prev && prev.status !== 'running') return
    // la entrada de inicio deja de mostrarse como "en curso"
    const startId = this.activityIndex.get(startKey)
    if (startId) this.set((st) => ({ activity: st.activity.map((a) => (a.id === startId ? { ...a, status: 'done' } : a)) }))
    this.pushActivity({ ...runEntry(run, Date.now(), false), id: uid() })
    setTimeout(this.refreshGit, 100)
  }

  private pushActivity(e: ActivityEntry) {
    this.set((st) => ({ activity: [e, ...st.activity].slice(0, 200) }))
  }

  // Línea de tiempo de lo que hacen los agentes, a partir de eventos reales
  private trackActivity(s: SessionMeta, items: ChatItem[]) {
    for (const it of items) {
      let entry: Omit<ActivityEntry, 'id'> | null = null
      if (it.type === 'tool') entry = { at: it.at ?? Date.now(), agent: s.agent, sessionId: s.id, kind: 'tool', text: toolName(it.name), detail: it.input, status: it.status }
      else if (it.type === 'files')
        entry = { at: it.at ?? Date.now(), agent: s.agent, sessionId: s.id, kind: 'files', text: `${it.files.length} fichero${it.files.length === 1 ? '' : 's'} modificado${it.files.length === 1 ? '' : 's'}`, detail: it.files.map((f) => basename(f.path)).join(', '), status: 'done' }
      else if (it.type === 'error') entry = { at: it.at ?? Date.now(), agent: s.agent, sessionId: s.id, kind: 'error', text: 'Error', detail: it.text.split('\n')[0], status: 'error' }
      else if (it.type === 'permission')
        entry = { at: it.at ?? Date.now(), agent: s.agent, sessionId: s.id, kind: 'permission', text: 'Permiso denegado', detail: it.denials.map((d) => d.tool).join(', '), status: 'error' }
      if (!entry) continue
      const existing = this.activityIndex.get(it.id)
      if (existing) {
        const e = entry
        this.set((st) => ({ activity: st.activity.map((a) => (a.id === existing ? { ...a, ...e } : a)) }))
      } else {
        const id = uid()
        this.activityIndex.set(it.id, id)
        this.pushActivity({ id, ...entry })
      }
    }
  }
}

function runEntry(run: RunInfo, at: number, start: boolean): Omit<ActivityEntry, 'id'> {
  const name = AGENT_NAMES[run.agent]
  const text = start
    ? `${name} empezó a trabajar`
    : run.status === 'completed'
      ? `${name} terminó`
      : run.status === 'cancelled'
        ? `${name} se detuvo`
        : run.status === 'interrupted'
          ? `${name}: ejecución interrumpida`
          : `${name} falló`
  const status = start ? 'running' : run.status === 'completed' ? 'done' : 'error'
  return { at, agent: run.agent, sessionId: run.sessionId, kind: 'run', text, detail: run.sessionTitle, status }
}

// ---------- React ----------

const Ctx = createContext<ProjectStore | null>(null)
export const ProjectProvider = Ctx.Provider

// el proyecto, si lo hay (p. ej. Ajustes se ve fuera de cualquier proyecto)
export const useOptionalPS = (): ProjectStore | null => useContext(Ctx)

export function usePS(): ProjectStore {
  const ps = useContext(Ctx)
  if (!ps) throw new Error('usePS fuera de un proyecto')
  return ps
}

export function useStore<T>(sel: (s: ProjectState) => T): T {
  const ps = usePS()
  return useSyncExternalStore(ps.subscribe, () => sel(ps.state))
}
