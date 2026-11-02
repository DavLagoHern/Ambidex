import {
  app, BrowserWindow, BrowserWindowConstructorOptions, clipboard, IpcMainInvokeEvent, Menu, MenuItemConstructorOptions, nativeTheme, session, shell, WebContents,
  webContents
} from 'electron'
import type { WebIssue } from '@shared/types'
import { WEB_PARTITION, isWebUrl } from '@shared/web'
import { saveImage } from './attachments'
import { checkExternalUrl } from './security'
import { logger } from './logger'

// Visor web integrado: <webview> aislado (sin preload, sin Node, sesión propia) dentro de la ventana de la app,
// y ventanas flotantes con el mismo visor.

interface WebDeps {
  windowPrefs: () => BrowserWindowConstructorOptions['webPreferences']
  loadRenderer: (w: BrowserWindow, hash: string) => void
  isTrusted: (url: string) => boolean
  attachmentsDir: () => string
  // pedir a la ventana principal que abra el visor de un proyecto (cuando un agente lo necesita)
  openInProject: (projectId: string, url: string) => void
}

let deps: WebDeps
const favicons = new Map<string, string | null>()

// Teclas que, con el foco dentro de una página, se reenvían al visor o a la app (⌘L, ⌘T, ⌘K…)
const FORWARD_KEYS = new Set(['l', 't', 'w', 'r', '[', ']', 'k', 'p', 'b', 'j', 'e'])

export function setupWeb(d: WebDeps) {
  deps = d
  const ses = session.fromPartition(WEB_PARTITION)
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  ses.setDevicePermissionHandler(() => false)
  // agente de usuario de Chrome normal: algunas webs sirven versiones peores a "Electron"
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ses.setUserAgent(ses.getUserAgent().replace(new RegExp(`\\s(?:Electron|${name})/\\S+`, 'g'), ''))
  // peticiones que fallan (4xx/5xx o error de red) de cada página
  const failed = (id: number | undefined, text: string, url: string) => {
    if (!id || /\/favicon\.ico(\?|$)/.test(url)) return
    const wc = webContents.fromId(id)
    if (wc && wc.getType() === 'webview') report(wc, { kind: 'network', level: 'error', text, source: url, at: Date.now() })
  }
  ses.webRequest.onCompleted((d) => d.statusCode >= 400 && failed(d.webContentsId, `${d.statusCode} ${d.method} ${d.url}`, d.url))
  ses.webRequest.onErrorOccurred((d) => d.error !== 'net::ERR_ABORTED' && failed(d.webContentsId, `${d.error} ${d.method} ${d.url}`, d.url))

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') guest(contents)
    else
      contents.on('will-attach-webview', (e, prefs, params) => {
        // la página nunca recibe preload, Node ni otra sesión, aunque el renderer lo pidiera
        delete prefs.preload
        prefs.nodeIntegration = false
        prefs.nodeIntegrationInSubFrames = false
        prefs.contextIsolation = true
        prefs.sandbox = true
        prefs.webSecurity = true
        prefs.allowRunningInsecureContent = false
        if (!deps.isTrusted(contents.getURL()) || params.partition !== WEB_PARTITION || !isWebUrl(params.src)) {
          logger.warn('web.attach.blocked', { src: params.src.slice(0, 200) })
          e.preventDefault()
        }
      })
  })
}

// Avisos de una página al visor que la aloja. Como mucho 20 por segundo: una página que falla en bucle no satura la app.
const budget = new WeakMap<WebContents, { second: number; n: number }>()
function report(contents: WebContents, issue: WebIssue) {
  const now = Math.floor(Date.now() / 1000)
  const b = budget.get(contents) ?? { second: now, n: 0 }
  if (b.second !== now) Object.assign(b, { second: now, n: 0 })
  budget.set(contents, b)
  if (++b.n > 20) return
  const short = { ...issue, text: issue.text.slice(0, 2000) }
  issueLog.set(contents.id, [...(issueLog.get(contents.id) ?? []), short].slice(-100))
  contents.hostWebContents?.send('web:issue', { from: contents.id, issue: short })
}

