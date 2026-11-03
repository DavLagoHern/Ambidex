import { execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppUpdate } from '../src/shared/types'
import { AppUpdater, type Exec } from '../src/main/app-update'
import { cleanupTmp, tmpDir } from './helpers'

afterAll(cleanupTmp)

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string, content: string) => {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', `cambia ${file}`)
}

// «GitHub» (repositorio desnudo), el clon desde el que se instaló la app y otro clon que publica cambios
function setup() {
  const root = tmpDir('ambidex-update-')
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const dev = join(root, 'dev')
  git(root, 'clone', '-q', origin, dev)
  commit(dev, 'package.json', JSON.stringify({ name: 'ambidex', version: '0.2.0' }))
  commit(dev, 'package-lock.json', '{}')
  git(dev, 'push', '-q', '-u', 'origin', 'main')
  const source = join(root, 'source')
  git(root, 'clone', '-q', origin, source)
  const built = git(source, 'rev-parse', 'HEAD')

  const npm: string[][] = []
  const states: AppUpdate[] = []
  let npmFails: string | undefined
  const run = (args: string[]) =>
    new Promise<Exec>((resolve) =>
      execFile('git', args, { cwd: source, env: ENV }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    )
  const make = (opts: { source?: string; builtCommit?: string } = { source, builtCommit: built }) =>
    new AppUpdater({
      ...opts,
      exists: existsSync,
      git: run,
      npm: async (args) => {
        npm.push(args)
        return npmFails && args.join(' ').includes(npmFails) ? { code: 1, stdout: '', stderr: 'npm ERR! algo falló\n' } : { code: 0, stdout: '', stderr: '' }
      },
      version: () => JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version,
      onStatus: (s) => states.push(s),
      log: () => {}
    })
  return { dev, source, built, npm, states, make, failNpm: (what: string) => (npmFails = what) }
}

describe('actualización de Ambidex (git pull + compilar)', () => {
  it('sin clon de Git no hace nada', async () => {
    const s = setup()
    expect((await s.make({}).check()).state).toBe('off')
    expect((await s.make({ source: join(s.source, 'no-existe') }).check()).state).toBe('off')
    expect(s.npm).toHaveLength(0)
  })

  it('al día: no descarga ni compila', async () => {
    const s = setup()
    expect(await s.make().check()).toMatchObject({ state: 'current' })
    expect(s.npm).toHaveLength(0)
  })

  it('con commits nuevos: pull, compila (dependencias solo si cambiaron) y queda lista para reiniciar', async () => {
    const s = setup()
    commit(s.dev, 'README.md', 'nuevo')
    commit(s.dev, 'package.json', JSON.stringify({ name: 'ambidex', version: '0.3.0' }))
    git(s.dev, 'push', '-q')
    const u = s.make()
    const r = await u.check()
    expect(r).toMatchObject({ state: 'ready', version: '0.3.0', commits: 2, from: s.built.slice(0, 7) })
    expect(git(s.source, 'rev-parse', 'HEAD')).toBe(git(s.dev, 'rev-parse', 'HEAD'))
    // package.json cambió: npm ci y después la compilación
    expect(s.npm).toEqual([
      ['ci', '--no-audit', '--no-fund'],
      ['run', 'dist']
    ])
    expect(s.states.map((x) => x.state)).toEqual(['checking', 'pulling', 'building', 'building', 'ready'])
    // ya compilada: no se repite hasta reiniciar
    expect((await u.check()).state).toBe('ready')
    expect(s.npm).toHaveLength(2)

    // un cambio que no toca dependencias: solo compila
    const s2 = setup()
    commit(s2.dev, 'src.ts', 'x')
    git(s2.dev, 'push', '-q')
    expect((await s2.make().check()).state).toBe('ready')
    expect(s2.npm).toEqual([['run', 'dist']])
  })

  it('nunca pisa cambios locales ni commits propios', async () => {
    const s = setup()
    commit(s.dev, 'README.md', 'nuevo')
    git(s.dev, 'push', '-q')
    const head = git(s.source, 'rev-parse', 'HEAD')

    writeFileSync(join(s.source, 'package.json'), 'editado a mano')
    const dirty = await s.make().check()
    expect(dirty.state).toBe('blocked')
    expect(dirty.message).toMatch(/sin commitear/)
    expect(git(s.source, 'rev-parse', 'HEAD')).toBe(head)

    git(s.source, 'checkout', '-q', '--', 'package.json')
    commit(s.source, 'mio.txt', 'commit propio')
    const ahead = await s.make().check()
    expect(ahead.state).toBe('blocked')
    expect(ahead.message).toMatch(/commits que no están en GitHub/)
    expect(s.npm).toHaveLength(0)
  })

  it('si la compilación falla, lo dice y se puede reintentar', async () => {
    const s = setup()
    commit(s.dev, 'src.ts', 'x')
    git(s.dev, 'push', '-q')
    s.failNpm('dist')
    const r = await s.make().check()
    expect(r.state).toBe('error')
    expect(r.message).toBe('No se pudo compilar la versión nueva: npm ERR! algo falló')
  })
})
