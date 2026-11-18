import { useEffect, useState } from 'react'
import type { Orchestration } from '@shared/orchestrator'
import { AGENT_NAMES, type RunInfo } from '@shared/types'
import { mergeTeamRuns, proposalProgress, teamSteps, type TeamStep } from '@shared/team-progress'
import { usePS, useStore } from '../../lib/project-store'
import { durationText, toolName } from '../../lib/utils'
import { AgentLogo, Icon } from '../Icons'
import { api } from '../../lib/api'

const STATUS = {
  pending: ['Iniciando', 'muted'], running: ['En curso', 'running'], completed: ['Terminado', 'ok'],
  failed: ['Falló', 'error'], cancelled: ['Cancelado', 'muted'], interrupted: ['Interrumpido', 'warn']
} as const

function Step({ step, now }: { step: TeamStep; now: number }) {
  const ps = usePS(), { session, run, status, lastTool } = step
  useEffect(() => { void ps.loadMessages(session.id) }, [ps, session.id])
  const busy = status === 'running', st = STATUS[status]
  return <div className={`team-step ${st[1]}`} data-team-session={session.id}>
    <div className="team-step-head">
      <AgentLogo agent={session.agent} size={14} /><b>{AGENT_NAMES[session.agent]}</b>
      <span className="team-step-phase">{step.phase}</span>
      <span className={`status-chip ${st[1]}`}>{busy && <span className={`pulse small agent-${session.agent}`} />}{st[0]}</span>
      {run && <span className="muted small tabular">{durationText(step.elapsedMs)}</span>}
    </div>
    <div className="muted small">{session.model || 'Modelo predeterminado del CLI'}{session.effort ? ` · razonamiento ${session.effort}` : ''}{step.tools > 0 ? ` · ${step.tools} acciones` : ''}</div>
    {lastTool && <div className="team-step-tool small"><span>{lastTool.status === 'running' && busy ? 'En curso' : 'Última acción'}: {toolName(lastTool.name)}</span>{lastTool.input && <span className="mono muted">{lastTool.input.slice(0, 240)}</span>}</div>}
    {busy && !lastTool && <div className="small muted">{run?.lastActivityAt ? 'Recibiendo actividad del agente…' : 'Esperando la primera salida del CLI…'}</div>}
    {busy && step.lastSignalAt !== undefined && <div className={`small ${step.quiet ? 'team-step-quiet' : 'muted'}`} role={step.quiet ? 'status' : undefined}>
      {step.quiet ? 'Sin salida nueva desde hace ' : 'Última salida hace '}{durationText(Math.max(0, now - step.lastSignalAt))}{step.quiet && '. El proceso sigue abierto; no se puede confirmar si avanza.'}
    </div>}
    {step.lastMessage && !step.lastMessage.trimStart().startsWith('{') && <div className="team-step-message small">{step.lastMessage}</div>}
    {run?.error && <div className="small del">{run.error}</div>}
    <div className="team-step-actions">
      <button className="btn ghost small" onClick={() => ps.focusSession(session.id)}><Icon.chat size={11} /> Ver conversación</button>
      {run && <button className="btn ghost small" onClick={() => ps.set(s => ({ bottomTab: 'log', logRun: run.id, panels: { ...s.panels, bottom: true } }))}><Icon.terminal size={11} /> Ver salida</button>}
    </div>
  </div>
}

export function TeamActivity({ o }: { o: Orchestration }) {
  const sessions = useStore(s => s.sessions), runs = useStore(s => s.runs)
  const [now, setNow] = useState(Date.now()), [history, setHistory] = useState(false)
  const [savedRuns, setSavedRuns] = useState<RunInfo[]>([])
  useEffect(() => {
    let current = true
    api.orch.runs(o.id).then(list => { if (current) setSavedRuns(list) }).catch(() => {})
    return () => { current = false }
  }, [o.id, o.updatedAt])
  const active = ['planning', 'running', 'integrating', 'testing'].includes(o.status)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const steps = teamSteps(o.id, Object.values(sessions), mergeTeamRuns(savedRuns, runs), now)
  const busy = steps.filter(s => s.status === 'running')
  const latest = steps.slice(-4), shown = history ? steps : [...new Set([...busy, ...latest])].sort((a, b) => a.session.createdAt - b.session.createdAt)
  if (!steps.length) return active ? <div className="small muted" role="status">Preparando los pasos del equipo…</div> : null
  const progress = o.status === 'planning' ? proposalProgress(steps) : undefined
  return <section className="team-activity" aria-label="Actividad del equipo">
    <div className="team-activity-head"><b>Actividad del equipo</b>{progress && <span className="muted small" role="status">{progress}</span>}
      {shown.length < steps.length || history ? <button className="link-btn" onClick={() => setHistory(!history)}>{history ? 'Ver menos' : `Ver los ${steps.length} pasos`}</button> : null}
    </div>
    {shown.map(step => <Step key={step.session.id} step={step} now={now} />)}
  </section>
}
