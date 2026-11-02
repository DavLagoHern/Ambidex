import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024

// Logs estructurados (una línea JSON por evento) con rotación simple por tamaño
export class Logger {
  private file: string | null = null

  init(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'main.log')
  }

  get path() {
    return this.file
  }

  log(level: Level, msg: string, data?: Record<string, unknown>) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data })
    if (level === 'error' || level === 'warn') console.error(line)
    else if (process.env.NODE_ENV === 'development') console.log(line)
    if (!this.file) return
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, this.file + '.1')
      appendFileSync(this.file, line + '\n')
    } catch {
      /* el log nunca debe tumbar la app */
    }
  }

  info = (msg: string, data?: Record<string, unknown>) => this.log('info', msg, data)
  warn = (msg: string, data?: Record<string, unknown>) => this.log('warn', msg, data)
  error = (msg: string, data?: Record<string, unknown>) => this.log('error', msg, data)
}

export const logger = new Logger()
