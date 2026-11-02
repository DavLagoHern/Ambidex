// Prueba E2E de la aplicación real (Electron + CLI reales de Claude Code y Codex).
// Uso: npm run build && npm run test:e2e
// Consume una cantidad mínima de cuota: un mensaje de una palabra a cada agente.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = resolve(import.meta.dirname, '../..')
const shots = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'ambidex-shots-'))
mkdirSync(shots, { recursive: true })
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'ambidex-e2e-data-')))
const skipAgents = process.env.E2E_SKIP_AGENTS === '1'

const results = []
const errors = []
let step = 0

function makeRepo(name, files) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'ambidex-e2e-'))), name)
  mkdirSync(dir)
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'E2E')
  g('config', 'user.email', 'e2e@local')
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), c)
  }
  g('add', '.')
  g('commit', '-q', '-m', 'inicial')
  return dir
}

async function launch() {
  const env = { ...process.env, AMBIDEX_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE // VS Code la define y haría arrancar Electron como Node
  // E2E_APP: ruta al ejecutable de la .app empaquetada (si no, se usa el código compilado en out/)
  const app = await electron.launch({
    executablePath: process.env.E2E_APP || electronPath,
    args: process.env.E2E_APP ? [] : [join(root, 'out/main/index.js')],
    env,
    timeout: 60000
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await page.waitForSelector('.tabbar', { timeout: 30000 })
  return { app, page }
}

async function check(name, fn) {
  step++
  const t = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t })
    console.log(`✓ ${step}. ${name} (${Date.now() - t} ms)`)
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e).split('\n')[0] })
    await page.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-FALLO.png`) }).catch(() => {})
    if (process.env.E2E_DEBUG)
      console.log(
        '   estado:',
        JSON.stringify(
          await page
            .evaluate(() => ({
              overlay: !!document.querySelector('.dock-overlay'),
              arrastrando: [...document.querySelectorAll('.dock-pane.drag-src')].map((e) => e.className),
              foco: document.activeElement?.tagName + '.' + document.activeElement?.className,
              paleta: document.querySelector('.palette-input input')?.value,
              body: document.body.className
            }))
            .catch((e) => String(e))
        )
      )
    console.log(`✗ ${step}. ${name}: ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

const shot = (page, name) => page.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name}.png`) })

// `npm run dev` de verdad: un servidor que dice su dirección como Vite y sirve una página con errores
const DEV_SERVER = `const http = require('http')
const s = http.createServer((req, res) => {
  if (req.url !== '/') return (res.statusCode = 404), res.end('no')
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<title>Dev E2E</title><h1>Tienda</h1><script>console.error("Fallo E2E: carrito no está definido"); fetch("/api/no-existe")</script>')
})
s.listen(0, '127.0.0.1', () => console.log('\\n  ➜  Local:   http://localhost:' + s.address().port + '/\\n'))
`
const projA = makeRepo('tienda-web', {
  'package.json': JSON.stringify({ name: 'tienda-web', version: '1.0.0', scripts: { test: 'node --test', dev: 'node dev.js' } }, null, 2) + '\n',
  'dev.js': DEV_SERVER,
  'src/app.ts': 'export function total(precios: number[]): number {\n  return precios.reduce((a, b) => a + b, 0)\n}\n',
  'README.md': '# Tienda web\n'
})
// una imagen PNG de un color, para comprobar que el agente la ve
function solidPng(rgb) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (t, d) => {
    const td = Buffer.concat([Buffer.from(t), d])
    const out = Buffer.alloc(12 + d.length)
    out.writeUInt32BE(d.length, 0)
    td.copy(out, 4)
    out.writeUInt32BE(crc(td), 8 + d.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(64, 0)
  ihdr.writeUInt32BE(64, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((64 * 3 + 1) * 64)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw.set(rgb, y * 193 + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const redPng = join(realpathSync(mkdtempSync(join(tmpdir(), 'ambidex-e2e-img-'))), 'rojo.png')
writeFileSync(redPng, solidPng([220, 20, 20]))

const projB = makeRepo('api-pedidos', { 'server.js': "console.log('api')\n", 'README.md': '# API de pedidos\n' })

// servidor local para el visor web (como un `npm run dev`)
const web = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url === '/otra') return res.end('<title>Otra página</title><h1>Otra</h1>')
  res.end('<title>Página E2E</title><body style="margin:0;font:28px sans-serif"><a href="/otra" target="_blank" style="display:block;padding:40px">Abrir otra</a></body>')
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const webUrl = `http://localhost:${web.address().port}/`

