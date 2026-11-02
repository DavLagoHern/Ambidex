import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer, Server } from 'http'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JevStatus } from '../src/shared/types'
import { DEFAULT_ROUTE_PREFS } from '../src/shared/types'
import { decideRoute, RouteContext } from '../src/shared/router'
import { Dispatcher } from '../src/main/agents/dispatcher'
import { isAlive } from '../src/main/agents/runner'
import { JEV_ASSETS, JEV_CATEGORIES, Jev, parseSums } from '../src/main/jev'
import { memoryStore, tmpDir } from './helpers'

// Una "release" de Jev hecha aquí: mismo formato de paquete, sumas y API que la real (jevos-v5), con un
// servidor falso en Node en lugar del binario. Así se prueba todo el camino sin ejecutar código externo.
const FAKE_JEV = `#!${process.execPath}
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const key = process.env.JEV_API_KEY
const fs = require('fs')
const log = (o) => fs.appendFileSync(__dirname + '/requests.log', JSON.stringify(o) + '\\n')
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ready', model: 'jevos-v5' }))
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + key) return (res.statusCode = 401), res.end('{"detail":"Unauthorized"}')
      const j = JSON.parse(body)
      log(j)
      const msg = String(j.state.message)
      const answers = {}
      for (const [id, q] of Object.entries(j.questions)) {
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: /^(s[ií]|vale|y ahora)/i.test(msg) ? 0.91 : 0.07 }
        else {
          const keys = Object.keys(q.criteria)
          const best = /error|falla|no funciona/i.test(msg) ? 'debug' : /pantalla|css|bonit/i.test(msg) ? 'frontend' : /docker|deploy|despliega/i.test(msg) ? 'terminal' : null
          const probabilities = {}
          for (const k of keys) probabilities[k] = best ? (k === best ? 0.72 : 0.04) : 1 / keys.length
          answers[id] = { type: 'choice', choice: best ?? keys[0], probabilities, confidence: best ? 0.68 : 0 }
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jevos-v5', answers, usage: { input_tokens: 40, output_tokens: 0 } }))
    })
  }).listen(port, '127.0.0.1')
}, 200)
`

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

let server: Server
let base = ''
let releaseDir = ''
let corrupt = false

