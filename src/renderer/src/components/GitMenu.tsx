import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { askText, attempt, confirmAsync, pick, PickItem, setApp, toast, useApp } from '../lib/app-store'
import type { ProjectStore } from '../lib/project-store'
import { timeAgo } from '../lib/utils'
import { Icon } from './Icons'

export interface MenuNode {
  label: string
  action?: () => void
  children?: MenuNode[]
  danger?: boolean
  sep?: boolean
}

// Menú con submenús que se abren al pasar el ratón. Se pinta en un portal con posición fija
// para que no lo recorte el scroll de la barra lateral.
export function MenuTree({ items, onClose, align = 'left' }: { items: MenuNode[]; onClose: () => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState<number | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)

  useLayoutEffect(() => {
    const host = anchor.current?.parentElement
    if (!host) return
    const r = host.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 400
    const top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - h - 8))
    setPos(align === 'right' ? { top, right: window.innerWidth - r.right } : { top, left: r.left })
  }, [align])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.parentElement?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const menu = (
    <div
      ref={ref}
      className={`menu tree-menu ${align === 'right' ? 'align-right' : ''}`}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left, right: pos?.right, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-divider" />
        ) : (
          <div
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''} ${open === i ? 'selected' : ''}`}
            onMouseEnter={() => setOpen(it.children ? i : null)}
            onClick={(e) => {
              e.stopPropagation()
              if (it.children) return setOpen(i)
              onClose()
              it.action?.()
            }}
          >
            <span>{it.label}</span>
            {it.children && <Icon.chevronRight size={12} />}
            {it.children && open === i && (
              <div className="menu submenu">
                {it.children.map((c, j) =>
                  c.sep ? (
                    <div key={j} className="menu-divider" />
                  ) : (
                    <div
                      key={j}
                      className={`menu-item ${c.danger ? 'danger' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onClose()
                        c.action?.()
                      }}
                    >
                      <span>{c.label}</span>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
  return (
    <>
      <span ref={anchor} style={{ display: 'none' }} />
      {createPortal(menu, document.body)}
    </>
  )
}

// ---------- acciones ----------

const g = (cwd: string, args: string[]) => api.git.run(cwd, args)

// Ejecuta una acción de Git y refresca el proyecto que la lanzó (aunque el usuario haya cambiado de pestaña)
async function act(ps: ProjectStore, fn: () => Promise<unknown>, ok?: string) {
  await attempt(fn, ok)
  ps.refreshGit()
  ps.set((s) => ({ fsTick: s.fsTick + 1 }))
}

async function pickBranch(cwd: string, title: string, opts: { remote?: boolean; local?: boolean } = { local: true, remote: true }) {
  const list = await api.git.branches(cwd)
  const items: PickItem[] = list
    .filter((b) => (b.remote ? opts.remote : opts.local))
    .map((b) => ({ value: b.name, label: `${b.current ? '● ' : ''}${b.name}`, detail: `${b.remote ? 'remota' : 'local'}${b.lastCommit ? ' · ' + timeAgo(b.lastCommit) : ''}` }))
  return pick(title, items)
}

async function pickRemote(cwd: string, title: string) {
  const rs = await api.git.remotes(cwd)
  if (!rs.length) {
    toast('Este repositorio no tiene remotos', 'error')
    return null
  }
  if (rs.length === 1) return rs[0].name
  return pick(title, rs.map((r) => ({ value: r.name, label: r.name, detail: r.url })))
}

async function pickStash(cwd: string, title: string) {
  const list = await api.git.stashes(cwd)
  if (!list.length) {
    toast('No hay stashes')
    return null
  }
  return pick(title, list.map((s) => ({ value: s.ref, label: `${s.ref}: ${s.subject}`, detail: timeAgo(s.date) })))
}

export async function cloneRepo(ps: ProjectStore) {
  const url = await askText('URL del repositorio a clonar', 'https://github.com/usuario/repo.git')
  if (!url) return
  toast('Clonando…')
  const path = await attempt(() => api.git.clone(url))
  if (path) {
    toast(`Clonado en ${path}`)
    ps.addRepoToProject(path)
  }
}

