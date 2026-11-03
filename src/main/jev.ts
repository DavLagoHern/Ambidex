import { ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { arch, cpus, platform } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { JevStatus, JevTest, ModelTier, RouteCategory } from '@shared/types'
import { CATEGORY_CRITERIA, DIFFICULTY_CRITERIA } from '@shared/router'
import type { Classification } from '@shared/router'
import { killGroup, pidMatches } from './agents/runner'

// Jev / jevos (github.com/feder-cr/jev, MIT): modelo local de ~0,9B que solo toma decisiones (sí/no, elegir
// entre opciones) en la CPU; sus autores anuncian decenas de milisegundos, en un M-series medido ≈0,7 s. La app lo descarga cuando el usuario lo pide, verifica
// las sumas SHA-256 publicadas en la release y lo arranca escuchando solo en 127.0.0.1 con una clave aleatoria.

export const JEV_RELEASE = 'jevos-v5'
export const JEV_SOURCE = 'https://github.com/feder-cr/jev'
export const JEV_ASSETS = { bin: 'jev-macos-arm64.tar.gz', model: `${JEV_RELEASE}-openvino-int8.zip`, sums: 'SHA256SUMS.txt' }

// Lo que se le pregunta: tipo de tarea (choice), si el mensaje continúa la petición anterior (sí/no) y su dificultad.
// Los criterios de serie viven en el enrutador compartido; el usuario los puede editar y ampliar (JevContext).
export const JEV_CATEGORIES = CATEGORY_CRITERIA
export const JEV_DIFFICULTY = DIFFICULTY_CRITERIA
const CATEGORY_Q = 'The message is a request to an AI coding assistant. Which kind of task does it ask for?'
const FOLLOWUP_Q =
  'Does the message continue or depend on the previous request in the conversation (like "yes, do it", "and now…", "the same for…") rather than start a new independent task?'
const DIFFICULTY_Q =
  'How demanding is the work the message asks an AI coding assistant to do? If the message continues the previous request, judge the work that request needs.'
// por debajo de esta confianza el tipo de tarea no se usa (0 = reparto uniforme, 1 = seguro)
const MIN_CONFIDENCE = 0.2

export interface JevContext {
  previousAgent?: string
  previousRequest?: string
  // preguntar también la dificultad (para elegir el modelo y el razonamiento)
  difficulty?: boolean
  // criterios del usuario: tipos de tarea (id → descripción) y dificultad; sin ellos, los de serie
  categories?: Record<RouteCategory, string>
  difficultyCriteria?: Record<ModelTier, string>
}

export interface JevDeps {
  dir: string
  onStatus: (s: JevStatus) => void
  log: (msg: string, data?: Record<string, unknown>) => void
  fetch?: typeof fetch
  baseUrl?: string
  idleMs?: number
  startTimeoutMs?: number
  // en pruebas se acepta cualquier plataforma
  anyPlatform?: boolean
}

type Answers = Record<string, { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number }>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) =>
    execFile(cmd, args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`.trim())) : resolve()))
  )
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (m) out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

// carpeta (hasta dos niveles) que contiene el ejecutable `jev`
function findRoot(dir: string, depth = 0): string | null {
  const bin = join(dir, 'jev')
  if (existsSync(bin) && statSync(bin).isFile()) return dir
  if (depth >= 2) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const r = findRoot(join(dir, e.name), depth + 1)
    if (r) return r
  }
  return null
}

export class Jev {
  private proc?: ChildProcess
  private port = 0
  private key = ''
  private starting?: Promise<void>
  private idle?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private st: JevStatus
  private cache = new Map<string, Classification & { probabilities: Partial<Record<RouteCategory, number>>; followP?: number; tierConfidence?: number }>()
  private fetch: typeof fetch

  constructor(private d: JevDeps) {
    this.fetch = d.fetch ?? fetch
    this.st = { state: 'missing', release: JEV_RELEASE, source: JEV_SOURCE, installed: false }
    this.refresh()
    this.killOrphan()
  }

  get home() {
    return join(this.d.dir, JEV_RELEASE)
  }
  private get bin() {
    return join(this.home, 'jev')
  }
  private get pidFile() {
    return join(this.d.dir, 'jev.pid')
  }

  supported() {
    return this.d.anyPlatform || (platform() === 'darwin' && arch() === 'arm64')
  }

  installed() {
    return existsSync(this.bin) && existsSync(join(this.home, 'model')) && existsSync(join(this.home, 'installed.json'))
  }

  status(): JevStatus {
    return this.st
  }

  private set(p: Partial<JevStatus>) {
    this.st = { ...this.st, ...p, installed: this.installed() }
    this.d.onStatus(this.st)
  }

  private refresh() {
    const state = !this.supported() ? 'unsupported' : this.installed() ? (this.proc ? this.st.state : 'stopped') : 'missing'
    this.st = { ...this.st, state, installed: this.installed() }
  }

  // un servidor que quedó vivo tras un cierre inesperado de la app no debe seguir ocupando memoria
  private killOrphan() {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8'))
      if (pid && pidMatches(pid, this.bin)) killGroup(pid, 'SIGTERM')
      unlinkSync(this.pidFile)
    } catch {
      /* no había */
    }
  }

  // ---------- instalación ----------

  async install(): Promise<void> {
    if (this.st.state === 'installing') return
    if (!this.supported()) throw new Error('Jev solo tiene versión para Mac con Apple Silicon')
    mkdirSync(this.d.dir, { recursive: true })
    const free = statfsSync(this.d.dir)
    if (free.bavail * free.bsize < 2.5e9) throw new Error('Hacen falta unos 2,5 GB libres para descargar e instalar Jev')
    const base = this.d.baseUrl ?? `${JEV_SOURCE}/releases/download/${JEV_RELEASE}/`
    const tmp = join(this.d.dir, `.descarga-${Date.now()}`)
    mkdirSync(tmp)
    this.abort = new AbortController()
    try {
      this.set({ state: 'installing', error: undefined, progress: { label: 'Comprobando la versión', done: 0, total: 0 } })
      const sums = parseSums(await (await this.get(base + JEV_ASSETS.sums)).text())
      const verified: Record<string, string> = {}
      for (const [key, label] of [
        ['bin', 'Descargando el programa'],
        ['model', 'Descargando el modelo']
      ] as const) {
        const name = JEV_ASSETS[key]
        const want = sums.get(name)
        if (!want) throw new Error(`${name} no aparece en SHA256SUMS.txt de la release`)
        const got = await this.download(base + name, join(tmp, name), label)
        if (got !== want) throw new Error(`La suma SHA-256 de ${name} no coincide: la descarga está dañada o no es la publicada`)
        verified[name] = got
      }
      this.set({ progress: { label: 'Descomprimiendo', done: 0, total: 0 } })
      const stage = join(tmp, 'x')
      mkdirSync(stage)
      await run('tar', ['-xzf', join(tmp, JEV_ASSETS.bin), '-C', stage])
      const root = findRoot(stage)
      if (!root) throw new Error('El paquete no contiene el ejecutable jev')
      await run('unzip', ['-q', '-o', join(tmp, JEV_ASSETS.model), '-d', root])
      if (!existsSync(join(root, 'model'))) throw new Error('El modelo no trae la carpeta model/')
      chmodSync(join(root, 'jev'), 0o755)
      writeFileSync(join(root, 'installed.json'), JSON.stringify({ release: JEV_RELEASE, source: JEV_SOURCE, installedAt: Date.now(), sha256: verified }, null, 2))
      await this.stop()
      rmSync(this.home, { recursive: true, force: true })
      renameSync(root, this.home)
      this.d.log('jev.installed', { release: JEV_RELEASE })
      this.set({ state: 'stopped', progress: undefined })
    } catch (e) {
      const cancelled = this.abort?.signal.aborted
      this.refresh()
      this.set({ progress: undefined, error: cancelled ? undefined : (e as Error).message })
      if (!cancelled) this.d.log('jev.install.error', { error: (e as Error).message })
      throw cancelled ? new Error('Instalación cancelada') : e
    } finally {
      this.abort = undefined
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  cancelInstall() {
    this.abort?.abort()
  }

  async remove() {
    await this.stop()
    rmSync(this.home, { recursive: true, force: true })
    this.cache.clear()
    this.refresh()
    this.set({ error: undefined })
  }

  private async get(url: string) {
    const r = await this.fetch(url, { redirect: 'follow', signal: this.abort?.signal })
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar ${url.split('/').pop()} (HTTP ${r.status})`)
    return r
  }

  private async download(url: string, dest: string, label: string): Promise<string> {
    const r = await this.get(url)
    const total = Number(r.headers.get('content-length')) || 0
    const hash = createHash('sha256')
    let done = 0
    let last = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        hash.update(chunk)
        done += chunk.length
        if (Date.now() - last > 250) {
          last = Date.now()
          this.set({ progress: { label, done, total } })
        }
        cb(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(r.body as never), meter, createWriteStream(dest))
    this.set({ progress: { label, done, total: total || done } })
    return hash.digest('hex')
  }

  // ---------- servidor ----------

  async ensure(): Promise<void> {
    if (this.proc && this.st.state === 'ready') return this.touch()
    if (!this.installed()) throw new Error('Jev no está instalado')
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async start() {
    this.set({ state: 'starting', error: undefined })
    this.port = await freePort()
    this.key = randomBytes(24).toString('hex')
    // la mitad de los núcleos: rápido sin quitarle fluidez al resto del Mac
    const threads = Math.max(2, Math.min(8, Math.ceil(cpus().length / 2)))
    const p = spawn(this.bin, ['serve', '--host', '127.0.0.1', '--port', String(this.port), '--threads', String(threads)], {
      cwd: this.home,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', JEV_API_KEY: this.key },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    this.proc = p
    if (p.pid) writeFileSync(this.pidFile, String(p.pid))
    let tail = ''
    const keep = (b: Buffer) => (tail = (tail + b.toString()).slice(-2000))
    p.stdout?.on('data', keep)
    p.stderr?.on('data', keep)
    p.on('exit', (code, signal) => {
      if (this.proc !== p) return
      this.proc = undefined
      clearTimeout(this.idle)
      try {
        unlinkSync(this.pidFile)
      } catch {
        /* ya no estaba */
      }
      const crashed = this.st.state !== 'stopped'
      this.d.log('jev.exit', { code, signal, tail: tail.slice(-300) })
      this.set({ state: 'stopped', error: crashed && code ? `Jev se cerró (código ${code}): ${tail.trim().split('\n').pop() ?? ''}` : this.st.error })
    })
    const t0 = Date.now()
    const deadline = t0 + (this.d.startTimeoutMs ?? 90_000)
    while (Date.now() < deadline) {
      if (this.proc !== p) throw new Error(`Jev no pudo arrancar: ${tail.trim().split('\n').slice(-2).join(' ') || 'se cerró'}`)
      try {
        const r = await this.fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })
        const j = r.ok ? ((await r.json()) as { status?: string }) : null
        if (j?.status === 'ready') {
          this.d.log('jev.ready', { ms: Date.now() - t0, threads })
          this.set({ state: 'ready' })
          return this.touch()
        }
      } catch {
        /* todavía cargando */
      }
      await sleep(250)
    }
    await this.stop()
    throw new Error('Jev tardó demasiado en arrancar')
  }

  private touch() {
    clearTimeout(this.idle)
    // libera ~1 GB de memoria cuando no se usa
    this.idle = setTimeout(() => this.stop(), this.d.idleMs ?? 10 * 60_000)
  }

  async stop() {
    clearTimeout(this.idle)
    const p = this.proc
    if (!p) return
    this.set({ state: 'stopped' })
    killGroup(p.pid, 'SIGTERM')
    const until = Date.now() + 3000
    while (p.exitCode === null && p.signalCode === null && Date.now() < until) await sleep(50)
    if (p.exitCode === null && p.signalCode === null) killGroup(p.pid, 'SIGKILL')
  }

  // ---------- decisiones ----------

  private async ask(state: Record<string, unknown>, questions: Record<string, unknown>, timeoutMs: number): Promise<Answers> {
    await this.ensure()
    const r = await this.fetch(`http://127.0.0.1:${this.port}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const j = (await r.json().catch(() => null)) as { answers?: Answers; detail?: unknown } | null
    if (!r.ok || !j?.answers) throw new Error(`Jev respondió ${r.status}: ${JSON.stringify(j?.detail ?? j).slice(0, 200)}`)
    this.touch()
    return j.answers
  }

  // Tipo de tarea, si continúa la conversación y (si se pide) su dificultad, en una sola petición. Las
  // respuestas se guardan un rato: la vista previa mientras se escribe y el envío hacen la misma pregunta.
  async classify(text: string, ctx: JevContext, timeoutMs = 4000) {
    const state: Record<string, unknown> = { message: text.slice(0, 3000) }
    if (ctx.previousAgent) {
      state.previous_agent = ctx.previousAgent
      if (ctx.previousRequest) state.previous_request = ctx.previousRequest.slice(0, 600)
    }
    const categories = ctx.categories && Object.keys(ctx.categories).length ? ctx.categories : JEV_CATEGORIES
    const levels = ctx.difficultyCriteria ?? JEV_DIFFICULTY
    const key = JSON.stringify([state, !!ctx.difficulty, categories, ctx.difficulty ? levels : null])
    const hit = this.cache.get(key)
    if (hit) return { ...hit, ms: 0 }
    const questions: Record<string, unknown> = { category: { type: 'choice', instructions: CATEGORY_Q, criteria: categories } }
    if (ctx.previousAgent) questions.followup = { type: 'noul', instructions: FOLLOWUP_Q }
    if (ctx.difficulty) questions.difficulty = { type: 'choice', instructions: DIFFICULTY_Q, criteria: levels }
    const t0 = Date.now()
    const a = await this.ask(state, questions, timeoutMs)
    const ms = Date.now() - t0
    const cat = a.category
    const confidence = cat?.confidence
    const category = cat?.choice && cat.choice in categories && (confidence ?? 0) >= MIN_CONFIDENCE ? (cat.choice as RouteCategory) : undefined
    const followP = a.followup?.noul
    const dif = a.difficulty
    const out = {
      via: 'jev' as const,
      category,
      confidence,
      followUp: (followP ?? 0) >= 0.5,
      followP,
      tier: dif?.choice && dif.choice in levels && (dif.confidence ?? 0) >= MIN_CONFIDENCE ? (dif.choice as ModelTier) : undefined,
      tierConfidence: dif?.confidence,
      probabilities: (cat?.probabilities ?? {}) as Partial<Record<RouteCategory, number>>
    }
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, out)
    this.set({ lastMs: ms })
    return { ...out, ms }
  }

  async test(text: string, ctx: JevContext = {}): Promise<JevTest> {
    const c = await this.classify(text, { ...ctx, difficulty: true }, 120_000)
    return { ms: c.ms, category: c.category, confidence: c.confidence, probabilities: c.probabilities, followUp: c.followP, tier: c.tier, tierConfidence: c.tierConfidence }
  }
}