beforeAll(async () => {
  releaseDir = tmpDir('ambidex-jevrel-')
  const pkg = join(releaseDir, 'pkg', 'jev')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'jev'), FAKE_JEV)
  chmodSync(join(pkg, 'jev'), 0o755)
  execFileSync('tar', ['-czf', join(releaseDir, JEV_ASSETS.bin), '-C', join(releaseDir, 'pkg'), 'jev'])
  const m = join(releaseDir, 'm', 'model')
  mkdirSync(m, { recursive: true })
  writeFileSync(join(m, 'model.json'), '{"name":"jevos-v5"}')
  execFileSync('zip', ['-qr', join(releaseDir, JEV_ASSETS.model), 'model'], { cwd: join(releaseDir, 'm') })
  writeFileSync(
    join(releaseDir, JEV_ASSETS.sums),
    [JEV_ASSETS.bin, JEV_ASSETS.model].map((n) => `${sha(join(releaseDir, n))}  ${n}`).join('\n') + '\n'
  )
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('/').pop() ?? '')
    const f = join(releaseDir, name)
    if (!existsSync(f)) return (res.statusCode = 404), res.end()
    let data = readFileSync(f)
    if (corrupt && name === JEV_ASSETS.model) data = Buffer.concat([data, Buffer.from('x')])
    res.setHeader('content-length', data.length)
    res.end(data)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/download/`
})

afterAll(() => server?.close())

const make = (dir: string, statuses: JevStatus[] = []) =>
  new Jev({ dir, baseUrl: base, anyPlatform: true, idleMs: 60_000, onStatus: (s) => statuses.push(s), log: () => {} })

const ctx = (lastAgent?: 'claude' | 'codex'): RouteContext => ({
  available: { claude: true, codex: true },
  busy: { claude: false, codex: false },
  usage: {},
  lastAgent,
  prefs: DEFAULT_ROUTE_PREFS,
  defaultAgent: 'claude'
})

describe('Jev (modelo local del enrutado)', () => {
  it('lee el SHA256SUMS.txt de la release', () => {
    const m = parseSums(`${'a'.repeat(64)}  jev-macos-arm64.tar.gz\n${'B'.repeat(64)} *otro.zip\nbasura\n`)
    expect(m.get('jev-macos-arm64.tar.gz')).toBe('a'.repeat(64))
    expect(m.get('otro.zip')).toBe('b'.repeat(64))
    expect(m.size).toBe(2)
  })

  it('instala verificando SHA-256, arranca con clave, decide y se detiene', async () => {
    const dir = tmpDir('ambidex-jev-')
    const statuses: JevStatus[] = []
    const jev = make(dir, statuses)
    expect(jev.status().state).toBe('missing')

    await jev.install()
    expect(jev.installed()).toBe(true)
    expect(statuses.some((s) => s.progress?.label === 'Descargando el modelo')).toBe(true)
    expect(jev.status().state).toBe('stopped')
    expect(existsSync(join(dir, 'jevos-v5', 'model', 'model.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'jevos-v5', 'installed.json'), 'utf8')).sha256[JEV_ASSETS.model]).toBe(sha(join(releaseDir, JEV_ASSETS.model)))

    const c = await jev.classify('El botón de pagar da un error en el móvil', { previousAgent: 'Claude Code', previousRequest: 'Haz la pantalla de pago' })
    expect(jev.status().state).toBe('ready')
    expect(c).toMatchObject({ via: 'jev', category: 'debug', followUp: false })
    expect(c.confidence).toBeCloseTo(0.68)

    // la petición lleva el formato de Jev: estado, una pregunta de elección con los 8 tipos y una de sí/no
    const req = JSON.parse(readFileSync(join(dir, 'jevos-v5', 'requests.log'), 'utf8').trim().split('\n')[0])
    expect(req.model).toBe('jev-latest')
    expect(req.state).toEqual({ message: 'El botón de pagar da un error en el móvil', previous_agent: 'Claude Code', previous_request: 'Haz la pantalla de pago' })
    expect(req.questions.category.type).toBe('choice')
    expect(Object.keys(req.questions.category.criteria)).toEqual(Object.keys(JEV_CATEGORIES))
    expect(req.questions.followup.type).toBe('noul')

    // la misma pregunta (vista previa y luego envío) no se repite
    const again = await jev.classify('El botón de pagar da un error en el móvil', { previousAgent: 'Claude Code', previousRequest: 'Haz la pantalla de pago' })
    expect(again.ms).toBe(0)
    expect(readFileSync(join(dir, 'jevos-v5', 'requests.log'), 'utf8').trim().split('\n')).toHaveLength(1)

    // lo que entiende Jev pasa por tus preferencias: depurar → Codex
    const d = decideRoute('El botón de pagar da un error en el móvil', ctx('claude'), c)
    expect(d).toMatchObject({ agent: 'codex', method: 'jev', category: 'debug' })
    expect(d.reason).toContain('Jev 68%')

    // "sí, hazlo" continúa con el mismo agente aunque no tenga tipo de tarea
    const f = await jev.classify('sí, hazlo', { previousAgent: 'Codex' })
    expect(f.followUp).toBe(true)
    expect(f.category).toBeUndefined()
    expect(decideRoute('sí, hazlo', ctx('codex'), f)).toMatchObject({ agent: 'codex', method: 'jev' })

    const pid = Number(readFileSync(join(dir, 'jev.pid'), 'utf8'))
    expect(isAlive(pid)).toBe(true)
    await jev.stop()
    expect(jev.status().state).toBe('stopped')
    await new Promise((r) => setTimeout(r, 100))
    expect(isAlive(pid)).toBe(false)
  }, 30_000)

  it('si la descarga no coincide con la suma publicada, no instala nada', async () => {
    const dir = tmpDir('ambidex-jev-bad-')
    const jev = make(dir)
    corrupt = true
    try {
      await expect(jev.install()).rejects.toThrow(/SHA-256 .* no coincide/)
    } finally {
      corrupt = false
    }
    expect(jev.installed()).toBe(false)
    expect(jev.status().state).toBe('missing')
    expect(jev.status().error).toMatch(/no coincide/)
  }, 30_000)

  it('un servidor que quedó vivo tras un cierre inesperado se detiene al volver a abrir', async () => {
    const dir = tmpDir('ambidex-jev-orphan-')
    const a = make(dir)
    await a.install()
    await a.classify('instala docker', {})
    const pid = Number(readFileSync(join(dir, 'jev.pid'), 'utf8'))
    expect(isAlive(pid)).toBe(true)
    make(dir) // la app "se reabre" sin haber detenido el anterior
    await new Promise((r) => setTimeout(r, 300))
    expect(isAlive(pid)).toBe(false)
  }, 30_000)

  it('si Jev no contesta a tiempo, deciden las reglas y el mensaje no espera', async () => {
    const store = memoryStore()
    store.saveSettings({ routerMode: 'jev' })
    const hang = { classify: () => new Promise<never>(() => {}) }
    const dispatcher = new Dispatcher({ store, service: {} as never, push: () => {}, settings: () => store.getSettings(), available: () => true, jev: hang })
    const t0 = Date.now()
    const d = await dispatcher.preview(null, 'Configura el script de deploy con docker')
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(d).toMatchObject({ agent: 'codex', method: 'rules', category: 'terminal' })
  })
})
