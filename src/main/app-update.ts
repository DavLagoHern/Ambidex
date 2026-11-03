import { join } from 'path'
import type { AppUpdate } from '@shared/types'

// Actualización de Ambidex. La app se instala compilándola desde un clon de GitHub (npm run install:app), así que
// actualizarse es lo mismo que haría uno a mano: traer lo último del repositorio (git pull, solo avance rápido),
// recompilar e instalar. Se comprueba al abrir la app y cada pocas horas. Nunca pisa nada: con ficheros modificados
// o commits propios en el clon, avisa y no toca. La versión nueva se instala al reiniciar (botón) o al salir.

export interface Exec {
  code: number
  stdout: string
  stderr: string
}

export interface AppUpdaterDeps {
  // carpeta del clon desde el que se compiló esta instalación y commit que se compiló
  source?: string
  builtCommit?: string
  exists: (path: string) => boolean
  // git y npm en la carpeta del clon (npm tarda minutos: dependencias y compilación)
  git: (args: string[]) => Promise<Exec>
  npm: (args: string[]) => Promise<Exec>
  // versión de package.json del clon (la que se va a instalar)
  version: () => string | undefined
  onStatus: (s: AppUpdate) => void
  log: (msg: string, data?: Record<string, unknown>) => void
}

class Fail extends Error {}

const lastLine = (s: string) =>
  s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200)

export class AppUpdater {
  private st: AppUpdate
  private job?: Promise<AppUpdate>
  private timer?: ReturnType<typeof setTimeout>

  constructor(private d: AppUpdaterDeps) {
    this.st = { state: d.source ? 'idle' : 'off', source: d.source }
  }

  status(): AppUpdate {
    return this.st
  }

  // al abrir (tras unos segundos, para no competir con el arranque) y cada `everyMs`
  start(enabled: () => boolean, firstMs = 8000, everyMs = 6 * 3600_000) {
    const tick = () => {
      if (enabled()) this.check().catch(() => {})
      this.timer = setTimeout(tick, everyMs)
    }
    this.timer = setTimeout(tick, firstMs)
  }

  stop() {
    clearTimeout(this.timer)
  }

  // una sola comprobación a la vez; con una versión ya compilada no se vuelve a empezar
  check(): Promise<AppUpdate> {
    if (this.st.state === 'ready') return Promise.resolve(this.st)
    return (this.job ??= this.run().finally(() => (this.job = undefined)))
  }

  private set(s: Omit<AppUpdate, 'source' | 'checkedAt'>): AppUpdate {
    this.st = { ...s, source: this.d.source, checkedAt: Date.now() }
    this.d.onStatus(this.st)
    return this.st
  }

  private async git(args: string[], what: string): Promise<string> {
    const r = await this.d.git(args)
    if (r.code !== 0) throw new Fail(`${what}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`)
    return r.stdout.trim()
  }

  private async npm(args: string[], what: string) {
    const r = await this.d.npm(args)
    if (r.code !== 0) throw new Fail(`${what}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`)
  }

  private async run(): Promise<AppUpdate> {
    const { source, builtCommit: built } = this.d
    if (!source || !this.d.exists(join(source, '.git')))
      return this.set({ state: 'off', message: 'Esta instalación no se compiló desde un clon de Git: se actualiza a mano' })
    this.set({ state: 'checking' })
    try {
      await this.git(['fetch', '--quiet', 'origin'], 'No se pudo consultar GitHub')
      const upstream = await this.d.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (upstream.code !== 0) return this.set({ state: 'blocked', message: 'La rama del clon de Ambidex no sigue ninguna rama de GitHub' })
      const [ahead, behind] = (await this.git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], 'No se pudo comparar con GitHub')).split(/\s+/).map(Number)
      const dirty = (await this.git(['status', '--porcelain', '--untracked-files=no'], 'No se pudo leer el clon')) !== ''
      const head = await this.git(['rev-parse', 'HEAD'], 'No se pudo leer el clon')
      // nada que bajar; se recompila solo si el clon está limpio y va por delante de lo instalado (un pull a mano)
      if (!behind && (!built || head === built || dirty)) return this.set({ state: 'current' })
      if (behind) {
        if (dirty) return this.set({ state: 'blocked', commits: behind, message: `Hay cambios sin commitear en ${source}: no se actualiza para no pisarlos` })
        if (ahead) return this.set({ state: 'blocked', commits: behind, message: 'El clon tiene commits que no están en GitHub: actualízalo a mano (git pull)' })
        this.set({ state: 'pulling', commits: behind })
        await this.git(['pull', '--ff-only', '--quiet'], 'No se pudo descargar la versión nueva')
      }
      const now = await this.git(['rev-parse', 'HEAD'], 'No se pudo leer el clon')
      // dependencias: solo si cambiaron (o no se sabe qué se compiló)
      const deps = !built || (await this.d.git(['diff', '--quiet', built, now, '--', 'package.json', 'package-lock.json'])).code !== 0
      this.set({ state: 'building', commits: behind, message: deps ? 'Instalando dependencias…' : 'Compilando…' })
      if (deps) await this.npm(['ci', '--no-audit', '--no-fund'], 'No se pudieron instalar las dependencias')
      if (deps) this.set({ state: 'building', commits: behind, message: 'Compilando…' })
      await this.npm(['run', 'dist'], 'No se pudo compilar la versión nueva')
      const version = this.d.version()
      this.d.log('app.update.ready', { from: built, to: now, version, commits: behind })
      return this.set({ state: 'ready', version, commits: behind, from: built?.slice(0, 7), to: now.slice(0, 7) })
    } catch (e) {
      this.d.log('app.update.error', { error: (e as Error).message })
      return this.set({ state: 'error', message: e instanceof Fail ? e.message : `Error inesperado: ${(e as Error).message}` })
    }
  }
}
