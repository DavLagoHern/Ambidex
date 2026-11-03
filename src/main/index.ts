import { fetchAccountLimits } from './agents/usage-limits'
import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, nativeImage, nativeTheme, Notification, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentId, AgentInfo, AgentLimits, NativeMenuItem, Settings } from '@shared/types'
import { AGENT_NAMES, DEFAULT_MODEL_POLICY } from '@shared/types'
import { openDatabase, type DB } from './db/database'
import { Store } from './db/store'
import { claudeAdapter } from './agents/claude'
import { codexDefaultModel, codexHome, CodexModels, createCodexAdapter, latestCodexLimits, readCodexModels } from './agents/codex'
import { detectAgents, loginCommand, resolveBin } from './agents/detect'
import { agentEnv, binVersion, loadShellPath, run } from './agents/env'
import { oneShot } from './agents/oneshot'
import { SessionService } from './agents/service'
import { Dispatcher } from './agents/dispatcher'
import { claudeChannel, CliUpdater } from './agents/updates'
import { AppUpdater, type Exec } from './app-update'
import { difficultyCriteria, pickModel, routeCategories } from '@shared/router'
import { Orchestrator } from './orchestrator/engine'
import * as files from './files'
import * as gitApi from './git'
import * as github from './github'
import { Handlers, registerHandlers } from './ipc'
import { logger } from './logger'
import { checkExternalUrl, checkGitArgs, PathGuard } from './security'
import * as term from './terminal'
import { checkImage, imageDataUrl, saveImage } from './attachments'
import { snapshot, undo, undoPlan } from './checkpoints'
import { detectDevScripts } from './devserver'
import { scanExtensions } from './extensions'
import { claudeSessions, claudeTranscript, codexSessions, codexTranscript, isClaudeLive } from './external-sessions'
import { openProjectTab, pageIssues, projectTab, setupWeb, webSenderHandlers } from './web'
import { agentMcpArgs, createWebAgent, WEB_TOKEN_ENV } from './web-agent'
import { Jev } from './jev'
import { APP_HOME, dbFile, legacyUserData } from './paths'

loadShellPath()
delete process.env.ELECTRON_RUN_AS_NODE
app.setName('Ambidex')
// los tests E2E usan un directorio de datos aislado; una instalación antigua («Code AI») conserva el suyo
const legacyData = legacyUserData(app.getPath('appData'))
if (process.env.AMBIDEX_USER_DATA) app.setPath('userData', process.env.AMBIDEX_USER_DATA)
else if (legacyData) app.setPath('userData', legacyData)
// una sola instancia por directorio de datos: una segunda apertura enfoca la ventana existente
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return app.isReady() && createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

let win: BrowserWindow | null = null
let db: DB
let store: Store
let service: SessionService
let dispatcher: Dispatcher
let orchestrator: Orchestrator
let jev: Jev
let updater: CliUpdater
let appUpdater: AppUpdater
// «Reiniciar» en el aviso de versión nueva: tras instalarla, se vuelve a abrir
let reopenAfterUpdate = false
// herramientas MCP para que los agentes usen la pestaña Web de su proyecto
const webAgent = createWebAgent({
  tab: projectTab,
  open: openProjectTab,
  issues: pageIssues,
  activity: (ctx, action) => push('web:agent', { projectId: ctx.projectId, agent: ctx.agent, action })
})
let agentInfo: AgentInfo[] = []
let quitting = false
// carpetas que macOS pide abrir (arrastradas al icono del Dock o "Abrir con") antes de que haya ventana
const pendingOpen: string[] = []

const settings = (): Settings => store.getSettings()
const childEnv = () => agentEnv(process.env, { stripApiKeys: settings().stripApiKeys })

// lo que se puede leer o enseñar de las extensiones: las carpetas de los CLI y los proyectos abiertos
const extGuard = new PathGuard(() => [join(homedir(), '.claude'), codexHome(), join(homedir(), '.claude.json'), ...store.listProjects().map((p) => p.path)])

function externalTranscript(projectId: string, agent: AgentId, id: string) {
  const p = store.getProject(projectId)
  if (!p) throw new Error('Proyecto no encontrado')
  return agent === 'claude' ? claudeTranscript(homedir(), p.path, id) : codexTranscript(codexHome(), p.path, id)
}

// una ejecución que se puede deshacer: tiene fotos de antes y de después y aún no se ha deshecho
function undoable(runId: string) {
  const c = store.checkpoint(runId)
  if (!c?.before || !c.after) throw new Error('Este turno no tiene punto de control (la carpeta no es un repositorio de Git)')
  if (c.undoneAt) throw new Error('Este turno ya se deshizo')
  return { ...c, before: c.before, after: c.after }
}

// imágenes adjuntas a los mensajes (y capturas de la web)
const attachmentsDir = () => join(app.getPath('userData'), 'attachments')

// Los avisos llegan a todas las ventanas de la app (la principal y los paneles sacados a otra ventana);
// cada una escucha solo los que le interesan
function push<K extends PushChannel>(channel: K, payload: PushContract[K]) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && isAppUrl(w.webContents.getURL())) w.webContents.send(channel, payload)
}

// Jev tarda ~4 s en arrancar y al enviar solo se le esperan 3: se despierta antes (al abrir y al escribir), sin preguntar nada
function warmJev() {
  if (settings().routerMode !== 'jev' || !jev?.installed()) return
  jev.ensure().catch((e) => logger.warn('jev.warm', { error: (e as Error).message }))
}

// ---------- actualización de Ambidex ----------

