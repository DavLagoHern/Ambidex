import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { RunLogLine } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { api } from '../lib/api'
import { toast } from '../lib/app-store'
import { ProjectStore, usePS, useStore } from '../lib/project-store'
import { AgentLogo, Icon } from './Icons'

// xterm solo se carga cuando hay alguna terminal
const TerminalView = lazy(() => import('./Terminal').then((m) => ({ default: m.TerminalView })))

// Registro técnico de una ejecución: stderr del CLI, eventos JSON y mensajes del sistema
function RunLog() {
  const ps = usePS()
  const runs = useStore((s) => s.runs)
  const selected = useStore((s) => s.logRun) ?? runs[0]?.id ?? null
  const run = runs.find((r) => r.id === selected)
  const [lines, setLines] = useState<RunLogLine[]>([])
  const [filter, setFilter] = useState<'output' | 'all' | 'stderr' | 'event'>('output')
  const items = useStore(s => run ? s.sessions[run.sessionId]?.items : undefined)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!selected) return setLines([])
    let alive = true
    setLines([])
    setError('')
    const load = () => api.runs.log(selected).then((l) => { if (alive) { setLines(l); setError('') } }).catch(e => { if (alive) setError(String(e)) })
    load()
    const t = run?.status === 'running' ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [selected, run?.status])

  useEffect(() => {
    if (run && !items) void ps.loadMessages(run.sessionId)
  }, [run?.sessionId, !!items])

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines.length, items])

  const shown = lines.filter((l) => filter === 'all' || l.stream === filter)
  return (
    <div className="runlog">
      <div className="runlog-bar">
        <select className="select" value={selected ?? ''} onChange={(e) => ps.set({ logRun: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {AGENT_NAMES[r.agent]} · {r.sessionTitle ?? r.id.slice(0, 8)} · {new Date(r.startedAt).toLocaleString()} · {r.status}
            </option>
          ))}
          {!runs.length && <option value="">Sin ejecuciones</option>}
        </select>
        <div className="seg">
          {(['output', 'all', 'stderr', 'event'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'output' ? 'Salida' : f === 'all' ? 'Todo' : f === 'stderr' ? 'stderr' : 'Eventos'}
            </button>
          ))}
        </div>
        {run && (
          <span className="muted small">
            {run.pid ? `PID ${run.pid} · ` : ''}
            {run.exitCode !== undefined && run.exitCode !== null ? `código ${run.exitCode}` : run.status}
          </span>
        )}
      </div>
      <div className="runlog-lines mono" ref={box}>
        {error && <div role="status" className="muted small">No se pudo actualizar el registro: {error}</div>}
        {filter === 'output' && <>
          <p className="runlog-explanation">Salida comunicada por el agente. Algunos comandos acumulan su salida hasta terminar; este visor no es una terminal interactiva.</p>
          {items?.filter(i => i.type === 'tool' && (i.at ?? 0) >= (run?.startedAt ?? 0) && (!run?.endedAt || (i.at ?? 0) <= run.endedAt)).map(i => i.type === 'tool' && <div className="runlog-command" key={i.id}>
            <div className="runlog-command-head"><b>{i.name}</b><span>{i.status === 'running' ? 'En ejecución' : i.status === 'error' ? 'Falló' : 'Terminó'}</span></div>
            <pre>{i.input}</pre>
            <pre className="runlog-command-output">{i.output || (i.status === 'running' ? 'El agente todavía no ha comunicado salida de esta acción.' : 'Sin salida de texto.')}</pre>
          </div>)}
          {lines.filter(l => l.stream === 'stderr').map((l,i) => <div key={i} className="log-line log-stderr"><span className="log-time">{new Date(l.at).toLocaleTimeString()}</span><span className="log-text">{l.line}</span></div>)}
          {run?.status === 'running' && <div className="runlog-waiting small muted">Esperando nueva salida · actualización automática cada 1,5 s. Puedes consultar los eventos técnicos en «Todo».</div>}
        </>}
        {filter !== 'output' && shown.map((l, i) => (
          <div key={i} className={`log-line log-${l.stream}`}>
            <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>
            <span className="log-stream">{l.stream}</span>
            <span className="log-text">{l.line}</span>
          </div>
        ))}
        {filter !== 'output' && !shown.length && <div className="muted small" style={{ padding: 10 }}>Sin líneas.</div>}
      </div>
    </div>
  )
}

// Menú con los scripts de desarrollo del proyecto
export async function devMenu(ps: ProjectStore) {
  const scripts = await ps.devScripts()
  if (!scripts.length) return toast('No encuentro scripts de desarrollo en package.json (dev, start, serve…)', 'error')
  if (scripts.length === 1) return ps.runDevServer(scripts[0].name)
  const c = await api.contextMenu(scripts.map((s) => ({ id: s.name, label: `${s.command}   —   ${s.script.slice(0, 50)}` })))
  if (c) ps.runDevServer(c)
}

export function BottomPanel({ visible }: { visible: boolean }) {
  const ps = usePS()
  const terminals = useStore((s) => s.terminals)
  const tab = useStore((s) => s.bottomTab)
  const running = useStore((s) => s.runs.find((r) => r.status === 'running'))

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        {terminals.map((t) => (
          <button key={t.id} className={`btab ${tab === t.id ? 'on' : ''} ${t.dev ? 'dev' : ''}`} onClick={() => ps.set({ bottomTab: t.id })} title={t.dev ? `Servidor de desarrollo · ${t.cwd}` : t.cwd}>
            {t.dev ? <Icon.play size={11} /> : <Icon.prompt size={12} />} {t.title}
            <span
              className="btab-close"
              onClick={(e) => {
                e.stopPropagation()
                ps.closeTerminal(t.id)
              }}
            >
              <Icon.x size={11} />
            </span>
          </button>
        ))}
        <button className="icon-btn" title="Nueva terminal (⇧⌘T)" onClick={() => ps.newTerminal()}>
          <Icon.plus size={14} />
        </button>
        <button className="icon-btn" title="Arrancar el servidor de desarrollo (scripts de package.json)" onClick={() => devMenu(ps)}>
          <Icon.play size={13} />
        </button>
        <span className="btab-sep" />
        <button className={`btab ${tab === 'log' ? 'on' : ''}`} onClick={() => ps.set({ bottomTab: 'log' })}>
          <Icon.log size={12} /> Registro {running && <AgentLogo agent={running.agent} size={10} />}
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title={ps.secondary ? 'Devolver a la ventana principal' : 'Ocultar la terminal (⌘J) · vuelve desde la barra de arriba'}
          onClick={() => (ps.secondary ? window.close() : ps.togglePanel('bottom', false))}
        >
          <Icon.x size={14} />
        </button>
      </div>
      <div className="bottom-body">
        <Suspense fallback={null}>
          {terminals.map((t) => (
            <TerminalView
              key={t.id}
              id={t.id}
              cwd={t.cwd}
              visible={visible && tab === t.id}
              dev={t.dev}
              detach={ps.secondary}
              onLink={(url, e) => (e.metaKey ? api.openExternal(url).catch(() => {}) : ps.openWeb(url))}
              onUrl={t.dev ? (url) => ps.openWeb(url) : undefined}
            />
          ))}
        </Suspense>
        {tab === 'log' && <RunLog />}
        {!terminals.length && tab !== 'log' && (
          <div className="empty">
            <button className="btn" onClick={() => ps.newTerminal()}>
              <Icon.terminal size={13} /> Nueva terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
