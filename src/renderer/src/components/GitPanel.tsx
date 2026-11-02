import { useEffect, useRef, useState } from 'react'
import type { GitBranch, GitFileStatus, GitWorktree } from '@shared/types'
import { api } from '../lib/api'
import { attempt, confirmAsync, setApp, toast, useApp } from '../lib/app-store'
import { usePS, useStore } from '../lib/project-store'
import { basename, dirname, errMsg, relPath, timeAgo } from '../lib/utils'
import { cloneRepo, MenuTree, repoMenu } from './GitMenu'
import { HistoryList } from './HistoryPanel'
import { Icon } from './Icons'

const NONE: string[] = []

const COMMIT_PROMPT = `Escribe un mensaje de commit para el diff que recibes por stdin.
Formato: una línea de resumen en imperativo (máx. 72 caracteres), una línea en blanco y, solo si aporta, un cuerpo breve con viñetas explicando el porqué.
Usa el mismo idioma y estilo (p. ej. Conventional Commits) que los commits recientes que se incluyen al principio.
Responde SOLO con el mensaje, sin comillas ni bloques de código.`

function FileRow({
  f, cwd, staged, stats, onStage, onUnstage, onDiscard, onOpen
}: {
  f: GitFileStatus
  cwd: string
  staged: boolean
  stats?: [number, number]
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onOpen: () => void
}) {
  const ps = usePS()
  const code = f.conflicted ? '!' : f.untracked ? 'U' : staged ? f.index : f.worktree
  return (
    <div className="file-row" onClick={onOpen} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
      <span className={`file-name ellipsis ${code === 'D' ? 'deleted' : ''}`}>
        {basename(f.path)} <span className="muted small">{dirname(f.path)}</span>
      </span>
      {stats && (stats[0] > 0 || stats[1] > 0) && (
        <span className="small">
          <span className="add">+{stats[0]}</span> <span className="del">−{stats[1]}</span>
        </span>
      )}
      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Abrir fichero" onClick={() => ps.openFile(`${cwd}/${f.path}`)}>
          <Icon.file size={13} />
        </button>
        {onDiscard && (
          <button className="icon-btn" title="Descartar cambios" onClick={onDiscard}>
            <Icon.undo size={13} />
          </button>
        )}
        {onStage && (
          <button className="icon-btn" title="Preparar (stage)" onClick={onStage}>
            <Icon.plus size={13} />
          </button>
        )}
        {onUnstage && (
          <button className="icon-btn" title="Quitar del stage" onClick={onUnstage}>
            <Icon.minus size={13} />
          </button>
        )}
      </span>
      <span className={`st-letter st-${code}`}>{code}</span>
    </div>
  )
}

