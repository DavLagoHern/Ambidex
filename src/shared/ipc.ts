import type {
  AgentId, AgentInfo, AgentLimits, AppInfo, AppUpdate, ChatItem, CliUpdate, JevStatus, JevTest, CommitDetail, DevScript, DirEntry, Extensions, ExternalSession, FileContent, GitBranch, GitCommit, GitLogEntry,
  GitStatus, GitWorktree, GrepHit, NativeMenuItem, ProjectMeta, ProjectPatch, QueuedMessage, RouteDecision, RunInfo, RunLogLine,
  SearchHit, SessionCreate, SessionMeta, SessionPatch, Settings, ThreadMeta, UndoFile, WebIssue
} from './types'
import type { FileChange, OrchStart, Orchestration, PlanTask } from './orchestrator'

// Contrato de las llamadas renderer → proceso principal. El preload expone un único `invoke`
// y ambos lados se tipan contra esta interfaz.
export interface IpcContract {
  'app:info': () => AppInfo
  'app:pickFolder': () => string | null
  'app:reveal': (path: string) => void
  'app:revealData': () => void
  'app:openExternal': (url: string) => void
  'app:openInVSCode': (path: string) => void
  'app:contextMenu': (items: NativeMenuItem[]) => string | null
  'app:confirm': (message: string, detail?: string, danger?: boolean) => boolean

  // visor web: abre una ventana flotante, la fija encima, o trae el icono de una página
  'web:popout': (url: string) => void
  'web:setOnTop': (on: boolean) => void
  'web:favicon': (url: string) => string | null
  // captura de una página del visor como imagen adjunta (solo de un visor de la ventana que la pide)
  'web:capture': (webContentsId: number) => { path: string; url: string }
  'web:active': (projectId: string, webContentsId: number | null) => void
  // el usuario quita a los agentes el control de la web del proyecto (hasta su próximo mensaje)
  'web:revokeAgent': (projectId: string) => void
  // sacar un panel (chat, terminal, editor, agentes) a su propia ventana, y lo que comparten las ventanas
  'panel:open': (projectId: string, panel: string) => void
  'panel:openWeb': (projectId: string, url: string) => void
  'panel:sync': (projectId: string, origin: string, patch: Record<string, unknown>) => void

  'settings:get': () => Settings
  'settings:save': (patch: Partial<Settings>) => Settings

  'projects:list': () => ProjectMeta[]
  'projects:open': (path: string) => ProjectMeta
  'projects:close': (id: string) => void
  'projects:update': (id: string, patch: ProjectPatch) => ProjectMeta
  'projects:reorder': (ids: string[]) => void
  'projects:forget': (id: string) => void
  'projects:getUi': (id: string) => unknown
  'projects:saveUi': (id: string, ui: unknown) => void

  'sessions:list': (projectId: string) => SessionMeta[]
  'sessions:create': (projectId: string, opts: SessionCreate) => SessionMeta
  'sessions:update': (id: string, patch: SessionPatch) => SessionMeta
  'sessions:delete': (id: string) => void
  'sessions:messages': (id: string) => ChatItem[]
  'sessions:search': (projectId: string, query: string) => SearchHit[]
  'sessions:send': (id: string, prompt: string, context?: string, images?: string[]) => { runId?: string; steered?: boolean; queued?: boolean }
  // deshacer lo que cambió un turno en los ficheros: primero qué pasaría, luego hacerlo (siempre lo pide el usuario)
  'runs:undoPreview': (runId: string) => { files: UndoFile[]; overlapping: number }
  'runs:undo': (runId: string) => { restored: string[]; deleted: string[]; skipped: string[] }
  'sessions:cancel': (id: string) => void
  // Claude Code: resume la conversación para seguir con menos contexto
  'sessions:compact': (id: string) => void
  'runs:recent': (projectId: string, limit: number) => RunInfo[]
  'runs:log': (runId: string) => RunLogLine[]

  'agents:info': (refresh: boolean) => AgentInfo[]
  'agents:limits': (refresh?: boolean) => Partial<Record<AgentId, AgentLimits>>
  'agents:oneShot': (agent: AgentId, cwd: string, prompt: string, stdin: string, model?: string) => string
  // versiones nuevas de los CLI: estado, comprobar ahora (instala si está activado) e instalar ya la de un agente
  'cli:updates': () => CliUpdate[]
  'cli:check': () => CliUpdate[]
  'cli:update': (agent: AgentId) => CliUpdate
  // versión nueva de Ambidex: estado, comprobar ahora y reiniciar para instalar la ya compilada
  'self:status': () => AppUpdate
  'self:check': () => AppUpdate
  'self:restart': () => void

