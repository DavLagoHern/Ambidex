import { randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { snapshot } from './checkpoints'
import { ManagedProcess } from './agents/runner'

export interface ProjectCheck {
  id: string
  label: string
  kind: 'typecheck' | 'build' | 'test'
  // Receta configurada por el proyecto; nunca una cadena interpretada por shell.
  command: string[]
  timeoutMs?: number
}

export interface CheckResult {
  id: string
  check: ProjectCheck
  cwd: string
  runId?: string
  outcome: 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'error'
  tree: string | null
  treeAfter: string | null
  validity: 'current' | 'stale' | 'unverified'
  // Un exit 0 por sí solo no verifica la versión actual del código.
  verified: boolean
  code: number | null
  ms: number
  outputTail: string
}

export interface CheckOptions {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  runId?: string
  onOutput?: (line: string) => void
}

export interface CheckJob {
  id: string
  done: Promise<CheckResult>
  cancel(): void
}

export function detectChecks(cwd: string): ProjectCheck[] {
  const has = (file: string) => existsSync(join(cwd, file))
  const read = (file: string) => { try { return readFileSync(join(cwd, file), 'utf8') } catch { return '' } }
  const checks: ProjectCheck[] = []
  try {
    if (has('package.json')) {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
      const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@/)?.[1] : undefined
      const manager = declared ?? (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm')
      for (const [kind, label] of [['typecheck', 'Comprobar tipos'], ['build', 'Compilar'], ['test', 'Ejecutar pruebas']] as const) {
        const script = pkg.scripts?.[kind]
        if (typeof script !== 'string' || !script.trim() || (kind === 'test' && /no test specified/i.test(script))) continue
        checks.push({ id: kind, label, kind, command: [manager, ...(kind === 'test' ? ['test'] : ['run', kind])] })
      }
    }
  } catch { /* un manifiesto inválido no inventa comprobaciones disponibles */ }
  if (!checks.some(c => c.kind === 'test')) {
    let command: string[] | undefined
    if (has('pytest.ini') || has('conftest.py') || /pytest/.test(read('pyproject.toml'))) command = ['python3', '-m', 'pytest']
    else if (has('go.mod')) command = ['go', 'test', './...']
    else if (has('Cargo.toml')) command = ['cargo', 'test']
    else if (has('Package.swift')) command = ['swift', 'test']
    if (command) checks.push({ id: 'test', label: 'Ejecutar pruebas', kind: 'test', command })
  }
  return checks
}

// Permite sustituir detectTests del Equipo sin duplicar su lógica en el chat.
export function detectTestCommand(cwd: string): string[] | undefined {
  return detectChecks(cwd).find(check => check.kind === 'test')?.command
}

// Al mostrar o consumir una evidencia, comprobar que ningún turno posterior la
// haya dejado antigua. No cambia el resultado original guardado en el historial.
export async function isCheckResultCurrent(result: CheckResult): Promise<boolean> {
  return result.validity === 'current' && !!result.tree && await snapshot(result.cwd) === result.tree
}

export class CheckRunner {
  private active = new Map<string, { abort: AbortController; done: Promise<CheckResult> }>()
  private stopped = false

  runningCount() { return this.active.size }

  start(cwd: string, check: ProjectCheck, options: CheckOptions = {}): CheckJob {
    if (this.stopped) throw new Error('El ejecutor de comprobaciones está cerrado')
    if (!Array.isArray(check.command) || !check.command.length || check.command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !check.command[0].trim()) {
      throw new Error('La comprobación necesita un ejecutable y argumentos válidos')
    }
    if (check.timeoutMs !== undefined && (!Number.isFinite(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 600_000)) {
      throw new Error('El tiempo máximo debe estar entre 1 y 600000 ms')
    }
    const root = realpathSync(cwd), id = randomUUID(), abort = new AbortController()
    // No permitir que el llamador modifique la receta mientras se obtiene el tree.
    const recipe = { ...check, command: [...check.command] }
    const cancel = () => abort.abort()
    if (options.signal?.aborted) cancel()
    else options.signal?.addEventListener('abort', cancel, { once: true })
    const done = this.execute(id, root, recipe, abort.signal, options).finally(() => {
      options.signal?.removeEventListener('abort', cancel)
      this.active.delete(id)
    })
    this.active.set(id, { abort, done })
    return { id, done, cancel }
  }

  async stop() {
    this.stopped = true
    const jobs = [...this.active.values()]
    for (const job of jobs) job.abort.abort()
    await Promise.all(jobs.map(job => job.done))
  }

  private async execute(id: string, cwd: string, check: ProjectCheck, signal: AbortSignal, options: CheckOptions): Promise<CheckResult> {
    const started = Date.now()
    let tree: string | null = null, treeAfter: string | null = null, outputTail = '', code: number | null = null
    let outcome: CheckResult['outcome'] = 'cancelled'
    if (!signal.aborted) tree = await snapshot(cwd)
    if (!signal.aborted) {
      let timedOut = false
      const append = (line: string) => {
        outputTail = (outputTail + line + '\n').slice(-20000)
        try { options.onOutput?.(line) } catch { /* el visor no puede detener el ejecutor */ }
      }
      const proc = new ManagedProcess({
        bin: check.command[0], args: check.command.slice(1), cwd,
        env: { ...(options.env ?? process.env), CI: '1', FORCE_COLOR: '0' }, stdin: ''
      }, { onStdout: append, onStderr: append })
      const cancel = () => { void proc.cancel(300) }
      signal.addEventListener('abort', cancel, { once: true })
      // Un abort puede llegar mientras se creaba el proceso.
      if (signal.aborted) cancel()
      const timer = setTimeout(() => { timedOut = true; cancel() }, check.timeoutMs ?? 600_000)
      try {
        const exit = await proc.done
        code = exit.code
        if (exit.spawnError) append(exit.spawnError)
        outcome = signal.aborted ? 'cancelled' : timedOut ? 'timed-out' : exit.spawnError ? 'error' : exit.code === 0 ? 'passed' : 'failed'
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
      }
      if (!signal.aborted) treeAfter = await snapshot(cwd)
    }
    if (signal.aborted) outcome = 'cancelled'
    const validity = !tree || !treeAfter ? 'unverified' : tree === treeAfter ? 'current' : 'stale'
    return {
      id, check, cwd, runId: options.runId, outcome, tree, treeAfter, validity,
      verified: outcome === 'passed' && validity === 'current', code,
      ms: Date.now() - started, outputTail: outputTail.trimEnd()
    }
  }
}
