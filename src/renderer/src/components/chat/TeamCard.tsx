import { useEffect, useState } from 'react'
import type { AgentId } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { FileChange, ORCH_MODES, OrchStatus, OrchTask, Orchestration, PlanTask, TaskStatus, other } from '@shared/orchestrator'
import { api } from '../../lib/api'
import { confirmAsync } from '../../lib/app-store'
import { usePS } from '../../lib/project-store'
import { durationText } from '../../lib/utils'
import { AgentLogo, Icon } from '../Icons'
import { Elapsed } from './parts'

export const ORCH_STATUS: Record<OrchStatus, { label: string; cls: string }> = {
  planning: { label: 'Planificando', cls: 'running' },
  awaiting_plan: { label: 'Plan listo · tu aprobación', cls: 'warn' },
  running: { label: 'Trabajando', cls: 'running' },
  integrating: { label: 'Integrando', cls: 'running' },
  testing: { label: 'Ejecutando pruebas', cls: 'running' },
  awaiting_approval: { label: 'Listo · tu aprobación', cls: 'warn' },
  integrated: { label: 'Integrado', cls: 'ok' },
  discarded: { label: 'Descartado', cls: 'muted' },
  failed: { label: 'Error', cls: 'error' },
  cancelled: { label: 'Cancelado', cls: 'muted' },
  interrupted: { label: 'Interrumpido', cls: 'warn' },
  needs_user: { label: 'Necesita tu ayuda', cls: 'warn' }
}

const TASK_STATUS: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: 'En espera', cls: 'muted' },
  running: { label: 'Implementando', cls: 'running' },
  reviewing: { label: 'En revisión', cls: 'running' },
  fixing: { label: 'Corrigiendo', cls: 'running' },
  done: { label: 'Hecha', cls: 'ok' },
  failed: { label: 'Falló', cls: 'error' },
  cancelled: { label: 'Cancelada', cls: 'muted' },
  skipped: { label: 'Omitida', cls: 'muted' }
}

const STEPS = ['Plan', 'Desarrollo', 'Revisión', 'Integración', 'Pruebas', 'Tu aprobación']

function currentStep(o: Orchestration): number {
  switch (o.status) {
    case 'planning':
    case 'awaiting_plan':
      return 0
    case 'running':
      return o.tasks.some((t) => t.status === 'reviewing' || t.status === 'fixing') ? 2 : 1
    case 'integrating':
      return 3
    case 'testing':
      return 4
    case 'awaiting_approval':
      return 5
    case 'integrated':
      return 6
    default:
      return -1
  }
}

function Stepper({ o }: { o: Orchestration }) {
  const cur = currentStep(o)
  const steps = o.mode === 'E' ? ['Desarrollo', 'Tu elección'] : o.mode === 'D' ? STEPS.slice(1) : STEPS
  const offset = o.mode === 'D' ? 1 : 0
  const idx = o.mode === 'E' ? (cur >= 5 ? 1 : cur >= 0 ? 0 : -1) : cur - offset
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div key={s} className={`step ${i < idx || cur === 6 ? 'done' : i === idx ? (['awaiting_plan', 'awaiting_approval'].includes(o.status) ? 'you' : 'now') : ''}`}>
          <span className="step-dot" />
          <span className="step-label">{s}</span>
        </div>
      ))}
    </div>
  )
}

function PlanEditor({ o }: { o: Orchestration }) {
  const ps = usePS()
  const [tasks, setTasks] = useState<PlanTask[]>(() => o.plan?.tasks ?? [])
  useEffect(() => setTasks(o.plan?.tasks ?? []), [o.plan])
  const changed = JSON.stringify(tasks) !== JSON.stringify(o.plan?.tasks ?? [])
  const fixed = o.mode === 'A' || o.mode === 'B'
  return (
    <div className="plan-edit">
      {o.plan?.summary && <p className="plan-summary">{o.plan.summary}</p>}
      {tasks.map((t, i) => (
        <div key={t.id} className="plan-task">
          <span className="task-key">{t.id}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ellipsis">
              <b>{t.title}</b>
            </div>
            <div className="muted small plan-desc">{t.description}</div>
            {t.dependsOn.length > 0 && <div className="muted tiny">después de {t.dependsOn.join(', ')}</div>}
          </div>
          <button
            className={`assignee agent-${t.assignee}`}
            disabled={fixed}
            title={fixed ? 'En este modo el reparto es fijo' : 'Cambiar de agente'}
            onClick={() => setTasks(tasks.map((x, j) => (j === i ? { ...x, assignee: other(x.assignee) } : x)))}
          >
            <AgentLogo agent={t.assignee} size={12} /> {AGENT_NAMES[t.assignee]}
          </button>
          {tasks.length > 1 && (
            <button
              className="icon-btn"
              title="Quitar tarea"
              onClick={() => setTasks(tasks.filter((_, j) => j !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== t.id) })))}
            >
              <Icon.x size={12} />
            </button>
          )}
        </div>
      ))}
      <div className="row gap" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={() => ps.approvePlan(o.id, changed ? tasks : undefined)}>
          <Icon.check size={13} /> Aprobar y empezar
        </button>
        <button className="btn ghost" onClick={() => ps.discardOrch(o.id)}>
          Descartar
        </button>
        {changed && <span className="muted small">Has modificado el plan</span>}
      </div>
    </div>
  )
}

