import { describe, expect, it } from 'vitest'
import type { AgentId, CliUpdate } from '../src/shared/types'
import { CliUpdater, isNewer, parseVersion, updatePlan, UpdaterDeps } from '../src/main/agents/updates'

const tags = (t: Record<string, string>, urls: string[] = []) => (async (url: string) => (urls.push(url), new Response(JSON.stringify(t)))) as unknown as typeof fetch

// Codex instalado con Homebrew en la versión `v`; `run` simula la orden de actualizar
function codexOnly(v: { now: string }, over: Partial<UpdaterDeps> = {}) {
  const runs: string[][] = []
  const statuses: CliUpdate[] = []
  const updated: string[] = []
  const u = new CliUpdater({
    bin: (a: AgentId) => (a === 'codex' ? '/opt/homebrew/bin/codex' : undefined),
    realpath: () => `/opt/homebrew/Caskroom/codex/${v.now}/codex-aarch64-apple-darwin`,
    version: async () => `codex-cli ${v.now}`,
    run: async (file, args) => {
      runs.push([file, ...args])
      v.now = '0.166.0'
      return { code: 0, stdout: '', stderr: '' }
    },
    busy: () => false,
    onStatus: (s) => statuses.push(s),
    onUpdated: async (a, from, to) => updated.push(`${a} ${from}→${to}`),
    log: () => {},
    fetch: tags({ latest: '0.166.0' }),
    ...over
  })
  return { u, runs, statuses, updated }
}

describe('actualización de los CLI', () => {
  it('lee y compara versiones', () => {
    expect(parseVersion('codex-cli 0.166.0')).toBe('0.166.0')
    expect(parseVersion('2.1.316 (Claude Code)')).toBe('2.1.316')
    expect(isNewer('0.166.0', '0.155.1')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('2.1.316', '2.1.316')).toBe(false)
    expect(isNewer('2.1.309', '2.1.316')).toBe(false)
  })

  it('actualiza con lo mismo con que se instaló', () => {
    expect(updatePlan('codex', '/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.166.0/codex-aarch64-apple-darwin')).toEqual({
      method: 'Homebrew',
      file: '/opt/homebrew/bin/brew',
      args: ['upgrade', '--cask', 'codex']
    })
    expect(updatePlan('codex', '/usr/local/bin/codex', '/usr/local/Cellar/codex/0.160.0/bin/codex')?.args).toEqual(['upgrade', 'codex'])
    expect(updatePlan('codex', '/x/codex', '/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js')).toEqual({
      method: 'npm',
      file: '/Users/u/.nvm/versions/node/v22.1.0/bin/npm',
      args: ['install', '-g', '@openai/codex@latest']
    })
    expect(updatePlan('claude', '/Users/u/.local/bin/claude', '/Users/u/.local/share/claude/versions/2.1.316')).toEqual({
      method: 'claude update',
      file: '/Users/u/.local/bin/claude',
      args: ['update']
    })
    // el binario de la extensión de VS Code lo actualiza el editor
    expect(updatePlan('claude', '/a/claude', '/Users/u/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude')).toBeUndefined()
  })

  it('instala la versión nueva, avisa y no repite si ya está al día', async () => {
    const urls: string[] = []
    const { u, runs, statuses, updated } = codexOnly({ now: '0.155.1' }, { fetch: tags({ latest: '0.166.0' }, urls) })
    const [claude, codex] = await u.check(true)
    expect(claude.state).toBe('missing')
    expect(codex).toMatchObject({ state: 'updated', installed: '0.166.0', latest: '0.166.0', method: 'Homebrew', message: 'Actualizado de 0.155.1 a 0.166.0' })
    expect(runs).toEqual([['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex']])
    expect(updated).toEqual(['codex 0.155.1→0.166.0'])
    expect(statuses.map((s) => s.state)).toEqual(['missing', 'checking', 'updating', 'updated'])
    expect(urls).toEqual(['https://registry.npmjs.org/-/package/@openai/codex/dist-tags'])
    expect((await u.checkOne('codex', true)).state).toBe('current')
    expect(runs).toHaveLength(1)
  })

  it('sin instalación automática solo avisa; con el agente trabajando espera', async () => {
    const off = codexOnly({ now: '0.155.1' })
    expect((await off.u.checkOne('codex', false)).state).toBe('available')
    expect(off.runs).toHaveLength(0)

    let busy = true
    const b = codexOnly({ now: '0.155.1' }, { busy: () => busy, retryMs: 30 })
    expect((await b.u.checkOne('codex', true)).state).toBe('waiting')
    expect(b.runs).toHaveLength(0)
    busy = false
    await new Promise((r) => setTimeout(r, 120))
    expect(b.u.status()[0]).toMatchObject({ state: 'updated', installed: '0.166.0' })
    b.u.stop()
  })

  it('si el gestor aún no tiene la versión o la orden falla, lo dice', async () => {
    const behind = codexOnly({ now: '0.155.1' }, { run: async () => ({ code: 0, stdout: 'Warning: Not upgrading codex, the latest version is already installed', stderr: '' }) })
    expect(await behind.u.checkOne('codex', true)).toMatchObject({ state: 'behind', installed: '0.155.1', message: expect.stringContaining('Homebrew aún no ofrece la 0.166.0') })
    expect(behind.updated).toHaveLength(0)

    const fail = codexOnly({ now: '0.155.1' }, { run: async () => ({ code: 1, stdout: '', stderr: 'Error: Permission denied @ rb_sysopen' }) })
    expect(await fail.u.checkOne('codex', true)).toMatchObject({ state: 'error', message: 'Error: Permission denied @ rb_sysopen' })

    const offline = codexOnly({ now: '0.155.1' }, { fetch: (async () => { throw new Error('offline') }) as never })
    expect(await offline.u.checkOne('codex', true)).toMatchObject({ state: 'error', message: expect.stringContaining('última versión') })
  })

  it('Claude Code sigue el canal que elegiste', async () => {
    const runs: string[][] = []
    const u = new CliUpdater({
      bin: (a) => (a === 'claude' ? '/Users/u/.local/bin/claude' : undefined),
      realpath: () => '/Users/u/.local/share/claude/versions/2.1.309',
      version: async () => '2.1.309 (Claude Code)',
      run: async (f, a) => (runs.push([f, ...a]), { code: 0, stdout: '', stderr: '' }),
      busy: () => false,
      onStatus: () => {},
      onUpdated: async () => {},
      log: () => {},
      fetch: tags({ stable: '2.1.309', latest: '2.1.316' }),
      channel: () => 'stable'
    })
    expect(await u.checkOne('claude', true)).toMatchObject({ state: 'current', latest: '2.1.309', method: 'claude update' })
    expect(runs).toHaveLength(0)
  })
})
