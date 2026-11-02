import { useEffect, useMemo, useState } from 'react'
import { setApp } from '../lib/app-store'
import { usePS, useStore } from '../lib/project-store'
import { basename, dirname, fuzzyScore } from '../lib/utils'
import { Icon } from './Icons'

export function QuickOpen() {
  const ps = usePS()
  const ws = useStore((s) => s.workspace)
  const name = useStore((s) => s.meta.name)
  const [files, setFiles] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  useEffect(() => {
    ps.fileList().then(setFiles)
  }, [ws])

  const results = useMemo(() => {
    const ql = q.toLowerCase()
    return (files ?? [])
      .map((f) => [f, fuzzyScore(f, ql)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([f]) => f)
  }, [files, q])

  const close = () => setApp({ overlay: null })
  const choose = (f?: string) => {
    if (f) ps.openFile(`${ws}/${f}`)
    close()
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon.file size={15} />
          <input
            autoFocus
            placeholder={files === null ? 'Cargando ficheros…' : files.length ? `Ir a fichero en ${name} (${files.length})` : 'No hay ficheros (¿repositorio Git?)'}
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel(Math.min(sel + 1, results.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setSel(Math.max(sel - 1, 0)))
              if (e.key === 'Enter') choose(results[sel])
            }}
          />
        </div>
        <div className="palette-list">
          {results.map((f, i) => (
            <div key={f} className={`palette-item ${i === sel ? 'selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(f)}>
              <Icon.file size={14} />
              <span className="palette-title">{basename(f)}</span>
              <span className="muted small ellipsis">{dirname(f)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