let { app, page } = await launch()

await check('Arranca y muestra la bienvenida con el estado real de los CLI', async () => {
  await page.waitForSelector('.welcome', { timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('.welcome-agent .ok').length + document.querySelectorAll('.welcome-agent .btn').length >= 2, null, { timeout: 60000 })
  await shot(page, 'bienvenida')
})

await check('Abre dos proyectos como pestañas', async () => {
  await page.evaluate((p) => window.bridge.invoke('projects:open', p), projA)
  await page.evaluate((p) => window.bridge.invoke('projects:open', p), projB)
  await page.reload()
  await page.waitForSelector('.ptab:nth-child(2)', { timeout: 20000 })
  const names = await page.$$eval('.ptab-name', (els) => els.map((e) => e.textContent))
  if (names.join(',') !== 'tienda-web,api-pedidos') throw new Error(`pestañas: ${names}`)
  await page.click('.ptab:has-text("tienda-web")')
  await page.waitForSelector('.workspace.active .agent-col.unified textarea')
  await shot(page, 'proyecto')
})

if (!skipAgents) {
  const lastReply = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent).join('\n'))
  await check('Modo Claude: responde de verdad (CLI con tu cuenta)', async () => {
    await page.click('.workspace.active .mode-btn.m-claude')
    const ta = page.locator('.workspace.active .agent-col.agent-claude textarea')
    await ta.fill('Responde únicamente con la palabra LISTO, sin nada más.')
    await ta.press('Enter')
    await page.waitForSelector('.workspace.active .agent-col.agent-claude .working', { timeout: 15000 })
    await shot(page, 'claude-trabajando')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.workspace.active .agent-col.agent-claude .msg-assistant')].some((e) => /LISTO/.test(e.textContent)) &&
        !document.querySelector('.workspace.active .agent-col.agent-claude .working'),
      null,
      { timeout: 180000 }
    )
    await shot(page, 'claude-respuesta')
  })

  await check('Cola: un segundo mensaje mientras Claude trabaja se encola y sale solo', async () => {
    const ta = page.locator('.workspace.active .agent-col.agent-claude textarea')
    await ta.fill('Responde únicamente con la palabra UNO.')
    await ta.press('Enter')
    await page.waitForSelector('.workspace.active .agent-col.agent-claude .working', { timeout: 15000 })
    await ta.fill('Responde únicamente con la palabra DOS.')
    await ta.press('Enter')
    await page.waitForSelector('.workspace.active .queue-item', { timeout: 5000 })
    await shot(page, 'cola')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.workspace.active .agent-col.agent-claude .msg-assistant')].some((e) => /\bDOS\b/.test(e.textContent)) &&
        !document.querySelector('.workspace.active .queue-item'),
      null,
      { timeout: 240000 }
    )
  })

  await check('Imagen adjunta: Claude la ve de verdad', async () => {
    const col = '.workspace.active .agent-col.agent-claude'
    await page.click('.workspace.active .mode-btn.m-claude')
    await page.waitForFunction(() => !document.querySelector('.workspace.active .agent-col.agent-claude .working'), null, { timeout: 120000 })
    await page.setInputFiles(`${col} .composer input[type=file]`, redPng)
    await page.waitForSelector(`${col} .attach-strip .attach img`, { timeout: 5000 })
    const ta = page.locator(`${col} textarea`)
    await ta.fill('¿De qué color es la imagen adjunta? Responde solo con el color, en una palabra.')
    await ta.press('Enter')
    await page.waitForSelector(`${col} .msg-user-wrap .sent-img img`, { timeout: 15000 })
    await page.waitForFunction(
      () => {
        const replies = [...document.querySelectorAll('.workspace.active .agent-col.agent-claude .msg-assistant')]
        return /roj/i.test(replies.at(-1)?.textContent ?? '') && !document.querySelector('.workspace.active .agent-col.agent-claude .working')
      },
      null,
      { timeout: 180000 }
    )
    await shot(page, 'imagen-claude')
  })

  await check('Deshacer un turno: Claude crea un fichero y se deshace sin tocar nada más', async () => {
    const col = '.workspace.active .agent-col.agent-claude'
    const file = join(projA, 'deshacer-e2e.txt')
    const ta = page.locator(`${col} textarea`)
    await ta.fill('Crea un fichero llamado deshacer-e2e.txt en la raíz del proyecto con el texto hola. No hagas nada más.')
    await ta.press('Enter')
    await page.waitForFunction(() => !!document.querySelector('.workspace.active .agent-col.agent-claude .working'), null, { timeout: 15000 })
    await page.waitForFunction(() => !document.querySelector('.workspace.active .agent-col.agent-claude .working'), null, { timeout: 180000 })
    if (!existsSync(file)) throw new Error('Claude no creó el fichero')
    await page.waitForSelector(`${col} .turn-undo button`, { timeout: 15000 })
    // el diálogo de confirmación es nativo: en la prueba se acepta desde el proceso principal
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await page.locator(`${col} .turn-undo button`).last().click()
    await page.waitForSelector(`${col} .turn-undo.done`, { timeout: 15000 })
    if (existsSync(file)) throw new Error('el fichero sigue ahí')
    await shot(page, 'deshacer')
  })

  await check('La Web la usa el agente: Claude abre la página, pulsa el enlace y lee la pestaña nueva', async () => {
    const col = '.workspace.active .agent-col.agent-claude'
    if (await page.$('.workspace.active .dock-web')) throw new Error('la Web debería empezar cerrada')
    const ta = page.locator(`${col} textarea`)
    await ta.fill(`Con las herramientas de la Web: abre ${webUrl} con web_open, pulsa el enlace de la página con web_click y luego usa web_snapshot. Responde solo con el título de la página que se ve al final.`)
    await ta.press('Enter')
    // la Web se abre sola y avisa de que el agente la está usando
    await page.waitForSelector('.workspace.active .dock-web .web-agent', { timeout: 90000 })
    await shot(page, 'agente-usa-web')
    await page.waitForFunction(
      () => {
        const replies = [...document.querySelectorAll('.workspace.active .agent-col.agent-claude .msg-assistant')]
        return /Otra página/.test(replies.at(-1)?.textContent ?? '') && !document.querySelector('.workspace.active .agent-col.agent-claude .working')
      },
      null,
      { timeout: 180000 }
    )
    const tabs = await page.$$eval('.workspace.active .web-tab', (t) => t.map((x) => x.textContent))
    if (!tabs.some((t) => t.includes('Página E2E')) || !tabs.some((t) => t.includes('Otra página'))) throw new Error(`pestañas: ${tabs}`)
  })

  await check('Modo Codex: responde de verdad (CLI con tu cuenta)', async () => {
    await page.click('.workspace.active .mode-btn.m-codex')
    const ta = page.locator('.workspace.active .agent-col.agent-codex textarea')
    await ta.fill('Responde únicamente con la palabra LISTO, sin nada más.')
    await ta.press('Enter')
    await page.waitForFunction(
      () => document.querySelectorAll('.workspace.active .agent-col.agent-codex .msg-assistant, .workspace.active .agent-col.agent-codex .msg-error').length > 0 &&
        !document.querySelector('.workspace.active .agent-col.agent-codex .working'),
      null,
      { timeout: 240000 }
    )
    await shot(page, 'codex-respuesta')
    const err = await lastReply('.workspace.active .agent-col.agent-codex .msg-error')
    if (err) throw new Error(`Codex devolvió un error: ${err}`)
  })

  await check('La Web la usa Codex: lee la página que tienes abierta', async () => {
    const col = '.workspace.active .agent-col.agent-codex'
    const ta = page.locator(`${col} textarea`)
    await ta.fill('Usa la herramienta web_snapshot y responde solo con el título de la página que se ve en la Web.')
    await ta.press('Enter')
    await page.waitForFunction(
      () => {
        const replies = [...document.querySelectorAll('.workspace.active .agent-col.agent-codex .msg-assistant')]
        return /Otra página|Página E2E/.test(replies.at(-1)?.textContent ?? '') && !document.querySelector('.workspace.active .agent-col.agent-codex .working')
      },
      null,
      { timeout: 180000 }
    )
    // se cierra la Web para que los pasos siguientes empiecen como antes
    await page.click('.workspace.active .mode-btn.m-web')
  })

  await check('Modo Ambos: el motor elige agente y lo explica', async () => {
    await page.click('.workspace.active .mode-btn.m-ambos')
    await page.waitForSelector('.workspace.active .agent-col.unified textarea')
    const ta = page.locator('.workspace.active .agent-col.unified textarea')
    await ta.fill('Arregla este error de sintaxis imaginario: responde solo con la palabra HECHO')
    await page.waitForSelector('.workspace.active .target-preview', { timeout: 5000 })
    const preview = await page.$eval('.workspace.active .target-preview', (e) => e.textContent)
    if (!/Codex/.test(preview)) throw new Error(`el motor no eligió Codex para depurar: ${preview}`)
    await shot(page, 'ambos-preview')
    await ta.press('Enter')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.workspace.active .reply.agent-codex .msg-assistant')].some((e) => /HECHO/.test(e.textContent)) &&
        !document.querySelector('.workspace.active .reply .working'),
      null,
      { timeout: 240000 }
    )
    await ta.fill('@claude responde únicamente con la palabra LISTO')
    await ta.press('Enter')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.workspace.active .reply.agent-claude .msg-assistant')].some((e) => /LISTO/.test(e.textContent)) &&
        !document.querySelector('.workspace.active .reply .working'),
      null,
      { timeout: 180000 }
    )
    const chips = await page.$$eval('.workspace.active .route-chip', (els) => els.map((e) => e.textContent))
    if (chips.length < 2) throw new Error('faltan las marcas de enrutado')
    await shot(page, 'ambos-respuestas')
  })

  await check('Un enlace en la respuesta de un agente se abre en el visor web', async () => {
    await page.click('.workspace.active .mode-btn.m-claude')
    const ta = page.locator('.workspace.active .agent-col.agent-claude textarea')
    await ta.fill(`Responde únicamente con esta dirección, sin nada más: ${webUrl}`)
    await ta.press('Enter')
    const link = '.workspace.active .agent-col.agent-claude .msg-assistant a.web-link'
    await page.waitForSelector(link, { timeout: 180000 })
    await page.click(link)
    await page.waitForFunction(() => document.querySelector('.workspace.active .web-tab.on')?.textContent?.includes('Página E2E'), null, { timeout: 15000 })
    await shot(page, 'enlace-en-web')
    await page.click('.workspace.active .mode-btn.m-web') // cierra el visor (las pestañas se guardan)
    await page.click('.workspace.active .mode-btn.m-ambos') // los pasos siguientes usan el chat con los dos
  })

  await check('La actividad y las ejecuciones reflejan lo ocurrido', async () => {
    await page.waitForSelector('.workspace.active .tl-run', { timeout: 10000 })
    const n = await page.$$eval('.workspace.active .tl-run', (els) => els.length)
    if (n < 6) throw new Error(`solo ${n} eventos de ejecución`)
  })
}

