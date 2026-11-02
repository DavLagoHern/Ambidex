import { useEffect, useMemo, useState } from 'react'
import type { DirEntry, GitStatus } from '@shared/types'
import { api } from '../lib/api'
import { attempt, toast } from '../lib/app-store'
import { usePS, useStore } from '../lib/project-store'
import { basename, dirname, fuzzyScore } from '../lib/utils'
import { Icon } from './Icons'

function statusMap(repoStatus: Record<string, GitStatus>) {
  const m: Record<string, string> = {}
  for (const [repo, st] of Object.entries(repoStatus))
    for (const f of st.files) m[`${repo}/${f.path}`] = f.untracked ? 'U' : f.worktree !== ' ' ? f.worktree : f.index
  return m
}

async function entryMenu(path: string, isDir: boolean, open: () => void) {
  const choice = await api.contextMenu([
    ...(!isDir ? [{ id: 'open', label: 'Abrir' }] : []),
    { id: 'reveal', label: 'Mostrar en Finder' },
    { id: 'vscode', label: 'Abrir en VS Code' },
    { type: 'separator' },
    { id: 'copy', label: 'Copiar ruta' }
  ])
  if (choice === 'open') open()
  if (choice === 'reveal') attempt(() => api.reveal(path))
  if (choice === 'vscode') attempt(() => api.openInVSCode(path))
  if (choice === 'copy') navigator.clipboard.writeText(path).then(() => toast('Ruta copiada', 'success'))
}

function Node({ entry, depth, status }: { entry: DirEntry; depth: number; status: Record<string, string> }) {
  const ps = usePS()
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const fsTick = useStore((s) => s.fsTick)
  const active = useStore((s) => s.activeTab === `file:${entry.path}`)

  useEffect(() => {
    if (open && entry.isDir) api.listDir(entry.path).then(setChildren).catch(() => setChildren([]))
  }, [open, fsTick, entry])

  const st = entry.isDir ? (Object.keys(status).some((p) => p.startsWith(entry.path + '/')) ? '•' : '') : status[entry.path] || ''
  const openIt = () => (entry.isDir ? setOpen(!open) : ps.openFile(entry.path))

  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} st-${st === '•' ? 'dot' : st}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={openIt}
        onContextMenu={(e) => (e.preventDefault(), entryMenu(entry.path, entry.isDir, openIt))}
        title={entry.path}
      >
        {entry.isDir ? (open ? <Icon.chevronDown size={12} /> : <Icon.chevronRight size={12} />) : <span style={{ width: 12 }} />}
        {entry.isDir ? <Icon.folder size={13} className="tree-icon" /> : <Icon.file size={13} className="tree-icon" />}
        <span className="ellipsis">{entry.name}</span>
        {st && <span className="tree-st">{st}</span>}
      </div>
      {open && children?.map((c) => <Node key={c.path} entry={c} depth={depth + 1} status={status} />)}
    </>
  )
}

export function Explorer() {
  const ps = usePS()
  const ws = useStore((s) => s.workspace)
  const repoStatus = useStore((s) => s.repoStatus)
  const fsTick = useStore((s) => s.fsTick)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const status = useMemo(() => statusMap(repoStatus), [repoStatus])

  useEffect(() => {
    api.listDir(ws).then(setEntries).catch(() => setEntries([]))
  }, [ws, fsTick])

  useEffect(() => {
    if (q) ps.fileList().then(setFiles)
  }, [q, fsTick])

  const results = useMemo(() => {
    const ql = q.toLowerCase()
    return files
      .map((f) => [f, fuzzyScore(f, ql)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([f]) => f)
  }, [files, q])

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Explorador</span>
        <span className="row-actions always">
          <button className="icon-btn" title="Mostrar en Finder" onClick={() => attempt(() => api.reveal(ws))}>
            <Icon.folderOpen size={14} />
          </button>
        </span>
      </div>
      <div className="panel-tools">
        <div className="search-input">
          <Icon.search size={13} />
          <input placeholder="Filtrar ficheros…" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="icon-btn" onClick={() => setQ('')}>
              <Icon.x size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="panel-body tree">
        {q
          ? results.map((f) => (
              <div key={f} className={`tree-row st-${status[`${ws}/${f}`] ?? ''}`} style={{ paddingLeft: 12 }} onClick={() => ps.openFile(`${ws}/${f}`)} title={f}>
                <Icon.file size={13} className="tree-icon" />
                <span className="ellipsis">
                  {basename(f)} <span className="muted small">{dirname(f)}</span>
                </span>
              </div>
            ))
          : entries.map((e) => <Node key={e.path} entry={e} depth={0} status={status} />)}
        {q && !results.length && <div className="empty small">Sin coincidencias</div>}
      </div>
    </div>
  )
}
