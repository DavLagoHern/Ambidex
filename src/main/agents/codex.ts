import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentEvent, AgentLimits, AgentModel, CodexSandbox, LimitWindow } from '@shared/types'
import { Adapter, parseJson, RunRequest, short } from './types'
import { CodexLiveProcess } from './codex-live'

const SANDBOXES: CodexSandbox[] = ['read-only', 'workspace-write', 'danger-full-access']

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex')

// ---------- modelos ----------

const levelOf = (x: any) => (typeof x === 'string' ? x : x?.effort)

export interface CodexModels {
  models: AgentModel[]
  // modelos que el servidor ofrece a esta cuenta (visibilidad "list")
  listed: string[]
  configModel?: string
}

function configModelOf(home: string): string | undefined {
  try {
    return readFileSync(join(home, 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
  } catch {
    return undefined
  }
}

// Catálogo con el formato de `codex debug models` (el mismo que models_cache.json)
export function parseCodexCatalog(json: string, configModel?: string): CodexModels {
  let raw: any[] = []
  try {
    raw = JSON.parse(json).models || []
  } catch {
    /* catálogo ilegible */
  }
  const models: AgentModel[] = raw.map((m) => ({
    id: m.slug,
    label: `${m.display_name || m.slug}${m.visibility === 'hide' ? ' (oculto)' : ''}`,
    efforts: (m.supported_reasoning_levels || []).map(levelOf).filter(Boolean),
    defaultEffort: m.default_reasoning_level,
    hidden: m.visibility === 'hide' || undefined
  }))
  return { models, listed: raw.filter((m) => m.visibility !== 'hide').map((m) => m.slug), configModel }
}

// Respaldo: la caché en disco. Ojo: la comparten otros clientes de Codex (app de escritorio, extensiones)
// y puede listar modelos que esta versión del CLI no puede usar.
export function readCodexModels(home = codexHome()): CodexModels {
  let json = '{}'
  try {
    json = readFileSync(join(home, 'models_cache.json'), 'utf8')
  } catch {
    /* sin caché */
  }
  return parseCodexCatalog(json, configModelOf(home))
}

// Fuente fiable: el catálogo que el servidor ofrece a la versión instalada del CLI
export async function fetchCodexModels(
  run: (bin: string, args: string[]) => Promise<{ code: number; stdout: string }>,
  bin: string,
  home = codexHome()
): Promise<CodexModels | undefined> {
  const r = await run(bin, ['debug', 'models'])
  if (r.code !== 0) return undefined
  const info = parseCodexCatalog(r.stdout, configModelOf(home))
  return info.models.length ? info : undefined
}

// Modelo efectivo cuando la conversación no fija ninguno, con avisos si config.toml apunta a uno inexistente
export function codexDefaultModel(info: CodexModels): { model?: string; warning?: string } {
  if (!info.listed.length) return { model: info.configModel }
  if (!info.configModel) return {}
  if (info.models.some((m) => m.id === info.configModel)) return { model: info.configModel }
  return {
    model: info.listed[0],
    warning: `~/.codex/config.toml usa el modelo "${info.configModel}", que no está disponible para tu cuenta. Se usará ${info.listed[0]} salvo que elijas otro.`
  }
}

// ---------- límites (Codex los escribe en el fichero de sesión, no en el stream) ----------

function windowLabel(minutes?: number) {
  if (!minutes) return 'Ventana'
  if (minutes === 300) return '5 h'
  if (minutes === 10080) return 'Semana'
  if (minutes % 1440 === 0) return `${minutes / 1440} d`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

export function parseRolloutLimits(text: string, mtime: number): AgentLimits | undefined {
  const idx = text.lastIndexOf('"rate_limits":{')
  if (idx < 0) return undefined
  const start = text.lastIndexOf('\n', idx) + 1
  const end = text.indexOf('\n', idx)
  const d = parseJson(text.slice(start, end < 0 ? undefined : end))
  const rl = d?.payload?.rate_limits || d?.rate_limits
  if (!rl) return undefined
  const windows: LimitWindow[] = []
  for (const w of [rl.primary, rl.secondary])
    if (w) windows.push({ label: windowLabel(w.window_minutes), usedPercent: Math.round(w.used_percent ?? 0), resetsAt: w.resets_at })
  return { agent: 'codex', windows, plan: rl.plan_type, status: rl.rate_limit_reached_type ? 'limit_reached' : 'allowed', updatedAt: mtime }
}

function sessionDirs(home: string): string[] {
  const base = join(home, 'sessions')
  const dirs: string[] = []
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.now() - back * 86400000)
    const p = join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    if (existsSync(p)) dirs.push(p)
  }
  return dirs
}

export function limitsForThread(threadId: string, home = codexHome()): AgentLimits | undefined {
  for (const dir of sessionDirs(home)) {
    const f = readdirSync(dir).find((n) => n.includes(threadId))
    if (f) {
      const p = join(dir, f)
      return parseRolloutLimits(readFileSync(p, 'utf8'), statSync(p).mtimeMs)
    }
  }
  return undefined
}

export function latestCodexLimits(home = codexHome()): AgentLimits | undefined {
  const files = sessionDirs(home)
    .flatMap((dir) => readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const f of files.slice(0, 5)) {
    const l = parseRolloutLimits(readFileSync(f, 'utf8'), statSync(f).mtimeMs)
    if (l) return l
  }
  return undefined
}

// ---------- adaptador ----------

export function prettyCodexError(msg?: string): string {
  if (!msg) return 'Error de Codex'
  const j = parseJson(msg)
  const text: string = j?.error?.message || j?.message || msg
  if (j?.error?.code === 'model_not_found' || /model is not supported/i.test(text))
    return `${text}\nElige otro modelo en el selector de la conversación o actualiza Codex (brew upgrade --cask codex).`
  return text
}

// Avisos internos de Codex que no aportan nada al usuario
const NOISE = /Skill descriptions were shortened|Model metadata for .* not found/

function toolItem(item: any, done: boolean): AgentEvent | null {
  switch (item.type) {
    case 'command_execution':
      return {
        kind: 'tool',
        id: item.id,
        name: 'Shell',
        input: String(item.command ?? '').replace(/^\/bin\/(z|ba)?sh -lc /, '').replace(/^'(.*)'$/s, '$1'),
        status: !done ? 'running' : item.exit_code === 0 || (item.exit_code == null && item.status === 'completed') ? 'done' : 'error',
        output: done
          ? item.status === 'declined'
            ? 'Denegado por el sandbox de Codex (cambia el modo de permisos de la conversación para permitirlo).'
            : short(item.aggregated_output ?? '') + (item.exit_code ? `\n[exit ${item.exit_code}]` : '')
          : undefined
      }
    case 'collab_tool_call':
      return {
        kind: 'tool',
        id: item.id,
        name: 'Subagente',
        input: `${item.tool ?? ''} ${short(item.prompt ?? '', 300)}`.trim(),
        status: !done ? 'running' : item.status === 'failed' ? 'error' : 'done'
      }
    case 'mcp_tool_call':
      return {
        kind: 'tool',
        id: item.id,
        name: `${item.server}.${item.tool}`,
        input: short(item.arguments ?? '', 600),
        status: !done ? 'running' : item.error ? 'error' : 'done',
        output: done ? short(item.error?.message ?? item.result ?? '') : undefined
      }
    case 'web_search':
      return { kind: 'tool', id: item.id, name: 'WebSearch', input: String(item.query ?? ''), status: done ? 'done' : 'running' }
    default:
      return null
  }
}

export function createCodexAdapter(home = codexHome()): Adapter {
  return {
    agent: 'codex',

    buildArgs(req: RunRequest) {
      const sandbox = SANDBOXES.includes(req.permission as CodexSandbox) ? (req.permission as CodexSandbox) : 'workspace-write'
      if (req.stream) return ['app-server', '-c', `sandbox_mode="${sandbox}"`, ...(req.extra ?? [])]
      // `exec resume` no admite -s: el sandbox se fija con -c, que vale para ambos casos
      const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`]
      if (req.model) common.push('-m', req.model)
      if (req.effort) common.push('-c', `model_reasoning_effort="${req.effort}"`)
      if (req.schema) common.push('--output-schema', req.schema.file)
      if (req.extra?.length) common.push(...req.extra)
      // --image=ruta (con «=»): «-i» acepta varios valores y se comería el «-» del prompt
      for (const p of req.images ?? []) common.push(`--image=${p}`)
      // "-" = leer el prompt de stdin
      return req.resumeId ? ['exec', 'resume', ...common, req.resumeId, '-'] : ['exec', ...common, '-']
    },

    streams: (req) => !req.schema,
    startProcess: (spec, req, handlers) => new CodexLiveProcess(spec, req, handlers),

    createParser() {
      let threadId: string | undefined
      let pendingError: string | undefined
      return {
        onLine(line) {
          const d = parseJson(line)
          if (!d || typeof d !== 'object') return []
          const out: AgentEvent[] = []
          switch (d.type) {
            case 'thread.started':
              threadId = d.thread_id
              out.push({ kind: 'session', sessionId: d.thread_id })
              break
            case 'item.started':
            case 'item.updated':
            case 'item.completed': {
              const item = d.item || {}
              const done = d.type === 'item.completed'
              if (item.type === 'agent_message') {
                if (done) out.push({ kind: 'text', text: item.text ?? '' })
              } else if (item.type === 'reasoning') {
                if (done && item.text) out.push({ kind: 'thinking', text: item.text })
              } else if (item.type === 'todo_list') {
                out.push({ kind: 'todo', items: (item.items || []).map((t: any) => ({ text: String(t.text ?? ''), done: !!t.completed })) })
              } else if (item.type === 'file_change') {
                if (done) out.push({ kind: 'files', id: item.id, files: (item.changes || []).map((c: any) => ({ path: c.path, change: c.kind })) })
              } else if (item.type === 'error') {
                if (!NOISE.test(item.message ?? '')) out.push({ kind: 'notice', text: item.message })
              } else {
                const ev = toolItem(item, done)
                if (ev) out.push(ev)
              }
              break
            }
            case 'turn.completed': {
              const u = d.usage || {}
              out.push({
                kind: 'usage',
                usage: {
                  inputTokens: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)),
                  cachedTokens: u.cached_input_tokens || 0,
                  outputTokens: u.output_tokens || 0,
                  reasoningTokens: u.reasoning_output_tokens
                }
              })
              break
            }
            case 'turn.failed':
              out.push({ kind: 'error', message: prettyCodexError(d.error?.message) })
              pendingError = undefined
              break
            case 'error':
              // Codex suele repetir el error en turn.failed: solo se muestra si no llega ese evento
              pendingError = prettyCodexError(d.message)
              break
          }
          return out
        },
        async onExit() {
          const out: AgentEvent[] = []
          if (pendingError) out.push({ kind: 'error', message: pendingError })
          const limits = threadId ? limitsForThread(threadId, home) : undefined
          if (limits) out.push({ kind: 'limits', limits })
          return out
        }
      }
    },

    isNoise(line) {
      return /Reading additional input from stdin|OAuth|oauth|refresh_transaction/.test(line)
    }
  }
}