await check('Cambiar de pestaña aísla el estado de cada proyecto', async () => {
  await page.click('.ptab:has-text("api-pedidos")')
  await page.waitForSelector('.workspace.active .chat-empty', { timeout: 10000 })
  await shot(page, 'otro-proyecto')
  await page.click('.ptab:has-text("tienda-web")')
  if (!skipAgents) await page.waitForSelector('.workspace.active .reply .msg-assistant', { timeout: 5000 })
})

await check('Ir a fichero (⌘P) abre el editor Monaco', async () => {
  await page.keyboard.press('Meta+P')
  await page.waitForSelector('.palette-input input')
  await page.keyboard.type('app')
  await page.waitForSelector('.palette-item')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.workspace.active .monaco-editor', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelector('.workspace.active .monaco-editor')?.textContent?.includes('precios'), null, { timeout: 10000 })
  await shot(page, 'editor')
})

await check('Paleta de comandos (⌘K) abre una terminal real en el proyecto', async () => {
  await page.keyboard.press('Meta+K')
  await page.waitForSelector('.palette-input input')
  await page.keyboard.type('nueva terminal')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.workspace.active .xterm', { timeout: 10000 })
  await page.waitForTimeout(1200)
  await page.click('.workspace.active .terminal-host')
  await page.keyboard.type('pwd && echo hola-e2e\n')
  await page.waitForFunction(() => document.querySelector('.workspace.active .xterm-rows')?.textContent?.includes('hola-e2e'), null, { timeout: 10000 })
  const text = await page.$eval('.workspace.active .xterm-rows', (e) => e.textContent)
  if (!text.includes('tienda-web')) throw new Error('la terminal no arrancó en la carpeta del proyecto')
  await shot(page, 'terminal')
})