// carpeta del clon desde el que se compiló (solo en la app instalada: en desarrollo no se actualiza sola)
const SOURCE = app.isPackaged && !process.env.AMBIDEX_USER_DATA ? __AMBIDEX_SOURCE__ : undefined
const updateLog = () => {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'update.log')
}

// git/npm en el clon, con la salida en logs/update.log; npm a prioridad baja para no frenar el trabajo
function sourceExec(file: string, args: string[], timeout: number): Promise<Exec> {
  return new Promise((resolve) => {
    const out = createWriteStream(updateLog(), { flags: 'a' })
    out.write(`\n[${new Date().toISOString()}] $ ${file} ${args.join(' ')}\n`)
    let stdout = ''
    let stderr = ''
    const done = (code: number) => {
      clearTimeout(timer)
      out.end()
      resolve({ code, stdout, stderr })
    }
    const p = spawn(file, args, { cwd: SOURCE, env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' } })
    const timer = setTimeout(() => p.kill('SIGTERM'), timeout)
    p.stdout.on('data', (d) => {
      const t = String(d)
      if (stdout.length < 1_000_000) stdout += t
      out.write(t)
    })
    p.stderr.on('data', (d) => {
      const t = String(d)
      stderr = (stderr + t).slice(-4000)
      out.write(t)
    })
    p.on('error', (e) => ((stderr += e.message), done(1)))
    p.on('close', (code) => done(code ?? 1))
  })
}

// Al salir con una versión ya compilada: el instalador del clon espera a que se cierre la app, la reemplaza en
// /Applications y (si se pidió con «Reiniciar») la vuelve a abrir. Va suelto para sobrevivir a la app.
function installUpdate() {
  if (!SOURCE || appUpdater?.status().state !== 'ready' || (!reopenAfterUpdate && settings().autoUpdateApp === false)) return
  try {
    const log = openSync(updateLog(), 'a')
    const p = spawn('node', ['scripts/install-app.mjs'], {
      cwd: SOURCE,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...childEnv(), AMBIDEX_NO_OPEN: reopenAfterUpdate ? '' : '1' }
    })
    p.unref()
    logger.info('app.update.install', { reopen: reopenAfterUpdate })
  } catch (e) {
    logger.error('app.update.install', { error: (e as Error).message })
  }
}

// ---------- paneles en otra ventana ----------

const POPOUT_PANELS = ['chat', 'terminal', 'editor', 'agents', 'activity']
const panelWins = new Map<string, BrowserWindow>()

function openPanelWindow(projectId: string, panel: string) {
  if (!POPOUT_PANELS.includes(panel) || !store.getProject(projectId)) throw new Error('Ese panel no se puede sacar a otra ventana')
  const key = `${projectId}:${panel}`
  const open = panelWins.get(key)
  if (open && !open.isDestroyed()) return open.focus()
  const w = new BrowserWindow({
    width: panel === 'agents' || panel === 'activity' ? 420 : 980,
    height: 680,
    minWidth: 360,
    minHeight: 260,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#f6f6f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: windowPrefs()
  })
  panelWins.set(key, w)
  w.once('ready-to-show', () => w.show())
  w.webContents.setWindowOpenHandler(({ url }) => {
    try {
      shell.openExternal(checkExternalUrl(url))
    } catch {
      /* protocolo no permitido */
    }
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, u) => u !== w.webContents.getURL() && e.preventDefault())
  // al cerrarla, el panel vuelve a la ventana principal
  w.on('closed', () => {
    panelWins.delete(key)
    push('panel:closed', { projectId, panel })
  })
  loadRenderer(w, `panel=${panel}&project=${encodeURIComponent(projectId)}`)
}

// ---------- rutas permitidas ----------

const worktreeBase = () => settings().worktreeDir || gitApi.WORKTREE_BASE

const guard = new PathGuard(() => {
  const roots = new Set<string>([gitApi.WORKTREE_BASE, worktreeBase()])
  const extra = settings().extraRepos ?? {}
  for (const p of store.listProjects()) {
    roots.add(p.path)
    if (p.gitRoot) roots.add(p.gitRoot)
    for (const r of extra[p.path] ?? []) roots.add(r)
  }
  return [...roots]
})

// ---------- agentes ----------

// catálogo de modelos de Codex para la versión instalada del CLI (se obtiene al detectar)
let codexModels: CodexModels | undefined
const codexDefault = () => codexDefaultModel(codexModels ?? readCodexModels()).model

async function refreshAgents(): Promise<AgentInfo[]> {
  const r = await detectAgents(settings(), childEnv())
  agentInfo = r.agents
  if (r.codexModels) codexModels = r.codexModels
  for (const a of agentInfo) logger.info('agent.detected', { agent: a.agent, path: a.path, version: a.version, loggedIn: a.auth?.loggedIn, warnings: a.warnings })
  return agentInfo
}

// un agente está disponible si está instalado y con sesión (antes de detectar se asume que sí)
const available = (agent: AgentId) => {
  const i = agentInfo.find((a) => a.agent === agent)
  return !i || (!!i.path && i.auth?.loggedIn !== false)
}

function updateDockBadge() {
  const n = service?.runningCount() ?? 0
  app.dock?.setBadge(n ? String(n) : '')
}

function notifyFinished(run: Parameters<NonNullable<ConstructorParameters<typeof SessionService>[0]['onFinished']>>[0]) {
  updateDockBadge()
  const s = settings()
  if (!s.notifications || !Notification.isSupported()) return
  const focused = win?.isFocused() && s.activeProjectId === run.projectId
  if (focused) return
  const project = store.getProject(run.projectId)
  const verb = run.status === 'completed' ? 'ha terminado' : run.status === 'cancelled' ? 'se ha detenido' : 'ha fallado'
  const n = new Notification({
    title: `${AGENT_NAMES[run.agent]} ${verb}`,
    subtitle: project?.name,
    body: run.sessionTitle ?? '',
    silent: run.status === 'completed'
  })
  n.on('click', () => {
    win?.show()
    win?.focus()
    push('focus-project', { projectId: run.projectId, sessionId: run.sessionId })
  })
  n.show()
}

// ---------- ventana ----------

function createWindow() {
  const bounds = store.kvGet<{ x: number; y: number; width: number; height: number }>('window')
  win = new BrowserWindow({
    width: bounds?.width ?? 1600,
    height: bounds?.height ?? 1000,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Ambidex',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#f6f6f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: { ...windowPrefs(), webviewTag: true }
  })
  win.once('ready-to-show', () => win?.show())
  const saveBounds = () => win && !win.isDestroyed() && !win.isFullScreen() && store.kvSet('window', win.getBounds())
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)
  win.on('focus', updateDockBadge)

  // la ventana nunca navega fuera de la app; los enlaces se abren en el navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      shell.openExternal(checkExternalUrl(url))
    } catch {
      /* protocolo no permitido */
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })

  win.webContents.on('did-finish-load', () => {
    for (const path of pendingOpen.splice(0)) push('open-path', { path })
  })

  loadRenderer(win)
}