export async function checkoutTo(ps: ProjectStore, cwd: string) {
  const list = await api.git.branches(cwd)
  const choice = await pick('Checkout a…', [
    { value: '__new', label: '+ Crear rama nueva…' },
    { value: '__newfrom', label: '+ Crear rama nueva desde…' },
    { value: '__detach', label: '⌁ Checkout separado (detached)…' },
    ...list.map((b) => ({ value: (b.remote ? 'r:' : 'l:') + b.name, label: `${b.current ? '● ' : ''}${b.name}`, detail: b.remote ? 'remota' : 'local' }))
  ])
  if (!choice) return
  if (choice === '__new') return createBranch(ps, cwd)
  if (choice === '__newfrom') return createBranchFrom(ps, cwd)
  if (choice === '__detach') {
    const ref = await askText('Commit, tag o rama para checkout separado')
    if (ref) act(ps, () => g(cwd, ['checkout', '--detach', ref]))
    return
  }
  act(ps, () => api.git.checkout(cwd, choice.slice(2), choice.startsWith('r:')), `Cambiado a ${choice.slice(2)}`)
}

async function createBranch(ps: ProjectStore, cwd: string) {
  const name = await askText('Nombre de la nueva rama', 'feature/…')
  if (name) act(ps, () => api.git.createBranch(cwd, name), `Rama ${name} creada`)
}

async function createBranchFrom(ps: ProjectStore, cwd: string) {
  const from = await pickBranch(cwd, 'Crear rama desde…')
  if (!from) return
  const name = await askText(`Nueva rama desde ${from}`, 'feature/…')
  if (name) act(ps, () => api.git.createBranch(cwd, name, from), `Rama ${name} creada`)
}

export interface CommitHooks {
  commit: (mode: 'staged' | 'all' | 'amend') => void
  generate: () => void
  focusMessage: () => void
}

