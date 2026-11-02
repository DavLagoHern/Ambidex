import { execFile, execFileSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Las apps lanzadas desde Finder no heredan el PATH del shell: lo leemos del login shell.
export function loadShellPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { encoding: 'utf8', timeout: 5000 })
    const m = out.match(/__P__(.*)__P__/)
    if (m) process.env.PATH = m[1]
  } catch {
    process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':')
  }
}

export function which(cmd: string, path = process.env.PATH || ''): string | undefined {
  for (const dir of path.split(':')) {
    if (!dir) continue
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  return undefined
}

// Claude Code: ruta configurada, PATH, instalaciones locales y el binario de la extensión de VS Code/Cursor
export function findClaude(override?: string): string | undefined {
  if (override && existsSync(override)) return override
  const fromPath = which('claude')
  if (fromPath) return fromPath
  const home = homedir()
  for (const c of [join(home, '.claude/local/claude'), join(home, '.local/bin/claude')]) if (existsSync(c)) return c
  for (const extDir of [join(home, '.vscode/extensions'), join(home, '.cursor/extensions')]) {
    if (!existsSync(extDir)) continue
    const found = readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .map((d) => join(extDir, d, 'resources/native-binary/claude'))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    if (found[0]) return found[0]
  }
  return undefined
}

export function findCodex(override?: string): string | undefined {
  if (override && existsSync(override)) return override
  return which('codex')
}

export function run(bin: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? 15000, env: opts.env ?? process.env, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function binVersion(bin?: string): Promise<string | undefined> {
  if (!bin) return undefined
  const r = await run(bin, ['--version'], { timeout: 10000 })
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : undefined
}

// Variables que una sesión de Claude Code/Codex exporta a sus procesos hijos. Si la app se lanza desde una
// de esas terminales, los agentes las heredarían y se engancharían a la sesión padre.
const SESSION_VARS = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_AGENT_SDK_VERSION$/,
  /^CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|STARTUP_FAILURE_RESULTS|QUESTION_PREVIEW_FORMAT|ENABLE_SDK_FILE_CHECKPOINTING|ENABLE_TASKS)$/,
  /^CLAUDE_CODE_MESSAGING_/,
  /^CODEX_(THREAD_ID|SANDBOX|SANDBOX_NETWORK_DISABLED)$/,
  /^ELECTRON_RUN_AS_NODE$/
]

// Con estas variables los CLI usarían facturación por API en lugar de la suscripción del usuario
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']

export function agentEnv(base: NodeJS.ProcessEnv, opts: { stripApiKeys: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (SESSION_VARS.some((re) => re.test(k))) continue
    if (opts.stripApiKeys && API_KEY_VARS.includes(k)) continue
    env[k] = v
  }
  return env
}