function windowPrefs(): Electron.WebPreferences {
  return { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
}

function loadRenderer(w: BrowserWindow, hash?: string) {
  if (process.env.ELECTRON_RENDERER_URL) w.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
  else w.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

// Carpeta soltada en el icono del Dock o abierta con "Abrir con Ambidex"
app.on('open-file', (e, path) => {
  e.preventDefault()
  if (!existsSync(path) || !statSync(path).isDirectory()) return
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) push('open-path', { path })
  else pendingOpen.push(path)
})

function isTrusted(e: Electron.IpcMainInvokeEvent) {
  return isAppUrl(e.senderFrame?.url ?? '')
}

function isAppUrl(url: string) {
  const dev = process.env.ELECTRON_RENDERER_URL
  return !!(dev && url.startsWith(dev)) || url.startsWith('file://')
}

// ---------- menú ----------

function buildMenu() {
  const cmd = (command: string) => () => push('menu', { command })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Ambidex',
      submenu: [
        { role: 'about', label: 'Acerca de Ambidex' },
        { type: 'separator' },
        { label: 'Ajustes…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'services', label: 'Servicios' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Ambidex' },
        { role: 'hideOthers', label: 'Ocultar otros' },
        { role: 'unhide', label: 'Mostrar todo' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir de Ambidex' }
      ]
    },
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir proyecto…', accelerator: 'CmdOrCtrl+O', click: cmd('open-project') },
        { label: 'Proyectos…', accelerator: 'CmdOrCtrl+Shift+O', click: cmd('projects') },
        { type: 'separator' },
        { label: 'Nueva conversación', accelerator: 'CmdOrCtrl+N', click: cmd('new-chat') },
        { label: 'Nueva terminal', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('new-terminal') },
        { type: 'separator' },
        { label: 'Cerrar pestaña de proyecto', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('close-project') }
      ]
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'pasteAndMatchStyle', label: 'Pegar con el mismo estilo' },
        { role: 'delete', label: 'Eliminar' },
        { role: 'selectAll', label: 'Seleccionar todo' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Paleta de comandos   ⌘K', click: cmd('palette') },
        { label: 'Ir a fichero   ⌘P', click: cmd('quick-open') },
        { type: 'separator' },
        { label: 'Barra lateral', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
        { label: 'Agentes', accelerator: 'CmdOrCtrl+Alt+B', click: cmd('toggle-right') },
        { label: 'Actividad', click: cmd('toggle-activity') },
        { label: 'Terminal', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-bottom') },
        { label: 'Restablecer diseño', click: cmd('reset-layout') },
        { label: 'Alternar chat / código', accelerator: 'CmdOrCtrl+E', click: cmd('toggle-layout') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño real' },
        { role: 'zoomIn', label: 'Ampliar' },
        { role: 'zoomOut', label: 'Reducir' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Ventana',
      submenu: [
        { label: 'Proyecto siguiente', accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next-project') },
        { label: 'Proyecto anterior', accelerator: 'CmdOrCtrl+Shift+[', click: cmd('prev-project') },
        { type: 'separator' },
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        { role: 'front', label: 'Traer todo al frente' }
      ]
    },
    {
      label: 'Ayuda',
      submenu: [{ label: 'Mostrar logs de la aplicación', click: () => logger.path && shell.showItemInFolder(logger.path) }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- handlers ----------

const g = (cwd: string) => guard.check(cwd, 'El repositorio')

function handlers(): Handlers {
  return {
    'app:info': () => {
      const dbPath = dbFile(app.getPath('userData'))
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        dataDir: app.getPath('userData'),
        dbPath,
        dbSize: existsSync(dbPath) ? statSync(dbPath).size : 0
      }
    },
    'app:pickFolder': async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Abrir proyecto' })
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    'app:reveal': (p) => shell.showItemInFolder(guard.check(p)),
    'app:revealData': () => shell.showItemInFolder(dbFile(app.getPath('userData'))),
    'app:openExternal': (url) => shell.openExternal(checkExternalUrl(url)),
    'app:openInVSCode': (p) =>
      new Promise<void>((resolve, reject) =>
        execFile('open', ['-a', 'Visual Studio Code', guard.check(p)], (err) => (err ? reject(new Error('No se pudo abrir VS Code')) : resolve()))
      ),
    'app:contextMenu': (items) =>
      new Promise<string | null>((resolve) => {
        let chosen: string | null = null
        const build = (list: NativeMenuItem[]): Electron.MenuItemConstructorOptions[] =>
          list.map((i) =>
            i.type === 'separator'
              ? { type: 'separator' as const }
              : i.submenu
                ? { label: i.label, enabled: i.enabled !== false && i.submenu.length > 0, submenu: build(i.submenu) }
                : {
                    label: i.label,
                    type: i.type === 'checkbox' ? ('checkbox' as const) : ('normal' as const),
                    checked: i.checked,
                    enabled: i.enabled !== false,
                    accelerator: i.accelerator,
                    registerAccelerator: false,
                    click: () => (chosen = i.id ?? null)
                  }
          )
        const menu = Menu.buildFromTemplate(build(items))
        menu.popup({ window: win!, callback: () => setTimeout(() => resolve(chosen), 0) })
      }),
    'app:confirm': async (message, detail, danger) => {
      const r = await dialog.showMessageBox(win!, {
        type: danger ? 'warning' : 'question',
        message,
        detail,
        buttons: [danger ? 'Continuar' : 'Aceptar', 'Cancelar'],
        defaultId: danger ? 1 : 0,
        cancelId: 1
      })
      return r.response === 0
    },

    'settings:get': () => settings(),
    'settings:save': async (patch) => {
      const prev = settings()
      const next = store.saveSettings(patch)
      if (patch.theme) nativeTheme.themeSource = next.theme
      if (patch.claudePath !== undefined || patch.codexPath !== undefined || patch.stripApiKeys !== prev.stripApiKeys) refreshAgents()
      if (patch.autoUpdateClis && !prev.autoUpdateClis) updater.check(true).catch(() => {})
      return next
    },

    'projects:list': () => store.listProjects().map((p) => ({ ...p, exists: existsSync(p.path) })),
    'projects:open': async (path) => {
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('La carpeta no existe')
      const root = await gitApi.repoRoot(path)
      const p = store.openProject(path, basename(path), root)
      store.audit(p.id, 'user', 'project.open', { path })
      return { ...p, exists: true }
    },
    'projects:close': (id) => {
      store.closeProject(id)
      files.unwatch(id)
    },
    'projects:update': (id, patch) => ({ ...store.updateProject(id, patch), exists: true }),
    'projects:reorder': (ids) => store.reorderProjects(ids),
    'projects:forget': (id) => {
      if (store.listSessions(id).some((s) => service.isRunning(s.id))) throw new Error('Hay agentes trabajando en este proyecto')
      store.audit(id, 'user', 'project.forget', {})
      store.forgetProject(id)
      files.unwatch(id)
    },
    'projects:getUi': (id) => store.getUi(id),
    'projects:saveUi': (id, ui) => store.saveUi(id, ui),

    'sessions:list': (projectId) => service.listSessions(projectId),
    'sessions:create': (projectId, opts) => {
      const p = store.getProject(projectId)
      if (!p) throw new Error('Proyecto no encontrado')
      const s = settings()
      const cwd = guard.check(opts.cwd || p.path, 'La carpeta de trabajo')
      return store.createSession(projectId, cwd, {
        ...opts,
        model: opts.model ?? (opts.agent === 'claude' ? s.claudeModel : s.codexModel),
        effort: opts.effort ?? (opts.agent === 'claude' ? s.claudeEffort : s.codexEffort),
        permission: opts.permission ?? (opts.agent === 'claude' ? s.claudeMode : s.codexSandbox)
      })
    },
    'sessions:update': (id, patch) => service.withRunState(store.updateSession(id, patch)),
    'sessions:delete': (id) => {
      if (service.isRunning(id)) throw new Error('Detén el agente antes de borrar la conversación')
      store.deleteSession(id)
    },
    'sessions:messages': (id) => store.messages(id),
    'sessions:search': (projectId, q) => (q.trim() ? store.search(projectId, q.trim()) : []),
    'sessions:send': async (id, prompt, context, images) => {
      if (service.isRunning(id)) {
        if (await service.steer(id, prompt, context, images)) return { steered: true }
        dispatcher.enqueue({ projectId: store.getSession(id)!.projectId, sessionId: id, prompt, context, images })
        // Puede haber terminado entre comprobar el estado y añadir el mensaje a la cola.
        if (!service.isRunning(id)) void dispatcher.onIdle(store.getSession(id)!)
        return { queued: true }
      }
      const { runId } = service.send(id, prompt, context, { images })
      updateDockBadge()
      return { runId }
    },
    'sessions:cancel': (id) => service.cancel(id),
    'sessions:compact': (id) => void service.compact(id),
    'runs:undoPreview': async (runId) => {
      const c = undoable(runId)
      const plan = await undoPlan(c.cwd, c.before, c.after)
      return { files: plan.files.map(({ path, action }) => ({ path, action })), overlapping: store.overlappingRuns(runId) }
    },
    'runs:undo': async (runId) => {
      const c = undoable(runId)
      const busy = store.runningRuns().find((r) => store.checkpoint(r.id)?.cwd === c.cwd)
      if (busy) throw new Error('Hay un agente trabajando en esa carpeta: espera a que termine para deshacer')
      const r = await undo(c.cwd, c.before, c.after)
      store.markUndone(runId)
      store.audit(c.projectId, 'user', 'agent.undo', { runId, restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length })
      const info = store.getRun(runId)
      if (info) push('run:status', info)
      return r
    },
    'runs:recent': (projectId, limit) => store.recentRuns(projectId, Math.min(limit, 200)),

    'threads:list': (projectId) => store.listThreads(projectId),
    'threads:create': (projectId) => dispatcher.createThread(projectId),
    'threads:rename': (id, title) => {
      const t = store.updateThread(id, { title })
      for (const sid of Object.values(t.sessions)) if (sid) store.updateSession(sid, { title: t.title })
      return t
    },
    'threads:delete': (id) => {
      const t = store.getThread(id)
      if (t && Object.values(t.sessions).some((sid) => sid && service.isRunning(sid))) throw new Error('Detén los agentes antes de borrar la conversación')
      store.deleteThread(id)
    },
    'threads:preview': (threadId, text) => dispatcher.preview(threadId, text),

    'jev:status': () => jev.status(),
    'jev:install': async () => {
      store.audit(null, 'user', 'jev.install', { release: jev.status().release, source: jev.status().source })
      await jev.install()
      // recién instalado, pasa a ser el enrutador
      store.saveSettings({ routerMode: 'jev' })
      jev.ensure().catch(() => {})
      return settings()
    },
    'jev:cancel': () => jev.cancelInstall(),
    'jev:stop': () => jev.stop(),
    'jev:remove': async () => {
      await jev.remove()
      if (settings().routerMode === 'jev') store.saveSettings({ routerMode: 'rules' })
      return settings()
    },
    'jev:warm': () => warmJev(),
    'jev:test': (text) => {
      const s = settings()
      return jev.test(text, { categories: Object.fromEntries(routeCategories(s).map((c) => [c.id, c.description.trim() || c.label])), difficultyCriteria: difficultyCriteria(s) })
    },
    'threads:send': async (threadId, text, opts) => {
      const r = await dispatcher.sendThread(threadId, text, opts)
      updateDockBadge()
      return { decision: r.decision, sessionId: r.sessionId, queued: !!r.queued, steered: !!r.steered }
    },

    'queue:list': (projectId) => store.listQueue(projectId),
    'queue:add': (m) => dispatcher.enqueue(m),
    'queue:remove': (id) => dispatcher.remove(id),
    'queue:update': (id, prompt) => dispatcher.update(id, prompt),
    'queue:sendNow': (id, to) => dispatcher.sendNow(id, to),

    'orch:list': (projectId) => orchestrator.list(projectId),
    'orch:get': (id) => orchestrator.get(id),
    'orch:start': async (projectId, req, threadId) => {
      const o = await orchestrator.start(projectId, req, threadId)
      // la petición al equipo da nombre a la conversación si aún no lo tiene
      const t = threadId ? store.getThread(threadId) : undefined
      if (t && t.title === 'Nueva conversación') push('thread:meta', store.updateThread(t.id, { title: req.request.split('\n')[0].slice(0, 60), updatedAt: Date.now() }))
      return o
    },
    'orch:approvePlan': (id, tasks) => orchestrator.approvePlan(id, tasks),
    'orch:cancel': (id) => orchestrator.cancel(id),
    'orch:resume': (id) => orchestrator.resume(id),
    'orch:integrate': (id, opts) => orchestrator.integrate(id, opts),
    'orch:discard': (id) => orchestrator.discard(id),
    'orch:cleanup': (id) => orchestrator.cleanup(id),
    'orch:changes': (id, candidate) => orchestrator.changes(id, candidate),
    'runs:log': (runId) => store.runLog(runId),

    'agents:info': (refresh) => (refresh || !agentInfo.length ? refreshAgents() : agentInfo),
    'agents:limits': async (refresh) => {
      const all: Partial<Record<AgentId, AgentLimits>> = store.getLimits()
      const codex = latestCodexLimits()
      if (codex && (!all.codex || codex.updatedAt > all.codex.updatedAt)) all.codex = codex
      if (refresh) {
        try {
          const bin = resolveBin('codex', settings())
          if (!bin) throw new Error('Codex no está instalado')
          all.codex = await fetchAccountLimits(bin, homedir(), childEnv())
          store.saveLimits(all.codex)
        } catch (error) {
          all.codex = { ...(all.codex ?? { agent: 'codex', windows: [], updatedAt: 0 }), refreshError: error instanceof Error ? error.message : String(error) }
        }
      }
      return all
    },
    'agents:oneShot': (agent, cwd, prompt, stdin, model) => {
      const bin = resolveBin(agent, settings())
      if (!bin) throw new Error(`No se encontró el CLI de ${AGENT_NAMES[agent]}`)
      // tareas cortas (mensaje de commit…): siempre el modelo más rápido y barato, nunca el que uses para programar
      const fast = agent === 'claude' ? 'haiku' : pickModel('codex', 'easy', settings().modelPolicy ?? DEFAULT_MODEL_POLICY, agentInfo.find((a) => a.agent === 'codex')?.models?.map((m) => m.id))?.model
      return oneShot({ agent, bin, cwd: guard.check(cwd), prompt, stdin, model: fast || model || (agent === 'codex' ? codexDefault() : undefined), env: childEnv() })
    },
    'cli:updates': () => updater.status(),
    'cli:check': () => updater.check(settings().autoUpdateClis !== false),
    'cli:update': (agent) => updater.checkOne(agent, true),
    'self:status': () => appUpdater.status(),
    'self:check': () => appUpdater.check(),
    'self:restart': () => {
      if (appUpdater.status().state !== 'ready') throw new Error('No hay ninguna versión nueva lista')
      reopenAfterUpdate = true
      app.quit()
    },

    'fs:list': (dir) => files.listDir(guard.check(dir)),
    'fs:read': (p) => files.readText(guard.check(p)),
    'fs:write': async (p, content) => {
      await files.writeText(guard.check(p), content)
      store.audit(null, 'user', 'file.write', { path: p, bytes: content.length })
    },
    'fs:watch': (projectId, dir) => files.watchDir(projectId, guard.check(dir), (paths) => push('fs:changed', { projectId, paths })),
    'fs:unwatch': (projectId) => files.unwatch(projectId),

    'git:status': (cwd) => gitApi.status(g(cwd)),
    'git:numstat': (cwd, staged) => gitApi.numstat(g(cwd), staged),
    'git:stage': async (cwd, paths) => void (await gitApi.stage(g(cwd), paths)),
    'git:unstage': async (cwd, paths) => void (await gitApi.unstage(g(cwd), paths)),
    'git:discard': async (cwd, list) => {
      await gitApi.discard(g(cwd), list)
      store.audit(null, 'user', 'git.discard', { cwd, files: list.map((f) => f.path) })
    },
    'git:show': (cwd, ref, path) => gitApi.showFile(g(cwd), ref, path),
    'git:diffText': (cwd, staged) => gitApi.diffText(g(cwd), staged),
    'git:commit': async (cwd, msg, amend) => {
      const out = await gitApi.commit(g(cwd), msg, amend)
      store.audit(null, 'user', 'git.commit', { cwd, amend })
      return out
    },
    'git:lastMessage': (cwd) => gitApi.lastCommitMessage(g(cwd)),
    'git:log': (cwd, limit, skip, all) => gitApi.log(g(cwd), limit, skip, all),
    'git:commitDetail': (cwd, hash) => gitApi.commitDetail(g(cwd), hash),
    'git:commitPatch': (cwd, hash) => gitApi.commitPatch(g(cwd), hash),
    'git:branches': (cwd) => gitApi.branches(g(cwd)),
    'git:checkout': async (cwd, name, remote) => void (await gitApi.checkout(g(cwd), name, remote)),
    'git:createBranch': async (cwd, name, from) => void (await gitApi.createBranch(g(cwd), name, from)),
    'git:deleteBranch': async (cwd, name, force) => {
      await gitApi.deleteBranch(g(cwd), name, force)
      store.audit(null, 'user', 'git.deleteBranch', { cwd, name, force })
    },
    'git:fetch': async (cwd) => void (await gitApi.fetch(g(cwd))),
    'git:pull': async (cwd) => {
      await gitApi.pull(g(cwd))
      store.audit(null, 'user', 'git.pull', { cwd })
    },
    'git:push': async (cwd) => {
      await gitApi.push(g(cwd))
      store.audit(null, 'user', 'git.push', { cwd })
    },
    'git:init': async (cwd) => void (await gitApi.init(g(cwd))),
    'git:worktrees': (cwd) => gitApi.worktrees(g(cwd)),
    'git:addWorktree': (cwd, name) => gitApi.addWorktree(g(cwd), name, worktreeBase()),
    'git:removeWorktree': async (cwd, path) => {
      await gitApi.removeWorktree(g(cwd), guard.check(path, 'El worktree'))
      store.audit(null, 'user', 'git.removeWorktree', { cwd, path })
    },
    'git:listFiles': (cwd) => gitApi.listFiles(g(cwd)),
    'git:grep': (cwd, q, regex, cs) => gitApi.grep(g(cwd), q, regex, cs),
    'git:findRepos': (root) => {
      const extra = (settings().extraRepos?.[root] ?? []).filter((p) => existsSync(p))
      return [...new Set([...gitApi.findRepos(g(root)), ...extra])]
    },
    'git:addRepo': async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Añadir repositorio', properties: ['openDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    },
    'git:clone': async (url) => {
      const r = await dialog.showOpenDialog(win!, { title: 'Carpeta donde clonar', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      const target = await gitApi.clone(url, r.filePaths[0])
      store.audit(null, 'user', 'git.clone', { url, target })
      return target
    },
    'git:run': async (cwd, args) => {
      const out = await gitApi.run(g(cwd), checkGitArgs(args))
      store.audit(null, 'user', 'git.run', { cwd, args })
      return out
    },
    'git:remotes': (cwd) => gitApi.remotes(g(cwd)),
    'git:tags': (cwd) => gitApi.tags(g(cwd)),
    'git:stashes': (cwd) => gitApi.stashes(g(cwd)),
    'git:output': () => gitApi.gitOutput(),
    'git:prInfo': (cwd) => github.prInfo(g(cwd)),
    'git:createPR': async (cwd, pr) => {
      const url = await github.createPR(g(cwd), pr)
      store.audit(null, 'user', 'git.createPR', { cwd, url })
      return url
    },
    'git:commitsSince': (cwd, base) => gitApi.commitsSince(g(cwd), base),

    'term:create': (id, o) => {
      if (!o.login && term.hasTerminal(id)) return { buffer: term.terminalBuffer(id) }
      const login = o.login ? loginCommand(o.login, settings()) : undefined
      if (o.login && !login) throw new Error(`No se encontró el CLI de ${AGENT_NAMES[o.login]}`)
      // en las terminales del usuario solo se limpian las variables de sesión; en el login también las claves API
      const env = agentEnv(process.env, { stripApiKeys: !!o.login })
      const cwd = o.login ? homedir() : guard.check(o.cwd, 'La carpeta de la terminal')
      // el servidor de desarrollo se teclea en la shell (sigue siendo interactiva: ⌃C la devuelve al prompt)
      const dev = o.dev && !o.login ? detectDevScripts(cwd).find((s) => s.name === o.dev) : undefined
      if (o.dev && !dev) throw new Error(`No hay ningún script «${o.dev}» en package.json`)
      // se teclea cuando la shell ya ha dicho algo (su prompt), para que no salga repetido antes de él
      let typeDev = dev?.command
      term.createTerminal(
        id,
        { cwd, env, command: login },
        (data) => {
          push('term:data', { id, data })
          if (typeDev) setTimeout((c: string) => term.writeTerminal(id, c + '\r'), 80, typeDev)
          typeDev = undefined
        },
        (code) => push('term:exit', { id, code })
      )
      if (o.login) store.audit(null, 'user', 'agent.login', { agent: o.login })
      return {}
    },
    'attachments:save': (data, mime) => saveImage(attachmentsDir(), data, mime),
    'attachments:read': (path) => imageDataUrl(attachmentsDir(), path),
    'panel:open': (projectId, panel) => openPanelWindow(projectId, panel),
    // un enlace en una ventana de panel se abre en la Web de la ventana principal
    'panel:openWeb': (projectId, url) => {
      if (win && !win.isDestroyed()) win.webContents.send('web:agent-open', { projectId, url })
    },
    'panel:sync': (projectId, origin, patch) => push('panel:sync', { projectId, origin, patch }),
    'web:revokeAgent': (projectId) => webAgent.revokeWhere((c) => c.projectId === projectId),
    'extensions:read': (p) => {
      const f = extGuard.check(p, 'El fichero')
      if (!f.endsWith('.md')) throw new Error('Solo se pueden leer aquí los .md (los ficheros de configuración pueden tener claves)')
      return readFileSync(f, 'utf8').slice(0, 200_000)
    },
    'extensions:reveal': (p) => shell.showItemInFolder(extGuard.check(p, 'El fichero')),
    'external:list': (projectId) => {
      const p = store.getProject(projectId)
      if (!p) return []
      // las que ya continúan en la app no se repiten
      const known = new Set(store.listSessions(projectId).map((s) => s.agentSessionId))
      return [...claudeSessions(homedir(), p.path), ...codexSessions(codexHome(), p.path)].filter((s) => !known.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    'external:read': (projectId, agent, id) => externalTranscript(projectId, agent, id),
    'external:import': (projectId, agent, id) => {
      const p = store.getProject(projectId)
      if (!p) throw new Error('Proyecto no encontrado')
      const ext = (agent === 'claude' ? claudeSessions(homedir(), p.path, 500) : codexSessions(codexHome(), p.path, 500)).find((s) => s.id === id)
      if (!ext) throw new Error('Esa conversación ya no existe')
      const items = externalTranscript(projectId, agent, id)
      const s = store.createSession(projectId, p.path, { agent, title: ext.title, permission: agent === 'claude' ? settings().claudeMode : settings().codexSandbox })
      store.updateSession(s.id, { agentSessionId: id, updatedAt: ext.updatedAt })
      items.forEach((it, i) => store.upsertMessage(s.id, i, null, it))
      store.upsertMessage(s.id, items.length, null, {
        id: randomUUID(),
        type: 'notice',
        text: `Conversación traída de ${ext.source}: lo que escribas aquí continúa la misma sesión de ${AGENT_NAMES[agent]}.`,
        at: Date.now()
      })
      store.audit(projectId, 'user', 'session.import', { agent, source: ext.source })
      const meta = service.getSession(s.id)!
      push('session:meta', meta)
      return meta
    },
    'extensions:list': (root) => scanExtensions(homedir(), codexHome(), root ? guard.check(root, 'La carpeta del proyecto') : undefined),
    'project:devScripts': (dir) => detectDevScripts(guard.check(dir, 'La carpeta del proyecto')),
    'term:write': (id, data) => term.writeTerminal(id, data),
    'term:resize': (id, c, r) => term.resizeTerminal(id, c, r),
    'term:kill': (id) => term.killTerminal(id)
  }
}

// ---------- ciclo de vida ----------

app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  logger.init(join(dataDir, 'logs'))
  try {
    db = openDatabase(dbFile(dataDir))
  } catch (e) {
    dialog.showErrorBox('Ambidex', `No se pudo abrir la base de datos local:\n${(e as Error).message}`)
    app.exit(1)
    return
  }
  store = new Store(db)
  nativeTheme.themeSource = settings().theme

  service = new SessionService({
    store,
    push,
    adapters: { claude: claudeAdapter, codex: createCodexAdapter() },
    resolveBin: (agent) => resolveBin(agent, settings()),
    env: childEnv,
    // se calcula al enviar (no depende de que haya terminado la detección del arranque)
    defaultModel: (agent) => (agent === 'codex' ? codexDefault() : undefined),
    checkImage: (p) => checkImage(attachmentsDir(), p),
    checkpoint: (cwd) => snapshot(cwd),
    // una sesión de Claude abierta en otra terminal no se continúa encima: se bifurca
    forkIfLive: (agent, id) => agent === 'claude' && isClaudeLive(homedir(), id),
    // la Web del proyecto como herramientas MCP del turno (la clave va por variable de entorno, no en los argumentos)
    tools: ({ projectId, runId, agent }) => {
      if (settings().agentWeb === false || !webAgent.started) return undefined
      const token = webAgent.grant({ projectId, runId, agent })
      return { ...agentMcpArgs(agent, webAgent.url), env: { [WEB_TOKEN_ENV]: token }, release: () => webAgent.revoke(token) }
    },
    // Claude Code compacta solo al llegar a este contexto (0: su ventana completa); Codex, por extraArgs
    agentEnv: (agent): Record<string, string> => {
      const n = settings().autoCompact
      return agent === 'claude' && n > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(n)) } : {}
    },
    onFinished: notifyFinished,
    onIdle: (s) => dispatcher.onIdle(s),
    extraArgs: (agent) => {
      const s = settings()
      if (agent !== 'codex') return []
      const extra: string[] = []
      if (s.codexNetwork) extra.push('-c', 'sandbox_workspace_write.network_access=true')
      if (s.autoCompact > 0) extra.push('-c', `model_auto_compact_token_limit=${Math.round(s.autoCompact)}`)
      if (s.codexWebSearch !== 'default') extra.push('-c', `web_search="${s.codexWebSearch}"`)
      return extra
    }
  })
  jev = new Jev({ dir: join(APP_HOME, 'jev'), onStatus: (s) => push('jev:status', s), log: (m, d) => logger.info(m, d) })
  dispatcher = new Dispatcher({
    store,
    service,
    push,
    settings,
    available,
    jev,
    models: (agent) => agentInfo.find((a) => a.agent === agent)?.models,
    // enrutado con IA: un modelo rápido, sin herramientas
    aiRoute: (prompt, cwd) => {
      const bin = resolveBin('claude', settings())
      if (!bin) return Promise.reject(new Error('Claude Code no encontrado'))
      return oneShot({ agent: 'claude', bin, cwd, prompt, stdin: '', model: 'haiku', env: childEnv() })
    }
  })
  orchestrator = new Orchestrator({ store, service, push, settings, worktreeBase, env: childEnv })
  updater = new CliUpdater({
    bin: (agent) => resolveBin(agent, settings()),
    version: binVersion,
    run: (file, args) => run(file, args, { env: { ...childEnv(), HOMEBREW_NO_ENV_HINTS: '1' }, timeout: 10 * 60_000 }),
    busy: (agent) => service.agentBusy(agent),
    onStatus: (s) => push('cli:update', s),
    // la versión nueva puede traer otros modelos (el catálogo de Codex depende de la versión del CLI)
    onUpdated: (agent, from, to) => {
      store.audit(null, 'system', 'cli.update', { agent, from, to })
      return refreshAgents()
    },
    log: (m, d) => logger.info(m, d),
    channel: (agent) => (agent === 'claude' ? claudeChannel() : 'latest')
  })
  // los E2E usan un directorio de datos aislado y CLI de prueba: ahí no se actualiza nada
  if (!process.env.AMBIDEX_USER_DATA) updater.start(() => settings().autoUpdateClis !== false)
  appUpdater = new AppUpdater({
    source: SOURCE,
    builtCommit: SOURCE ? __AMBIDEX_COMMIT__ || undefined : undefined,
    exists: existsSync,
    git: (args) => sourceExec('git', args, 2 * 60_000),
    npm: (args) => sourceExec('/usr/bin/nice', ['-n', '10', 'npm', ...args], 20 * 60_000),
    version: () => {
      try {
        return JSON.parse(readFileSync(join(SOURCE!, 'package.json'), 'utf8')).version
      } catch {
        return undefined
      }
    },
    onStatus: (s) => push('self:update', s),
    log: (m, d) => logger.info(m, d)
  })
  if (SOURCE) appUpdater.start(() => settings().autoUpdateApp !== false)
  const recovered = service.recoverInterrupted()
  const recoveredOrch = orchestrator.recover()
  logger.info('app.start', { version: app.getVersion(), recoveredRuns: recovered, recoveredOrchestrations: recoveredOrch })
  if (!app.isPackaged) {
    const icon = join(__dirname, '../../build/icon.png')
    if (existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon))
  }
  app.setAboutPanelOptions({ applicationName: 'Ambidex', applicationVersion: app.getVersion(), copyright: 'Claude Code + Codex, juntos.' })

  registerHandlers(handlers(), webSenderHandlers, isTrusted)
  setupWeb({ windowPrefs, loadRenderer, isTrusted: isAppUrl, attachmentsDir, openInProject: (projectId, url) => push('web:agent-open', { projectId, url }) })
  webAgent.start().catch((e) => logger.warn('web.agent.start', { error: String(e) }))
  buildMenu()
  createWindow()
  refreshAgents().catch((e) => logger.error('agent.detect', { error: (e as Error).message }))
  setTimeout(warmJev, 3000)

  // el Dock reabre la ventana principal aunque quede alguna ventana web flotante
  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow()
    else if (!win.isVisible()) win.show()
  })
})

app.on('before-quit', (e) => {
  if (quitting || !service) return
  const running = service.runningCount()
  if (running > 0) {
    const r = dialog.showMessageBoxSync(win ?? undefined!, {
      type: 'warning',
      message: running === 1 ? 'Hay un agente trabajando' : `Hay ${running} agentes trabajando`,
      detail: 'Si sales ahora se detendrán. El historial hasta este momento queda guardado.',
      buttons: ['Salir', 'Cancelar'],
      defaultId: 1,
      cancelId: 1
    })
    if (r !== 0) {
      reopenAfterUpdate = false
      return e.preventDefault()
    }
  }
  e.preventDefault()
  quitting = true
  updater?.stop()
  appUpdater?.stop()
  const timeout = new Promise((r) => setTimeout(r, 4000))
  Promise.race([Promise.all([service.cancelAll(), jev?.stop()]), timeout]).finally(() => {
    term.killAllTerminals()
    files.unwatchAll()
    try {
      db.close()
    } catch {
      /* ya cerrada */
    }
    logger.info('app.quit')
    installUpdate()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
