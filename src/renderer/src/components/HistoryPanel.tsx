import { useEffect, useMemo, useState } from 'react'
import type { GitCommit } from '@shared/types'
import { api } from '../lib/api'
import { computeGraph, GraphRow, LANE_COLORS } from '../lib/graph'
import { askText, attempt, confirmAsync, toast } from '../lib/app-store'
import { usePS, useStore } from '../lib/project-store'
import { basename, timeAgo } from '../lib/utils'
import { Icon } from './Icons'

const ROW = 30
const LANE = 12

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (i: number) => 8 + i * LANE
  const mid = ROW / 2
  const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length]
  return (
    <svg width={8 + width * LANE} height={ROW} className="graph-cell">
      {row.top.map((s, i) => (
        <path key={'t' + i} d={`M${x(s.from)} 0 C${x(s.from)} ${mid / 2}, ${x(s.to)} ${mid / 2}, ${x(s.to)} ${mid}`} stroke={color(s.from)} fill="none" strokeWidth={1.6} />
      ))}
      {row.bottom.map((s, i) => (
        <path key={'b' + i} d={`M${x(s.from)} ${mid} C${x(s.from)} ${mid * 1.5}, ${x(s.to)} ${mid * 1.5}, ${x(s.to)} ${ROW}`} stroke={color(s.to)} fill="none" strokeWidth={1.6} />
      ))}
      <circle cx={x(row.col)} cy={mid} r={4} fill={color(row.col)} stroke="var(--bg-panel)" strokeWidth={1.5} />
    </svg>
  )
}

function RefBadge({ r }: { r: string }) {
  const head = r.startsWith('HEAD -> ')
  const name = r.replace('HEAD -> ', '').replace('tag: ', '')
  const cls = r.startsWith('tag: ') ? 'tag' : name.includes('/') && !head ? 'remote' : head ? 'head' : 'local'
  return <span className={`ref ref-${cls}`}>{name}</span>
}

export function HistoryPanel() {
  const repo = useStore((s) => s.repo)
  const repos = useStore((s) => s.repos)
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Historial{repos.length > 1 && repo ? ` · ${basename(repo)}` : ''}</span>
      </div>
      {repo ? <HistoryList cwd={repo} /> : <div className="empty small">No hay repositorio activo.</div>}
    </div>
  )
}

export function HistoryList({ cwd: ws, embedded }: { cwd: string; embedded?: boolean }) {
  const ps = usePS()
  const gitTick = useStore((s) => s.gitTick)
  const activeTab = useStore((s) => s.activeTab)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [all, setAll] = useState(true)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(embedded ? 60 : 300)

  useEffect(() => {
    api.git.log(ws, limit, 0, all).then(setCommits)
  }, [ws, all, limit, gitTick])

  const graph = useMemo(() => computeGraph(commits), [commits])
  const maxWidth = Math.min(8, Math.max(1, ...graph.map((g) => g.width)))
  const f = filter.toLowerCase()

  return (
    <div className={embedded ? 'history-embedded' : 'history-full'}>
      <div className="panel-tools row gap" style={{ flexDirection: 'row' }}>
        <div className="search-input">
          <Icon.search size={13} />
          <input placeholder="Filtrar por mensaje, autor o hash…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label className="check small" title="Mostrar todas las ramas">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Todas
        </label>
      </div>
      <div className={embedded ? '' : 'panel-body'}>
        {commits.length === 0 && <div className="empty small">Sin commits todavía.</div>}
        {commits.map((c, i) => {
          if (f && !`${c.subject} ${c.author} ${c.hash}`.toLowerCase().includes(f)) return null
          return (
            <div
              key={c.hash}
              className={`commit-row ${activeTab === `commit:${c.hash}` ? 'active' : ''}`}
              style={{ height: ROW }}
              onClick={() => ps.openCommit(ws, c.hash, c.subject)}
              onContextMenu={async (e) => {
                e.preventDefault()
                const choice = await api.contextMenu([
                  { id: 'open', label: 'Ver commit' },
                  { type: 'separator' },
                  { id: 'cherry', label: 'Cherry-pick en la rama actual' },
                  { id: 'revert', label: 'Revertir este commit' },
                  { id: 'branch', label: 'Crear rama desde aquí…' },
                  { type: 'separator' },
                  { id: 'copy', label: 'Copiar hash' }
                ])
                const done = () => (ps.refreshGit(), ps.set((s) => ({ fsTick: s.fsTick + 1 })))
                if (choice === 'open') ps.openCommit(ws, c.hash, c.subject)
                if (choice === 'cherry' && (await confirmAsync(`¿Aplicar ${c.short} sobre la rama actual?`, c.subject)))
                  await attempt(() => api.git.run(ws, ['cherry-pick', '-x', c.hash]), 'Cherry-pick hecho').finally(done)
                if (choice === 'revert' && (await confirmAsync(`¿Revertir ${c.short}?`, 'Se crea un commit nuevo que deshace sus cambios.')))
                  await attempt(() => api.git.run(ws, ['revert', '--no-edit', c.hash]), 'Commit revertido').finally(done)
                if (choice === 'branch') {
                  const name = await askText('Nombre de la nueva rama', 'feature/…')
                  if (name) await attempt(() => api.git.createBranch(ws, name, c.hash), `Rama ${name} creada`).finally(done)
                }
                if (choice === 'copy') navigator.clipboard.writeText(c.hash).then(() => toast('Hash copiado', 'success'))
              }}
              title={`${c.hash}\n${c.author} · ${new Date(c.date * 1000).toLocaleString()}\n\n${c.subject}`}
            >
              {!f && <GraphCell row={graph[i]} width={maxWidth} />}
              <div className="commit-main">
                <div className="commit-subject ellipsis">
                  {c.refs.map((r) => <RefBadge key={r} r={r} />)}
                  {c.subject}
                </div>
                <div className="commit-meta muted small ellipsis">
                  {c.short} · {c.author} · {timeAgo(c.date)}
                </div>
              </div>
            </div>
          )
        })}
        {commits.length >= limit && (
          <button className="btn ghost full" onClick={() => setLimit(limit + 300)}>
            <Icon.down size={13} /> Cargar más
          </button>
        )}
      </div>
    </div>
  )
}
