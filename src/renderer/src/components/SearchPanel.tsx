import { useState } from 'react'
import type { GrepHit } from '@shared/types'
import { api } from '../lib/api'
import { usePS, useStore } from '../lib/project-store'
import { basename, dirname, relPath } from '../lib/utils'
import { Icon } from './Icons'

export function SearchPanel() {
  const ps = usePS()
  const ws = useStore((s) => s.workspace)
  const repos = useStore((s) => s.repos)
  const [q, setQ] = useState('')
  const [regex, setRegex] = useState(false)
  const [cs, setCs] = useState(false)
  const [hits, setHits] = useState<GrepHit[] | null>(null)
  const [busy, setBusy] = useState(false)

  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    const lists = await Promise.all(
      (repos.length ? repos : [ws]).map((r) =>
        api.git
          .grep(r, q, regex, cs)
          .then((hs) => hs.map((h) => ({ ...h, path: relPath(ws, `${r}/${h.path}`) })))
          .catch(() => [] as GrepHit[])
      )
    )
    setHits(lists.flat())
    setBusy(false)
  }
  const groups: Record<string, GrepHit[]> = {}
  for (const h of hits || []) (groups[h.path] ||= []).push(h)

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Buscar</span>
      </div>
      <div className="panel-tools">
        <div className="search-input">
          <Icon.search size={13} />
          <input autoFocus placeholder="Buscar en el proyecto (↵)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <button className={`icon-btn toggle ${cs ? 'on' : ''}`} title="Distinguir mayúsculas" onClick={() => setCs(!cs)}>
            Aa
          </button>
          <button className={`icon-btn toggle ${regex ? 'on' : ''}`} title="Expresión regular" onClick={() => setRegex(!regex)}>
            .*
          </button>
        </div>
        {hits && <span className="muted small">{busy ? 'Buscando…' : `${hits.length} resultados en ${Object.keys(groups).length} ficheros`}</span>}
      </div>
      <div className="panel-body">
        {Object.entries(groups).map(([path, list]) => (
          <div key={path} className="section">
            <div className="section-header">
              <Icon.file size={12} /> {basename(path)} <span className="muted small ellipsis">{dirname(path)}</span>
              <span className="count">{list.length}</span>
            </div>
            {list.map((h) => (
              <div key={`${h.line}:${h.column}`} className="file-row" onClick={() => ps.openFile(`${ws}/${path}`, h.line)}>
                <span className="muted small tabular" style={{ width: 34, textAlign: 'right' }}>
                  {h.line}
                </span>
                <span className="ellipsis mono small">{h.text.trim()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
