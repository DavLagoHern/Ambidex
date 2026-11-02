import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAdapter } from '../src/main/agents/claude'
import { codexDefaultModel, createCodexAdapter, fetchCodexModels, parseRolloutLimits, readCodexModels } from '../src/main/agents/codex'
import { parseClaudeAuth, parseCodexAuth } from '../src/main/agents/detect'
import type { Adapter } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/types'
import { cleanupTmp, FIXTURES, tmpDir } from './helpers'

afterEach(cleanupTmp)

const replay = (adapter: Adapter, fixture: string): AgentEvent[] => {
  const p = adapter.createParser()
  return readFileSync(join(FIXTURES, fixture), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => p.onLine(l))
}

describe('Claude Code (stream-json real, v2.1.316)', () => {
  const evs = replay(claudeAdapter, 'claude-stream.jsonl')

  it('detecta la sesión y el modelo', () => {
    expect(evs[0]).toEqual({ kind: 'session', sessionId: '3f1c2b4a-1111-4222-8333-944455556666', model: 'claude-opus-5-5' })
  })

  it('emite la herramienta en curso y su resultado', () => {
    const tools = evs.filter((e) => e.kind === 'tool') as Extract<AgentEvent, { kind: 'tool' }>[]
    expect(tools.map((t) => [t.name, t.status, t.input])).toEqual([
      ['Read', 'running', '/repo/a.txt'],
      ['Read', 'done', '/repo/a.txt']
    ])
    expect(tools[1].output).toContain('hola')
  })

  it('emite texto en streaming y el texto final', () => {
    const text = evs.filter((e) => e.kind === 'text') as Extract<AgentEvent, { kind: 'text' }>[]
    expect(text.filter((t) => t.streaming).map((t) => t.text).join('')).toContain('HOLA')
    expect(text.filter((t) => !t.streaming).at(-1)?.text).toBe('HOLA')
  })

  it('emite límites de uso y consumo del turno', () => {
    const limits = evs.find((e) => e.kind === 'limits') as Extract<AgentEvent, { kind: 'limits' }>
    expect(limits.limits.windows).toEqual([
      { label: '5 h', usedPercent: 25, resetsAt: 1793567400 },
      { label: 'Semana', usedPercent: 5, resetsAt: 1794088800 }
    ])
    const usage = evs.find((e) => e.kind === 'usage') as Extract<AgentEvent, { kind: 'usage' }>
    expect(usage.usage.outputTokens).toBe(300)
    expect(usage.usage.costUsd).toBeGreaterThan(0)
  })

  it('informa de permisos denegados y de errores del resultado', () => {
    const p = claudeAdapter.createParser()
    const evs2 = p.onLine(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Fallo',
        usage: {},
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]
      })
    )
    expect(evs2).toContainEqual({ kind: 'permission', denials: [{ tool: 'Bash', input: 'rm -rf build' }] })
    expect(evs2).toContainEqual({ kind: 'error', message: 'Fallo' })
  })

  it('ignora líneas que no son JSON', () => {
    expect(claudeAdapter.createParser().onLine('esto no es json')).toEqual([])
  })

  it('construye argumentos sin el prompt (va por stdin) y con un modo válido', () => {
    const args = claudeAdapter.buildArgs({ cwd: '/r', resumeId: 'abc', model: 'opus', effort: 'high', permission: 'plan' })
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan',
      '--permission-prompts', 'none', '--resume', 'abc', '--model', 'opus', '--effort', 'high'
    ])
    expect(claudeAdapter.buildArgs({ cwd: '/r', permission: 'danger-full-access' })).toContain('acceptEdits')
    const allowed = claudeAdapter.buildArgs({ cwd: '/r', allowedTools: ['Bash(npm test)', 'Bash(git diff *)'] })
    expect(allowed.slice(allowed.indexOf('--allowedTools'), allowed.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'Bash(npm test),Bash(git diff *)'])
  })
})

