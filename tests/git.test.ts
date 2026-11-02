import { existsSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as g from '../src/main/git'
import { cleanupTmp, git, initRepo, tmpDir } from './helpers'

afterEach(cleanupTmp)

describe('git (repositorios temporales)', () => {
  it('estado: modificado, nuevo, preparado y renombrado', async () => {
    const repo = initRepo()
    writeFileSync(join(repo, 'README.md'), '# Cambiado\n')
    writeFileSync(join(repo, 'nuevo.ts'), 'export {}\n')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-q', '-m', 'a')
    renameSync(join(repo, 'a.txt'), join(repo, 'b.txt'))
    git(repo, 'add', '-A', 'a.txt', 'b.txt')

    const st = await g.status(repo)
    expect(st.isRepo).toBe(true)
    expect(st.branch).toBe('main')
    const by = Object.fromEntries(st.files.map((f) => [f.path, f]))
    expect(by['README.md']).toMatchObject({ unstaged: true, staged: false, worktree: 'M' })
    expect(by['nuevo.ts']).toMatchObject({ untracked: true })
    expect(by['b.txt']).toMatchObject({ staged: true, index: 'R', origPath: 'a.txt' })
  })

  it('stage, commit, log y detalle del commit', async () => {
    const repo = initRepo()
    writeFileSync(join(repo, 'x.ts'), 'const x = 1\n')
    await g.stage(repo, ['x.ts'])
    expect((await g.status(repo)).files[0]).toMatchObject({ path: 'x.ts', staged: true })
    await g.commit(repo, 'feat: añade x\n\ncuerpo', false)
    const [last] = await g.log(repo, 1, 0, false)
    expect(last.subject).toBe('feat: añade x')
    const detail = await g.commitDetail(repo, last.hash)
    expect(detail.files).toEqual([{ status: 'A', path: 'x.ts', add: 1, del: 0 }])
    expect(await g.lastCommitMessage(repo)).toBe('feat: añade x\n\ncuerpo')
  })

  it('descartar cambios solo toca los ficheros indicados', async () => {
    const repo = initRepo()
    writeFileSync(join(repo, 'README.md'), 'cambio\n')
    writeFileSync(join(repo, 'tmp.log'), 'x')
    writeFileSync(join(repo, 'keep.txt'), 'x')
    await g.discard(repo, [
      { path: 'README.md', untracked: false },
      { path: 'tmp.log', untracked: true }
    ])
    expect(existsSync(join(repo, 'tmp.log'))).toBe(false)
    expect(existsSync(join(repo, 'keep.txt'))).toBe(true)
    expect((await g.status(repo)).files.map((f) => f.path)).toEqual(['keep.txt'])
  })

  it('ramas: crear, listar y cambiar', async () => {
    const repo = initRepo()
    await g.createBranch(repo, 'feature/login')
    expect((await g.status(repo)).branch).toBe('feature/login')
    await g.checkout(repo, 'main', false)
    const names = (await g.branches(repo)).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining(['main', 'feature/login']))
  })

  it('worktrees aislados: crear, listar y eliminar sin tocar el principal', async () => {
    const repo = initRepo()
    const wt = await g.addWorktree(repo, `test-${Date.now()}`)
    try {
      expect(wt.branch).toMatch(/^ai\/test-/)
      writeFileSync(join(wt.path, 'solo-en-wt.txt'), 'x')
      expect((await g.status(repo)).files).toEqual([])
      expect((await g.status(wt.path)).files.map((f) => f.path)).toEqual(['solo-en-wt.txt'])
      const list = await g.worktrees(repo)
      expect(list.map((w) => w.path)).toContain(wt.path)
      expect(list[0].main).toBe(true)
    } finally {
      await g.removeWorktree(repo, wt.path)
    }
    expect(existsSync(wt.path)).toBe(false)
  })

  it('detecta repos anidados y la raíz', async () => {
    const root = tmpDir()
    const a = join(root, 'a')
    git(root, 'init', '-q', 'a')
    git(root, 'init', '-q', 'b')
    expect(g.findRepos(root).sort()).toEqual([a, join(root, 'b')])
    expect(await g.repoRoot(a)).toBe(a)
    expect(await g.repoRoot(root)).toBeNull()
  })
})
