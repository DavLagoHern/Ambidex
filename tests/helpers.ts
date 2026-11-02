import { execFileSync } from 'child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { openDatabase } from '../src/main/db/database'
import { Store } from '../src/main/db/store'

export const FIXTURES = resolve(__dirname, 'fixtures')
export const FAKE_CLI = resolve(__dirname, 'fake-cli.mjs')
chmodSync(FAKE_CLI, 0o755)

const dirs: string[] = []

export function tmpDir(prefix = 'ambidex-test-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

export function cleanupTmp() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function memoryStore(): Store {
  return new Store(openDatabase(':memory:'))
}

export function fileStore(dir: string): { store: Store; file: string } {
  const file = join(dir, 'test.db')
  return { store: new Store(openDatabase(file)), file }
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' }
  })
}

export function initRepo(): string {
  const d = tmpDir('ambidex-repo-')
  git(d, 'init', '-q', '-b', 'main')
  git(d, 'config', 'user.name', 'Test')
  git(d, 'config', 'user.email', 't@t')
  writeFileSync(join(d, 'README.md'), '# Test\n')
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'inicial')
  return d
}

export const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor: tiempo agotado')
    await new Promise((r) => setTimeout(r, 20))
  }
}
