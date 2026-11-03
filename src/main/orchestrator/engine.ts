import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentId, Permission, Settings } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { titleFromPrompt } from '@shared/chat'
import {
  ACTIVE_STATUSES, agreementPrompt, conflictPrompt, consolidatePrompt, FileChange, finalFixPrompt, finalReviewPrompt, fixPrompt, normalizePlan,
  normalizeReview, OrchMessage, OrchStart, OrchStatus, OrchTask, OrchWorktree, Orchestration, other, parseJsonLoose, PLAN_SCHEMA, Plan, planPrompt,
  PlanTask, proposalPrompt, Review, REVIEW_SCHEMA, reviewPrompt, revisePlanPrompt, safeTestCommand, slugify, summaryPrompt, taskPrompt, testFixPrompt
} from '@shared/orchestrator'
import type { Store } from '../db/store'
import { repoRoot } from '../git'
import { ManagedProcess } from '../agents/runner'
import type { RunOutcome, SessionService } from '../agents/service'
import * as g from './gitops'

export interface EngineDeps {
  store: Store
  service: SessionService
  push: <K extends PushChannel>(channel: K, payload: PushContract[K]) => void
  settings: () => Settings
  worktreeBase: () => string
  env: () => NodeJS.ProcessEnv
}

class Cancelled extends Error {
  constructor() {
    super('Cancelado')
  }
}

const TERMINAL: OrchStatus[] = ['integrated', 'discarded', 'failed', 'cancelled']

// En las tareas del equipo, Claude puede comprobar su trabajo: solo pruebas y lectura de Git, nada más
export const TEAM_ALLOWED_TOOLS = [
  'Bash(npm test)', 'Bash(npm test *)', 'Bash(npm run test *)', 'Bash(pnpm test *)', 'Bash(yarn test *)', 'Bash(bun test *)',
  'Bash(npx vitest *)', 'Bash(npx jest *)', 'Bash(node --test *)', 'Bash(node --test)', 'Bash(pytest *)', 'Bash(python3 -m pytest *)',
  'Bash(go test *)', 'Bash(cargo test *)', 'Bash(swift test *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)'
]
const WRITE_CLAUDE: Permission[] = ['acceptEdits', 'auto', 'bypassPermissions']

// Motor de orquestación: estado explícito y persistente en SQLite; los agentes reciben tareas concretas
export class Orchestrator {
  private driving = new Set<string>()
  private cancelled = new Set<string>()
  private sessions = new Map<string, Set<string>>()
  private tests = new Map<string, ManagedProcess>()

  constructor(private d: EngineDeps) {}

  // ---------- consultas ----------

  get(id: string) {
    return this.d.store.getOrchestration(id)
  }

  list(projectId: string) {
    return this.d.store.listOrchestrations(projectId)
  }

  private emit(id: string) {
    const o = this.get(id)
    if (o) this.d.push('orch:update', o)
  }

  private msg(id: string, from: OrchMessage['from'], kind: OrchMessage['kind'], text: string, to?: OrchMessage['to']) {
    this.d.store.addOrchMessage(id, { from, to, kind, text })
    this.emit(id)
  }

  private setStatus(id: string, status: OrchStatus, extra: { error?: string | null } = {}) {
    this.d.store.updateOrchestration(id, { status, ...extra })
    this.emit(id)
  }

  private check(id: string) {
    if (this.cancelled.has(id)) throw new Cancelled()
  }

  // ---------- ciclo de vida ----------

  async start(projectId: string, req: OrchStart, threadId?: string): Promise<Orchestration> {
    const project = this.d.store.getProject(projectId)
    if (!project) throw new Error('Proyecto no encontrado')
    if (!req.request.trim()) throw new Error('Describe qué quieres que haga el equipo')
    const repo = await repoRoot(project.path)
    if (!repo) throw new Error('El modo Equipo necesita que el proyecto sea un repositorio Git')
    const baseCommit = await g.head(repo).catch(() => {
      throw new Error('El repositorio necesita al menos un commit para crear los worktrees de los agentes')
    })
    const baseBranch = await g.currentBranch(repo)
    const s = this.d.settings()
    const mode = req.mode
    const planner: AgentId | undefined = mode === 'A' ? 'claude' : mode === 'B' ? 'codex' : mode === 'C' ? s.defaultAgent : undefined
    const id = randomUUID()
    const slug = `${slugify(req.request)}-${id.slice(0, 4)}`
    const options = { ...req.options, maxRounds: Math.min(5, Math.max(1, req.options.maxRounds || 2)), parallel: Math.min(2, Math.max(1, req.options.parallel || 2)) }
    this.d.store.createOrchestration({
      id,
      projectId,
      threadId,
      mode,
      request: req.request.trim(),
      status: planner ? 'planning' : 'running',
      planner,
      options,
      repo,
      baseBranch,
      baseCommit,
      slug,
      createdAt: Date.now()
    })
    if (mode === 'D') {
      const impl = options.implementer ?? s.defaultAgent
      this.d.store.replaceTasks(id, [{ key: 'T1', title: titleFromPrompt(req.request), description: req.request, acceptance: '', assignee: impl, dependsOn: [] }])
      this.msg(id, 'system', 'info', `Revisión cruzada: ${AGENT_NAMES[impl]} implementa y ${AGENT_NAMES[other(impl)]} revisa (hasta ${options.maxRounds} rondas).`)
    } else if (mode === 'E') {
      const t = { title: titleFromPrompt(req.request), description: req.request, acceptance: '', dependsOn: [] }
      this.d.store.replaceTasks(id, [
        { ...t, key: 'Claude', assignee: 'claude' },
        { ...t, key: 'Codex', assignee: 'codex' }
      ])
      this.msg(id, 'system', 'info', 'Comparación: Claude y Codex implementan lo mismo por separado, cada uno en su worktree.')
    } else {
      const roles = mode === 'C' ? `${AGENT_NAMES[planner!]} planifica y el trabajo se reparte entre los dos` : `${AGENT_NAMES[planner!]} planifica y revisa; ${AGENT_NAMES[other(planner!)]} implementa`
      this.msg(id, 'system', 'info', `${roles}. Cada agente trabaja en su propio worktree desde ${baseBranch ?? 'HEAD'} (${baseCommit.slice(0, 7)}).`)
    }
    if (await g.isDirty(repo).catch(() => false))
      this.msg(id, 'system', 'warning', `Tienes cambios sin commit: los agentes parten del último commit (${baseCommit.slice(0, 7)}) y no los verán.`)
    this.d.store.audit(projectId, 'user', 'orch.start', { id, mode, request: req.request.slice(0, 500) })
    this.drive(id)
    return this.get(id)!
  }

