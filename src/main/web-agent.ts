import type { WebContents } from 'electron'
import type { AgentId, WebIssue } from '@shared/types'
import { isWebUrl, normalizeAddress } from '@shared/web'
import { McpContent, McpServer, McpTool, ToolError } from './mcp-server'

// Herramientas para que un agente use la pestaña Web de su proyecto: abrir, leer, pulsar, escribir y capturar.
// Los clics y las teclas llegan a la página como eventos reales del sistema. No hay herramienta para ejecutar
// JavaScript arbitrario: solo lo que hace falta para leer la página y encontrar sus elementos.

export interface WebAgentCtx {
  projectId: string
  runId: string
  agent: AgentId
}

export interface WebAgentDeps {
  // pestaña activa del visor del proyecto (si está abierto)
  tab: (projectId: string) => WebContents | undefined
  // abre el visor del proyecto con esa dirección y devuelve su pestaña cuando existe
  open: (projectId: string, url: string) => Promise<WebContents>
  issues: (wc: WebContents) => WebIssue[]
  // aviso a la interfaz: qué está haciendo el agente en la web
  activity: (ctx: WebAgentCtx, action: string) => void
}

const text = (t: string): McpContent[] => [{ type: 'text', text: t }]

function settle(wc: WebContents, ms = 15_000): Promise<void> {
  return new Promise((resolve) => {
    // una navegación puede tardar unos milisegundos en empezar después del clic o la tecla
    setTimeout(() => {
      if (!wc.isLoading()) return resolve()
      const done = () => (clearTimeout(t), wc.off('did-stop-loading', done), resolve())
      const t = setTimeout(done, ms)
      wc.on('did-stop-loading', done)
    }, 250)
  })
}

