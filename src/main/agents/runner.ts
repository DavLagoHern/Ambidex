import { ChildProcess, execFileSync, spawn } from 'child_process'
import { basename } from 'path'

export interface ProcessSpec {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  // no cerrar stdin al escribir: se podrán añadir mensajes (write) hasta endInput()
  keepOpen?: boolean
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  cancelled: boolean
  spawnError?: string
}

export interface ProcessHandlers {
  onStdout: (line: string) => void
  onStderr: (line: string) => void
}

export interface AgentProcess {
  readonly pid: number | undefined
  readonly done: Promise<ExitInfo>
  readonly inputOpen: boolean
  write(data: string): boolean
  endInput(): void
  cancel(graceMs?: number): Promise<void>
  steer?(text: string, images?: string[]): Promise<boolean>
}

function lineSplitter(onLine: (line: string) => void) {
  let buf = ''
  return {
    push(chunk: string) {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.trim()) onLine(line)
      }
    },
    end() {
      if (buf.trim()) onLine(buf)
      buf = ''
    }
  }
}

// Proceso hijo en su propio grupo: cancelar termina también los comandos que haya lanzado el agente.
export class ManagedProcess {
  readonly child: ChildProcess
  readonly done: Promise<ExitInfo>
  private cancelled = false
  private exited = false
  inputOpen = false

  constructor(spec: ProcessSpec, handlers: { onStdout: (line: string) => void; onStderr: (line: string) => void }) {
    this.child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })
    const out = lineSplitter(handlers.onStdout)
    const err = lineSplitter(handlers.onStderr)
    this.child.stdout?.setEncoding('utf8')
    this.child.stderr?.setEncoding('utf8')
    this.child.stdout?.on('data', (d: string) => out.push(d))
    this.child.stderr?.on('data', (d: string) => err.push(d))
    // EPIPE si el proceso muere antes de leer stdin: no es un error de la app
    this.child.stdin?.on('error', () => {})
    if (spec.keepOpen) this.child.stdin?.write(spec.stdin ?? '')
    else if (spec.stdin !== undefined) this.child.stdin?.end(spec.stdin)
    else this.child.stdin?.end()
    this.inputOpen = !!spec.keepOpen

    this.done = new Promise((resolve) => {
      let spawnError: string | undefined
      this.child.on('error', (e) => {
        spawnError = e.message
        // si ni siquiera llegó a arrancar no habrá 'close' con datos útiles
        if (this.child.pid === undefined && !this.exited) {
          this.exited = true
          resolve({ code: null, signal: null, cancelled: this.cancelled, spawnError })
        }
      })
      this.child.on('close', (code, signal) => {
        out.end()
        err.end()
        if (this.exited) return
        this.exited = true
        resolve({ code, signal, cancelled: this.cancelled, spawnError })
      })
    })
  }

  // añade a la entrada abierta; false si ya se cerró
  write(data: string): boolean {
    if (!this.inputOpen || this.exited || !this.child.stdin?.writable) return false
    this.child.stdin.write(data)
    return true
  }

  endInput() {
    if (!this.inputOpen) return
    this.inputOpen = false
    this.child.stdin?.end()
  }

  get pid() {
    return this.child.pid
  }

  get running() {
    return !this.exited
  }

  // SIGTERM al grupo y, si no termina en `graceMs`, SIGKILL
  async cancel(graceMs = 3000): Promise<void> {
    if (this.exited) return
    this.cancelled = true
    killGroup(this.child.pid, 'SIGTERM')
    const timer = setTimeout(() => killGroup(this.child.pid, 'SIGKILL'), graceMs)
    await this.done
    clearTimeout(timer)
    // el líder puede salir antes que sus hijos
    killGroup(this.child.pid, 'SIGKILL')
  }
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* ya no existe */
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Comprueba que un PID guardado sigue siendo el CLI esperado (los PID se reutilizan)
export function pidMatches(pid: number, bin: string | null): boolean {
  if (!isAlive(pid)) return false
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim()
    return !!bin && cmd.includes(basename(bin))
  } catch {
    return false
  }
}