  approvePlan(id: string, tasks?: PlanTask[]) {
    const o = this.get(id)
    if (!o || o.status !== 'awaiting_plan') throw new Error('El plan no está pendiente de aprobación')
    if (tasks?.length) {
      const plan = { ...o.plan!, tasks }
      this.d.store.updateOrchestration(id, { plan })
      this.d.store.replaceTasks(
        id,
        tasks.map((t) => ({ key: t.id, title: t.title, description: t.description, acceptance: t.acceptance, assignee: t.assignee, dependsOn: t.dependsOn }))
      )
    }
    this.msg(id, 'user', 'plan', 'Plan aprobado. Empieza el trabajo.')
    this.setStatus(id, 'running')
    this.drive(id)
  }

  async cancel(id: string) {
    const o = this.get(id)
    if (!o || TERMINAL.includes(o.status)) return
    this.cancelled.add(id)
    this.tests.get(id)?.cancel(500)
    await Promise.all([...(this.sessions.get(id) ?? [])].map((sid) => this.d.service.cancel(sid)))
    this.d.store.updateOrchestration(id, { status: 'cancelled', resumeStatus: ACTIVE_STATUSES.includes(o.status) ? o.status : null })
    for (const t of o.tasks) if (['running', 'reviewing', 'fixing'].includes(t.status)) this.d.store.updateTask(t.id, { status: 'pending' })
    this.msg(id, 'user', 'warning', 'Cancelado. Los worktrees se conservan; puedes reanudar o limpiarlos.')
    this.d.store.audit(o.projectId, 'user', 'orch.cancel', { id })
  }

  resume(id: string) {
    const o = this.get(id)
    if (!o) throw new Error('Orquestación no encontrada')
    if (!['interrupted', 'needs_user', 'cancelled', 'failed'].includes(o.status)) throw new Error('No hay nada que reanudar')
    this.cancelled.delete(id)
    for (const t of o.tasks) if (['running', 'reviewing', 'fixing', 'failed'].includes(t.status)) this.d.store.updateTask(t.id, { status: 'pending', error: null })
    const prev = this.d.store.resumeStatusOf(id)
    const next: OrchStatus = prev && ACTIVE_STATUSES.includes(prev) ? prev : !o.plan && o.planner ? 'planning' : o.tasks.every((t) => t.status === 'done') ? 'integrating' : 'running'
    this.d.store.updateOrchestration(id, { status: next, resumeStatus: null, error: null })
    this.msg(id, 'user', 'info', 'Reanudado.')
    this.drive(id)
  }

  // Al arrancar la app: lo que estaba en marcha queda interrumpido (no se finge que sigue)
  recover(): number {
    const list = this.d.store.orchestrationsWithStatus(ACTIVE_STATUSES)
    for (const { id, status } of list) {
      this.d.store.updateOrchestration(id, { status: 'interrupted', resumeStatus: status })
      for (const t of this.d.store.orchTasks(id)) if (['running', 'reviewing', 'fixing'].includes(t.status)) this.d.store.updateTask(t.id, { status: 'pending' })
      this.d.store.addOrchMessage(id, { from: 'system', kind: 'warning', text: 'La aplicación se cerró mientras el equipo trabajaba. Pulsa Reanudar para continuar.' })
    }
    return list.length
  }

  private async drive(id: string) {
    if (this.driving.has(id)) return
    this.driving.add(id)
    try {
      for (;;) {
        this.check(id)
        const o = this.get(id)
        if (!o) return
        if (o.status === 'planning') await (o.mode === 'C' ? this.planJoint(o) : this.plan(o))
        else if (o.status === 'running') await this.execute(id)
        else if (o.status === 'integrating') await this.integrateBranches(id)
        else if (o.status === 'testing') await this.test(id)
        else return
      }
    } catch (e) {
      if (e instanceof Cancelled) return
      const message = (e as Error).message || String(e)
      this.d.store.updateOrchestration(id, { status: 'failed', error: message })
      this.msg(id, 'system', 'error', message)
    } finally {
      this.driving.delete(id)
    }
  }

  // ---------- agentes ----------