await check('Git muestra el estado y los cambios del proyecto', async () => {
  await page.keyboard.press('Meta+Shift+G')
  await page.waitForSelector('.workspace.active .repo-row', { timeout: 10000 })
  await page.evaluate((p) => window.bridge.invoke('fs:write', p + '/src/app.ts', 'export const x = 1\n'), projA)
  await page.waitForSelector('.workspace.active .file-row .st-letter', { timeout: 10000 })
  await shot(page, 'git')
})

await check('Visor web: localhost, pestañas, enlaces target=_blank y ventana nueva', async () => {
  await page.click('.workspace.active .mode-btn.m-web')
  await page.waitForSelector('.workspace.active .webpanel')
  await page.click('.workspace.active .webpanel .icon-btn[title^="Pestaña nueva"]')
  if (!(await page.evaluate(() => !!document.activeElement?.closest('.web-url')))) throw new Error('la pestaña nueva no enfoca la barra de direcciones')
  await page.keyboard.type(webUrl.replace('http://', ''))
  const typed = await page.$eval('.workspace.active .web-url input', (e) => e.value)
  if (typed !== webUrl.replace('http://', '')) throw new Error(`en la barra solo llegó ${JSON.stringify(typed)}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.workspace.active .web-tab.on')?.textContent?.includes('Página E2E'), null, { timeout: 15000 })
  const n = await page.$$eval('.workspace.active .web-tab', (e) => e.length)
  const box = await page.locator('.workspace.active .web-page.on').boundingBox()
  // Chromium tarda unos milisegundos en enrutar clics a una página recién mostrada: un clic sintético
  // inmediato puede no llegar (pasaba igual antes de los paneles movibles). Un clic que no llega no hace nada,
  // así que se repite hasta que se abre la pestaña.
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(box.x + 100, box.y + 45)
    const opened = await page
      .waitForFunction((k) => document.querySelectorAll('.workspace.active .web-tab').length > k, n, { timeout: 2500 })
      .then(() => true, () => false)
    if (opened) break
  }
  const after = await page.$$eval('.workspace.active .web-tab', (e) => e.length)
  if (after !== n + 1) throw new Error(`el enlace target=_blank abrió ${after - n} pestañas`)
  await shot(page, 'web')
  const [w] = await Promise.all([app.waitForEvent('window'), page.click('.workspace.active .webpanel .icon-btn[title="Abrir en una ventana nueva"]')])
  await w.waitForSelector('.webwin .web-tab.on', { timeout: 15000 })
  await w.close()
})

await check('Paneles: arrastrar la terminal sobre la web las intercambia sin perder la sesión ni recargar la página', async () => {
  const P = '.workspace.active .dock-'
  const box = (p) => page.locator(P + p).boundingBox()
  const near = (a, b) => Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3 && Math.abs(a.width - b.width) < 3 && Math.abs(a.height - b.height) < 3
  const drag = async (from, to, name) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 14 })
    await page.waitForSelector('.workspace.active .dock-drop', { timeout: 3000 })
    if (name) await shot(page, name)
    if (process.env.E2E_DEBUG)
      console.log(
        '   soltar en',
        JSON.stringify(to),
        await page.$eval('.workspace.active .dock-drop span', (e) => e.textContent),
        JSON.stringify(
          await page.$$eval('.workspace.active .dock-pane', (ps) =>
            ps.filter((p) => p.style.display !== 'none').map((p) => [p.className.split(' ')[1], Math.round(p.getBoundingClientRect().x), Math.round(p.getBoundingClientRect().width)])
          )
        ),
        JSON.stringify(await page.$eval('.workspace.active .dock', (d) => Math.round(d.getBoundingClientRect().width)))
      )
    await page.mouse.up()
    await page.waitForSelector('.workspace.active .dock-overlay', { state: 'detached', timeout: 3000 })
  }
  // un punto de la cabecera del panel que no es un botón
  const header = async (sel) => {
    const b = await page.locator(sel).first().boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const termHeader = () => header(P + 'terminal .bottom-tabs > span[style*="flex"]')
  const middle = async (p) => {
    const b = await box(p)
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const webview = () => page.locator('.workspace.active .web-page.on')
  await webview().evaluate((w) => w.executeJavaScript('window.__antesDeMover = 42'))
  const term0 = await box('terminal')
  const web0 = await box('web')

  await drag(await termHeader(), await middle('web'), 'arrastrando-terminal')
  // la terminal pasa arriba, junto al chat, y la web abajo (cada una con el tamaño del sitio al que va)
  const [t1, w1, c1] = await Promise.all(['terminal', 'web', 'chat'].map(box))
  if (Math.abs(t1.y - c1.y) > 2 || t1.x < c1.x + c1.width || w1.y < c1.y + c1.height - 2) throw new Error('no se intercambiaron la terminal y la web')
  await shot(page, 'paneles-intercambiados')
  if (!(await page.$eval(P + 'terminal .xterm-rows', (e) => e.textContent.includes('hola-e2e')))) throw new Error('la terminal perdió lo que tenía')
  await page.click(P + 'terminal .terminal-host')
  await page.keyboard.type('echo sigue-viva\n')
  await page.waitForFunction(() => document.querySelector('.workspace.active .dock-terminal .xterm-rows')?.textContent?.includes('sigue-viva'), null, { timeout: 10000 })
  if ((await webview().evaluate((w) => w.executeJavaScript('window.__antesDeMover'))) !== 42) throw new Error('la página web se recargó al moverla')

  // y de vuelta, arrastrando la web por su cabecera
  // Escape cancela un arrastre a medias sin mover nada
  const t = await box('terminal')
  await page.mouse.move(...Object.values(await header(P + 'web .web-drag')))
  await page.mouse.down()
  await page.mouse.move(t.x + 30, t.y + t.height / 2, { steps: 14 })
  await page.waitForSelector('.workspace.active .dock-drop', { timeout: 3000 })
  await shot(page, 'arrastrando-web-al-borde')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForSelector('.workspace.active .dock-overlay', { state: 'detached', timeout: 3000 })
  if (!near(await box('terminal'), t)) throw new Error('Escape no canceló el arrastre')

  await drag(await header(P + 'web .web-drag'), await middle('terminal'))
  if (!near(await box('terminal'), term0) || !near(await box('web'), web0)) throw new Error('no volvieron a su sitio')

  // al borde de abajo del área: a todo lo ancho; y «Restablecer diseño» lo devuelve
  const dock = await page.locator('.workspace.active .dock').boundingBox()
  await drag(await header(P + 'agents .panel-header > span'), { x: dock.x + dock.width / 2, y: dock.y + dock.height - 4 })
  const ag = await box('agents')
  if (Math.abs(ag.width - dock.width) > 2 || Math.abs(ag.y + ag.height - (dock.y + dock.height)) > 2) throw new Error('Agentes no quedó abajo a todo lo ancho')
  await shot(page, 'agentes-abajo')
  await page.keyboard.press('Meta+K')
  await page.keyboard.type('restablecer el dise')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const d = document.querySelector('.workspace.active .dock').getBoundingClientRect()
    const a = document.querySelector('.workspace.active .dock-agents').getBoundingClientRect()
    return Math.abs(a.right - d.right) < 2 && Math.abs(a.height - d.height) < 2
  }, null, { timeout: 3000 })

  // ocultar Agentes y recuperarlo desde la barra de título
  await page.click(P + 'agents .panel-header .icon-btn[title^="Ocultar"]')
  await page.waitForSelector(P + 'agents', { state: 'detached', timeout: 3000 })
  await page.click('.tabbar .layout-ctl .tb-btn[title*="Agentes"]')
  await page.waitForSelector(P + 'agents .act-cards', { timeout: 3000 })

  // se deja la terminal en el sitio de la web para comprobar que se guarda al reabrir
  await drag(await termHeader(), await middle('web'))
  await shot(page, 'paneles-final')
})

await check('Ventanas: la terminal sale a su propia ventana con la misma sesión, y el chat también; al cerrarlas vuelven', async () => {
  const palette = async (q) => {
    await page.keyboard.press('Meta+K')
    await page.waitForSelector('.palette-input input')
    await page.keyboard.type(q)
    const got = await page.$eval('.palette-input input', (e) => e.value)
    if (got !== q) throw new Error(`en la paleta solo llegó ${JSON.stringify(got)} (el foco se fue a ${await page.evaluate(() => document.activeElement?.className)})`)
    await page.keyboard.press('Enter')
  }
  const display = (p) => page.$eval(`.workspace.active .dock-${p}`, (e) => getComputedStyle(e).display).catch(() => 'none')
  console.log('   estado al empezar:', JSON.stringify(await page.evaluate(() => ({
    overlay: !!document.querySelector('.dock-overlay'),
    arrastrando: [...document.querySelectorAll('.dock-pane.drag-src')].map((e) => e.className),
    foco: document.activeElement?.tagName + '.' + document.activeElement?.className,
    body: document.body.className
  }))))
  const focusLog = []
  if (process.env.E2E_DEBUG) {
    page.on('console', (m) => m.text().startsWith('FOCO') && focusLog.push(m.text()))
    await page.evaluate(() =>
      document.addEventListener('focusin', (e) => console.log('FOCO ' + e.target.tagName + '.' + e.target.className + '\n' + new Error().stack.split('\n').slice(2, 12).join('\n')), true)
    )
  }
  const [w] = await Promise.all([app.waitForEvent('window', { timeout: 15000 }), palette('Abrir la terminal en una ventana nueva')]).catch((e) => {
    console.log(focusLog.join('\n---\n'))
    throw e
  })
  // lo que ya había en la terminal se ve en la ventana nueva: es la misma shell. (Las últimas líneas pueden
  // redibujarse: zsh repinta su prompt al cambiar de ancho, como en cualquier terminal al ensancharla)
  await w.waitForFunction(() => document.querySelector('.panelwin .xterm-rows')?.textContent?.includes('hola-e2e'), null, { timeout: 15000 }).catch(async (e) => {
    await shot(w, 'terminal-ventana-fallo')
    console.log('   principal:', JSON.stringify((await page.$eval('.workspace.active .dock-terminal .xterm-rows', (x) => x.textContent).catch(() => '-')).slice(-300)))
    console.log('   ventana:', w.url(), JSON.stringify(await w.$$eval('.btab', (t) => t.map((x) => x.textContent))), JSON.stringify((await w.$eval('.panelwin .xterm-rows', (x) => x.textContent).catch(() => '-')).slice(-300)))
    throw e
  })
  if ((await display('terminal')) !== 'none') throw new Error('la terminal sigue en la ventana principal')
  await w.click('.panelwin .terminal-host')
  await w.keyboard.type('echo desde-otra-ventana\n')
  await w.waitForFunction(() => document.querySelector('.panelwin .xterm-rows')?.textContent?.match(/desde-otra-ventana[\s\S]*desde-otra-ventana/), null, { timeout: 10000 })
  await shot(w, 'terminal-en-ventana')
  await w.close()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace.active .dock-terminal')).display !== 'none', null, { timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('.workspace.active .dock-terminal .xterm-rows')?.textContent?.includes('desde-otra-ventana'), null, { timeout: 5000 })

  const [w2] = await Promise.all([app.waitForEvent('window'), palette('Abrir el chat en una ventana nueva')])
  await w2.waitForSelector('.panelwin .agent-panel .modebar', { timeout: 15000 })
  await page.waitForSelector('.workspace.active .dock-chat', { state: 'detached', timeout: 5000 })
  await shot(w2, 'chat-en-ventana')
  await w2.close()
  await page.waitForSelector('.workspace.active .dock-chat .agent-panel', { timeout: 5000 })
})

await check('Tema claro', async () => {
  await page.keyboard.press('Meta+K')
  await page.keyboard.type('tema')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.waitForTimeout(300)
  await shot(page, 'tema-claro')
  await page.keyboard.press('Meta+K')
  await page.keyboard.type('tema')
  await page.keyboard.press('Enter')
})

await check('Ajustes muestra cuentas, versiones y avisos reales', async () => {
  await page.click('.tabbar .tb-btn[title^="Ajustes"]')
  await page.waitForSelector('.agent-card', { timeout: 10000 })
  await page.waitForTimeout(300)
  await shot(page, 'ajustes')
  await page.keyboard.press('Escape')
})

await check('Cerrar y reabrir la app restaura pestañas, paneles y conversaciones', async () => {
  await page.waitForTimeout(800) // deja que se guarde el layout (debounce)
  await app.close()
  ;({ app, page } = await launch())
  await page.waitForSelector('.ptab:nth-child(2)', { timeout: 20000 })
  const active = await page.$eval('.ptab.active .ptab-name', (e) => e.textContent)
  if (active !== 'tienda-web') throw new Error(`pestaña activa: ${active}`)
  await page.waitForSelector('.workspace.active .tab', { timeout: 10000 }) // el fichero abierto en el editor
  await page.waitForSelector('.workspace.active .repo-row', { timeout: 10000 }) // la barra lateral seguía en Git
  if (!(await page.$('.workspace.active .dock-terminal .xterm'))) throw new Error('no se restauró la terminal')
  // la terminal sigue donde se dejó: al lado del chat, arriba, y la web debajo
  const [t, w, c] = await Promise.all(['terminal', 'web', 'chat'].map((p) => page.locator(`.workspace.active .dock-${p}`).boundingBox()))
  if (Math.abs(t.y - c.y) > 2 || w.y < c.y + c.height - 2) throw new Error('no se restauró dónde estaba cada panel')
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace.active .web-tab')].some((e) => e.textContent.includes('Página E2E')), null, { timeout: 15000 }).catch(() => {
    throw new Error('no se restauraron las pestañas web')
  })
  if (!skipAgents) {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.workspace.active .reply.agent-claude .msg-assistant')].some((e) => /LISTO/.test(e.textContent)),
      null,
      { timeout: 10000 }
    ).catch(() => {
      throw new Error('no se restauró la conversación con los dos')
    })
    await page.keyboard.press('Meta+Shift+C')
    await page.waitForFunction(() => document.querySelectorAll('.workspace.active .chat-row').length >= 3, null, { timeout: 10000 }).catch(() => {
      throw new Error('no aparecen las conversaciones en el historial')
    })
  }
  await shot(page, 'restaurado')
})

await check('Diseños, prompts con /, servidor de desarrollo y errores de la web al chat', async () => {
  const P = '.workspace.active '
  const palette = async (q) => {
    await page.keyboard.press('Meta+K')
    await page.waitForSelector('.palette-input input')
    await page.keyboard.type(q)
    await page.keyboard.press('Enter')
  }
  // diseño de serie: sin barra lateral ni agentes, con web y terminal
  await palette('Diseño: Frontend')
  await page.waitForSelector(P + '.dock-sidebar', { state: 'detached', timeout: 3000 })
  await page.waitForSelector(P + '.dock-agents', { state: 'detached', timeout: 3000 })
  await page.waitForSelector(P + '.dock-web', { timeout: 3000 })

  // /revisa al principio del mensaje se cambia por su texto
  const ta = page.locator(P + '.agent-col.unified textarea')
  await ta.click()
  await ta.fill('')
  await page.keyboard.type('/rev')
  await page.waitForSelector(P + '.mentions .menu-item:has-text("/revisa")', { timeout: 3000 })
  await page.keyboard.press('Enter')
  if (!(await ta.inputValue()).startsWith('Revisa los cambios sin commitear')) throw new Error(`/revisa no se expandió: ${await ta.inputValue()}`)
  await ta.fill('')

  // ▶ arranca `npm run dev` y su localhost se abre solo en la web
  await page.click(P + '.bottom-tabs .icon-btn[title^="Arrancar el servidor"]')
  await page.waitForSelector(P + '.btab.dev', { timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('.workspace.active .web-tab.on')?.textContent?.includes('Dev E2E'), null, { timeout: 30000 })

  // la página tiene un error de consola y una petición 404: el aviso los cuenta y los pasa al chat
  await page.waitForFunction(() => +(document.querySelector('.workspace.active .web-issues-btn.err')?.textContent ?? 0) >= 2, null, { timeout: 10000 })
  await page.click(P + '.web-issues-btn')
  await shot(page, 'errores-web')
  await page.click(P + '.web-issues button:has-text("Pedir que lo arreglen")')
  // el cuadro coloca el cursor al final en el siguiente fotograma: se espera a que tenga el foco
  await page.waitForFunction(() => document.activeElement?.matches('.workspace.active .agent-col.unified textarea'))
  const msg = await ta.inputValue()
  if (!msg.includes('Fallo E2E: carrito no está definido') || !/404 GET http:\/\/localhost:\d+\/api\/no-existe/.test(msg)) throw new Error(`mensaje: ${msg.slice(0, 200)}`)
  await ta.fill('')

  // 📷 una captura de la página queda adjunta en el chat
  await page.click(P + '.web-bar .icon-btn[title^="Enviar una captura"]')
  await page.waitForSelector(P + '.agent-col.unified .attach-strip .attach img', { timeout: 5000 })
  await page
    .waitForFunction(() => document.querySelector('.workspace.active .agent-col.unified textarea')?.value.startsWith('Captura de http://localhost:'), null, { timeout: 3000 })
    .catch(async () => {
      throw new Error(`la captura no dejó su texto: ${JSON.stringify(await ta.inputValue())}`)
    })
  await shot(page, 'captura-en-chat')
  await page.hover(P + '.agent-col.unified .attach')
  await page.click(P + '.agent-col.unified .attach-x')
  await ta.fill('')
})

await app.close()
web.close()

const failed = results.filter((r) => !r.ok)
const relevant = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e))
console.log(`\n${results.length - failed.length}/${results.length} pasos correctos · capturas en ${shots}`)
if (relevant.length) console.log('Errores de la página:\n  ' + relevant.slice(0, 15).join('\n  '))
process.exit(failed.length ? 1 : 0)
