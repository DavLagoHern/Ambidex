import { execFile } from 'child_process'
import { Dirent, existsSync, mkdirSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import type { CommitDetail, GitBranch, GitCommit, GitFileStatus, GitLogEntry, GitStatus, GitWorktree, GrepHit } from '@shared/types'
import { APP_HOME } from './paths'

// Los worktrees de los agentes viven fuera de los repos para no ensuciar `git status`
export const WORKTREE_BASE = join(APP_HOME, 'worktrees')

// Registro de los comandos git ejecutados ("Ver salida de Git")
const output: GitLogEntry[] = []
const QUIET = new Set(['status', 'diff', 'show', 'log', 'rev-parse', 'for-each-ref', 'worktree', 'ls-files', 'grep', 'remote', 'tag', 'stash'])

export const gitOutput = () => output.slice(-400)

export function git(cwd: string, args: string[], input?: string): Promise<string> {
  const started = Date.now()
  const record = (ok: boolean, stderr: string) => {
    // las lecturas frecuentes solo se registran si fallan, para no inundar el log
    if (ok && QUIET.has(args[0]) && !(args[0] === 'stash' && args[1] && args[1] !== 'list')) return
    output.push({ at: started, cwd, args, ms: Date.now() - started, ok, stderr: stderr.trim().slice(0, 2000) })
    if (output.length > 1000) output.splice(0, output.length - 1000)
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 128 * 1024 * 1024,
        // nunca se abre un editor (merge, rebase, cherry-pick…): se quedaría esperando
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }
      },
      (err, stdout, stderr) => {
        record(!err, stderr || (err ? err.message : ''))
        if (err) reject(new Error((stderr || err.message).trim()))
        else resolve(stdout)
      }
    )
    if (input !== undefined) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export async function status(cwd: string): Promise<GitStatus> {
  let out: string
  try {
    out = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'])
  } catch {
    return { isRepo: false, ahead: 0, behind: 0, files: [] }
  }
  const parts = out.split('\0')
  const res: GitStatus = { isRepo: true, ahead: 0, behind: 0, files: [], operation: await operation(cwd) }
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      let head = entry.slice(3).replace(/^(No commits yet on |Initial commit on )/, '')
      const track = head.match(/ \[(.*)\]$/)
      if (track) head = head.slice(0, track.index)
      const [branch, upstream] = head.split('...')
      res.branch = branch.startsWith('HEAD (') ? 'HEAD (detached)' : branch
      res.upstream = upstream
      res.ahead = +(track?.[1].match(/ahead (\d+)/)?.[1] ?? 0)
      res.behind = +(track?.[1].match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    let origPath: string | undefined
    if (x === 'R' || x === 'C') origPath = parts[++i]
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    res.files.push({
      path,
      origPath,
      index: x,
      worktree: y,
      untracked: x === '?',
      staged: !conflicted && x !== ' ' && x !== '?',
      unstaged: !conflicted && (y !== ' ' || x === '?'),
      conflicted
    } satisfies GitFileStatus)
  }
  return res
}

// Operación a medias en el repositorio (para mostrar continuar/abortar)
async function operation(cwd: string): Promise<GitStatus['operation']> {
  try {
    const dir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
  } catch {
    /* sin repositorio */
  }
  return undefined
}

export async function commitsSince(cwd: string, base: string): Promise<string[]> {
  const out = await git(cwd, ['log', '--format=%s', '--max-count=50', `${base}..HEAD`]).catch(() => '')
  return out.split('\n').filter(Boolean)
}

export async function numstat(cwd: string, staged: boolean): Promise<Record<string, [number, number]>> {
  const res: Record<string, [number, number]> = {}
  try {
    const out = await git(cwd, ['diff', '--numstat', '-z', ...(staged ? ['--cached'] : [])])
    for (const line of out.split('\0')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (m) res[m[3]] = [m[1] === '-' ? 0 : +m[1], m[2] === '-' ? 0 : +m[2]]
    }
  } catch {
    /* repo sin commits */
  }
  return res
}

const hasHead = (cwd: string) => git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)

export const stage = (cwd: string, paths: string[]) => git(cwd, ['add', '-A', '--', ...paths])

export async function unstage(cwd: string, paths: string[]) {
  if (await hasHead(cwd)) return git(cwd, ['restore', '--staged', '--', ...paths])
  return git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths])
}

export async function discard(cwd: string, files: { path: string; untracked: boolean }[]) {
  const untracked = files.filter((f) => f.untracked).map((f) => f.path)
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path)
  if (untracked.length) await git(cwd, ['clean', '-f', '--', ...untracked])
  if (tracked.length) await git(cwd, ['restore', '--worktree', '--', ...tracked])
}

