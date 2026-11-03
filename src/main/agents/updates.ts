import { readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentId, CliUpdate } from '@shared/types'
import { AGENTS } from '@shared/types'

// Actualización de los CLI: cada pocas horas se compara la versión instalada con la publicada en npm (donde
// salen también las de Homebrew y los instaladores propios) y, si hay una nueva, se instala con lo mismo que se
// usó para instalarlo. Nunca mientras ese agente está trabajando.

export const CLI_PACKAGES: Record<AgentId, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }

export const parseVersion = (s?: string) => s?.match(/\d+\.\d+\.\d+/)?.[0]

// a > b, con versiones x.y.z
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}

export interface UpdatePlan {
  method: string
  file: string
  args: string[]
}

const realOf = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Cómo se instaló un CLI y con qué orden se actualiza (programa y argumentos, sin shell)
export function updatePlan(agent: AgentId, bin: string, real = realOf(bin)): UpdatePlan | undefined {
  // el binario que trae la extensión de VS Code/Cursor lo actualiza el editor
  if (/\/\.(vscode|cursor)\/extensions\//.test(real)) return undefined
  const cask = real.match(/^(.*)\/Caskroom\/([^/]+)\//)
  if (cask) return { method: 'Homebrew', file: join(cask[1], 'bin', 'brew'), args: ['upgrade', '--cask', cask[2]] }
  const formula = real.match(/^(.*)\/Cellar\/([^/]+)\//)
  if (formula) return { method: 'Homebrew', file: join(formula[1], 'bin', 'brew'), args: ['upgrade', formula[2]] }
  const pkg = CLI_PACKAGES[agent]
  const i = real.indexOf(`/lib/node_modules/${pkg}/`)
  if (i > 0) return { method: 'npm', file: join(real.slice(0, i), 'bin', 'npm'), args: ['install', '-g', `${pkg}@latest`] }
  // instalador propio: `claude update` y `codex update` saben dónde están y cómo cambiarse
  return { method: `${basename(bin)} update`, file: bin, args: ['update'] }
}

// Canal de Claude Code: «stable» si lo eligió el usuario en ~/.claude/settings.json; si no, «latest»
export function claudeChannel(home = homedir()): 'stable' | 'latest' {
  try {
    return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
  } catch {
    return 'latest'
  }
}

export interface UpdaterDeps {
  bin: (agent: AgentId) => string | undefined
  version: (bin: string) => Promise<string | undefined>
  run: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  // hay un turno de este agente en marcha
  busy: (agent: AgentId) => boolean
  onStatus: (s: CliUpdate) => void
  // tras instalar una versión nueva: volver a detectar (versión y catálogo de modelos)
  onUpdated: (agent: AgentId, from: string, to: string) => Promise<unknown>
  log: (msg: string, data?: Record<string, unknown>) => void
  fetch?: typeof fetch
  channel?: (agent: AgentId) => string
  realpath?: (p: string) => string
  retryMs?: number
}

export class CliUpdater {
  private st: Partial<Record<AgentId, CliUpdate>> = {}
  private jobs = new Map<AgentId, Promise<CliUpdate>>()
  private timer?: ReturnType<typeof setTimeout>
  private retry?: ReturnType<typeof setTimeout>

  constructor(private d: UpdaterDeps) {}

  status(): CliUpdate[] {
    return AGENTS.flatMap((a) => (this.st[a] ? [this.st[a]!] : []))
  }

  private set(agent: AgentId, patch: Omit<Partial<CliUpdate>, 'agent'>): CliUpdate {
    const s: CliUpdate = { state: 'checking', ...this.st[agent], ...patch, agent }
    this.st[agent] = s
    this.d.onStatus(s)
    return s
  }

  // Comprueba los dos CLI; con `install`, instala las versiones nuevas
  check(install: boolean): Promise<CliUpdate[]> {
    return Promise.all(AGENTS.map((a) => this.checkOne(a, install)))
  }

  checkOne(agent: AgentId, install: boolean): Promise<CliUpdate> {
    const cur = this.jobs.get(agent)
    if (cur) return cur
    const job = this.run(agent, install)
      .catch((e) => this.set(agent, { state: 'error', message: (e as Error).message, checkedAt: Date.now() }))
      .finally(() => this.jobs.delete(agent))
    this.jobs.set(agent, job)
    return job
  }

  // Primera comprobación poco después de abrir la app y luego cada `everyMs`
  start(install: () => boolean, firstMs = 60_000, everyMs = 6 * 3600_000) {
    const tick = () => {
      this.check(install()).catch(() => {})
      this.timer = setTimeout(tick, everyMs)
    }
    this.timer = setTimeout(tick, firstMs)
  }

  stop() {
    clearTimeout(this.timer)
    clearTimeout(this.retry)
  }

  private async latest(agent: AgentId): Promise<string | undefined> {
    const r = await (this.d.fetch ?? fetch)(`https://registry.npmjs.org/-/package/${CLI_PACKAGES[agent]}/dist-tags`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return undefined
    const tags = (await r.json()) as Record<string, string>
    return parseVersion(tags[this.d.channel?.(agent) ?? 'latest'] ?? tags.latest)
  }

  // un agente estaba trabajando: se vuelve a intentar al rato
  private retrySoon() {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      for (const a of AGENTS) if (this.st[a]?.state === 'waiting') this.checkOne(a, true).catch(() => {})
    }, this.d.retryMs ?? 2 * 60_000)
  }

  private async run(agent: AgentId, install: boolean): Promise<CliUpdate> {
    const bin = this.d.bin(agent)
    if (!bin) return this.set(agent, { state: 'missing', installed: undefined, latest: undefined, method: undefined, message: undefined, checkedAt: Date.now() })
    this.set(agent, { state: 'checking', message: undefined })
    const plan = updatePlan(agent, bin, (this.d.realpath ?? realOf)(bin))
    const [installed, latest] = await Promise.all([this.d.version(bin).then(parseVersion), this.latest(agent).catch(() => undefined)])
    const base = { installed, latest, method: plan?.method, checkedAt: Date.now(), message: undefined }
    if (!installed) return this.set(agent, { ...base, state: 'error', message: 'No se pudo leer la versión instalada' })
    if (!latest) return this.set(agent, { ...base, state: 'error', message: 'No se pudo consultar la última versión publicada (¿sin conexión?)' })
    if (!isNewer(latest, installed)) return this.set(agent, { ...base, state: 'current' })
    if (!plan) return this.set(agent, { ...base, state: 'manual', message: 'Este binario viene con la extensión de tu editor y se actualiza con ella' })
    if (!install) return this.set(agent, { ...base, state: 'available' })
    if (this.d.busy(agent)) {
      this.retrySoon()
      return this.set(agent, { ...base, state: 'waiting', message: 'Se instalará cuando termine el turno en curso' })
    }
    this.set(agent, { ...base, state: 'updating' })
    this.d.log('cli.update.start', { agent, from: installed, to: latest, method: plan.method })
    const r = await this.d.run(plan.file, plan.args)
    const now = parseVersion(await this.d.version(this.d.bin(agent) ?? bin))
    if (now && isNewer(now, installed)) {
      this.d.log('cli.update.done', { agent, from: installed, to: now })
      await this.d.onUpdated(agent, installed, now).catch(() => {})
      return this.set(agent, { ...base, installed: now, state: 'updated', message: `Actualizado de ${installed} a ${now}` })
    }
    const tail = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n')
    this.d.log('cli.update.fail', { agent, code: r.code, tail })
    if (r.code === 0) return this.set(agent, { ...base, state: 'behind', message: `${plan.method} aún no ofrece la ${latest}; se volverá a intentar más tarde` })
    return this.set(agent, { ...base, state: 'error', message: tail || `La actualización terminó con código ${r.code}` })
  }
}