describe('Codex (exec --json real, v0.155.1)', () => {
  const codex = createCodexAdapter(tmpDir())

  it('normaliza mensajes, comandos y consumo', () => {
    const evs = replay(codex, 'codex-stream.jsonl')
    expect(evs[0]).toEqual({ kind: 'session', sessionId: '01a19838-386f-76f1-a1f6-0440042a6221' })
    const tool = evs.filter((e) => e.kind === 'tool') as Extract<AgentEvent, { kind: 'tool' }>[]
    expect(tool.map((t) => [t.name, t.input, t.status])).toEqual([
      ['Shell', 'cat a.txt', 'running'],
      ['Shell', 'cat a.txt', 'done']
    ])
    expect(evs.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual([
      'Voy a leer a.txt y convertir su contenido a mayúsculas.',
      'HOLA'
    ])
    const usage = evs.find((e) => e.kind === 'usage') as Extract<AgentEvent, { kind: 'usage' }>
    expect(usage.usage).toMatchObject({ inputTokens: 38626 - 31872, cachedTokens: 31872, outputTokens: 73 })
  })

  it('muestra una sola vez el error de modelo no disponible, legible', async () => {
    const p = codex.createParser()
    const evs = readFileSync(join(FIXTURES, 'codex-model-error.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => p.onLine(l))
    const after = await p.onExit!()
    const errors = [...evs, ...after].filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    const msg = (errors[0] as { message: string }).message
    expect(msg).toContain("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.")
    expect(msg).toContain('Elige otro modelo')
    // el aviso interno de metadatos no llega al usuario
    expect(evs.some((e) => e.kind === 'notice')).toBe(false)
  })

  it('usa stdin para el prompt y -c para el sandbox también al reanudar', () => {
    expect(codex.buildArgs({ cwd: '/r', permission: 'read-only', model: 'gpt-6-sol' })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'gpt-6-sol', '-'
    ])
    const resume = codex.buildArgs({ cwd: '/r', resumeId: 'T1', permission: 'workspace-write', effort: 'high' })
    expect(resume.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(resume.slice(-2)).toEqual(['T1', '-'])
    expect(resume).toContain('model_reasoning_effort="high"')
    expect(resume).not.toContain('-s')
  })

  it('detecta un modelo de config.toml que no está disponible para la cuenta', () => {
    const home = tmpDir()
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n')
    writeFileSync(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'medium' },
          { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' }
        ]
      })
    )
    const info = readCodexModels(home)
    expect(info.listed).toEqual(['gpt-6-sol'])
    expect(info.models[0].efforts).toEqual(['low', 'high'])
    const def = codexDefaultModel(info)
    expect(def.model).toBe('gpt-6-sol')
    expect(def.warning).toContain('gpt-6.1-sol')
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6-sol"\n')
    expect(codexDefaultModel(readCodexModels(home))).toEqual({ model: 'gpt-6-sol' })
  })

  it('prefiere el catálogo del CLI instalado a la caché compartida con otros clientes', async () => {
    const home = tmpDir()
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n')
    // la caché la escribió un cliente más nuevo y lista un modelo que este CLI no puede usar
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ client_version: '0.163.0', models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'gpt-6-sol', visibility: 'list' }] }))
    expect(codexDefaultModel(readCodexModels(home)).model).toBe('gpt-6.1-sol')
    const catalog = JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }, { slug: 'gpt-6-sol', visibility: 'list' }] })
    const calls: string[][] = []
    const fetched = await fetchCodexModels(async (_b, a) => (calls.push(a), { code: 0, stdout: catalog }), '/bin/codex', home)
    expect(calls).toEqual([['debug', 'models']])
    expect(codexDefaultModel(fetched!)).toMatchObject({ model: 'gpt-6-astra' })
    expect(await fetchCodexModels(async () => ({ code: 1, stdout: '' }), '/bin/codex', home)).toBeUndefined()
  })

  it('lee los límites del fichero de sesión', () => {
    const home = tmpDir()
    const d = new Date()
    const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ type: 'event_msg', payload: { rate_limits: { primary: { used_percent: 12.4, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 3, window_minutes: 10080 }, plan_type: 'pro' } } })
    writeFileSync(join(dir, 'rollout-T9.jsonl'), `{"type":"x"}\n${line}\n`)
    const l = parseRolloutLimits(`{"a":1}\n${line}\n`, 5)!
    expect(l.windows).toEqual([
      { label: '5 h', usedPercent: 12, resetsAt: 1 },
      { label: 'Semana', usedPercent: 3, resetsAt: undefined }
    ])
    expect(l.plan).toBe('pro')
  })
})

describe('autenticación (salida real de los CLI)', () => {
  it('Claude: cuenta claude.ai con plan', () => {
    const a = parseClaudeAuth(
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'yo@ejemplo.com', orgName: 'Org', subscriptionType: 'team' }),
      0
    )
    expect(a).toMatchObject({ loggedIn: true, method: 'Cuenta claude.ai', account: 'yo@ejemplo.com', plan: 'team', org: 'Org' })
  })

  it('Claude: sin sesión o salida inesperada', () => {
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false }), 1).loggedIn).toBe(false)
    expect(parseClaudeAuth('boom', 1)).toMatchObject({ loggedIn: false, detail: 'boom' })
  })

  it('Codex: ChatGPT, API key y sin sesión', () => {
    expect(parseCodexAuth('Logged in using ChatGPT\n', 0)).toMatchObject({ loggedIn: true, method: 'Cuenta ChatGPT' })
    expect(parseCodexAuth('Logged in using an API key - sk-***', 0)).toMatchObject({ loggedIn: true, method: 'an API key - sk-***' })
    expect(parseCodexAuth('Not logged in', 1).loggedIn).toBe(false)
  })
})