// los errores de la página que se ve ahora (para que el agente los consulte)
const issueLog = new Map<number, WebIssue[]>()
export const pageIssues = (wc: WebContents) => issueLog.get(wc.id) ?? []

// ---------- la pestaña que usan los agentes ----------

// pestaña activa del visor de cada proyecto (la avisa la ventana principal)
const activeTabs = new Map<string, number>()
const waiting = new Map<string, ((wc: WebContents) => void)[]>()

export function projectTab(projectId: string): WebContents | undefined {
  const id = activeTabs.get(projectId)
  const wc = id ? webContents.fromId(id) : undefined
  return wc && !wc.isDestroyed() ? wc : undefined
}

// Abre una dirección en el visor del proyecto; si estaba cerrado, se le pide a la ventana que lo abra
export async function openProjectTab(projectId: string, url: string): Promise<WebContents> {
  const wc = projectTab(projectId)
  if (wc) {
    // los fallos de carga (servidor apagado…) los ve el agente al leer la página
    wc.loadURL(url).catch(() => {})
    return wc
  }
  const ready = new Promise<WebContents>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The web viewer did not open (is this project the one on screen?)')), 15_000)
    waiting.set(projectId, [...(waiting.get(projectId) ?? []), (w) => (clearTimeout(t), resolve(w))])
  })
  deps.openInProject(projectId, url)
  return ready
}

function openOutside(url: string) {
  try {
    shell.openExternal(checkExternalUrl(url))
  } catch {
    /* protocolo no permitido */
  }
}

function guest(contents: WebContents) {
  const host = () => contents.hostWebContents
  const newTab = (url: string) => host()?.send('web:open', { url, from: contents.id })

  // ventanas emergentes y enlaces target=_blank → pestaña nueva del mismo visor
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) newTab(url)
    else openOutside(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string) => {
    if (isWebUrl(url)) return
    e.preventDefault()
    if (!url.startsWith('file:')) openOutside(url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  // una página nueva empieza sin errores
  contents.on('did-navigate', () => issueLog.delete(contents.id))
  contents.on('destroyed', () => issueLog.delete(contents.id))

  contents.on('console-message', (e) => {
    // las advertencias de seguridad de Electron son de la app, no de la página
    if ((e.level === 'error' || e.level === 'warning') && !e.message.startsWith('Electron Security Warning'))
      report(contents, { kind: 'console', level: e.level, text: e.message, source: e.sourceId ? `${e.sourceId}:${e.lineNumber}` : undefined, at: Date.now() })
  })

  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.alt || input.control || input.shift) return
    const key = input.key.toLowerCase()
    if (!FORWARD_KEYS.has(key)) return
    e.preventDefault()
    host()?.send('web:key', { from: contents.id, key, shift: false })
  })

  contents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    const sep = () => items.length && items.at(-1)?.type !== 'separator' && items.push({ type: 'separator' })
    if (p.linkURL) {
      items.push(
        { label: 'Abrir enlace en una pestaña nueva', enabled: isWebUrl(p.linkURL), click: () => newTab(p.linkURL) },
        { label: 'Abrir enlace en el navegador', click: () => openOutside(p.linkURL) },
        { label: 'Copiar enlace', click: () => clipboard.writeText(p.linkURL) }
      )
      sep()
    }
    if (p.mediaType === 'image' && p.srcURL && !p.srcURL.startsWith('data:')) {
      items.push(
        { label: 'Abrir imagen en una pestaña nueva', click: () => newTab(p.srcURL) },
        { label: 'Copiar dirección de la imagen', click: () => clipboard.writeText(p.srcURL) }
      )
      sep()
    }
    if (p.isEditable) {
      items.push(
        { label: 'Cortar', enabled: p.editFlags.canCut, click: () => contents.cut() },
        { label: 'Copiar', enabled: p.editFlags.canCopy, click: () => contents.copy() },
        { label: 'Pegar', enabled: p.editFlags.canPaste, click: () => contents.paste() },
        { label: 'Seleccionar todo', click: () => contents.selectAll() }
      )
      sep()
    } else if (p.selectionText.trim()) {
      const q = p.selectionText.trim().slice(0, 200)
      items.push(
        { label: 'Copiar', click: () => contents.copy() },
        { label: `Buscar «${q.length > 30 ? q.slice(0, 30) + '…' : q}» en Google`, click: () => newTab(`https://www.google.com/search?q=${encodeURIComponent(q)}`) }
      )
      sep()
    }
    const nav = contents.navigationHistory
    items.push(
      { label: 'Atrás', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Adelante', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Recargar', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Copiar dirección de la página', click: () => clipboard.writeText(contents.getURL()) },
      { label: 'Abrir página en el navegador', click: () => openOutside(contents.getURL()) },
      { type: 'separator' },
      { label: 'Inspeccionar elemento', click: () => contents.inspectElement(p.x, p.y) }
    )
    const h = host()
    Menu.buildFromTemplate(items).popup({ window: h ? (BrowserWindow.fromWebContents(h) ?? undefined) : undefined })
  })
}

