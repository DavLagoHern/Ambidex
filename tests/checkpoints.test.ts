import { execFileSync } from 'child_process'
import { chmodSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import { SessionService } from '../src/main/agents/service'
import { snapshot, undo, undoPlan } from '../src/main/checkpoints'
import { cleanupTmp, FAKE_CLI, FIXTURES, memoryStore, tmpDir, waitFor } from './helpers'

afterEach(cleanupTmp)

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function repo() {
  const dir = tmpDir('ambidex-cp-')
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.name', 'T')
  g(dir, 'config', 'user.email', 't@t')
  writeFileSync(join(dir, 'a.txt'), 'a original\n')
  writeFileSync(join(dir, 'b.txt'), 'b original\n')
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hola\n')
  chmodSync(join(dir, 'run.sh'), 0o755)
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  g(dir, 'add', '.')
  g(dir, 'commit', '-q', '-m', 'inicial')
  return dir
}

describe('Puntos de control (deshacer un turno)', () => {
  it('la foto no toca el índice, las ramas, el historial ni el stash', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'preparado\n')
    g(dir, 'add', 'a.txt')
    writeFileSync(join(dir, 'nuevo.txt'), 'sin seguimiento\n')
    writeFileSync(join(dir, 'ignorado.log'), 'x')
    const state = () => [g(dir, 'status', '--porcelain'), g(dir, 'for-each-ref'), g(dir, 'rev-parse', 'HEAD'), g(dir, 'stash', 'list'), g(dir, 'diff', '--cached')]
    const before = state()
    const tree = await snapshot(dir)
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
    expect(state()).toEqual(before)
    const files = g(dir, 'ls-tree', '-r', '--name-only', tree!).split('\n')
    expect(files).toContain('nuevo.txt')
    expect(g(dir, 'show', `${tree}:a.txt`)).toBe('preparado')
  })

  it('deshacer vuelve los ficheros a como estaban, salvo los que cambiaron después', async () => {
    const dir = repo()
    const p = (f: string) => join(dir, f)
    const before = await snapshot(dir)
    // el "agente": modifica, borra, crea y quita el permiso de ejecución
    writeFileSync(p('a.txt'), 'del agente\n')
    rmSync(p('b.txt'))
    writeFileSync(p('creado.txt'), 'nuevo\n')
    writeFileSync(p('c.txt'), 'c del agente\n')
    chmodSync(p('run.sh'), 0o644)
    const after = await snapshot(dir)
    // después el usuario sigue trabajando en c.txt: eso no se toca
    writeFileSync(p('c.txt'), 'c del usuario\n')

    const plan = await undoPlan(dir, before!, after!)
    expect(plan.files.map((f) => [f.path, f.action]).sort()).toEqual([
      ['a.txt', 'restore'],
      ['b.txt', 'restore'],
      ['c.txt', 'conflict'],
      ['creado.txt', 'delete'],
      ['run.sh', 'restore']
    ])
    const r = await undo(dir, before!, after!)
    expect(readFileSync(p('a.txt'), 'utf8')).toBe('a original\n')
    expect(readFileSync(p('b.txt'), 'utf8')).toBe('b original\n')
    expect(existsSync(p('creado.txt'))).toBe(false)
    expect(readFileSync(p('c.txt'), 'utf8')).toBe('c del usuario\n')
    expect(statSync(p('run.sh')).mode & 0o111).not.toBe(0)
    expect(r.skipped).toEqual(['c.txt'])
    expect(g(dir, 'status', '--porcelain')).toBe('?? c.txt')
  })

  it('ve un cambio del mismo tamaño hecho en el mismo segundo que el último commit', async () => {
    const dir = repo()
    // índice y fichero con la misma fecha, como si el agente lo cambiara justo después del commit
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000)
    const index = join(dir, '.git', 'index')
    utimesSync(join(dir, 'a.txt'), t, t)
    g(dir, 'update-index', '--refresh')
    utimesSync(index, t, t)
    const before = await snapshot(dir)
    writeFileSync(join(dir, 'a.txt'), 'b original\n') // mismo tamaño
    utimesSync(join(dir, 'a.txt'), t, t)
    const after = await snapshot(dir)
    expect(after).not.toBe(before)
    expect(g(dir, 'show', `${after}:a.txt`)).toBe('b original')
  })

  it('fuera de un repositorio de Git no hay punto de control', async () => {
    expect(await snapshot(tmpDir())).toBeNull()
  })

  it('el servicio hace las fotos de cada turno y lo deja listo para deshacer', async () => {
    const store = memoryStore()
    const dir = repo()
    const project = store.openProject(dir, 'demo', null)
    const service = new SessionService({
      store,
      push: () => {},
      adapters: { claude: claudeAdapter, codex: createCodexAdapter(tmpDir()) },
      resolveBin: () => FAKE_CLI,
      env: () => ({ ...process.env, FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_WRITE: JSON.stringify({ 'a.txt': 'cambiado por el agente\n' }) }),
      defaultModel: () => undefined,
      checkpoint: (cwd) => snapshot(cwd),
      uiThrottleMs: 5,
      dbThrottleMs: 10
    })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    const { runId, done } = service.send(s.id, 'cambia a.txt')
    await done
    await waitFor(() => store.getRun(runId)?.undo === 'available', 5000)
    const c = store.checkpoint(runId)!
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('cambiado por el agente\n')
    await undo(dir, c.before!, c.after!)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('detener un turno mientras se hace la foto: el agente no llega a arrancar', async () => {
    const store = memoryStore()
    const dir = repo()
    const project = store.openProject(dir, 'demo', null)
    let release!: () => void
    const service = new SessionService({
      store,
      push: () => {},
      adapters: { claude: claudeAdapter, codex: createCodexAdapter(tmpDir()) },
      resolveBin: () => FAKE_CLI,
      env: () => ({ ...process.env, FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_WRITE: JSON.stringify({ 'a.txt': 'no debería cambiar\n' }) }),
      defaultModel: () => undefined,
      checkpoint: () => new Promise((r) => (release = () => r(null))),
      uiThrottleMs: 5,
      dbThrottleMs: 10
    })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    const { done } = service.send(s.id, 'cambia a.txt')
    await service.cancel(s.id)
    release()
    expect((await done).status).toBe('cancelled')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(service.isRunning(s.id)).toBe(false)
  })
})
