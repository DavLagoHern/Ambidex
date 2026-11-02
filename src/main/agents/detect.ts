import type { AgentAuth, AgentId, AgentInfo, AgentModel, Settings } from '@shared/types'
import { codexDefaultModel, CodexModels, fetchCodexModels, readCodexModels } from './codex'
import { binVersion, findClaude, findCodex, run } from './env'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

// Claude Code acepta alias que siempre apuntan al último modelo de cada familia, o el id completo
const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: '', label: 'Por defecto' },
  { id: 'opus', label: 'Opus (último)' },
  { id: 'sonnet', label: 'Sonnet (último)' },
  { id: 'haiku', label: 'Haiku (último)' },
  { id: 'fable', label: 'Fable (último)' },
  { id: 'best', label: 'El más capaz disponible' },
  { id: 'opus[1m]', label: 'Opus · contexto 1M' },
  { id: 'sonnet[1m]', label: 'Sonnet · contexto 1M' },
  { id: 'opusplan', label: 'Opus planifica + Sonnet ejecuta' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' }
]

export function resolveBin(agent: AgentId, s: Settings): string | undefined {
  return agent === 'claude' ? findClaude(s.claudePath) : findCodex(s.codexPath)
}

// `claude auth status --json` → { loggedIn, authMethod, email, orgName, subscriptionType, … }
export function parseClaudeAuth(stdout: string, code: number): AgentAuth {
  const now = Date.now()
  try {
    const j = JSON.parse(stdout)
    const method = j.authMethod === 'claude.ai' ? 'Cuenta claude.ai' : j.authMethod === 'console' ? 'Anthropic Console' : j.authMethod || j.apiProvider
    return {
      loggedIn: !!j.loggedIn,
      method,
      account: j.email,
      org: j.orgName,
      plan: j.subscriptionType,
      detail: j.loggedIn ? undefined : 'Sin sesión iniciada',
      checkedAt: now
    }
  } catch {
    return { loggedIn: false, detail: stdout.trim() || `claude auth status terminó con código ${code}`, checkedAt: now }
  }
}

// `codex login status` → "Logged in using ChatGPT" / "Logged in using an API key…" / "Not logged in"
export function parseCodexAuth(text: string, code: number): AgentAuth {
  const now = Date.now()
  const t = text.trim()
  const m = t.match(/Logged in using (.+)/i)
  if (m && code === 0) {
    const how = m[1].trim()
    return { loggedIn: true, method: /chatgpt/i.test(how) ? 'Cuenta ChatGPT' : how, checkedAt: now }
  }
  return { loggedIn: false, detail: t || 'Sin sesión iniciada', checkedAt: now }
}

export async function detectAgents(s: Settings, env: NodeJS.ProcessEnv): Promise<{ agents: AgentInfo[]; codexModels?: CodexModels }> {
  let codexModels: CodexModels | undefined
  const claudePath = resolveBin('claude', s)
  const codexPath = resolveBin('codex', s)

  const claude = (async (): Promise<AgentInfo> => {
    const warnings: string[] = []
    const [version, auth] = await Promise.all([
      binVersion(claudePath),
      claudePath ? run(claudePath, ['auth', 'status', '--json'], { env, timeout: 20000 }).then((r) => parseClaudeAuth(r.stdout, r.code)) : undefined
    ])
    if (!claudePath) warnings.push('No se encontró el CLI de Claude Code. Instálalo o indica su ruta.')
    else if (auth && !auth.loggedIn) warnings.push('Claude Code no tiene sesión iniciada.')
    if (auth?.loggedIn && auth.method && !/claude\.ai/i.test(auth.method))
      warnings.push(`Claude Code está autenticado con "${auth.method}", no con tu suscripción.`)
    return {
      agent: 'claude',
      path: claudePath,
      version,
      auth,
      models: CLAUDE_MODELS.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })),
      warnings
    }
  })()

  const codex = (async (): Promise<AgentInfo> => {
    const warnings: string[] = []
    const [version, auth, fetched] = await Promise.all([
      binVersion(codexPath),
      codexPath ? run(codexPath, ['login', 'status'], { env, timeout: 20000 }).then((r) => parseCodexAuth(r.stdout + r.stderr, r.code)) : undefined,
      codexPath ? fetchCodexModels((b, a) => run(b, a, { env, timeout: 25000 }), codexPath).catch(() => undefined) : undefined
    ])
    if (!codexPath) warnings.push('No se encontró el CLI de Codex. Instálalo con `npm i -g @openai/codex` o `brew install codex`.')
    else if (auth && !auth.loggedIn) warnings.push('Codex no tiene sesión iniciada.')
    if (auth?.loggedIn && auth.method && !/chatgpt/i.test(auth.method)) warnings.push(`Codex está autenticado con "${auth.method}", no con tu cuenta ChatGPT.`)
    const cm = fetched ?? readCodexModels()
    codexModels = cm
    if (codexPath && !fetched) warnings.push('No se pudo obtener el catálogo de modelos de Codex; se usa la caché local, que puede no coincidir con tu versión del CLI.')
    const def = codexDefaultModel(cm)
    if (def.warning) warnings.push(def.warning)
    const efforts = [...new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', ...cm.models.flatMap((m) => m.efforts)])]
    const models: AgentModel[] = [
      { id: '', label: `Por defecto${def.model ? ` (${def.model})` : ''}`, efforts },
      ...cm.models.map((m) => ({ ...m, efforts: m.efforts.length ? m.efforts : efforts }))
    ]
    return { agent: 'codex', path: codexPath, version, auth, models, effectiveDefaultModel: def.model, warnings }
  })()

  const agents = await Promise.all([claude, codex])
  return { agents, codexModels }
}

export function loginCommand(agent: AgentId, s: Settings): { file: string; args: string[] } | undefined {
  const bin = resolveBin(agent, s)
  if (!bin) return undefined
  return agent === 'claude' ? { file: bin, args: ['auth', 'login'] } : { file: bin, args: ['login'] }
}