// ---------- ventanas flotantes con el visor ----------

function openWebWindow(from: BrowserWindow | null, url: string) {
  const b = from?.getBounds()
  const w = new BrowserWindow({
    width: 1120,
    height: 800,
    x: b ? b.x + 48 : undefined,
    y: b ? b.y + 48 : undefined,
    minWidth: 420,
    minHeight: 320,
    show: false,
    title: 'Ambidex · Web',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#f6f6f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: { ...deps.windowPrefs(), webviewTag: true }
  })
  w.once('ready-to-show', () => w.show())
  w.webContents.setWindowOpenHandler(({ url: u }) => (openOutside(u), { action: 'deny' }))
  w.webContents.on('will-navigate', (e, u) => u !== w.webContents.getURL() && e.preventDefault())
  deps.loadRenderer(w, `web=${encodeURIComponent(isWebUrl(url) ? url : 'about:blank')}`)
}

async function favicon(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  if (favicons.has(url)) return favicons.get(url)!
  let out: string | null = null
  try {
    const r = await session.fromPartition(WEB_PARTITION).fetch(url, { signal: AbortSignal.timeout(4000) })
    const type = r.headers.get('content-type') ?? ''
    const buf = Buffer.from(await r.arrayBuffer())
    if (r.ok && /^image\//.test(type) && buf.length < 256 * 1024) out = `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    /* sin icono */
  }
  if (favicons.size > 300) favicons.clear()
  favicons.set(url, out)
  return out
}

// Llamadas que necesitan saber desde qué ventana se hacen
export const webSenderHandlers = {
  'web:popout': (e: IpcMainInvokeEvent, url: string) => openWebWindow(BrowserWindow.fromWebContents(e.sender), url),
  'web:setOnTop': (e: IpcMainInvokeEvent, on: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(on, 'floating')
  },
  'web:favicon': (_e: IpcMainInvokeEvent, url: string) => favicon(url),
  // la ventana dice qué pestaña del visor tiene a la vista cada proyecto (null: visor cerrado)
  'web:active': (e: IpcMainInvokeEvent, projectId: string, id: number | null) => {
    const wc = id ? webContents.fromId(id) : undefined
    if (id && (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== e.sender.id)) return
    if (!wc) return void activeTabs.delete(projectId)
    activeTabs.set(projectId, wc.id)
    for (const f of waiting.get(projectId) ?? []) f(wc)
    waiting.delete(projectId)
  },
  'web:capture': async (e: IpcMainInvokeEvent, id: number) => {
    const wc = webContents.fromId(id)
    if (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== e.sender.id) throw new Error('Esa página no es de este visor')
    const img = await wc.capturePage()
    if (img.isEmpty()) throw new Error('La página aún no se ha pintado')
    // en pantallas retina la captura sale al doble: se reduce para no mandar imágenes enormes al agente
    const png = (img.getSize().width > 1600 ? img.resize({ width: 1600, quality: 'good' }) : img).toPNG()
    return { path: saveImage(deps.attachmentsDir(), png, 'image/png'), url: `data:image/png;base64,${png.toString('base64')}` }
  }
}