function TaskRow({ t, o }: { t: OrchTask; o: Orchestration }) {
  const ps = usePS()
  const st = TASK_STATUS[t.status]
  const reviewer = o.mode === 'A' || o.mode === 'B' ? o.planner : o.mode === 'E' ? undefined : other(t.assignee)
  return (
    <div className={`task-row ${t.status}`}>
      <span className="task-key">{t.key}</span>
      <AgentLogo agent={t.assignee} size={13} />
      <div className="task-main">
        <div className="ellipsis">{t.title}</div>
        <div className="muted tiny ellipsis">
          {t.dependsOn.length > 0 && <>después de {t.dependsOn.join(', ')} · </>}
          {t.result?.files.length ? `${t.result.files.length} ficheros · ` : ''}
          {t.round > 0 && reviewer && <>revisión de {AGENT_NAMES[reviewer]} · ronda {t.round} · </>}
          {t.review && (t.review.verdict === 'approve' ? 'aprobada' : `${t.review.issues.length} cambios pedidos`)}
          {t.error && <span className="del">{t.error}</span>}
          {t.startedAt && t.endedAt ? ` · ${durationText(t.endedAt - t.startedAt)}` : ''}
        </div>
      </div>
      <span className={`status-chip ${st.cls}`}>
        {st.cls === 'running' && <span className={`pulse small agent-${t.status === 'reviewing' && reviewer ? reviewer : t.assignee}`} />} {st.label}
      </span>
      {t.sessionId && (
        <button className="icon-btn" title="Ver la conversación de la tarea" onClick={() => ps.set({ drawer: t.sessionId! })}>
          <Icon.chat size={13} />
        </button>
      )}
      {t.reviewSessionId && (
        <button className="icon-btn" title="Ver la revisión" onClick={() => ps.set({ drawer: t.reviewSessionId! })}>
          <Icon.search size={13} />
        </button>
      )}
    </div>
  )
}

