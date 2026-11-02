// E2E del modo Equipo con Claude Code y Codex reales sobre un repositorio temporal.
// Uso: npm run build && npm run test:e2e:team   (gasta cuota: ~5-8 ejecuciones de agentes)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const shots = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'ambidex-team-shots-'))
mkdirSync(shots, { recursive: true })
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'ambidex-team-data-')))
const repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'ambidex-team-'))), 'calculadora')
mkdirSync(join(repo, 'src'), { recursive: true })
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
g('init', '-q', '-b', 'main')
g('config', 'user.name', 'E2E')
g('config', 'user.email', 'e2e@local')
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'calculadora', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n')
writeFileSync(join(repo, 'src/index.js'), '// calculadora\n')
writeFileSync(join(repo, 'README.md'), '# Calculadora\n')
g('add', '.')
g('commit', '-q', '-m', 'inicial')

const env = { ...process.env, AMBIDEX_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: require('electron'), args: [join(root, 'out/main/index.js')], env, timeout: 60000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
let n = 0
const shot = (name) => page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) })
const status = () => page.$eval('.workspace.active .team-card .team-head .status-chip', (e) => e.textContent.trim()).catch(() => '')
const t0 = Date.now()
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${m}`)
let ok = false

try {
  await page.waitForSelector('.tabbar', { timeout: 30000 })
  await page.evaluate(() => window.bridge.invoke('settings:save', { orchMaxRounds: 1, orchApprovePlan: true, orchMode: 'C' }))
  await page.evaluate((p) => window.bridge.invoke('projects:open', p), repo)
  await page.reload()
  await page.waitForSelector('.workspace.active .agent-col.unified textarea', { timeout: 30000 })

  await page.click('.workspace.active .target-btn')
  await page.click('.workspace.active .menu.up .menu-item:has-text("Equipo")')
  const ta = page.locator('.workspace.active .agent-col.unified textarea')
  await ta.fill(
    'Crea src/suma.js que exporte la función suma(a, b) y src/resta.js que exporte resta(a, b) (módulos ES). ' +
      'Añade test/suma.test.js y test/resta.test.js con node:test y node:assert que las prueben. Las pruebas se ejecutan con npm test. Hazlo simple.'
  )
  await shot('encargo')
  await ta.press('Enter')
  log('Encargo enviado al equipo')

  await page.waitForFunction(() => /Plan listo|Error|ayuda/.test(document.querySelector('.workspace.active .team-card .team-head .status-chip')?.textContent ?? ''), null, { timeout: 6 * 60000 })
  log(`Plan: ${await status()}`)
  await shot('plan')
  const tasks = await page.$$eval('.workspace.active .plan-task', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  console.log('  ' + tasks.join('\n  '))
  await page.click('.workspace.active .team-card button:has-text("Aprobar y empezar")')

  let last = ''
  const deadline = Date.now() + 25 * 60000
  while (Date.now() < deadline) {
    const s = await status()
    if (s !== last) {
      log(`Estado: ${s}`)
      last = s
      if (/Trabajando|Integrando|pruebas/.test(s)) await shot(s.replace(/\W+/g, '-').toLowerCase())
    }
    if (/tu aprobación|Error|ayuda|Cancelado/.test(s) && !/Plan listo/.test(s)) break
    await page.waitForTimeout(3000)
  }
  await shot('resultado')
  const final = await status()
  const rows = await page.$$eval('.workspace.active .task-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  console.log('  ' + rows.join('\n  '))
  const coord = await page.$$eval('.workspace.active .coord-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  console.log('  Coordinación (últimos):\n    ' + coord.join('\n    '))
  if (!/tu aprobación/.test(final)) throw new Error(`terminó en "${final}"`)

  const tests = await page.$eval('.workspace.active .test-result', (e) => e.textContent).catch(() => '')
  log(`Pruebas: ${tests}`)
  await page.click('.workspace.active .team-card button:has-text("Integrar en")')
  await page.waitForFunction(() => /Integrado/.test(document.querySelector('.workspace.active .team-card .team-head .status-chip')?.textContent ?? ''), null, { timeout: 30000 })
  const staged = g('diff', '--cached', '--name-only').trim().split('\n')
  log(`Integrado en main (preparado para commit): ${staged.join(', ')}`)
  if (!staged.some((f) => f.includes('suma'))) throw new Error('no se integró el trabajo del equipo')
  const testRun = execFileSync('npm', ['test'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  log(`npm test en el repositorio del usuario: ${/fail 0/.test(testRun) ? 'OK' : testRun.slice(-300)}`)
  await shot('integrado')
  ok = true
} catch (e) {
  console.log(`✗ ${e.message}`)
  await shot('fallo').catch(() => {})
} finally {
  await app.close().catch(() => {})
  if (errors.length) console.log('Errores de la página:\n  ' + errors.slice(0, 10).join('\n  '))
  console.log(`${ok ? '✓ Equipo real completado' : '✗ Equipo real fallido'} · capturas en ${shots} · repo ${repo}`)
  process.exit(ok ? 0 : 1)
}