export function repoMenu(ps: ProjectStore, cwd: string, hooks: CommitHooks): MenuNode[] {
  const st = () => ps.state.repoStatus[cwd]
  const branch = () => st()?.branch
  return [
    { label: 'Pull', action: () => act(ps, () => api.git.pull(cwd), 'Pull completado') },
    { label: 'Push', action: () => act(ps, () => api.git.push(cwd), 'Push completado') },
    { label: 'Clonar…', action: () => cloneRepo(ps) },
    { label: 'Checkout a…', action: () => checkoutTo(ps, cwd) },
    { label: 'Fetch', action: () => act(ps, () => api.git.fetch(cwd), 'Fetch completado') },
    { label: '', sep: true },
    {
      label: 'Commit',
      children: [
        { label: 'Commit', action: hooks.focusMessage },
        { label: 'Commit preparados', action: () => hooks.commit('staged') },
        { label: 'Commit todo', action: () => hooks.commit('all') },
        { label: 'Commit (amend)', action: () => hooks.commit('amend') },
        { label: 'Generar mensaje con IA', action: hooks.generate },
        { label: '', sep: true },
        {
          label: 'Deshacer último commit',
          action: async () => (await confirmAsync('¿Deshacer el último commit? Los cambios vuelven al stage (git reset --soft HEAD~1).', undefined, true)) && act(ps, () => g(cwd, ['reset', '--soft', 'HEAD~1']), 'Commit deshecho')
        }
      ]
    },
    {
      label: 'Cambios',
      children: [
        { label: 'Preparar todo', action: () => act(ps, () => g(cwd, ['add', '-A'])) },
        { label: 'Quitar todo del stage', action: () => act(ps, () => g(cwd, ['reset', '-q'])) },
        { label: '', sep: true },
        {
          label: 'Descartar todos los cambios',
          danger: true,
          action: async () => (await confirmAsync('¿Descartar TODOS los cambios (incluidos ficheros nuevos)? No se puede deshacer.', undefined, true)) && act(ps, () => g(cwd, ['reset', '--hard', '-q']).then(() => g(cwd, ['clean', '-fd'])), 'Cambios descartados')
        },
        {
          label: 'Descartar ficheros sin seguimiento',
          danger: true,
          action: async () => (await confirmAsync('¿Borrar los ficheros sin seguimiento (git clean -fd)?', undefined, true)) && act(ps, () => g(cwd, ['clean', '-fd']))
        }
      ]
    },
    {
      label: 'Pull, Push',
      children: [
        { label: 'Sincronizar (pull + push)', action: () => act(ps, async () => (await api.git.pull(cwd), await api.git.push(cwd)), 'Sincronizado') },
        { label: '', sep: true },
        { label: 'Pull', action: () => act(ps, () => api.git.pull(cwd), 'Pull completado') },
        { label: 'Pull (rebase)', action: () => act(ps, () => g(cwd, ['pull', '--rebase']), 'Pull con rebase completado') },
        {
          label: 'Pull desde…',
          action: async () => {
            const remote = await pickRemote(cwd, 'Pull desde remoto')
            if (!remote) return
            const br = await askText(`Rama de ${remote}`, '', branch())
            if (br) act(ps, () => g(cwd, ['pull', remote, br]), 'Pull completado')
          }
        },
        { label: '', sep: true },
        { label: 'Push', action: () => act(ps, () => api.git.push(cwd), 'Push completado') },
        {
          label: 'Push a…',
          action: async () => {
            const remote = await pickRemote(cwd, 'Push a remoto')
            if (remote && branch()) act(ps, () => g(cwd, ['push', '-u', remote, branch()!]), 'Push completado')
          }
        },
        {
          label: 'Push (forzado con lease)',
          danger: true,
          action: async () => (await confirmAsync('¿Push forzado (--force-with-lease)?', undefined, true)) && act(ps, () => g(cwd, ['push', '--force-with-lease']), 'Push forzado completado')
        },
        { label: '', sep: true },
        { label: 'Fetch', action: () => act(ps, () => g(cwd, ['fetch']), 'Fetch completado') },
        { label: 'Fetch (prune)', action: () => act(ps, () => g(cwd, ['fetch', '--prune']), 'Fetch completado') },
        { label: 'Fetch de todos los remotos', action: () => act(ps, () => api.git.fetch(cwd), 'Fetch completado') }
      ]
    },
    {
      label: 'Rama',
      children: [
        {
          label: 'Merge de rama…',
          action: async () => {
            const b = await pickBranch(cwd, `Merge en ${branch()}`)
            if (b) act(ps, () => g(cwd, ['merge', b]), `Merge de ${b} completado`)
          }
        },
        {
          label: 'Rebase de rama…',
          action: async () => {
            const b = await pickBranch(cwd, `Rebase de ${branch()} sobre…`)
            if (b) act(ps, () => g(cwd, ['rebase', b]), `Rebase sobre ${b} completado`)
          }
        },
        { label: '', sep: true },
        { label: 'Crear rama…', action: () => createBranch(ps, cwd) },
        { label: 'Crear rama desde…', action: () => createBranchFrom(ps, cwd) },
        {
          label: 'Renombrar rama…',
          action: async () => {
            const name = await askText('Nuevo nombre de la rama', '', branch())
            if (name) act(ps, () => g(cwd, ['branch', '-m', name]), 'Rama renombrada')
          }
        },
        {
          label: 'Borrar rama…',
          danger: true,
          action: async () => {
            const b = await pickBranch(cwd, 'Borrar rama local', { local: true })
            if (!b) return
            try {
              await api.git.deleteBranch(cwd, b, false)
              toast(`Rama ${b} borrada`)
            } catch {
              if (await confirmAsync(`La rama ${b} no está fusionada`, '¿Borrarla igualmente? Se perderán sus commits no fusionados.', true)) await attempt(() => api.git.deleteBranch(cwd, b, true), `Rama ${b} borrada`)
            }
            ps.refreshGit()
          }
        },
        {
          label: 'Borrar rama remota…',
          danger: true,
          action: async () => {
            const b = await pickBranch(cwd, 'Borrar rama remota', { remote: true })
            if (!b || !(await confirmAsync(`¿Borrar ${b} del remoto?`, undefined, true))) return
            const [remote, ...rest] = b.split('/')
            act(ps, () => g(cwd, ['push', remote, '--delete', rest.join('/')]), `Rama remota ${b} borrada`)
          }
        },
        { label: '', sep: true },
        {
          label: 'Publicar rama',
          action: async () => {
            const remote = await pickRemote(cwd, 'Publicar en')
            if (remote && branch()) act(ps, () => g(cwd, ['push', '-u', remote, branch()!]), 'Rama publicada')
          }
        }
      ]
    },
    {
      label: 'Remoto',
      children: [
        {
          label: 'Añadir remoto…',
          action: async () => {
            const url = await askText('URL del remoto')
            if (!url) return
            const name = await askText('Nombre del remoto', 'origin', 'origin')
            if (name) act(ps, () => g(cwd, ['remote', 'add', name, url]), `Remoto ${name} añadido`)
          }
        },
        {
          label: 'Quitar remoto…',
          danger: true,
          action: async () => {
            const r = await pickRemote(cwd, 'Quitar remoto')
            if (r && (await confirmAsync(`¿Quitar el remoto ${r}?`, undefined, true))) act(ps, () => g(cwd, ['remote', 'remove', r]), `Remoto ${r} eliminado`)
          }
        },
        {
          label: 'Ver remotos',
          action: async () => {
            const rs = await api.git.remotes(cwd)
            pick('Remotos', rs.map((r) => ({ value: r.name, label: r.name, detail: r.url })))
          }
        }
      ]
    },
    {
      label: 'Stash',
      children: [
        { label: 'Stash', action: () => act(ps, () => g(cwd, ['stash', 'push']), 'Stash guardado') },
        { label: 'Stash (incluir sin seguimiento)', action: () => act(ps, () => g(cwd, ['stash', 'push', '-u']), 'Stash guardado') },
        { label: 'Stash (solo preparados)', action: () => act(ps, () => g(cwd, ['stash', 'push', '--staged']), 'Stash guardado') },
        {
          label: 'Stash con mensaje…',
          action: async () => {
            const m = await askText('Mensaje del stash')
            if (m) act(ps, () => g(cwd, ['stash', 'push', '-u', '-m', m]), 'Stash guardado')
          }
        },
        { label: '', sep: true },
        { label: 'Aplicar último stash', action: () => act(ps, () => g(cwd, ['stash', 'apply']), 'Stash aplicado') },
        {
          label: 'Aplicar stash…',
          action: async () => {
            const s = await pickStash(cwd, 'Aplicar stash')
            if (s) act(ps, () => g(cwd, ['stash', 'apply', s]), 'Stash aplicado')
          }
        },
        { label: 'Pop último stash', action: () => act(ps, () => g(cwd, ['stash', 'pop']), 'Stash aplicado y eliminado') },
        {
          label: 'Pop stash…',
          action: async () => {
            const s = await pickStash(cwd, 'Pop stash')
            if (s) act(ps, () => g(cwd, ['stash', 'pop', s]), 'Stash aplicado y eliminado')
          }
        },
        { label: '', sep: true },
        {
          label: 'Borrar stash…',
          danger: true,
          action: async () => {
            const s = await pickStash(cwd, 'Borrar stash')
            if (s) act(ps, () => g(cwd, ['stash', 'drop', s]), 'Stash borrado')
          }
        },
        {
          label: 'Borrar todos los stashes',
          danger: true,
          action: async () => (await confirmAsync('¿Borrar todos los stashes?', undefined, true)) && act(ps, () => g(cwd, ['stash', 'clear']), 'Stashes borrados')
        }
      ]
    },
    {
      label: 'Tags',
      children: [
        {
          label: 'Crear tag…',
          action: async () => {
            const name = await askText('Nombre del tag', 'v1.0.0')
            if (!name) return
            const msg = await askText('Mensaje del tag (vacío = tag ligero)', '')
            act(ps, () => g(cwd, msg ? ['tag', '-a', name, '-m', msg] : ['tag', name]), `Tag ${name} creado`)
          }
        },
        {
          label: 'Borrar tag…',
          danger: true,
          action: async () => {
            const ts = await api.git.tags(cwd)
            const t = await pick('Borrar tag', ts.map((t) => ({ value: t.name, label: t.name, detail: t.subject })))
            if (t) act(ps, () => g(cwd, ['tag', '-d', t]), `Tag ${t} borrado`)
          }
        },
        { label: 'Push de tags', action: () => act(ps, () => g(cwd, ['push', '--tags']), 'Tags publicados') },
        {
          label: 'Borrar tag remoto…',
          danger: true,
          action: async () => {
            const remote = await pickRemote(cwd, 'Remoto')
            const t = remote && (await askText(`Tag a borrar de ${remote}`))
            if (remote && t && (await confirmAsync(`¿Borrar el tag ${t} de ${remote}?`, undefined, true))) act(ps, () => g(cwd, ['push', remote, '--delete', `refs/tags/${t}`]), 'Tag remoto borrado')
          }
        }
      ]
    },
    {
      label: 'Worktrees',
      children: [
        {
          label: 'Crear worktree…',
          action: async () => {
            const name = await askText('Nombre del worktree (se crea la rama ai/<nombre>)', 'experimento')
            if (name) act(ps, () => api.git.addWorktree(cwd, name), 'Worktree creado')
          }
        },
        {
          label: 'Abrir worktree…',
          action: async () => {
            const wts = await api.git.worktrees(cwd)
            const p = await pick('Abrir worktree como workspace', wts.map((w) => ({ value: w.path, label: w.branch || w.head.slice(0, 7), detail: w.path })))
            if (p) ps.setWorkspace(p)
          }
        },
        {
          label: 'Borrar worktree…',
          danger: true,
          action: async () => {
            const wts = (await api.git.worktrees(cwd)).filter((w) => !w.main)
            const p = await pick('Borrar worktree', wts.map((w) => ({ value: w.path, label: w.branch || w.head.slice(0, 7), detail: w.path })))
            if (p && (await confirmAsync(`¿Borrar el worktree ${p}?`, 'Se perderán los cambios sin commit del worktree (la rama se conserva).', true))) act(ps, () => api.git.removeWorktree(cwd, p), 'Worktree borrado')
          }
        }
      ]
    },
    { label: '', sep: true },
    { label: 'Ver salida de Git', action: () => setApp({ overlay: 'gitOutput' }) }
  ]
}