function Messages({ o }: { o: Orchestration }) {
  const [all, setAll] = useState(false)
  const list = all ? o.messages : o.messages.slice(-6)
  return (
    <div className="coord">
      <div className="coord-head">
        <Icon.workflow size={12} /> Coordinación
        {o.messages.length > 6 && (
          <button className="link-btn" onClick={() => setAll(!all)}>
            {all ? 'ver menos' : `ver todo (${o.messages.length})`}
          </button>
        )}
      </div>
      {list.map((m) => (
        <div key={m.id} className={`coord-row k-${m.kind}`}>
          <span className="coord-time tabular">{new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="coord-from">
            {m.from === 'claude' || m.from === 'codex' ? <AgentLogo agent={m.from} size={11} /> : m.from === 'user' ? <Icon.check size={11} /> : <Icon.zap size={11} />}
            {m.to && (m.to === 'claude' || m.to === 'codex') && (
              <>
                <span className="muted">→</span>
                <AgentLogo agent={m.to} size={11} />
              </>
            )}
          </span>
          <span className="coord-text">{m.text}</span>
        </div>
      ))}
    </div>
  )
}

function Changes({ o, candidate }: { o: Orchestration; candidate?: AgentId }) {
  const ps = usePS()
  const [data, setData] = useState<{ files: FileChange[]; branch: string; base: string; cwd: string } | null>(null)
  useEffect(() => {
    api.orch
      .changes(o.id, candidate)
      .then(setData)
      .catch(() => setData(null))
  }, [o.id, o.updatedAt, candidate])
  if (!data) return <div className="muted small">Calculando cambios…</div>
  const add = data.files.reduce((n, f) => n + f.add, 0)
  const del = data.files.reduce((n, f) => n + f.del, 0)
  return (
    <div className="changes">
      <div className="small muted">
        {data.files.length} ficheros · <span className="add">+{add}</span> <span className="del">−{del}</span> · rama <span className="mono">{data.branch}</span>
      </div>
      {data.files.map((f) => (
        <div key={f.path} className="file-row" onClick={() => ps.openRefDiff(data.cwd, f.path, data.base, data.branch)} title="Ver el diff">
          <span className="file-name ellipsis mono small">{f.path}</span>
          {f.agents.map((a) => (
            <AgentLogo key={a} agent={a} size={11} />
          ))}
          <span className="small">
            <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function Approval({ o }: { o: Orchestration }) {
  const ps = usePS()
  const into = ps.state.git?.branch ?? 'tu rama'
  if (o.mode === 'E')
    return (
      <div className="approval">
        <div className="approval-title">Elige la implementación que quieres integrar en {into}</div>
        <div className="candidates">
          {(['claude', 'codex'] as AgentId[]).map((a) => (
            <div key={a} className={`candidate agent-${a}`}>
              <div className="row gap">
                <AgentLogo agent={a} size={15} /> <b>{AGENT_NAMES[a]}</b>
              </div>
              <Changes o={o} candidate={a} />
              <button className="btn primary small" onClick={() => ps.integrateOrch(o.id, { candidate: a, strategy: 'squash' })}>
                Elegir la de {AGENT_NAMES[a]}
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  return (
    <div className="approval">
      <div className="approval-title">Revisa los cambios propuestos antes de integrarlos en {into}</div>
      <Changes o={o} />
      <div className="row gap" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => ps.integrateOrch(o.id, { strategy: 'squash' })} title="Aplica todos los cambios en tu rama, preparados para que hagas commit">
          <Icon.check size={13} /> Integrar en {into}
        </button>
        <button className="btn" onClick={() => ps.integrateOrch(o.id, { strategy: 'merge' })} title="Merge con commit conservando el historial de los agentes">
          Merge con historial
        </button>
        <button
          className="btn ghost"
          onClick={async () => (await confirmAsync('¿Descartar el trabajo del equipo?', 'Tu rama no cambia. Los worktrees se conservan hasta que los limpies.')) && ps.discardOrch(o.id)}
        >
          Descartar
        </button>
      </div>
    </div>
  )
}

export function TeamCard({ o }: { o: Orchestration }) {
  const ps = usePS()
  const st = ORCH_STATUS[o.status]
  const active = ['planning', 'running', 'integrating', 'testing'].includes(o.status)
  const mode = ORCH_MODES.find((m) => m.id === o.mode)
  const [testOpen, setTestOpen] = useState(false)
  return (
    <div className={`team-card ${active ? 'active' : ''}`}>
      <div className="team-head">
        <span className="team-badge">
          <Icon.workflow size={13} /> Equipo
        </span>
        <span className="muted small">{mode?.title}</span>
        <span style={{ flex: 1 }} />
        <span className={`status-chip ${st.cls}`}>
          {active && <span className="pulse small" />} {st.label}
        </span>
        {active && (
          <span className="muted small">
            <Elapsed since={o.createdAt} />
          </span>
        )}
        {active && (
          <button className="btn ghost small" onClick={() => ps.cancelOrch(o.id)}>
            <Icon.stop size={11} /> Cancelar
          </button>
        )}
        {['interrupted', 'needs_user', 'cancelled', 'failed'].includes(o.status) && (
          <button className="btn small" onClick={() => ps.resumeOrch(o.id)}>
            <Icon.refresh size={11} /> {o.status === 'needs_user' ? 'Continuar' : 'Reanudar'}
          </button>
        )}
      </div>
      <Stepper o={o} />
      {o.error && ['needs_user', 'failed'].includes(o.status) && (
        <div className="msg-error">
          <Icon.alert size={14} />
          <span>{o.error}</span>
        </div>
      )}
      {o.status === 'awaiting_plan' ? (
        <PlanEditor o={o} />
      ) : (
        o.tasks.length > 0 && (
          <div className="tasks">
            {o.tasks.map((t) => (
              <TaskRow key={t.id} t={t} o={o} />
            ))}
          </div>
        )
      )}
      {o.messages.length > 0 && <Messages o={o} />}
      {o.testResult && (
        <div className={`test-result ${o.testResult.skipped ? '' : o.testResult.ok ? 'ok' : 'fail'}`}>
          <button className="test-head" onClick={() => setTestOpen(!testOpen)}>
            {o.testResult.skipped ? <Icon.info size={13} /> : o.testResult.ok ? <Icon.ok size={13} /> : <Icon.fail size={13} />}
            {o.testResult.skipped ? 'Sin pruebas' : o.testResult.ok ? 'Pruebas superadas' : 'Las pruebas fallan'}
            {o.testResult.command && <span className="mono muted small">{o.testResult.command}</span>}
            {o.testResult.durationMs ? <span className="muted small">{durationText(o.testResult.durationMs)}</span> : null}
            <Icon.chevronRight size={12} className="tool-chevron" />
          </button>
          {testOpen && <pre className="tool-output">{o.testResult.output || '(sin salida)'}</pre>}
        </div>
      )}
      {o.status === 'awaiting_approval' && <Approval o={o} />}
      {o.status === 'integrated' && (
        <div className="approval done">
          <div className="approval-title">
            <Icon.ok size={14} /> Integrado en {o.integratedInto}. Revisa los cambios en Git, haz commit y push.
          </div>
          <div className="row gap">
            <button className="btn primary small" onClick={() => ps.set((s) => ({ sidebar: 'git', panels: { ...s.panels, sidebar: true } }))}>
              <Icon.git size={12} /> Ir a Git
            </button>
            {o.worktrees.some((w) => w.status === 'active') && (
              <button className="btn ghost small" onClick={() => ps.cleanupOrch(o.id)}>
                <Icon.trash size={12} /> Limpiar worktrees
              </button>
            )}
          </div>
        </div>
      )}
      {['discarded', 'cancelled', 'failed'].includes(o.status) && o.worktrees.some((w) => w.status === 'active') && (
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => ps.cleanupOrch(o.id)}>
          <Icon.trash size={12} /> Limpiar worktrees y ramas
        </button>
      )}
    </div>
  )
}