  'fs:list': (dir: string) => DirEntry[]
  'fs:image': (path: string) => string
  'fs:read': (path: string) => FileContent
  'fs:write': (path: string, content: string) => void
  'fs:watch': (projectId: string, dir: string) => void
  'fs:unwatch': (projectId: string) => void

  'git:status': (cwd: string) => GitStatus
  'git:numstat': (cwd: string, staged: boolean) => Record<string, [number, number]>
  'git:stage': (cwd: string, paths: string[]) => void
  'git:unstage': (cwd: string, paths: string[]) => void
  'git:discard': (cwd: string, files: { path: string; untracked: boolean }[]) => void
  'git:show': (cwd: string, ref: string, path: string) => string
  'git:diffText': (cwd: string, staged: boolean) => string
  'git:commit': (cwd: string, message: string, amend: boolean) => string
  'git:lastMessage': (cwd: string) => string
  'git:log': (cwd: string, limit: number, skip: number, all: boolean) => GitCommit[]
  'git:commitDetail': (cwd: string, hash: string) => CommitDetail
  'git:commitPatch': (cwd: string, hash: string) => string
  'git:branches': (cwd: string) => GitBranch[]
  'git:checkout': (cwd: string, name: string, remote: boolean) => void
  'git:createBranch': (cwd: string, name: string, from?: string) => void
  'git:deleteBranch': (cwd: string, name: string, force: boolean) => void
  'git:fetch': (cwd: string) => void
  'git:pull': (cwd: string) => void
  'git:push': (cwd: string) => void
  'git:init': (cwd: string) => void
  'git:worktrees': (cwd: string) => GitWorktree[]
  'git:addWorktree': (cwd: string, name: string) => GitWorktree
  'git:removeWorktree': (cwd: string, path: string) => void
  'git:listFiles': (cwd: string) => string[]
  'git:grep': (cwd: string, query: string, regex: boolean, caseSensitive: boolean) => GrepHit[]
  'git:findRepos': (root: string) => string[]
  'git:addRepo': () => string | null
  'git:clone': (url: string) => string | null
  'git:run': (cwd: string, args: string[]) => string
  'git:remotes': (cwd: string) => { name: string; url: string }[]
  'git:tags': (cwd: string) => { name: string; subject: string }[]
  'git:stashes': (cwd: string) => { ref: string; subject: string; date: number }[]
  'git:output': () => GitLogEntry[]

  'threads:list': (projectId: string) => ThreadMeta[]
  'threads:create': (projectId: string) => ThreadMeta
  'threads:rename': (id: string, title: string) => ThreadMeta
  'threads:delete': (id: string) => void
  'threads:preview': (threadId: string | null, text: string) => RouteDecision

  // Jev: modelo local para el enrutado (instalar bajo demanda, probar, detener, eliminar)
  'jev:status': () => JevStatus
  'jev:install': () => Settings
  'jev:cancel': () => void
  'jev:stop': () => void
  'jev:remove': () => Settings
  'jev:test': (text: string) => JevTest
  // arrancar Jev en segundo plano (al abrir la app o al empezar a escribir) para que llegue a tiempo al enviar
  'jev:warm': () => void
  // models/efforts: modelo y razonamiento fijados por agente antes de que exista su conversación en el hilo
  'threads:send': (
    threadId: string,
    text: string,
    opts: { agent?: AgentId; context?: string; images?: string[]; models?: Partial<Record<AgentId, string>>; efforts?: Partial<Record<AgentId, string>> }
  ) => { decision?: RouteDecision; sessionId?: string; queued?: boolean; steered?: boolean }

  'queue:list': (projectId: string) => QueuedMessage[]
  'queue:add': (m: { projectId: string; sessionId?: string; threadId?: string; prompt: string; context?: string; images?: string[] }) => QueuedMessage
  // imágenes adjuntas: se guardan en la carpeta de la app y se leen como data URL para enseñarlas
  'attachments:save': (data: Uint8Array, mime: string) => string
  'attachments:read': (path: string) => string
  'queue:remove': (id: string) => void
  'queue:update': (id: string, prompt: string) => void
  // añade al turno en curso sin cancelarlo
  'queue:sendNow': (id: string, to?: 'current' | 'other') => 'sent'

