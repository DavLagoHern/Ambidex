import { execFile } from 'child_process'
import { which } from './agents/env'
import { git, status } from './git'

function gh(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = which('gh')
  if (!bin) return Promise.resolve({ code: 127, stdout: '', stderr: 'GitHub CLI (gh) no está instalado' })
  return new Promise((resolve) =>
    execFile(bin, args, { cwd, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    )
  )
}

export async function prInfo(cwd: string) {
  if (!which('gh')) return { available: false, authed: false }
  const auth = await gh(cwd, ['auth', 'status'])
  if (auth.code !== 0) return { available: true, authed: false }
  const [pr, repo] = await Promise.all([
    gh(cwd, ['pr', 'view', '--json', 'url,number,state']),
    gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])
  ])
  let info: { url?: string; number?: number; state?: string } = {}
  try {
    if (pr.code === 0) info = JSON.parse(pr.stdout)
  } catch {
    /* sin PR */
  }
  return { available: true, authed: true, ...info, defaultBranch: repo.code === 0 ? repo.stdout.trim() || undefined : undefined }
}

// Publica la rama si hace falta y crea el PR con gh. Devuelve la URL.
export async function createPR(cwd: string, pr: { title: string; body: string; base?: string; draft: boolean }): Promise<string> {
  if (!pr.title.trim()) throw new Error('El PR necesita un título')
  const st = await status(cwd)
  if (!st.branch || st.branch.startsWith('HEAD')) throw new Error('No estás en una rama')
  if (!st.upstream) await git(cwd, ['push', '-u', 'origin', st.branch])
  else if (st.ahead > 0) await git(cwd, ['push'])
  const args = ['pr', 'create', '--title', pr.title, '--body', pr.body || ' ']
  if (pr.base) args.push('--base', pr.base)
  if (pr.draft) args.push('--draft')
  const r = await gh(cwd, args)
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh pr create falló')
  return r.stdout.trim().split('\n').pop() ?? ''
}
