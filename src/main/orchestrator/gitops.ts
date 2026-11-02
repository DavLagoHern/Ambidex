import { existsSync, lstatSync, readFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { git } from '../git'

const quiet = <T>(p: Promise<T>, def: T) => p.catch(() => def)

export const head = async (cwd: string) => (await git(cwd, ['rev-parse', 'HEAD'])).trim()

export const currentBranch = (cwd: string) =>
  quiet(
    git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).then((s) => s.trim() || undefined),
    undefined
  )

// Cambios en ficheros versionados (los no versionados no bloquean una integración)
export async function isDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=no'])
  return out.trim().length > 0
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(
    () => true,
    () => false
  )
}

export async function addWorktree(repo: string, path: string, branch: string, base: string) {
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', path, branch])
  else await git(repo, ['worktree', 'add', '-b', branch, path, base])
}

// Comparte node_modules del repositorio principal con el worktree (solo si está ignorado por Git)
export async function linkNodeModules(repo: string, wt: string) {
  const src = join(repo, 'node_modules')
  const dst = join(wt, 'node_modules')
  if (!existsSync(src) || existsSync(dst)) return
  try {
    if (lstatSync(src).isSymbolicLink()) return
    const ignored = await git(wt, ['check-ignore', '-q', 'node_modules']).then(
      () => true,
      () => false
    )
    if (ignored) symlinkSync(src, dst)
  } catch {
    /* no imprescindible */
  }
}

// Commit de todo lo que haya cambiado en un worktree de agente. Devuelve el commit o undefined si no hay cambios.
export async function commitAll(cwd: string, message: string): Promise<string | undefined> {
  await git(cwd, ['add', '-A'])
  const changed = await git(cwd, ['diff', '--cached', '--quiet']).then(
    () => false,
    () => true
  )
  if (!changed) return undefined
  await git(cwd, ['commit', '--no-verify', '-q', '-m', message])
  return head(cwd)
}

export async function changedFiles(cwd: string, from: string, to = 'HEAD'): Promise<string[]> {
  const out = await quiet(git(cwd, ['diff', '--name-only', '-z', from, to]), '')
  return out.split('\0').filter(Boolean)
}

export async function diff(cwd: string, from: string, to = 'HEAD', max = 40000): Promise<string> {
  const out = await quiet(git(cwd, ['diff', '--no-color', '-M', from, to]), '')
  return out.length > max ? out.slice(0, max) + `\n… (diff truncado: ${out.length - max} caracteres más)` : out
}

export async function unresolved(cwd: string): Promise<string[]> {
  const out = await quiet(git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']), '')
  const files = out.split('\0').filter(Boolean)
  // además de lo que Git marca, ningún fichero puede conservar marcadores de conflicto
  const touched = (await quiet(git(cwd, ['diff', '--name-only', '-z', 'HEAD']), '')).split('\0').filter(Boolean)
  for (const f of touched) {
    try {
      const text = readFileSync(join(cwd, f), 'utf8')
      if (/^<{7} |^>{7} /m.test(text) && !files.includes(f)) files.push(f)
    } catch {
      /* borrado o binario */
    }
  }
  return files
}

export const mergeInProgress = (cwd: string) =>
  git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false
  )

export async function mergeBranch(cwd: string, branch: string): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await git(cwd, ['merge', '--no-ff', '--no-edit', '-m', `ambidex: integra ${branch}`, branch])
    return { ok: true, conflicts: [] }
  } catch (e) {
    const conflicts = await unresolved(cwd)
    if (!conflicts.length) throw e
    return { ok: false, conflicts }
  }
}

export async function finishMerge(cwd: string) {
  await git(cwd, ['add', '-A'])
  if (await mergeInProgress(cwd)) await git(cwd, ['commit', '--no-verify', '--no-edit', '-q'])
}

export async function mergeInto(repo: string, branch: string, strategy: 'squash' | 'merge', message: string): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    if (strategy === 'squash') await git(repo, ['merge', '--squash', branch])
    else await git(repo, ['merge', '--no-ff', '-m', message, branch])
    return { ok: true, conflicts: [] }
  } catch (e) {
    const conflicts = await unresolved(repo)
    if (!conflicts.length) throw e
    return { ok: false, conflicts }
  }
}

export async function numstat(cwd: string, from: string, to: string): Promise<{ path: string; add: number; del: number }[]> {
  const out = await quiet(git(cwd, ['diff', '--numstat', '-z', '--no-renames', from, to]), '')
  return out
    .split('\0')
    .map((l) => l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ path: m[3], add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2] }))
}

export async function removeWorktree(repo: string, path: string) {
  if (existsSync(path)) await git(repo, ['worktree', 'remove', '--force', path])
  else await quiet(git(repo, ['worktree', 'prune']), '')
}

export const deleteBranch = (repo: string, branch: string) => quiet(git(repo, ['branch', '-D', branch]), '')
