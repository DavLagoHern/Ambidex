import { mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEnv } from '../src/main/agents/env'
import { checkExternalUrl, checkGitArgs, PathGuard } from '../src/main/security'
import { cleanupTmp, tmpDir } from './helpers'

afterEach(cleanupTmp)

describe('PathGuard', () => {
  it('permite rutas dentro de los proyectos y bloquea el resto', () => {
    const root = tmpDir()
    mkdirSync(join(root, 'src'))
    const guard = new PathGuard(() => [root])
    expect(guard.allowed(join(root, 'src/app.ts'))).toBe(true)
    expect(guard.allowed(join(root, 'nuevo/dir/fichero.ts'))).toBe(true)
    expect(guard.allowed(join(root, '../fuera.txt'))).toBe(false)
    expect(guard.allowed(root + '-hermano/x')).toBe(false)
    expect(guard.allowed('/etc/passwd')).toBe(false)
    expect(guard.allowed('relativa/x')).toBe(false)
    expect(() => guard.check('/etc/hosts')).toThrow(/fuera de los proyectos/)
  })

  it('no se deja engañar por enlaces simbólicos que salen del proyecto', () => {
    const root = tmpDir()
    const outside = tmpDir()
    symlinkSync(outside, join(root, 'escape'))
    const guard = new PathGuard(() => [root])
    expect(guard.allowed(join(root, 'escape/secreto'))).toBe(false)
  })
})

describe('git:run', () => {
  it('acepta subcomandos del menú de Git', () => {
    expect(checkGitArgs(['stash', 'push', '-u', '-m', 'wip'])).toEqual(['stash', 'push', '-u', '-m', 'wip'])
    expect(checkGitArgs(['push', '-u', 'origin', 'main'])).toHaveLength(4)
  })

  it('rechaza subcomandos y opciones que ejecutan programas', () => {
    expect(() => checkGitArgs(['config', 'core.pager', 'sh'])).toThrow(/no permitido/)
    expect(() => checkGitArgs(['-c', 'core.sshCommand=sh', 'fetch'])).toThrow(/no permitido/)
    expect(() => checkGitArgs(['fetch', '--upload-pack=touch /tmp/x'])).toThrow(/no permitida/)
    expect(() => checkGitArgs(['pull', '--exec', 'x'])).toThrow(/no permitida/)
    expect(() => checkGitArgs(['rebase', '-x', 'touch /tmp/x', 'main'])).toThrow(/no permitida/)
    expect(() => checkGitArgs(['rebase', '-ix', 'sh', 'main'])).toThrow(/no permitida/)
    expect(checkGitArgs(['cherry-pick', '-x', 'abc'])).toHaveLength(3)
    expect(() => checkGitArgs([])).toThrow()
    expect(() => checkGitArgs('push' as unknown)).toThrow()
  })
})

describe('entorno de los agentes', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/Users/x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oa',
    CLAUDE_CODE_SESSION_ID: 'padre',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDECODE: '1',
    CODEX_SANDBOX: 'seatbelt',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ELECTRON_RUN_AS_NODE: '1'
  }

  it('elimina variables de sesiones padre y claves API (usa la suscripción)', () => {
    const env = agentEnv(base, { stripApiKeys: true })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', CLAUDE_CODE_USE_BEDROCK: '1' })
  })

  it('puede conservar las claves si el usuario lo decide', () => {
    expect(agentEnv(base, { stripApiKeys: false }).ANTHROPIC_API_KEY).toBe('sk-ant')
  })
})

describe('enlaces externos', () => {
  it('solo http(s) y mailto', () => {
    expect(checkExternalUrl('https://github.com')).toBe('https://github.com/')
    expect(() => checkExternalUrl('file:///etc/passwd')).toThrow()
    expect(() => checkExternalUrl('javascript:alert(1)')).toThrow()
  })
})
