export type AgentId = 'claude' | 'codex'
export const AGENTS: AgentId[] = ['claude', 'codex']
export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' }

// ---------- proyectos ----------

export interface ProjectMeta {
  id: string
  path: string
  name: string
  color: string
  gitRoot: string | null
  createdAt: number
  lastOpenedAt: number
  isOpen: boolean
  tabOrder: number
  pinned: boolean
  exists: boolean
}

export interface ProjectPatch {
  name?: string
  color?: string
  pinned?: boolean
}

// ---------- límites y consumo ----------

export interface LimitWindow {
  label: string
  usedPercent: number
  resetsAt?: number // epoch seconds
}

export interface AgentLimits {
  agent: AgentId
  windows: LimitWindow[]
  status?: string
  plan?: string
  updatedAt: number
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens?: number
  costUsd?: number
  durationMs?: number
  numTurns?: number
}

export interface SessionTotals {
  input: number
  output: number
  cached: number
  cost: number
  turns: number
  ms: number
}

export const emptyTotals = (): SessionTotals => ({ input: 0, output: 0, cached: 0, cost: 0, turns: 0, ms: 0 })

// ---------- eventos de los CLI (normalizados) ----------

export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string; streaming?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: string; status: 'running' | 'done' | 'error'; output?: string }
  | { kind: 'files'; id: string; files: { path: string; change: string }[] }
  | { kind: 'todo'; items: { text: string; done: boolean }[] }
  | { kind: 'usage'; usage: TurnUsage }
  | { kind: 'limits'; limits: AgentLimits }
  | { kind: 'permission'; denials: { tool: string; input: string }[] }
  | { kind: 'structured'; data: unknown }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }

// ---------- conversación ----------

export type ChatItem =
  | { id: string; type: 'user'; text: string; context?: string; route?: RouteDecision; images?: string[]; at: number }
  | { id: string; type: 'assistant'; text: string; streaming?: boolean; at?: number }
  | { id: string; type: 'thinking'; text: string; at?: number }
  | { id: string; type: 'tool'; toolId: string; name: string; input: string; status: 'running' | 'done' | 'error'; output?: string; at?: number }
  | { id: string; type: 'files'; files: { path: string; change: string }[]; at?: number }
  | { id: string; type: 'todo'; items: { text: string; done: boolean }[]; at?: number }
  | { id: string; type: 'usage'; usage: TurnUsage; at?: number }
  | { id: string; type: 'permission'; denials: { tool: string; input: string }[]; at?: number }
  | { id: string; type: 'notice'; text: string; at?: number }
  | { id: string; type: 'error'; text: string; at?: number }

export type ClaudeMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'manual'
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type Permission = ClaudeMode | CodexSandbox

export const UNRESTRICTED: Permission[] = ['bypassPermissions', 'danger-full-access']

export interface SessionMeta {
  id: string
  projectId: string
  agent: AgentId
  title: string
  cwd: string
  agentSessionId?: string
  model?: string
  effort?: string
  permission?: Permission
  worktree?: { path: string; branch: string }
  totals: SessionTotals
  createdAt: number
  updatedAt: number
  messageCount: number
  running: boolean
  runId?: string
  threadId?: string
  orchestrationId?: string
}

export interface QueuedMessage {
  id: string
  projectId: string
  sessionId?: string
  threadId?: string
  prompt: string
  context?: string
  agent?: AgentId
  images?: string[]
  createdAt: number
}

// Hilo del chat único (Auto): una conversación que el motor reparte entre los dos agentes
export interface ThreadMeta {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  sessions: Partial<Record<AgentId, string>>
}

// Tipos de tarea del enrutado: los de serie y los que añada el usuario (Ajustes → Motor de enrutado)
export type BuiltinCategory = 'plan' | 'explain' | 'implement' | 'debug' | 'tests' | 'review' | 'frontend' | 'terminal'
export type RouteCategory = string
// nombre que se ve y descripción que lee Jev para decidir (puede estar en español)
export interface RouteCategoryDef {
  id: RouteCategory
  label: string
  description: string
}