// ---------- salida de Git y selector ----------

export function GitOutput() {
  const open = useApp((s) => s.overlay === 'gitOutput')
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.git.output>>>([])
  useEffect(() => {
    if (!open) return
    const load = () => api.git.output().then(setEntries)
    load()
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [open])
  if (!open) return null
  return (
    <div className="overlay" onMouseDown={() => setApp({ overlay: null })}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Salida de Git</h3>
        <div className="git-output">
          {entries.length === 0 && <div className="muted">Todavía no se han ejecutado comandos.</div>}
          {[...entries].reverse().map((e, i) => (
            <div key={i} className={`git-out-row ${e.ok ? '' : 'fail'}`}>
              <span className="muted">{new Date(e.at).toLocaleTimeString()}</span>{' '}
              <span className="muted">[{e.cwd.split('/').pop()}]</span> git {e.args.join(' ')} <span className="muted">· {e.ms} ms</span>
              {e.stderr && <pre>{e.stderr}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}


export function Picker() {
  const picker = useApp((s) => s.picker)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  useEffect(() => {
    setQ('')
    setSel(0)
  }, [picker])
  if (!picker) return null
  const ql = q.toLowerCase()
  const items = picker.items.filter((i) => !ql || `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(ql))
  return (
    <div className="overlay" onMouseDown={() => picker.resolve(null)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="small muted" style={{ padding: '2px 4px 6px' }}>{picker.title}</div>
        <input
          autoFocus
          className="input"
          placeholder="Filtrar…"
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') picker.resolve(null)
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel(Math.min(sel + 1, items.length - 1)))
            if (e.key === 'ArrowUp') (e.preventDefault(), setSel(Math.max(sel - 1, 0)))
            if (e.key === 'Enter' && items[sel]) picker.resolve(items[sel].value)
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <div key={it.value + i} className={`menu-item ${i === sel ? 'selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => picker.resolve(it.value)}>
              <span>{it.label}</span>
              {it.detail && <span className="muted small ellipsis">{it.detail}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="muted small" style={{ padding: 8 }}>Sin resultados</div>}
        </div>
      </div>
    </div>
  )
}
