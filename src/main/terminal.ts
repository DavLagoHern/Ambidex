import { ChildProcess, spawn as spawnChild } from 'child_process'

type Pty = {
  write: (d: string) => void
  resize: (c: number, r: number) => void
  kill: () => void
  // lo último que ha escrito, para enseñarlo en otra ventana que se engancha a esta terminal
  buffer: string
}

const BUFFER = 200_000
const keep = (id: string, d: string) => {
  const t = terms.get(id)
  if (t) t.buffer = (t.buffer + d).slice(-BUFFER)
}

export const hasTerminal = (id: string) => terms.has(id)
export const terminalBuffer = (id: string) => terms.get(id)?.buffer ?? ''

const terms = new Map<string, Pty>()

let nodePty: typeof import('node-pty') | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nodePty = require('node-pty')
} catch {
  nodePty = null // sin módulo nativo: terminal básica sin TTY
}

export interface TermOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  // programa a ejecutar en lugar del shell (p. ej. el login oficial de un CLI)
  command?: { file: string; args: string[] }
}

export function createTerminal(id: string, o: TermOptions, onData: (d: string) => void, onExit: (code: number) => void) {
  killTerminal(id)
  const shell = process.env.SHELL || '/bin/zsh'
  const file = o.command?.file ?? shell
  const args = o.command?.args ?? ['-l']
  const env = { ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Ambidex' } as Record<string, string>
  if (nodePty) {
    const p = nodePty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: o.cwd, env })
    p.onData((d) => (keep(id, d), onData(d)))
    p.onExit(({ exitCode }) => {
      if (terms.get(id)?.kill === kill) terms.delete(id)
      onExit(exitCode)
    })
    const kill = () => p.kill()
    terms.set(id, { write: (d) => p.write(d), resize: (c, r) => p.resize(Math.max(c, 2), Math.max(r, 2)), kill, buffer: '' })
    return
  }
  const c: ChildProcess = spawnChild(file, o.command ? args : ['-i'], { cwd: o.cwd, env })
  c.stdout?.on('data', (d) => (keep(id, d.toString()), onData(d.toString())))
  c.stderr?.on('data', (d) => (keep(id, d.toString()), onData(d.toString())))
  c.on('close', (code) => {
    terms.delete(id)
    onExit(code ?? 0)
  })
  onData('\x1b[33m[Terminal básica: node-pty no disponible, ejecuta `npm run rebuild`]\x1b[0m\r\n')
  terms.set(id, { write: (d) => c.stdin?.write(d.replace(/\r/g, '\n')), resize: () => {}, kill: () => c.kill(), buffer: '' })
}

export const writeTerminal = (id: string, data: string) => terms.get(id)?.write(data)
export const resizeTerminal = (id: string, cols: number, rows: number) => terms.get(id)?.resize(cols, rows)

export function killTerminal(id: string) {
  const t = terms.get(id)
  terms.delete(id)
  t?.kill()
}

export const killAllTerminals = () => [...terms.keys()].forEach(killTerminal)
