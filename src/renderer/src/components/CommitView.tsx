import { useEffect, useState } from 'react'
import { DiffPane } from './DiffPane'
import type { CommitDetail } from '@shared/types'
import { api } from '../lib/api'
import { askText, attempt, toast } from '../lib/app-store'
import { usePS } from '../lib/project-store'
import { basename, dirname } from '../lib/utils'
import { AgentLogo, Icon } from './Icons'

export function CommitView({ cwd, hash }: { cwd: string; hash: string }) {
  const ps = usePS()
  const [c, setC] = useState<CommitDetail | null>(null)
  const [sel, setSel] = useState<number>(0)
  const [sides, setSides] = useState<{ a: string; b: string } | null>(null)
  const [inline, setInline] = useState(false)

  useEffect(() => {
    api.git.commitDetail(cwd, hash).then(setC).catch((e) => toast(String(e), 'error'))
  }, [cwd, hash])

  const file = c?.files[sel]
  useEffect(() => {
    if (!c || !file) return
    const parent = c.parents[0]
    Promise.all([
      parent && file.status !== 'A' ? api.git.show(cwd, parent, file.origPath || file.path) : Promise.resolve(''),
      file.status !== 'D' ? api.git.show(cwd, c.hash, file.path) : Promise.resolve('')
    ]).then(([a, b]) => setSides({ a, b }))
  }, [c, sel])

  if (!c) return <div className="center-msg">Cargando commit…</div>

  const [subject, ...bodyLines] = c.message.split('\n')
  const body = bodyLines.join('\n').trim()
  const totalAdd = c.files.reduce((n, f) => n + f.add, 0)
  const totalDel = c.files.reduce((n, f) => n + f.del, 0)

  const explain = (agent: 'claude' | 'codex') => {
    ps.set((s) => ({ agentView: s.agentView === 'both' ? 'both' : agent }))
    ps.ask(
      agent,
      `Explícame el commit ${c.hash} de este repositorio (usa \`git show ${c.hash}\`): qué cambia, por qué parece hacerse, el impacto y cualquier riesgo o bug potencial. No modifiques ficheros.`,
      { fresh: true, cwd, withContext: false }
    )
  }

  return (
    <div className="commit-view">
      <div className="commit-head">
        <h2>{subject}</h2>
        {body && <pre className="commit-body">{body}</pre>}
        <div className="commit-info small">
          <span><b>{c.author}</b> &lt;{c.email}&gt;</span>
          <span className="muted">{new Date(c.date * 1000).toLocaleString()}</span>
          <span className="mono hash" title="Copiar hash" onClick={() => (navigator.clipboard.writeText(c.hash), toast('Hash copiado', 'success'))}>
            {c.hash.slice(0, 10)} <Icon.copy size={11} />
          </span>
          {c.parents.map((p) => (
            <span key={p} className="mono link" onClick={() => ps.openCommit(cwd, p, 'padre')}>padre {p.slice(0, 7)}</span>
          ))}
          <span><span className="add">+{totalAdd}</span> <span className="del">−{totalDel}</span> en {c.files.length} ficheros</span>
        </div>
        <div className="row gap">
          <button className="btn" onClick={() => explain('claude')}><AgentLogo agent="claude" size={13} /> Explicar con Claude</button>
          <button className="btn" onClick={() => explain('codex')}><AgentLogo agent="codex" size={13} /> Explicar con Codex</button>
          <button
            className="btn ghost"
            onClick={async () => {
              const name = await askText('Nombre de la nueva rama desde este commit', 'feature/…')
              if (name) {
                await attempt(() => api.git.createBranch(cwd, name, c.hash), `Rama ${name} creada`)
                ps.refreshGit()
              }
            }}
          >
            <Icon.branch size={13} /> Crear rama aquí
          </button>
        </div>
      </div>
      <div className="commit-split">
        <div className="commit-files">
          {c.files.map((f, i) => (
            <div key={f.path} className={`file-row ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
              <span className="file-name ellipsis">{basename(f.path)} <span className="muted small">{dirname(f.path)}</span></span>
              <span className="small"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
              <span className={`st-letter st-${f.status}`}>{f.status}</span>
            </div>
          ))}
        </div>
        <div className="commit-diff">
          {file && (
            <div className="diff-bar">
              <span className="mono small">{file.origPath ? `${file.origPath} → ` : ''}{file.path}</span>
              <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => setInline(!inline)}>
                {inline ? 'Lado a lado' : 'En línea'}
              </button>
            </div>
          )}
          {sides && file && <DiffPane id={`${c.hash}:${file.path}`} path={file.path} original={sides.a} modified={sides.b} inline={inline} />}
        </div>
      </div>
    </div>
  )
}