// Jev (modelo local de decisiones) para el enrutado
export type JevState = 'unsupported' | 'missing' | 'installing' | 'stopped' | 'starting' | 'ready' | 'error'
export interface JevStatus {
  state: JevState
  release: string
  source: string
  installed: boolean
  progress?: { label: string; done: number; total: number }
  error?: string
  // última decisión: cuánto tardó
  lastMs?: number
}

export interface JevTest {
  ms: number
  category?: RouteCategory
  confidence?: number
  probabilities: Partial<Record<RouteCategory, number>>
  followUp?: number
  tier?: ModelTier
  tierConfidence?: number
}

export interface RouteDecision {
  agent: AgentId
  reason: string
  method: 'manual' | 'mention' | 'rules' | 'ai' | 'jev'
  category?: RouteCategory
  // modelo del turno: elegido por dificultad o fijado en la conversación
  model?: string
  tier?: ModelTier
  // razonamiento del turno: automático (medio salvo que Jev vea clara la dificultad) o fijado en la conversación
  effort?: string
  // seguridad de Jev en la dificultad (0–1), para ver por qué subió o no el razonamiento
  tierConfidence?: number
}

// Dificultad estimada de un mensaje: decide qué modelo de cada agente lo atiende
export type ModelTier = 'hard' | 'easy'

export interface AgentModelPolicy {
  // modelos que el enrutado puede elegir
  allowed: string[]
  hard: string
  easy: string
}

export interface ModelPolicy {
  // en el chat único, elegir el modelo de cada mensaje según su dificultad
  auto: boolean
  // y el razonamiento: medio por defecto, alto o bajo solo si Jev lo ve claro (sin el campo: activado)
  autoEffort?: boolean
  claude: AgentModelPolicy
  codex: AgentModelPolicy
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  auto: true,
  autoEffort: true,
  claude: { allowed: ['claude-opus-5-5', 'claude-sonnet-5-5'], hard: 'claude-opus-5-5', easy: 'claude-sonnet-5-5' },
  codex: { allowed: ['gpt-6.1-sol', 'gpt-6.1-terra'], hard: 'gpt-6.1-sol', easy: 'gpt-6.1-terra' }
}

// Actualización de un CLI: la app compara la versión instalada con la publicada y, si hay una nueva, la instala
export type CliUpdateState = 'checking' | 'current' | 'available' | 'waiting' | 'updating' | 'updated' | 'behind' | 'manual' | 'missing' | 'error'
export interface CliUpdate {
  agent: AgentId
  state: CliUpdateState
  installed?: string
  latest?: string
  // con qué se actualiza: Homebrew, npm o el propio CLI
  method?: string
  message?: string
  checkedAt?: number
}

// Actualización de Ambidex: se compila desde un clon de GitHub; al abrir se trae lo último, se recompila y se instala al reiniciar
export type AppUpdateState = 'off' | 'idle' | 'checking' | 'current' | 'pulling' | 'building' | 'ready' | 'blocked' | 'error'
export interface AppUpdate {
  state: AppUpdateState
  // versión que se instalará y commits nuevos
  version?: string
  commits?: number
  from?: string
  to?: string
  message?: string
  // carpeta del clon
  source?: string
  checkedAt?: number
}

export interface SessionCreate {
  agent: AgentId
  cwd?: string
  worktree?: { path: string; branch: string }
  model?: string
  effort?: string
  permission?: Permission
  title?: string
  threadId?: string
  orchestrationId?: string
}

export interface SessionPatch {
  title?: string
  model?: string
  effort?: string
  permission?: Permission
}

export interface SearchHit {
  sessionId: string
  title: string
  agent: AgentId
  snippet: string
  updatedAt: number
}

// ---------- ejecuciones ----------

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface RunInfo {
  id: string
  sessionId: string
  projectId: string
  agent: AgentId
  status: RunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  error?: string
  pid?: number
  sessionTitle?: string
  // se puede deshacer lo que cambió en los ficheros (hay fotos de antes y después y no son iguales)
  undo?: 'available' | 'done'
}

// Lo que haría deshacer un turno en cada fichero que tocó
export interface UndoFile {
  path: string
  action: 'restore' | 'delete' | 'conflict'
}