function BranchMenu({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const ps = usePS()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [filter, setFilter] = useState('')
  useEffect(() => {
    api.git.branches(cwd).then(setBranches)
  }, [cwd])
  const list = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
  const create = async () => {
    const name = filter.trim()
    if (!name) return
    await attempt(() => api.git.createBranch(cwd, name), `Rama ${name} creada`)
    onClose()
    ps.refreshGit()
  }
  return (
    <div className="menu wide" onMouseLeave={onClose}>
      <input
        autoFocus
        className="input"
        placeholder="Buscar o crear rama…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !list.some((b) => b.name === filter) && create()}
      />
      {filter && !branches.some((b) => b.name === filter) && (
        <div className="menu-item" onClick={create}>
          <Icon.plus size={13} /> Crear rama <b>{filter}</b> desde HEAD
        </div>
      )}
      <div className="menu-scroll">
        {list.map((b) => (
          <div
            key={b.name}
            className={`menu-item ${b.current ? 'selected' : ''}`}
            onClick={async () => {
              onClose()
              await attempt(() => api.git.checkout(cwd, b.name, b.remote), `Cambiado a ${b.name}`)
              ps.refreshGit()
              ps.set((s) => ({ fsTick: s.fsTick + 1 }))
            }}
          >
            <span>
              {b.current && <Icon.check size={12} />} {b.name} {b.remote && <span className="badge">remota</span>}
            </span>
            <span className="muted small">{b.lastCommit ? timeAgo(b.lastCommit) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Worktrees({ cwd }: { cwd: string }) {
  const ps = usePS()
  const workspace = useStore((s) => s.workspace)
  const project = useStore((s) => s.meta.path)
  const gitTick = useStore((s) => s.gitTick)
  const [wts, setWts] = useState<GitWorktree[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    api.git.worktrees(cwd).then(setWts)
  }, [cwd, gitTick])
  if (wts.length <= 1) return null
  return (
    <div className="section">
      <div className="section-header" onClick={() => setOpen(!open)}>
        {open ? <Icon.chevronDown size={12} /> : <Icon.chevronRight size={12} />} Worktrees <span className="count">{wts.length}</span>
      </div>
      {open &&
        wts.map((w) => (
          <div key={w.path} className={`file-row ${w.path === workspace ? 'active' : ''}`} onClick={() => ps.setWorkspace(w.path)} title={w.path}>
            <span className="file-name ellipsis">
              <Icon.layers size={12} /> {w.branch || w.head.slice(0, 7)} {w.main && <span className="muted small">principal</span>}
            </span>
            {!w.main && (
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  title="Nueva conversación de Claude en este worktree"
                  onClick={() => ps.newSession('claude', { cwd: w.path, worktree: { path: w.path, branch: w.branch || '' } })}
                >
                  <Icon.sparkles size={13} />
                </button>
                <button
                  className="icon-btn"
                  title="Eliminar worktree"
                  onClick={async () => {
                    if (!(await confirmAsync(`¿Eliminar el worktree ${w.path}?`, 'Los cambios sin commit se perderán (la rama se conserva).', true))) return
                    if (workspace === w.path) await ps.setWorkspace(project)
                    await attempt(() => api.git.removeWorktree(cwd, w.path), 'Worktree eliminado')
                    ps.refreshGit()
                  }}
                >
                  <Icon.trash size={13} />
                </button>
              </span>
            )}
          </div>
        ))}
    </div>
  )
}

function RepoRow({ path, active, hooks }: { path: string; active: boolean; hooks: Parameters<typeof repoMenu>[2] }) {
  const ps = usePS()
  const st = useStore((s) => s.repoStatus[path])
  const workspace = useStore((s) => s.workspace)
  const project = useStore((s) => s.meta.path)
  const extra = useApp((s) => s.settings?.extraRepos?.[project]) ?? NONE
  const [menu, setMenu] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const dirty = (st?.files.length ?? 0) > 0
  const name = path === workspace ? basename(path) : relPath(workspace, path)

  const sync = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSyncing(true)
    await attempt(async () => {
      await api.git.fetch(path)
      const s = await api.git.status(path)
      if (s.behind) await api.git.pull(path)
      if (s.ahead || !s.upstream) await api.git.push(path)
    }, 'Sincronizado')
    setSyncing(false)
    ps.refreshGit()
  }

  return (
    <div className={`repo-row ${active ? 'active' : ''}`} onClick={() => ps.setRepo(path)} title={path}>
      <Icon.git size={13} />
      <span className="repo-name ellipsis">{name}</span>
      <span className="repo-branch ellipsis">
        <Icon.branch size={11} /> {st?.branch ?? '—'}
        {dirty && '*'}
      </span>
      {st && (st.ahead > 0 || st.behind > 0) && (
        <span className="tiny muted">
          {st.behind > 0 && `${st.behind}↓`} {st.ahead > 0 && `${st.ahead}↑`}
        </span>
      )}
      <button className="icon-btn" title="Sincronizar (fetch, pull y push)" onClick={sync}>
        <span className={syncing ? 'spin' : ''} style={{ display: 'inline-flex' }}><Icon.refresh size={13} /></span>
      </button>
      <span className="dropdown" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Más acciones" onClick={() => setMenu(!menu)}>
          ⋯
        </button>
        {menu && (
          <MenuTree
            onClose={() => setMenu(false)}
            items={[
              ...repoMenu(ps, path, hooks),
              ...(extra.includes(path) ? [{ label: '', sep: true }, { label: 'Quitar del proyecto', action: () => ps.removeRepoFromProject(path) }] : [])
            ]}
          />
        )}
      </span>
    </div>
  )
}

// Crear un pull request con GitHub CLI
function PRDialog({ cwd, branch, onClose }: { cwd: string; branch: string; onClose: () => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.git.prInfo>> | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.git.prInfo(cwd).then(async (i) => {
      setInfo(i)
      if (i.defaultBranch) {
        setBase(i.defaultBranch)
        const commits = await api.git.commitsSince(cwd, `origin/${i.defaultBranch}`).catch(() => [] as string[])
        setTitle(commits.at(-1) ?? branch)
        setBody(commits.map((c) => `- ${c}`).join('\n'))
      }
    })
  }, [cwd])
  const create = async () => {
    setBusy(true)
    const url = await attempt(() => api.git.createPR(cwd, { title, body, base: base || undefined, draft }), 'Pull request creado')
    setBusy(false)
    if (url) {
      api.openExternal(url)
      onClose()
    }
  }
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Pull request · {branch}</h3>
        {!info ? (
          <div className="muted">Comprobando GitHub CLI…</div>
        ) : !info.available ? (
          <p className="muted">Necesitas GitHub CLI: <code>brew install gh</code> y después <code>gh auth login</code>.</p>
        ) : !info.authed ? (
          <p className="muted">GitHub CLI no tiene sesión. Ejecuta <code>gh auth login</code> en la terminal.</p>
        ) : info.url ? (
          <div className="row gap">
            <span>Ya existe el PR #{info.number} ({info.state}).</span>
            <button className="btn primary" onClick={() => (api.openExternal(info.url!), onClose())}>
              Abrir en GitHub
            </button>
          </div>
        ) : (
          <div className="form">
            <label>
              Título
              <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Descripción
              <textarea className="input" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <div className="row gap">
              <label className="row gap" style={{ flex: 1 }}>
                Base <input className="input" value={base} onChange={(e) => setBase(e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Borrador
              </label>
            </div>
            <p className="muted small">Si la rama no está publicada se hará push antes de crear el PR.</p>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
          {info?.authed && !info.url && (
            <button className="btn primary" disabled={busy || !title.trim()} onClick={create}>
              {busy ? 'Creando…' : 'Crear pull request'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function GitPanel() {
  const ps = usePS()
  const repos = useStore((s) => s.repos)
  const repo = useStore((s) => s.repo) ?? ''
  const git = useStore((s) => s.git)
  const gitTick = useStore((s) => s.gitTick)
  const settings = useApp((s) => s.settings)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [globalMenu, setGlobalMenu] = useState(false)
  const [stats, setStats] = useState<{ staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> }>({ staged: {}, unstaged: {} })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ graph: false })
  const msgRef = useRef<HTMLTextAreaElement>(null)
  const messageRef = useRef(message)
  messageRef.current = message

  useEffect(() => {
    if (!git?.isRepo || !repo) return
    Promise.all([api.git.numstat(repo, true), api.git.numstat(repo, false)]).then(([staged, unstaged]) => setStats({ staged, unstaged }))
  }, [repo, gitTick, git?.isRepo])

  useEffect(() => {
    if (amend && !message) api.git.lastMessage(repo).then(setMessage)
  }, [amend])

  // al cambiar de repo, cada uno conserva su borrador de mensaje
  const drafts = useRef<Record<string, string>>({})
  const prevRepo = useRef(repo)
  useEffect(() => {
    drafts.current[prevRepo.current] = messageRef.current
    setMessage(drafts.current[repo] ?? '')
    prevRepo.current = repo
  }, [repo])

  const staged = git?.files.filter((f) => f.staged) ?? []
  const unstaged = git?.files.filter((f) => f.unstaged && !f.conflicted) ?? []
  const conflicts = git?.files.filter((f) => f.conflicted) ?? []
  const [prOpen, setPrOpen] = useState(false)

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label)
    await attempt(fn, ok)
    setBusy(null)
    ps.refreshGit()
  }

  const doCommit = async (mode: 'auto' | 'staged' | 'all' | 'amend' = 'auto') => {
    const isAmend = mode === 'amend' || amend
    let msg = messageRef.current
    if (isAmend && !msg.trim()) msg = await api.git.lastMessage(repo)
    if (!msg.trim()) {
      msgRef.current?.focus()
      return toast('Escribe un mensaje de commit', 'error')
    }
    const st = ps.state.git
    const stagedNow = st?.files.filter((f) => f.staged) ?? []
    const unstagedNow = st?.files.filter((f) => f.unstaged) ?? []
    if (mode === 'all' || (mode === 'auto' && !stagedNow.length && !isAmend)) {
      // como VS Code: si no hay nada preparado, se preparan todos los cambios
      if (unstagedNow.length) await api.git.stage(repo, unstagedNow.map((f) => f.path))
    } else if (mode === 'staged' && !stagedNow.length) return toast('No hay cambios preparados', 'error')
    setBusy('commit')
    try {
      await api.git.commit(repo, msg, isAmend)
      toast(isAmend ? 'Commit modificado' : 'Commit creado', 'success')
      setMessage('')
      setAmend(false)
    } catch (e) {
      toast(errMsg(e), 'error')
    }
    setBusy(null)
    ps.refreshGit()
  }

  const generate = async () => {
    const agent = settings?.commitAgent || 'claude'
    setBusy('generate')
    try {
      let diff = await api.git.diffText(repo, true)
      if (!diff.trim()) diff = await api.git.diffText(repo, false)
      const untracked = ps.state.git?.files.filter((f) => f.untracked).map((f) => f.path) ?? []
      if (!diff.trim() && !untracked.length) throw new Error('No hay cambios')
      const recent = (await api.git.log(repo, 8, 0, false)).map((c) => `- ${c.subject}`).join('\n')
      const input = `Commits recientes:\n${recent || '(ninguno)'}\n\n${untracked.length ? `Ficheros nuevos sin seguimiento: ${untracked.join(', ')}\n\n` : ''}${diff.slice(0, 60000)}`
      const model = agent === 'claude' ? settings?.claudeModel : settings?.codexModel
      const msg = await api.oneShot(agent, repo, COMMIT_PROMPT, input, model || undefined)
      setMessage(msg.replace(/^```\w*\n?|```$/g, '').trim())
    } catch (e) {
      toast(errMsg(e), 'error')
    }
    setBusy(null)
  }

  const hooks = {
    commit: (m: 'staged' | 'all' | 'amend') => {
      if (repo) doCommit(m)
    },
    generate,
    focusMessage: () => msgRef.current?.focus()
  }

  const review = (agent: 'claude' | 'codex') => {
    ps.set((s) => ({ agentView: s.agentView === 'both' ? 'both' : agent }))
    ps.ask(
      agent,
      'Revisa los cambios sin commitear de este repositorio (`git diff` y `git diff --cached`, más los ficheros nuevos). Señala bugs, riesgos y mejoras concretas, ordenados por gravedad. No modifiques nada.',
      { fresh: true, cwd: repo, withContext: false }
    )
  }

  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Control de código</span>
        <span className="row-actions always">
          <button className="icon-btn" title="Revisar cambios con Claude" onClick={() => review('claude')}>
            <Icon.sparkles size={14} />
          </button>
          <button className="icon-btn" title="Refrescar" onClick={ps.refreshGit}>
            <Icon.refresh size={14} />
          </button>
          <span className="dropdown">
            <button className="icon-btn" title="Más" onClick={() => setGlobalMenu(!globalMenu)}>⋯</button>
            {globalMenu && (
              <MenuTree
                align="right"
                onClose={() => setGlobalMenu(false)}
                items={[
                  { label: 'Clonar repositorio…', action: () => cloneRepo(ps) },
                  {
                    label: 'Añadir repositorio existente…',
                    action: async () => {
                      const p = await api.git.addRepo()
                      if (p) ps.addRepoToProject(p)
                    }
                  },
                  { label: 'Inicializar repositorio aquí', action: () => run('init', () => api.git.init(ps.state.workspace), 'Repositorio inicializado').then(() => ps.addRepoToProject(ps.state.workspace)) },
                  { label: '', sep: true },
                  { label: 'Revisar cambios con Codex', action: () => review('codex') },
                  { label: 'Ver salida de Git', action: () => setApp({ overlay: 'gitOutput' }) }
                ]}
              />
            )}
          </span>
        </span>
      </div>

      <div className="panel-body">
        <div className="section">
          <div className="section-header" onClick={() => toggle('repos')}>
            {collapsed.repos ? <Icon.chevronRight size={12} /> : <Icon.chevronDown size={12} />} Repositorios <span className="count">{repos.length}</span>
          </div>
          {!collapsed.repos && (
            <>
              {repos.map((r) => <RepoRow key={r} path={r} active={r === repo} hooks={hooks} />)}
              {repos.length === 0 && (
                <div className="empty small">
                  <p>No se han encontrado repositorios Git en esta carpeta.</p>
                  <div className="row gap" style={{ justifyContent: 'center' }}>
                    <button className="btn primary small" onClick={() => run('init', () => api.git.init(ps.state.workspace), 'Repositorio inicializado').then(() => ps.addRepoToProject(ps.state.workspace))}>
                      Inicializar
                    </button>
                    <button className="btn small" onClick={() => cloneRepo(ps)}>Clonar…</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {git?.isRepo && repo && (
          <>
            <div className="branch-bar">
              <div className="dropdown" style={{ flex: 1, minWidth: 0 }}>
                <button className="btn ghost branch-btn" onClick={() => setBranchMenu(!branchMenu)} title="Cambiar de rama">
                  <Icon.branch size={13} /> <span className="ellipsis">{git.branch}</span> <Icon.chevronDown size={12} />
                </button>
                {branchMenu && <BranchMenu cwd={repo} onClose={() => setBranchMenu(false)} />}
              </div>
              <button className="btn ghost" title="Fetch" disabled={!!busy} onClick={() => run('fetch', () => api.git.fetch(repo), 'Fetch completado')}>
                <Icon.refresh size={13} />
              </button>
              <button className="btn ghost" title="Pull" disabled={!!busy} onClick={() => run('pull', () => api.git.pull(repo), 'Pull completado')}>
                <Icon.down size={13} /> {git.behind || ''}
              </button>
              <button className="btn ghost" title="Push" disabled={!!busy} onClick={() => run('push', () => api.git.push(repo), 'Push completado')}>
                <Icon.up size={13} /> {git.ahead || ''}
              </button>
              <button className="btn ghost" title="Pull request (GitHub CLI)" onClick={() => setPrOpen(true)}>
                PR
              </button>
            </div>
            {prOpen && <PRDialog cwd={repo} branch={git.branch ?? ''} onClose={() => setPrOpen(false)} />}

            {git.operation && (
              <div className="op-banner">
                <Icon.warn size={14} />
                <span>
                  {git.operation === 'merge' ? 'Merge' : git.operation === 'rebase' ? 'Rebase' : git.operation === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} en curso
                  {conflicts.length ? ` · ${conflicts.length} conflicto${conflicts.length === 1 ? '' : 's'}` : ' · sin conflictos'}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn small primary"
                  disabled={conflicts.length > 0 || !!busy}
                  title={conflicts.length ? 'Resuelve primero los conflictos' : 'Continuar'}
                  onClick={() => run('op', () => api.git.run(repo, git.operation === 'merge' ? ['commit', '--no-edit'] : [git.operation!, '--continue']), 'Hecho')}
                >
                  Continuar
                </button>
                <button
                  className="btn small ghost"
                  onClick={async () =>
                    (await confirmAsync(`¿Abortar el ${git.operation}?`, 'Se vuelve al estado anterior a la operación.', true)) && run('op', () => api.git.run(repo, [git.operation!, '--abort']), 'Abortado')
                  }
                >
                  Abortar
                </button>
              </div>
            )}

            <div className="commit-box">
              <textarea
                ref={msgRef}
                className="input"
                rows={3}
                placeholder={`Mensaje (⌘↵ para commit en "${git.branch}"${repos.length > 1 ? ` · ${basename(repo)}` : ''})`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doCommit()
                }}
              />
              <div className="commit-actions">
                <button className="btn" disabled={!!busy} onClick={generate} title={`Generar mensaje con ${settings?.commitAgent === 'codex' ? 'Codex' : 'Claude'}`}>
                  <Icon.sparkles size={13} /> {busy === 'generate' ? 'Generando…' : 'Generar'}
                </button>
                <label className="check">
                  <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
                </label>
                <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={() => doCommit()}>
                  <Icon.check size={13} /> {busy === 'commit' ? 'Commit…' : staged.length || amend ? 'Commit' : 'Commit todo'}
                </button>
              </div>
            </div>

            {conflicts.length > 0 && (
              <div className="section">
                <div className="section-header">
                  <Icon.alert size={12} /> Conflictos <span className="count">{conflicts.length}</span>
                </div>
                {conflicts.map((f) => (
                  <div key={'c' + f.path} className="file-row conflict" onClick={() => ps.openFile(`${repo}/${f.path}`)} title="Abrir para resolver a mano">
                    <span className="file-name ellipsis">
                      {basename(f.path)} <span className="muted small">{dirname(f.path)}</span>
                    </span>
                    <span className="row-actions always" onClick={(e) => e.stopPropagation()}>
                      <button className="btn ghost small" title="Quedarse con nuestra versión" onClick={() => run('ours', async () => (await api.git.run(repo, ['checkout', '--ours', '--', f.path]), await api.git.stage(repo, [f.path])))}>
                        Nuestra
                      </button>
                      <button className="btn ghost small" title="Quedarse con la versión entrante" onClick={() => run('theirs', async () => (await api.git.run(repo, ['checkout', '--theirs', '--', f.path]), await api.git.stage(repo, [f.path])))}>
                        Suya
                      </button>
                      <button className="icon-btn" title="Marcar como resuelto" onClick={() => run('stage', () => api.git.stage(repo, [f.path]))}>
                        <Icon.check size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        title="Pedir a un agente que lo resuelva"
                        onClick={() =>
                          ps.ask(settings?.defaultAgent ?? 'claude', `Resuelve los conflictos de merge del fichero ${f.path} conservando la intención de ambos lados. Elimina los marcadores de conflicto y no hagas commit.`, {
                            fresh: true,
                            cwd: repo,
                            withContext: false
                          })
                        }
                      >
                        <Icon.sparkles size={13} />
                      </button>
                    </span>
                    <span className="st-letter st-!">!</span>
                  </div>
                ))}
              </div>
            )}

            {staged.length > 0 && (
              <div className="section">
                <div className="section-header" onClick={() => toggle('staged')}>
                  {collapsed.staged ? <Icon.chevronRight size={12} /> : <Icon.chevronDown size={12} />} Preparados
                  <span className="count">{staged.length}</span>
                  <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Quitar todo del stage" onClick={() => run('unstage', () => api.git.unstage(repo, staged.map((f) => f.path)))}>
                      <Icon.minus size={13} />
                    </button>
                  </span>
                </div>
                {!collapsed.staged &&
                  staged.map((f) => (
                    <FileRow
                      key={'s' + f.path}
                      f={f}
                      cwd={repo}
                      staged
                      stats={stats.staged[f.path]}
                      onOpen={() => ps.openDiff(repo, f.path, 'staged')}
                      onUnstage={() => run('unstage', () => api.git.unstage(repo, [f.path]))}
                    />
                  ))}
              </div>
            )}
            <div className="section">
              <div className="section-header" onClick={() => toggle('changes')}>
                {collapsed.changes ? <Icon.chevronRight size={12} /> : <Icon.chevronDown size={12} />} Cambios
                <span className="count">{unstaged.length}</span>
                {unstaged.length > 0 && (
                  <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      title="Descartar todo"
                      onClick={async () => {
                        if (await confirmAsync(`¿Descartar los cambios de ${unstaged.length} ficheros?`, 'Incluye ficheros nuevos sin seguimiento. No se puede deshacer.', true))
                          run('discard', () => api.git.discard(repo, unstaged.map((f) => ({ path: f.path, untracked: f.untracked }))))
                      }}
                    >
                      <Icon.undo size={13} />
                    </button>
                    <button className="icon-btn" title="Preparar todo" onClick={() => run('stage', () => api.git.stage(repo, unstaged.map((f) => f.path)))}>
                      <Icon.plus size={13} />
                    </button>
                  </span>
                )}
              </div>
              {!collapsed.changes &&
                unstaged.map((f) => (
                  <FileRow
                    key={'u' + f.path}
                    f={f}
                    cwd={repo}
                    staged={false}
                    stats={stats.unstaged[f.path]}
                    onOpen={() => (f.untracked ? ps.openFile(`${repo}/${f.path}`) : ps.openDiff(repo, f.path, 'unstaged'))}
                    onStage={() => run('stage', () => api.git.stage(repo, [f.path]))}
                    onDiscard={async () => {
                      if (await confirmAsync(`¿Descartar los cambios en ${f.path}?`, 'No se puede deshacer.', true)) run('discard', () => api.git.discard(repo, [{ path: f.path, untracked: f.untracked }]))
                    }}
                  />
                ))}
              {!collapsed.changes && !unstaged.length && !staged.length && <div className="empty small">Sin cambios. Árbol de trabajo limpio.</div>}
            </div>

            <div className="section">
              <div className="section-header" onClick={() => toggle('graph')}>
                {collapsed.graph ? <Icon.chevronRight size={12} /> : <Icon.chevronDown size={12} />} Grafo
              </div>
              {!collapsed.graph && <HistoryList cwd={repo} embedded />}
            </div>
            <Worktrees cwd={repo} />
          </>
        )}
      </div>
    </div>
  )
}