  private agentCwd(o: Orchestration, root: string): string {
    const project = this.d.store.getProject(o.projectId)
    const rel = project ? relative(o.repo, project.path) : ''
    return rel && !rel.startsWith('..') ? join(root, rel) : root
  }

  private async runAgent(o: Orchestration, r: { agent: AgentId; cwd: string; title: string; prompt: string; write: boolean; schema?: object }): Promise<RunOutcome> {
    const s = this.d.settings()
    const permission: Permission = r.write
      ? r.agent === 'claude'
        ? WRITE_CLAUDE.includes(s.claudeMode) ? s.claudeMode : 'acceptEdits'
        : s.codexSandbox === 'danger-full-access' ? s.codexSandbox : 'workspace-write'
      : r.agent === 'claude' ? 'plan' : 'read-only'
    const session = this.d.store.createSession(o.projectId, r.cwd, {
      agent: r.agent,
      title: r.title,
      orchestrationId: o.id,
      model: r.agent === 'claude' ? s.claudeModel : s.codexModel,
      effort: r.agent === 'claude' ? s.claudeEffort : s.codexEffort,
      permission
    })
    this.d.push('session:meta', session)
    const set = this.sessions.get(o.id) ?? new Set<string>()
    this.sessions.set(o.id, set)
    set.add(session.id)
    try {
      const { done } = this.d.service.send(session.id, r.prompt, undefined, { schema: r.schema, allowedTools: r.write && r.agent === 'claude' ? TEAM_ALLOWED_TOOLS : undefined })
      const out = await done
      this.check(o.id)
      return out
    } finally {
      set.delete(session.id)
    }
  }

  private async ensureWorktree(o: Orchestration, owner: OrchWorktree['owner']): Promise<OrchWorktree> {
    const existing = this.d.store.orchWorktrees(o.id).find((w) => w.owner === owner && w.status === 'active')
    if (existing && existsSync(existing.path)) return existing
    const path = join(this.d.worktreeBase(), basename(o.repo), `${o.slug}-${owner}`)
    const branch = `ambidex/${o.slug}/${owner}`
    mkdirSync(dirname(path), { recursive: true })
    await g.addWorktree(o.repo, path, branch, o.baseCommit)
    await g.linkNodeModules(o.repo, path)
    if (!existing) this.d.store.addWorktree({ projectId: o.projectId, orchestrationId: o.id, owner, path, branch, baseCommit: o.baseCommit })
    const who = owner === 'integration' ? 'integración' : AGENT_NAMES[owner]
    this.msg(o.id, 'system', 'info', `Worktree de ${who} listo · rama ${branch}`)
    return { owner, path, branch, status: 'active' }
  }

  private worktreeOf(o: Orchestration, owner: OrchWorktree['owner']) {
    return o.worktrees.find((w) => w.owner === owner && w.status === 'active')
  }

  // ---------- fases ----------

  private async plan(o: Orchestration) {
    const planner = o.planner!
    this.msg(o.id, planner, 'info', `${AGENT_NAMES[planner]} analiza el proyecto y prepara el plan…`)
    const r = await this.runAgent(o, {
      agent: planner,
      cwd: this.agentCwd(o, o.repo),
      title: `Plan · ${titleFromPrompt(o.request)}`,
      prompt: planPrompt(o.request, o.mode, planner),
      write: false,
      schema: PLAN_SCHEMA
    })
    if (r.status !== 'completed') throw new Error(r.error || `${AGENT_NAMES[planner]} no pudo completar el plan`)
    const { plan, notes } = normalizePlan(r.structured ?? parseJsonLoose(r.text), o.mode, planner)
    this.adoptPlan(o, planner, plan, notes)
  }