export interface RunLogLine {
  at: number
  stream: 'stderr' | 'event' | 'system'
  line: string
}

// ---------- agentes ----------

export interface AgentAuth {
  loggedIn: boolean
  method?: string
  account?: string
  plan?: string
  org?: string
  detail?: string
  checkedAt: number
}

export interface AgentModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort?: string
  // el catálogo lo oculta (modelos internos de Codex)
  hidden?: boolean
}

export interface AgentInfo {
  agent: AgentId
  path?: string
  version?: string
  auth?: AgentAuth
  models: AgentModel[]
  // modelo que se usará cuando la conversación no fija ninguno
  effectiveDefaultModel?: string
  warnings: string[]
}

// ---------- git ----------

export interface GitFileStatus {
  path: string
  origPath?: string
  index: string // X
  worktree: string // Y
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  isRepo: boolean
  // operación a medias en el repositorio
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export interface GitCommit {
  hash: string
  short: string
  parents: string[]
  author: string
  email: string
  date: number
  subject: string
  refs: string[]
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
  upstream?: string
  lastCommit: number
}

export interface GitWorktree {
  path: string
  branch?: string
  head: string
  main: boolean
}

export interface CommitDetail {
  hash: string
  parents: string[]
  author: string
  email: string
  date: number
  committer: string
  commitDate: number
  message: string
  files: { status: string; path: string; origPath?: string; add: number; del: number }[]
}

export interface GitLogEntry {
  at: number
  cwd: string
  args: string[]
  ms: number
  ok: boolean
  stderr: string
}

export interface GrepHit {
  path: string
  line: number
  column: number
  text: string
}

// ---------- ficheros ----------

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface FileContent {
  content: string
  binary: boolean
  tooLarge: boolean
}

// ---------- ajustes ----------

export type Theme = 'dark' | 'light' | 'system'

export interface Settings {
  claudePath?: string
  codexPath?: string
  claudeModel?: string
  codexModel?: string
  claudeEffort?: string
  codexEffort?: string
  claudeMode: ClaudeMode
  codexSandbox: CodexSandbox
  commitAgent: AgentId
  defaultAgent: AgentId
  stripApiKeys: boolean
  theme: Theme
  notifications: boolean
  activeProjectId?: string
  extraRepos?: Record<string, string[]>
  // motor de enrutado del chat único
  // rules: palabras clave · jev: modelo local de decisiones (jevos) · ai: Claude Haiku
  routerMode: 'rules' | 'ai' | 'jev'
  routePrefs: Record<RouteCategory, AgentId | 'any'>
  // tipos de tarea editados o añadidos (sin el campo: los de serie) y criterios de dificultad editados
  routeCategories?: RouteCategoryDef[]
  difficultyCriteria?: Partial<Record<ModelTier, string>>
  // qué modelos puede usar el enrutado y cuál para tareas difíciles o sencillas
  modelPolicy: ModelPolicy
  // instalar solas las versiones nuevas de los CLI
  autoUpdateClis: boolean
  // traer y compilar la última versión de Ambidex al abrir
  autoUpdateApp: boolean
  // orquestador (modo Equipo)
  orchMode: 'A' | 'B' | 'C' | 'D' | 'E'
  orchMaxRounds: number
  orchApprovePlan: boolean
  orchParallel: number
  worktreeDir?: string
  // Codex: red dentro del sandbox de escritura y búsqueda web
  codexNetwork: boolean
  // los dos agentes compactan su conversación al pasar de estos tokens de contexto (0: lo que decida cada CLI).
  // Es un único tope para que en Ambos los dos guarden la misma memoria y cualquiera pueda seguir el hilo
  autoCompact: number
  codexWebSearch: 'default' | 'live' | 'disabled'
  // los agentes pueden usar la pestaña Web del proyecto (abrir, leer, pulsar, escribir, capturar)
  agentWeb?: boolean
  // diseños de paneles guardados y prompts reutilizables (/nombre en el chat)
  layouts?: SavedLayout[]
  prompts?: SavedPrompt[]
}

export interface LayoutShow {
  sidebar: boolean
  terminal: boolean
  web: boolean
  agents: boolean
  // diseños guardados antes de este panel no lo tienen: se ve si se veían los agentes
  activity?: boolean
  code: boolean
}

export interface SavedLayout {
  name: string
  dock: unknown // árbol de paneles; el renderer lo valida antes de usarlo
  show: LayoutShow
}

// Una conversación de Claude Code o Codex empezada fuera de la app en la carpeta del proyecto
export interface ExternalSession {
  agent: AgentId
  id: string // id de sesión del CLI
  title: string
  updatedAt: number
  source: string // Terminal, VS Code, SDK…
  live?: boolean // sigue abierta en otro sitio
}

// Algo instalado o configurado en un CLI (solo para enseñarlo; sin secretos)
export interface ExtItem {
  kind: 'plugin' | 'skill' | 'agent' | 'command' | 'mcp' | 'hook' | 'instructions'
  name: string
  description?: string
  source: string // Usuario, Proyecto, Plugin X, Marketplace Y, Sistema
  path?: string
  enabled?: boolean
  detail?: string
}

export interface Extensions {
  claude: ExtItem[]
  codex: ExtItem[]
  errors: string[]
}

// algo que ha fallado en una página del visor: un error de la consola o una petición
export interface WebIssue {
  kind: 'console' | 'network'
  level: 'error' | 'warning'
  text: string
  source?: string
  at: number
}

// un script de package.json que arranca un servidor de desarrollo
export interface DevScript {
  name: string
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun'
  command: string
  script: string
}

export interface SavedPrompt {
  id: string
  name: string
  text: string
}

export const DEFAULT_PROMPTS: SavedPrompt[] = [
  { id: 'revisa', name: 'revisa', text: 'Revisa los cambios sin commitear: busca errores, casos sin cubrir y riesgos de seguridad. Dime qué arreglarías y por qué.' },
  { id: 'arregla', name: 'arregla', text: 'Ejecuta los tests y la comprobación de tipos del proyecto y arregla lo que falle.' },
  { id: 'tests', name: 'tests', text: 'Escribe tests para el código que acabamos de tocar y ejecútalos.' },
  { id: 'explica', name: 'explica', text: 'Explícame la arquitectura de este proyecto: las piezas principales, cómo se comunican y por dónde empezar.' },
  { id: 'plan', name: 'plan', text: 'Antes de tocar nada, propón un plan paso a paso para: ' }
]

export const DEFAULT_ROUTE_PREFS: Record<RouteCategory, AgentId | 'any'> = {
  plan: 'claude',
  explain: 'claude',
  frontend: 'claude',
  implement: 'any',
  debug: 'codex',
  tests: 'codex',
  review: 'codex',
  terminal: 'codex'
}

// Tope de contexto a partir del cual cada agente resume su conversación. Los modelos actuales admiten 500k–1M,
// pero cada paso (cada herramienta) relee todo el contexto: con 200k hay memoria de sobra para una tarea larga y
// el gasto por paso queda acotado.
export const DEFAULT_AUTO_COMPACT = 200_000

export const DEFAULT_SETTINGS: Settings = {
  claudeMode: 'acceptEdits',
  codexSandbox: 'workspace-write',
  commitAgent: 'claude',
  defaultAgent: 'claude',
  stripApiKeys: true,
  theme: 'dark',
  notifications: true,
  routerMode: 'rules',
  routePrefs: DEFAULT_ROUTE_PREFS,
  modelPolicy: DEFAULT_MODEL_POLICY,
  autoUpdateClis: true,
  autoUpdateApp: true,
  orchMode: 'C',
  orchMaxRounds: 2,
  orchApprovePlan: true,
  orchParallel: 2,
  codexNetwork: false,
  // 200k: memoria de sobra para trabajar sin que cada paso relea medio millón de tokens
  autoCompact: DEFAULT_AUTO_COMPACT,
  codexWebSearch: 'default'
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  dataDir: string
  dbPath: string
  dbSize: number
}

export interface NativeMenuItem {
  id?: string
  label?: string
  type?: 'separator' | 'normal' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  accelerator?: string
  submenu?: NativeMenuItem[]
}