// ref: 'HEAD', un hash, o ':' para el índice
export async function showFile(cwd: string, ref: string, path: string): Promise<string> {
  try {
    return await git(cwd, ['show', `${ref === ':' ? '' : ref}:${path}`])
  } catch {
    return ''
  }
}

export async function diffText(cwd: string, staged: boolean): Promise<string> {
  return git(cwd, ['diff', '--no-color', '-M', ...(staged ? ['--cached'] : [])])
}

export const commit = (cwd: string, message: string, amend: boolean) =>
  git(cwd, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], message)

export async function lastCommitMessage(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['log', '-1', '--format=%B'])).trim()
  } catch {
    return ''
  }
}

export async function log(cwd: string, limit: number, skip: number, all: boolean): Promise<GitCommit[]> {
  let out: string
  try {
    out = await git(cwd, [
      'log',
      '--topo-order',
      `--max-count=${limit}`,
      `--skip=${skip}`,
      '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e',
      ...(all ? ['--all'] : [])
    ])
  } catch {
    return []
  }
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, parents, author, email, date, subject, refs] = r.split('\x1f')
      return {
        hash,
        short,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: +date,
        subject,
        refs: refs ? refs.split(', ').filter(Boolean) : []
      }
    })
}

export async function commitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  const meta = await git(cwd, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B', hash])
  const [h, parents, author, email, date, committer, cdate, ...body] = meta.split('\x1f')
  const parentList = parents ? parents.trim().split(' ').filter(Boolean) : []
  const base = parentList[0]
  const nameStatus = base
    ? await git(cwd, ['diff', '--name-status', '-z', '-M', base, hash])
    : await git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash])
  const ns = base
    ? await git(cwd, ['diff', '--numstat', '-z', '-M', base, hash])
    : await git(cwd, ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '-M', hash])
  const stats: Record<string, [number, number]> = {}
  const nsParts = ns.split('\0')
  for (let i = 0; i < nsParts.length; i++) {
    const m = nsParts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/)
    if (!m) continue
    let p = m[3]
    if (p === '') {
      // rename: siguientes dos entradas son origen y destino
      i += 2
      p = nsParts[i]
    }
    stats[p] = [m[1] === '-' ? 0 : +m[1], m[2] === '-' ? 0 : +m[2]]
  }
  const parts = nameStatus.split('\0').filter((x) => x !== '')
  const files: { status: string; path: string; origPath?: string; add: number; del: number }[] = []
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i]
    if (st.startsWith('R') || st.startsWith('C')) {
      const orig = parts[++i]
      const p = parts[++i]
      files.push({ status: st[0], path: p, origPath: orig, add: stats[p]?.[0] ?? 0, del: stats[p]?.[1] ?? 0 })
    } else {
      const p = parts[++i]
      files.push({ status: st[0], path: p, add: stats[p]?.[0] ?? 0, del: stats[p]?.[1] ?? 0 })
    }
  }
  return {
    hash: h,
    parents: parentList,
    author,
    email,
    date: +date,
    committer,
    commitDate: +cdate,
    message: body.join('\x1f').trim(),
    files
  }
}

export async function commitPatch(cwd: string, hash: string): Promise<string> {
  return git(cwd, ['show', '--no-color', '--format=commit %H%nAuthor: %an <%ae>%nDate: %ad%n%n%B', '-M', hash])
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  try {
    const out = await git(cwd, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)',
      'refs/heads',
      'refs/remotes'
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, name, head, upstream, date] = l.split('\x1f')
        return { name, current: head === '*', remote: ref.startsWith('refs/remotes/'), upstream: upstream || undefined, lastCommit: +date }
      })
      .filter((b) => !b.name.endsWith('/HEAD'))
  } catch {
    return []
  }
}