  // Modo C. 1) los dos proponen por separado y a la vez; 2) el planificador las junta en un plan con el reparto;
  // 3) el otro lo revisa y, si pide ajustes, el planificador los incorpora; 4) queda el plan acordado.
  private async planJoint(o: Orchestration) {
    const planner = o.planner!
    const partner = other(planner)
    const cwd = this.agentCwd(o, o.repo)
    this.msg(o.id, 'system', 'info', 'Fase 1 · Propuestas: cada agente propone un plan por su cuenta, sin ver el del otro.')
    const ask = (agent: AgentId) =>
      this.runAgent(o, { agent, cwd, title: `Propuesta de ${AGENT_NAMES[agent]} · ${titleFromPrompt(o.request)}`, prompt: proposalPrompt(o.request, agent), write: false, schema: PLAN_SCHEMA })
    const settled = await Promise.allSettled([ask(planner), ask(partner)])
    for (const r of settled) if (r.status === 'rejected' && r.reason instanceof Cancelled) throw r.reason
    const proposals: { agent: AgentId; plan: Plan }[] = []
    settled.forEach((r, i) => {
      const agent = i === 0 ? planner : partner
      try {
        if (r.status !== 'fulfilled' || r.value.status !== 'completed') throw new Error(r.status === 'fulfilled' ? r.value.error || 'no terminó' : String(r.reason))
        const { plan } = normalizePlan(r.value.structured ?? parseJsonLoose(r.value.text), 'C', agent)
        proposals.push({ agent, plan })
        this.msg(o.id, agent, 'plan', `${AGENT_NAMES[agent]} propone: ${plan.summary}\n${plan.tasks.length} tareas`, 'system')
      } catch (e) {
        this.msg(o.id, 'system', 'warning', `${AGENT_NAMES[agent]} no pudo hacer su propuesta (${(e as Error).message.split('\n')[0].slice(0, 120)}).`)
      }
    })
    if (!proposals.length) throw new Error('Ninguno de los dos agentes pudo proponer un plan')

    let plan: Plan
    let notes: string[] = []
    if (proposals.length === 1) {
      plan = proposals[0].plan
      this.msg(o.id, 'system', 'warning', `Solo hay una propuesta (${AGENT_NAMES[proposals[0].agent]}): se usa tal cual.`)
    } else {
      this.msg(o.id, 'system', 'info', `Fase 2 · Acuerdo: ${AGENT_NAMES[planner]} junta las dos propuestas en un plan y reparte el trabajo.`)
      const best = proposals.find((p) => p.agent === planner) ?? proposals[0]
      try {
        const r = await this.runAgent(o, { agent: planner, cwd, title: `Plan acordado · ${titleFromPrompt(o.request)}`, prompt: consolidatePrompt(o.request, proposals), write: false, schema: PLAN_SCHEMA })
        if (r.status !== 'completed') throw new Error(r.error || 'no terminó')
        ;({ plan, notes } = normalizePlan(r.structured ?? parseJsonLoose(r.text), 'C', planner))
      } catch (e) {
        if (e instanceof Cancelled) throw e
        plan = best.plan
        this.msg(o.id, 'system', 'warning', `No se pudieron juntar las propuestas (${(e as Error).message.split('\n')[0].slice(0, 120)}): se usa la de ${AGENT_NAMES[best.agent]}.`)
      }
      this.msg(o.id, planner, 'plan', `Plan acordado: ${plan.summary}`)
      // el otro agente da su conformidad (o pide ajustes, que se incorporan una vez)
      try {
        const rv = await this.runAgent(o, { agent: partner, cwd, title: `Conformidad con el plan · ${AGENT_NAMES[partner]}`, prompt: agreementPrompt(o.request, plan, planner), write: false, schema: REVIEW_SCHEMA })
        const verdict = rv.status === 'completed' ? normalizeReview(rv.structured ?? parseJsonLoose(rv.text)) : undefined
        if (verdict?.verdict === 'approve') this.msg(o.id, partner, 'review', `${AGENT_NAMES[partner]} está de acuerdo con el plan. ${verdict.summary}`, planner)
        else if (verdict) {
          this.msg(o.id, partner, 'review', `${AGENT_NAMES[partner]} pide ajustes al plan:\n${verdict.issues.map((i) => `· [${i.severity}] ${i.description}`).join('\n')}`, planner)
          const rp = await this.runAgent(o, { agent: planner, cwd, title: `Plan · ajustes de ${AGENT_NAMES[partner]}`, prompt: revisePlanPrompt(o.request, plan, verdict, partner), write: false, schema: PLAN_SCHEMA })
          if (rp.status === 'completed') {
            const revised = normalizePlan(rp.structured ?? parseJsonLoose(rp.text), 'C', planner)
            plan = revised.plan
            notes = [...notes, ...revised.notes]
            this.msg(o.id, planner, 'plan', `Plan ajustado: ${plan.summary}`, partner)
          }
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e
        this.msg(o.id, 'system', 'warning', `No se pudo confirmar el plan con ${AGENT_NAMES[partner]}; sigue adelante tal cual.`)
      }
    }
    this.adoptPlan(o, planner, plan, notes, 'Fase 3 · Reparto')
  }

  // Guarda el plan, crea sus tareas y pasa a ejecutar (o a esperar tu aprobación)
  private adoptPlan(o: Orchestration, planner: AgentId, plan: Plan, notes: string[], label?: string) {
    this.d.store.updateOrchestration(o.id, { plan })
    this.d.store.replaceTasks(
      o.id,
      plan.tasks.map((t) => ({ key: t.id, title: t.title, description: t.description, acceptance: t.acceptance, assignee: t.assignee, dependsOn: t.dependsOn }))
    )
    const n = (a: AgentId) => plan.tasks.filter((t) => t.assignee === a).length
    this.msg(o.id, planner, 'plan', `${label ? `${label}: ` : ''}${plan.summary}\n${plan.tasks.length} tareas · Claude ${n('claude')} · Codex ${n('codex')}`)
    for (const note of notes) this.msg(o.id, 'system', 'warning', note)
    this.setStatus(o.id, o.options.approvePlan ? 'awaiting_plan' : 'running')
  }

  private reviewer(o: Orchestration, t: OrchTask): AgentId {
    return o.mode === 'A' || o.mode === 'B' ? o.planner! : other(t.assignee)
  }

  private async execute(id: string) {
    const running = new Map<string, Promise<void>>()
    const busy = new Set<AgentId>()
    for (;;) {
      this.check(id)
      const o = this.get(id)!
      const byKey = new Map(o.tasks.map((t) => [t.key, t]))
      const failed = o.tasks.find((t) => t.status === 'failed')
      if (failed && !running.size) {
        this.setStatus(id, 'needs_user', { error: `La tarea ${failed.key} ha fallado: ${failed.error ?? 'error desconocido'}` })
        return
      }
      if (!failed)
        for (const t of o.tasks) {
          if (running.size >= o.options.parallel) break
          if (t.status !== 'pending' || running.has(t.id) || busy.has(t.assignee)) continue
          if (!t.dependsOn.every((k) => byKey.get(k)?.status === 'done')) continue
          busy.add(t.assignee)
          const p = this.runTask(id, t.id)
            .catch((e) => {
              if (e instanceof Cancelled) return
              this.d.store.updateTask(t.id, { status: 'failed', error: (e as Error).message, endedAt: Date.now() })
              this.msg(id, 'system', 'error', `${t.key}: ${(e as Error).message}`)
            })
            .finally(() => {
              busy.delete(t.assignee)
              running.delete(t.id)
            })
          running.set(t.id, p)
        }
      if (!running.size) {
        if (o.tasks.some((t) => t.status === 'pending')) {
          this.setStatus(id, 'needs_user', { error: 'Hay tareas bloqueadas por dependencias sin completar' })
          return
        }
        break
      }
      await Promise.race(running.values())
    }
    const o = this.get(id)!
    if (o.mode === 'E') {
      this.msg(id, 'system', 'integration', 'Las dos implementaciones están listas. Compáralas y elige la que quieras integrar.')
      this.setStatus(id, 'awaiting_approval')
    } else this.setStatus(id, 'integrating')
  }

  private async runTask(id: string, taskId: string) {
    let o = this.get(id)!
    const t = o.tasks.find((x) => x.id === taskId)!
    const agent = t.assignee
    this.d.store.updateTask(t.id, { status: 'running', startedAt: Date.now(), error: null, endedAt: null })
    this.emit(id)
    const wt = await this.ensureWorktree(o, agent)
    o = this.get(id)!

    // intercambio de resultados: se incorpora el trabajo del otro agente del que depende esta tarea
    const handoffs: string[] = []
    const conflicts: string[] = []
    for (const k of t.dependsOn) {
      const dep = o.tasks.find((x) => x.key === k)
      if (!dep) continue
      handoffs.push(`- ${dep.key} (${AGENT_NAMES[dep.assignee]}): ${dep.title}. ${(dep.result?.summary ?? '').slice(0, 700)}${dep.result?.files.length ? ` Ficheros: ${dep.result.files.join(', ')}` : ''}`)
      if (dep.assignee === agent || !dep.result?.commit) continue
      const src = this.worktreeOf(o, dep.assignee)
      if (!src) continue
      const r = await g.mergeBranch(wt.path, src.branch)
      if (r.ok) this.msg(id, dep.assignee, 'handoff', `Entrega ${dep.key} a ${AGENT_NAMES[agent]}: su trabajo se incorpora a la rama de ${AGENT_NAMES[agent]}`, agent)
      else {
        conflicts.push(...r.conflicts)
        this.msg(id, 'system', 'warning', `Conflictos al incorporar ${dep.key} en la rama de ${AGENT_NAMES[agent]} (${r.conflicts.join(', ')}); los resolverá ${AGENT_NAMES[agent]}.`)
      }
    }
    const base = await g.head(wt.path)
    const cwd = this.agentCwd(o, wt.path)
    this.msg(id, agent, 'info', `${AGENT_NAMES[agent]} empieza ${t.key}: ${t.title}`)
    const r = await this.runAgent(o, { agent, cwd, title: `${t.key} · ${t.title}`, prompt: taskPrompt({ request: o.request, plan: o.plan, task: t, branch: wt.branch, handoffs, conflicts }), write: true })
    this.d.store.updateTask(t.id, { sessionId: r.sessionId })
    if (r.status !== 'completed') throw new Error(r.error || `${AGENT_NAMES[agent]} no completó la tarea`)
    const left = await g.unresolved(wt.path)
    if (left.length) throw new Error(`Quedan conflictos sin resolver: ${left.join(', ')}`)
    if (await g.mergeInProgress(wt.path)) await g.finishMerge(wt.path)
    let commit = await g.commitAll(wt.path, `ambidex(${agent}): ${t.key} ${t.title}`)
    let files = await g.changedFiles(wt.path, base)
    let summary = r.text.slice(0, 4000)
    this.d.store.updateTask(t.id, { result: { summary, files, commit: commit ?? base, base } })
    o = this.get(id)!
    const rev = this.reviewer(o, t)
    this.msg(id, agent, 'result', `${t.key} lista: ${files.length} fichero${files.length === 1 ? '' : 's'} cambiado${files.length === 1 ? '' : 's'}. ${summary.split('\n')[0].slice(0, 220)}`, o.mode === 'E' ? undefined : rev)

    if (o.mode !== 'E') {
      const max = o.options.maxRounds
      for (let round = 1; round <= max; round++) {
        this.d.store.updateTask(t.id, { status: 'reviewing', round })
        this.emit(id)
        const fresh = this.get(id)!.tasks.find((x) => x.id === t.id)!
        const review = await this.runAgent(o, {
          agent: rev,
          cwd,
          title: `Revisión ${t.key} · ronda ${round}`,
          prompt: reviewPrompt({ task: fresh, implementer: agent, diff: await g.diff(wt.path, base), round, maxRounds: max }),
          write: false,
          schema: REVIEW_SCHEMA
        })
        this.d.store.updateTask(t.id, { reviewSessionId: review.sessionId })
        const verdict = review.status === 'completed' ? normalizeReview(review.structured ?? parseJsonLoose(review.text)) : undefined
        if (!verdict) {
          this.msg(id, 'system', 'warning', `No se pudo obtener la revisión de ${AGENT_NAMES[rev]} para ${t.key}; queda para tu revisión.`)
          break
        }
        this.d.store.updateTask(t.id, { review: verdict })
        if (verdict.verdict === 'approve') {
          this.msg(id, rev, 'review', `Aprueba ${t.key}. ${verdict.summary}`, agent)
          break
        }
        const list = verdict.issues.map((i) => `· [${i.severity}] ${i.file ? i.file + ': ' : ''}${i.description}`).join('\n')
        this.msg(id, rev, 'review', `Pide cambios en ${t.key}:\n${list}`, agent)
        if (round === max) {
          this.msg(id, 'system', 'warning', `Límite de ${max} ronda${max === 1 ? '' : 's'} en ${t.key}: lo pendiente queda para tu revisión.`)
          break
        }
        this.d.store.updateTask(t.id, { status: 'fixing' })
        this.emit(id)
        const fx = await this.runAgent(o, { agent, cwd, title: `${t.key} · correcciones (ronda ${round})`, prompt: fixPrompt({ task: fresh, reviewer: rev, review: verdict, round, maxRounds: max }), write: true })
        if (fx.status !== 'completed') throw new Error(fx.error || 'No se completaron las correcciones')
        commit = (await g.commitAll(wt.path, `ambidex(${agent}): ${t.key} correcciones ronda ${round}`)) ?? commit
        files = await g.changedFiles(wt.path, base)
        summary = fx.text.slice(0, 4000) || summary
        this.d.store.updateTask(t.id, { result: { summary, files, commit: commit ?? base, base } })
        this.msg(id, agent, 'fix', `Corrige ${t.key}: ${summary.split('\n')[0].slice(0, 220)}`, rev)
      }
    }
    this.d.store.updateTask(t.id, { status: 'done', endedAt: Date.now() })
    this.emit(id)
  }

  private async integrateBranches(id: string) {
    let o = this.get(id)!
    const wt = await this.ensureWorktree(o, 'integration')
    o = this.get(id)!
    const cwd = this.agentCwd(o, wt.path)
    // reanudación tras resolver conflictos a mano
    if (await g.mergeInProgress(wt.path)) {
      const left = await g.unresolved(wt.path)
      if (left.length) return this.setStatus(id, 'needs_user', { error: `Quedan conflictos en ${left.join(', ')} (worktree ${wt.path}).` })
      await g.finishMerge(wt.path)
    }
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      const src = this.worktreeOf(o, agent)
      if (!src || !o.tasks.some((t) => t.assignee === agent && t.result?.commit)) continue
      const r = await g.mergeBranch(wt.path, src.branch)
      if (r.ok) {
        this.msg(id, 'system', 'integration', `Rama de ${AGENT_NAMES[agent]} integrada`)
        continue
      }
      const resolver = o.planner ?? other(agent)
      this.msg(id, 'system', 'warning', `Conflictos al integrar la rama de ${AGENT_NAMES[agent]}: ${r.conflicts.join(', ')}. Los resuelve ${AGENT_NAMES[resolver]}.`)
      const rr = await this.runAgent(o, { agent: resolver, cwd, title: 'Integración · conflictos', prompt: conflictPrompt(r.conflicts), write: true })
      const left = await g.unresolved(wt.path)
      if (rr.status !== 'completed' || left.length)
        return this.setStatus(id, 'needs_user', {
          error: `No se pudieron resolver los conflictos en ${(left.length ? left : r.conflicts).join(', ')}. Resuélvelos en ${wt.path} y pulsa Continuar.`
        })
      await g.finishMerge(wt.path)
      this.msg(id, resolver, 'integration', 'Conflictos de integración resueltos')
    }
    this.setStatus(id, 'testing')
  }