// Lee la página: elementos con los que se puede interactuar (con un número para usarlos) y el texto visible.
// Los valores de los campos de contraseña nunca se leen.
const SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const clean = (t) => String(t || '').trim().replace(/\\s+/g, ' ').slice(0, 90)
  const label = (el) => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || (el.type !== 'password' ? el.value : '') || el.getAttribute('alt') || el.getAttribute('name'))
  document.querySelectorAll('[data-ambidex-ref]').forEach((e) => e.removeAttribute('data-ambidex-ref'))
  const out = []
  let n = 0
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable="true"], [contenteditable=""], summary, h1, h2, h3'
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue
    const tag = el.tagName.toLowerCase()
    if (/^h[1-3]$/.test(tag)) { out.push('#'.repeat(+tag[1]) + ' ' + clean(el.innerText)); continue }
    if (n >= 300) continue
    const ref = ++n
    el.setAttribute('data-ambidex-ref', String(ref))
    const type = (el.getAttribute('type') || '').toLowerCase()
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (['checkbox', 'radio', 'submit', 'button'].includes(type) ? type : 'textbox') : tag === 'textarea' ? 'textbox' : tag === 'select' ? 'select' : tag)
    let line = '[' + ref + '] ' + role + ' "' + label(el) + '"'
    if (tag === 'a') line += ' -> ' + clean(el.getAttribute('href'))
    if (type === 'password') line += ' (password field)'
    else if ((tag === 'input' || tag === 'textarea') && role === 'textbox') line += ' value="' + clean(el.value).slice(0, 60) + '"'
    if (tag === 'select' && el.selectedOptions[0]) line += ' selected="' + clean(el.selectedOptions[0].text) + '"'
    if (el.checked) line += ' (checked)'
    if (el.disabled) line += ' (disabled)'
    out.push(line)
  }
  const body = document.body ? document.body.innerText : ''
  return { title: document.title, url: location.href, elements: out.join('\\n'), text: body.replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000), more: n >= 300 }
})()`

// Centro del elemento (ya visible en pantalla) para pulsarlo con el ratón
const locate = (ref: number) => `(() => {
  const el = document.querySelector('[data-ambidex-ref="${ref}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), editable: el.matches('input, textarea, [contenteditable="true"], [contenteditable=""]'), select: el.tagName === 'SELECT' }
})()`

const KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowdown: 'Down',
  arrowup: 'Up',
  arrowleft: 'Left',
  arrowright: 'Right',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  home: 'Home',
  end: 'End',
  space: 'Space'
}

function press(wc: WebContents, key: string) {
  const code = KEYS[key.toLowerCase()]
  if (!code) throw new ToolError(`Unknown key "${key}". Use one of: ${Object.keys(KEYS).join(', ')}`)
  wc.sendInputEvent({ type: 'keyDown', keyCode: code })
  if (code === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  if (code === 'Space') wc.sendInputEvent({ type: 'char', keyCode: ' ' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: code })
}

async function click(wc: WebContents, ref: number) {
  if (!Number.isInteger(ref) || ref < 1) throw new ToolError('ref must be a positive integer from web_snapshot')
  const p = await wc.executeJavaScript(locate(ref), true)
  if (!p) throw new ToolError(`Element [${ref}] is not on the page anymore. Call web_snapshot again.`)
  wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
  wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  return p as { editable: boolean; select: boolean }
}

async function snapshot(wc: WebContents): Promise<McpContent[]> {
  const s = await wc.executeJavaScript(SNAPSHOT, true)
  return text(
    `URL: ${s.url}\nTitle: ${s.title}\n\nInteractive elements (use the number with web_click / web_type):\n${s.elements || '(none)'}${s.more ? '\n(only the first 300 are listed; scroll to see more)' : ''}\n\nVisible text:\n${s.text}`
  )
}

export function webAgentTools(d: WebAgentDeps): McpTool<WebAgentCtx>[] {
  // la pestaña con la que se trabaja: si el visor está cerrado hay que abrir una dirección primero
  const tab = (ctx: WebAgentCtx) => {
    const wc = d.tab(ctx.projectId)
    if (!wc || wc.isDestroyed()) throw new ToolError('The web viewer of this project is closed. Call web_open with a URL first.')
    return wc
  }
  const tool = (name: string, description: string, props: Record<string, object>, required: string[], run: (a: any, wc: WebContents, ctx: WebAgentCtx) => Promise<McpContent[]>, action: (a: any) => string, needsTab = true): McpTool<WebAgentCtx> => ({
    name,
    description,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
    run: async (a, ctx) => {
      d.activity(ctx, action(a))
      return run(a, needsTab ? tab(ctx) : (undefined as unknown as WebContents), ctx)
    }
  })
  return [
    tool(
      'web_open',
      "Open a URL in the user's in-app web viewer for this project (the same tab the user sees, e.g. the local dev server like http://localhost:5173) and wait until it loads. Returns a snapshot of the page.",
      { url: { type: 'string', description: 'http(s) URL or host:port, e.g. localhost:3000' } },
      ['url'],
      async (a, _wc, ctx) => {
        const url = normalizeAddress(String(a.url ?? ''))
        if (!isWebUrl(url)) throw new ToolError('Only http(s) URLs can be opened')
        const wc = await d.open(ctx.projectId, url)
        await settle(wc)
        return snapshot(wc)
      },
      (a) => `abre ${a.url}`,
      false
    ),
    tool(
      'web_snapshot',
      'Read the current page in the web viewer: URL, title, the interactive elements numbered as [n] (links, buttons, fields…) and the visible text. Call it again after the page changes.',
      {},
      [],
      async (_a, wc) => snapshot(wc),
      () => 'lee la página'
    ),
    tool(
      'web_click',
      'Click an element by its number [n] from the last web_snapshot (a real mouse click). Waits for any navigation it causes.',
      { ref: { type: 'integer', description: 'Element number from web_snapshot' } },
      ['ref'],
      async (a, wc) => {
        await click(wc, Number(a.ref))
        await settle(wc)
        return text(`Clicked [${a.ref}]. Page: ${wc.getURL()}. Call web_snapshot to see the result.`)
      },
      (a) => `pulsa [${a.ref}]`
    ),
    tool(
      'web_type',
      'Type text into a field by its number [n] from web_snapshot. Replaces what the field had. Set submit to true to press Enter afterwards.',
      { ref: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      ['ref', 'text'],
      async (a, wc) => {
        const p = await click(wc, Number(a.ref))
        if (!p.editable) throw new ToolError(`Element [${a.ref}] is not a text field`)
        await wc.executeJavaScript(`(() => { const el = document.querySelector('[data-ambidex-ref="${Number(a.ref)}"]'); if (el && el.select) el.select(); else document.execCommand('selectAll') })()`, true)
        await wc.insertText(String(a.text ?? ''))
        if (a.submit) {
          press(wc, 'enter')
          await settle(wc)
        }
        return text(`Typed into [${a.ref}]${a.submit ? ' and pressed Enter' : ''}. Page: ${wc.getURL()}`)
      },
      (a) => `escribe en [${a.ref}]`
    ),
    tool(
      'web_press',
      'Press a key in the page (Enter, Escape, Tab, Backspace, ArrowDown, ArrowUp, PageDown, Space…).',
      { key: { type: 'string' } },
      ['key'],
      async (a, wc) => {
        press(wc, String(a.key ?? ''))
        await settle(wc)
        return text(`Pressed ${a.key}`)
      },
      (a) => `pulsa ${a.key}`
    ),
    tool(
      'web_scroll',
      'Scroll the page up or down.',
      { direction: { type: 'string', enum: ['up', 'down'] }, pages: { type: 'number', description: 'How many screens, default 1' } },
      ['direction'],
      async (a, wc) => {
        const pages = Math.max(0.1, Math.min(20, Number(a.pages) || 1))
        await wc.executeJavaScript(`window.scrollBy(0, ${a.direction === 'up' ? -1 : 1} * ${pages} * window.innerHeight * 0.9)`, true)
        return text(`Scrolled ${a.direction}`)
      },
      (a) => `desplaza ${a.direction === 'up' ? 'arriba' : 'abajo'}`
    ),
    tool(
      'web_back',
      'Go back to the previous page.',
      {},
      [],
      async (_a, wc) => {
        if (!wc.navigationHistory.canGoBack()) throw new ToolError('There is no previous page')
        wc.navigationHistory.goBack()
        await settle(wc)
        return text(`Back to ${wc.getURL()}`)
      },
      () => 'vuelve atrás'
    ),
    tool(
      'web_screenshot',
      'Take a screenshot of what the web viewer shows right now, to check how the page looks.',
      {},
      [],
      async (_a, wc) => {
        const img = await wc.capturePage()
        if (img.isEmpty()) throw new ToolError('The page has not been painted yet')
        const png = (img.getSize().width > 1280 ? img.resize({ width: 1280, quality: 'good' }) : img).toPNG()
        return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
      },
      () => 'hace una captura'
    ),
    tool(
      'web_console',
      'Errors and warnings of the current page: console messages and failed network requests (4xx/5xx or network errors).',
      {},
      [],
      async (_a, wc) => {
        const list = d.issues(wc)
        return text(list.length ? list.map((i) => `[${i.kind === 'network' ? 'network' : i.level}] ${i.text}${i.kind === 'console' && i.source ? ` (${i.source})` : ''}`).join('\n') : 'No errors or warnings on this page.')
      },
      () => 'mira la consola'
    )
  ]
}

export const WEB_TOKEN_ENV = 'AMBIDEX_WEB_TOKEN'

// Cómo se le da el servidor a cada CLI para un solo turno, sin tocar su configuración. La clave va en una
// variable de entorno del proceso (no aparece en los argumentos).
export function agentMcpArgs(agent: AgentId, url: string): { extra: string[]; allowedTools?: string[] } {
  if (agent === 'claude')
    return {
      // permitidas de antemano: en modo no interactivo una herramienta MCP sin permiso se deniega
      allowedTools: ['mcp__ambidex_web'],
      extra: ['--mcp-config', JSON.stringify({ mcpServers: { ambidex_web: { type: 'http', url, headers: { Authorization: `Bearer \${${WEB_TOKEN_ENV}}` } } } })]
    }
  const key = 'mcp_servers.ambidex_web'
  return { extra: ['-c', `${key}.url="${url}"`, '-c', `${key}.bearer_token_env_var="${WEB_TOKEN_ENV}"`, '-c', `${key}.default_tools_approval_mode="approve"`] }
}

export function createWebAgent(d: WebAgentDeps) {
  return new McpServer<WebAgentCtx>('ambidex-web', webAgentTools(d))
}