  'orch:list': (projectId: string) => Orchestration[]
  'orch:get': (id: string) => Orchestration | undefined
  'orch:start': (projectId: string, req: OrchStart, threadId?: string) => Orchestration
  'orch:approvePlan': (id: string, tasks?: PlanTask[]) => void
  'orch:cancel': (id: string) => void
  'orch:resume': (id: string) => void
  'orch:integrate': (id: string, opts: { candidate?: AgentId; strategy: 'squash' | 'merge' }) => void
  'orch:discard': (id: string) => void
  'orch:cleanup': (id: string) => void
  'orch:changes': (id: string, candidate?: AgentId) => { files: FileChange[]; branch: string; base: string; cwd: string }

  'git:prInfo': (cwd: string) => { available: boolean; authed: boolean; url?: string; number?: number; state?: string; defaultBranch?: string }
  'git:createPR': (cwd: string, pr: { title: string; body: string; base?: string; draft: boolean }) => string
  'git:commitsSince': (cwd: string, base: string) => string[]

  // dev: nombre de un script de package.json que se ejecuta nada más abrir la terminal
  // si la terminal ya existe (p. ej. la abre otra ventana) se engancha a ella y devuelve lo último que mostró
  'term:create': (id: string, opts: { cwd: string; login?: AgentId; dev?: string }) => { buffer?: string }
  'project:devScripts': (dir: string) => DevScript[]
  // plugins, skills, subagentes, comandos, MCP, hooks e instrucciones de cada CLI (y los del proyecto)
  'extensions:list': (projectRoot?: string) => Extensions
  // conversaciones del proyecto empezadas fuera de la app: verlas y continuarlas aquí
  'external:list': (projectId: string) => ExternalSession[]
  'external:read': (projectId: string, agent: AgentId, id: string) => ChatItem[]
  'external:import': (projectId: string, agent: AgentId, id: string) => SessionMeta
  // leer un .md de una extensión (skills, agentes, comandos, instrucciones) o enseñar un fichero en Finder
  'extensions:read': (path: string) => string
  'extensions:reveal': (path: string) => void
  'term:write': (id: string, data: string) => void
  'term:resize': (id: string, cols: number, rows: number) => void
  'term:kill': (id: string) => void
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<K extends IpcChannel> = Parameters<IpcContract[K]>
export type IpcResult<K extends IpcChannel> = ReturnType<IpcContract[K]>
// canales cuyo manejador necesita saber qué ventana llama
export type SenderChannel = 'web:popout' | 'web:setOnTop' | 'web:favicon' | 'web:capture' | 'web:active'

// Eventos proceso principal → renderer
export interface PushContract {
  'session:items': { projectId: string; sessionId: string; items: ChatItem[] }
  'session:meta': SessionMeta
  'run:status': RunInfo
  limits: AgentLimits
  'fs:changed': { projectId: string; paths: string[] }
  'term:data': { id: string; data: string }
  'term:exit': { id: string; code: number }
  menu: { command: string }
  'focus-project': { projectId: string; sessionId?: string }
  'thread:meta': ThreadMeta
  'queue:changed': { projectId: string; items: QueuedMessage[] }
  'orch:update': Orchestration
  'open-path': { path: string }
  // desde una página del visor: abrir un enlace en pestaña nueva, o un atajo de teclado (⌘L, ⌘T…)
  'web:open': { url: string; from: number }
  'web:key': { from: number; key: string; shift: boolean }
  'web:issue': { from: number; issue: WebIssue }
  // un agente abre la web del proyecto o la está usando
  'web:agent-open': { projectId: string; url: string }
  'web:agent': { projectId: string; agent: AgentId; action: string }
  'panel:closed': { projectId: string; panel: string }
  // cambios de estado que se reflejan en todas las ventanas de un proyecto (las terminales)
  'panel:sync': { projectId: string; origin: string; patch: Record<string, unknown> }
  'jev:status': JevStatus
  'cli:update': CliUpdate
  'self:update': AppUpdate
}

export type PushChannel = keyof PushContract