  private detectTests(cwd: string): string[] | undefined {
    const has = (f: string) => existsSync(join(cwd, f))
    try {
      if (has('package.json')) {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
        const test = pkg.scripts?.test
        if (test && !/no test specified/.test(test)) return [has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm', 'test']
      }
    } catch {
      /* package.json inválido */
    }
    if (has('pytest.ini') || has('conftest.py') || (has('pyproject.toml') && /pytest/.test(readFileSync(join(cwd, 'pyproject.toml'), 'utf8')))) return ['python3', '-m', 'pytest']
    if (has('go.mod')) return ['go', 'test', './...']
    if (has('Cargo.toml')) return ['cargo', 'test']
    if (has('Package.swift')) return ['swift', 'test']
    return undefined
  }

  private async runTests(id: string, argv: string[], cwd: string): Promise<{ ok: boolean; output: string; ms: number; code: number | null }> {
    const started = Date.now()
    let output = ''
    const proc = new ManagedProcess(
      { bin: argv[0], args: argv.slice(1), cwd, env: { ...this.d.env(), CI: '1', FORCE_COLOR: '0' } },
      {
        onStdout: (l) => (output = (output + l + '\n').slice(-20000)),
        onStderr: (l) => (output = (output + l + '\n').slice(-20000))
      }
    )
    this.tests.set(id, proc)
    const timer = setTimeout(() => proc.cancel(1000), 10 * 60 * 1000)
    const exit = await proc.done
    clearTimeout(timer)
    this.tests.delete(id)
    this.check(id)
    if (exit.spawnError) output += `\n${exit.spawnError}`
    return { ok: exit.code === 0 && !exit.spawnError, output: output.trim(), ms: Date.now() - started, code: exit.code }
  }

  private async test(id: string) {
    let o = this.get(id)!
    const wt = await this.ensureWorktree(o, 'integration')
    o = this.get(id)!
    const cwd = this.agentCwd(o, wt.path)
    const argv = safeTestCommand(o.options.testCommand) ?? safeTestCommand(o.plan?.testCommand) ?? this.detectTests(cwd)
    if (!argv) {
      this.d.store.updateOrchestration(id, { testResult: { ok: true, skipped: true, output: 'No se ha encontrado un comando de pruebas.', round: 0 } })
      this.msg(id, 'system', 'test', 'No hay pruebas que ejecutar en este proyecto.')
    } else {
      const command = argv.join(' ')
      for (let round = 0; ; round++) {
        this.msg(id, 'system', 'test', `Ejecutando ${command}…`)
        const tr = await this.runTests(id, argv, cwd)
        this.d.store.updateOrchestration(id, { testResult: { command, ok: tr.ok, output: tr.output, durationMs: tr.ms, round } })
        if (tr.ok) {
          this.msg(id, 'system', 'test', `Pruebas superadas (${Math.round(tr.ms / 1000)} s)`)
          break
        }
        this.msg(id, 'system', 'test', `Fallan las pruebas (código ${tr.code ?? '—'})`)
        if (round >= o.options.maxRounds) {
          this.msg(id, 'system', 'warning', 'Las pruebas siguen fallando tras las rondas de corrección: revísalo antes de integrar.')
          break
        }
        const fixer = o.planner ?? o.tasks[0]?.assignee ?? 'claude'
        const fx = await this.runAgent(o, { agent: fixer, cwd, title: `Pruebas · corrección ${round + 1}`, prompt: testFixPrompt({ command, output: tr.output, round: round + 1, maxRounds: o.options.maxRounds }), write: true })
        if (fx.status !== 'completed') break
        await g.commitAll(wt.path, `ambidex(${fixer}): corrige pruebas`)
        this.msg(id, fixer, 'fix', `Corrige las pruebas: ${fx.text.split('\n')[0].slice(0, 200)}`)
      }
    }
    if (o.mode === 'C') await this.wrapUp(id, wt.path, cwd, argv)
    this.msg(id, 'system', 'integration', 'Todo listo para tu revisión: mira los cambios y decide si integrarlos.')
    this.setStatus(id, 'awaiting_approval')
  }

  // Modo C, al final: los dos revisan el resultado completo; si piden ajustes, se aplican y se vuelven a pasar las
  // pruebas; y el planificador escribe el resumen en nombre de los dos.
  private async wrapUp(id: string, wtPath: string, cwd: string, argv?: string[]) {
    let o = this.get(id)!
    const planner = o.planner ?? 'claude'
    const settle = <T,>(rs: PromiseSettledResult<T>[]) => {
      for (const r of rs) if (r.status === 'rejected' && r.reason instanceof Cancelled) throw r.reason
    }
    const testNote = (): string => {
      const t = this.get(id)!.testResult
      return !t || t.skipped ? 'Pruebas: no hay comando de pruebas en este proyecto.' : `Pruebas (${t.command}): ${t.ok ? 'superadas' : 'FALLAN'}.`
    }
    const diff = await g.diff(wtPath, o.baseCommit, 'HEAD', 60000)
    this.msg(id, 'system', 'info', 'Fase final · Revisión conjunta: cada agente comprueba el resultado completo, incluido lo que hizo el otro.')
    const ask = (agent: AgentId, d: string) =>
      this.runAgent(o, { agent, cwd, title: `Revisión final · ${AGENT_NAMES[agent]}`, prompt: finalReviewPrompt({ request: o.request, plan: o.plan, diff: d, reviewer: agent, testNote: testNote() }), write: false, schema: REVIEW_SCHEMA })
    const reviewers: AgentId[] = ['claude', 'codex']
    const settled = await Promise.allSettled(reviewers.map((a) => ask(a, diff)))
    settle(settled)
    const reviews: { by: AgentId; review: Review }[] = []
    settled.forEach((r, i) => {
      const by = reviewers[i]
      const review = r.status === 'fulfilled' && r.value.status === 'completed' ? normalizeReview(r.value.structured ?? parseJsonLoose(r.value.text)) : undefined
      if (!review) return this.msg(id, 'system', 'warning', `No se pudo obtener la revisión final de ${AGENT_NAMES[by]}.`)
      reviews.push({ by, review })
      const issues = review.issues.map((x) => `· [${x.severity}] ${x.file ? x.file + ': ' : ''}${x.description}`).join('\n')
      this.msg(id, by, 'review', review.verdict === 'approve' ? `${AGENT_NAMES[by]} da el resultado por bueno. ${review.summary}` : `${AGENT_NAMES[by]} pide ajustes finales:\n${issues}`, 'user')
    })

    // ajustes: los aplica el planificador en la rama de integración y se vuelven a pasar las pruebas
    const open = reviews.filter((r) => r.review.verdict === 'changes')
    let fixed = false
    if (open.length) {
      this.msg(id, 'system', 'info', `${AGENT_NAMES[planner]} aplica los ajustes de la revisión final.`)
      o = this.get(id)!
      const fx = await this.runAgent(o, { agent: planner, cwd, title: 'Ajustes de la revisión final', prompt: finalFixPrompt(open), write: true })
      if (fx.status === 'completed') {
        const commit = await g.commitAll(wtPath, `ambidex(${planner}): ajustes de la revisión final`)
        if (commit) {
          fixed = true
          this.msg(id, planner, 'fix', `Ajustes aplicados: ${fx.text.split('\n')[0].slice(0, 200)}`)
          if (argv) {
            const tr = await this.runTests(id, argv, cwd)
            this.d.store.updateOrchestration(id, { testResult: { command: argv.join(' '), ok: tr.ok, output: tr.output, durationMs: tr.ms, round: 99 } })
            this.msg(id, 'system', 'test', tr.ok ? 'Pruebas superadas tras los ajustes' : `Fallan las pruebas tras los ajustes (código ${tr.code ?? '—'}): revísalo antes de integrar.`)
          }
        }
      } else this.msg(id, 'system', 'warning', 'No se pudieron aplicar los ajustes finales: quedan para tu revisión.')
    }

    // resumen en nombre de los dos
    o = this.get(id)!
    try {
      const sm = await this.runAgent(o, {
        agent: planner,
        cwd,
        title: 'Resumen del equipo',
        prompt: summaryPrompt({ request: o.request, plan: o.plan, tasks: o.tasks, reviews, tests: testNote(), fixed }),
        write: false
      })
      if (sm.status === 'completed' && sm.text.trim()) this.msg(id, planner, 'summary', sm.text.trim(), 'user')
    } catch (e) {
      if (e instanceof Cancelled) throw e
      this.msg(id, 'system', 'warning', 'No se pudo redactar el resumen final.')
    }
  }

  // ---------- revisión humana ----------

  async changes(id: string, candidate?: AgentId): Promise<{ files: FileChange[]; branch: string; base: string; cwd: string }> {
    const o = this.get(id)
    if (!o) throw new Error('Orquestación no encontrada')
    const owner = o.mode === 'E' ? (candidate ?? 'claude') : 'integration'
    const wt = this.worktreeOf(o, owner) ?? this.worktreeOf(o, candidate ?? 'claude')
    if (!wt) return { files: [], branch: '', base: o.baseCommit, cwd: o.repo }
    const stats = await g.numstat(o.repo, o.baseCommit, wt.branch)
    const files: FileChange[] = stats.map((s) => ({
      ...s,
      agents: (['claude', 'codex'] as AgentId[]).filter((a) => o.tasks.some((t) => t.assignee === a && t.result?.files.some((f) => s.path === f || s.path.endsWith('/' + f))))
    }))
    return { files, branch: wt.branch, base: o.baseCommit, cwd: o.repo }
  }

  async integrate(id: string, opts: { candidate?: AgentId; strategy: 'squash' | 'merge' }) {
    const o = this.get(id)
    if (!o) throw new Error('Orquestación no encontrada')
    if (o.status !== 'awaiting_approval') throw new Error('Todavía no hay nada listo para integrar')
    if (o.mode === 'E' && !opts.candidate) throw new Error('Elige qué implementación integrar')
    const wt = this.worktreeOf(o, o.mode === 'E' ? opts.candidate! : 'integration')
    if (!wt) throw new Error('No se encuentra la rama a integrar')
    if (await g.isDirty(o.repo)) throw new Error('Tienes cambios sin commit en el repositorio. Haz commit o stash antes de integrar.')
    const into = (await g.currentBranch(o.repo)) ?? 'HEAD'
    const r = await g.mergeInto(o.repo, wt.branch, opts.strategy, `Ambidex: ${titleFromPrompt(o.request)}`)
    this.d.store.audit(o.projectId, 'user', 'orch.integrate', { id, branch: wt.branch, into, strategy: opts.strategy, ok: r.ok })
    if (!r.ok) {
      this.d.store.updateOrchestration(id, { status: 'needs_user', error: `Conflictos al integrar en ${into}: ${r.conflicts.join(', ')}. Resuélvelos en Git.` })
      this.msg(id, 'system', 'warning', `Conflictos al integrar en ${into}: ${r.conflicts.join(', ')}. Resuélvelos desde el panel de Git y haz commit.`)
      return
    }
    this.d.store.updateOrchestration(id, { status: 'integrated', integratedInto: into, error: null })
    this.msg(
      id,
      'user',
      'integration',
      opts.strategy === 'squash'
        ? `Cambios aplicados en ${into} y preparados (stage). Revísalos en Git, escribe el mensaje de commit y haz push cuando quieras.`
        : `Merge hecho en ${into}.`
    )
  }

  discard(id: string) {
    const o = this.get(id)
    if (!o || TERMINAL.includes(o.status)) return
    this.d.store.updateOrchestration(id, { status: 'discarded' })
    this.msg(id, 'user', 'warning', 'Descartado. Los worktrees se conservan hasta que los limpies.')
  }

  async cleanup(id: string) {
    const o = this.get(id)
    if (!o) return
    if (!TERMINAL.includes(o.status)) throw new Error('Solo se pueden limpiar orquestaciones terminadas, descartadas o canceladas')
    for (const w of o.worktrees.filter((x) => x.status === 'active')) {
      await g.removeWorktree(o.repo, w.path)
      await g.deleteBranch(o.repo, w.branch)
      this.d.store.setWorktreeStatus(id, w.path, 'removed')
    }
    this.d.store.audit(o.projectId, 'user', 'orch.cleanup', { id })
    this.msg(id, 'user', 'info', 'Worktrees y ramas de los agentes eliminados.')
  }
}