export async function checkout(cwd: string, name: string, remote: boolean) {
  if (remote) {
    const local = name.replace(/^[^/]+\//, '')
    const exists = await git(cwd, ['rev-parse', '--verify', `refs/heads/${local}`]).then(() => true, () => false)
    return exists ? git(cwd, ['checkout', local]) : git(cwd, ['checkout', '-b', local, '--track', name])
  }
  return git(cwd, ['checkout', name])
}

export const createBranch = (cwd: string, name: string, from?: string) =>
  git(cwd, ['checkout', '-b', name, ...(from ? [from] : [])])

export const deleteBranch = (cwd: string, name: string, force: boolean) =>
  git(cwd, ['branch', force ? '-D' : '-d', name])

export const fetch = (cwd: string) => git(cwd, ['fetch', '--all', '--prune'])
export const pull = (cwd: string) => git(cwd, ['pull', '--ff-only'])

export async function push(cwd: string) {
  const st = await status(cwd)
  if (!st.upstream && st.branch) return git(cwd, ['push', '-u', 'origin', st.branch])
  return git(cwd, ['push'])
}

export const stashPush = (cwd: string, msg?: string) =>
  git(cwd, ['stash', 'push', '-u', ...(msg ? ['-m', msg] : [])])
export const stashPop = (cwd: string) => git(cwd, ['stash', 'pop'])

export const init = (cwd: string) => git(cwd, ['init'])

export async function worktrees(cwd: string): Promise<GitWorktree[]> {
  try {
    const out = await git(cwd, ['worktree', 'list', '--porcelain'])
    const list: GitWorktree[] = []
    for (const block of out.split('\n\n')) {
      const lines = block.split('\n').filter(Boolean)
      if (!lines.length) continue
      const wt: GitWorktree = { path: '', head: '', main: list.length === 0 }
      for (const l of lines) {
        if (l.startsWith('worktree ')) wt.path = l.slice(9)
        else if (l.startsWith('HEAD ')) wt.head = l.slice(5)
        else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace('refs/heads/', '')
      }
      if (wt.path) list.push(wt)
    }
    return list
  } catch {
    return []
  }
}

export async function addWorktree(cwd: string, name: string, baseDir = WORKTREE_BASE): Promise<GitWorktree> {
  const root = (await repoRoot(cwd)) || cwd
  const dir = join(baseDir, basename(root))
  mkdirSync(dir, { recursive: true })
  let path = join(dir, name)
  let n = 1
  while (existsSync(path)) path = join(dir, `${name}-${n++}`)
  const branch = `ai/${basename(path)}`
  await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  return { path, branch, head: '', main: false }
}

export async function removeWorktree(cwd: string, path: string) {
  await git(cwd, ['worktree', 'remove', '--force', path])
}

export async function listFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  return [...new Set(out.split('\0').filter(Boolean))]
}

export async function grep(cwd: string, query: string, regex: boolean, caseSensitive: boolean): Promise<GrepHit[]> {
  try {
    const out = await git(cwd, [
      'grep',
      '-n',
      '-I',
      '--untracked',
      '--column',
      '--max-count=50',
      ...(regex ? ['-E'] : ['-F']),
      ...(caseSensitive ? [] : ['-i']),
      '-e',
      query
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .slice(0, 2000)
      .map((l) => {
        const m = l.match(/^(.*?):(\d+):(\d+):(.*)$/)
        return m ? { path: m[1], line: +m[2], column: +m[3], text: m[4] } : null
      })
      .filter((h): h is GrepHit => h !== null)
  } catch {
    return [] // git grep sale con código 1 si no hay resultados
  }
}

// ---------- multirepo ----------

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '.venv', 'venv', 'Pods'])

// Busca repositorios dentro de una carpeta (la propia carpeta y subcarpetas hasta `depth` niveles)
export function findRepos(root: string, depth = 3): string[] {
  const found: string[] = []
  const walk = (dir: string, d: number) => {
    if (existsSync(join(dir, '.git'))) found.push(dir)
    if (d >= depth) return
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue
      walk(join(dir, e.name), d + 1)
    }
  }
  walk(root, 0)
  return found
}

export const run = (cwd: string, args: string[]) => git(cwd, args)

export async function remotes(cwd: string) {
  const out = await git(cwd, ['remote', '-v']).catch(() => '')
  const map = new Map<string, string>()
  for (const l of out.split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    if (m) map.set(m[1], m[2])
  }
  return [...map].map(([name, url]) => ({ name, url }))
}

export async function tags(cwd: string) {
  const out = await git(cwd, ['tag', '--sort=-creatordate', '--format=%(refname:short)%1f%(subject)']).catch(() => '')
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, subject] = l.split('\x1f')
    return { name, subject }
  })
}

export async function stashes(cwd: string) {
  const out = await git(cwd, ['stash', 'list', '--format=%gd%x1f%s%x1f%ct']).catch(() => '')
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, subject, date] = l.split('\x1f')
    return { ref, subject, date: +date }
  })
}

export async function clone(url: string, parent: string) {
  const name = url.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo'
  let target = join(parent, name)
  let n = 1
  while (existsSync(target)) target = join(parent, `${name}-${n++}`)
  await git(parent, ['clone', '--progress', url, target])
  return target
}
