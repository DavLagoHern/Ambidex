import type { AgentId } from './types'
import { AGENT_NAMES } from './types'

// A: Claude lidera · B: Codex lidera · C: reparto automático · D: revisión cruzada · E: comparación
export type OrchMode = 'A' | 'B' | 'C' | 'D' | 'E'

export const ORCH_MODES: { id: OrchMode; title: string; detail: string }[] = [
  { id: 'C', title: 'Colaboración automática', detail: 'Los dos proponen por separado y acuerdan un plan; se reparten el trabajo, se revisan entre ellos, comprueban juntos el resultado final y escriben un resumen.' },
  { id: 'A', title: 'Claude lidera', detail: 'Claude planifica y revisa; Codex implementa.' },
  { id: 'B', title: 'Codex lidera', detail: 'Codex planifica y revisa; Claude implementa.' },
  { id: 'D', title: 'Revisión cruzada', detail: 'Un agente implementa todo y el otro revisa, pide correcciones y verifica.' },
  { id: 'E', title: 'Comparación', detail: 'Los dos implementan lo mismo por separado y tú eliges el resultado.' }
]

export type OrchStatus =
  | 'planning'
  | 'awaiting_plan'
  | 'running'
  | 'integrating'
  | 'testing'
  | 'awaiting_approval'
  | 'integrated'
  | 'discarded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'needs_user'

export const ACTIVE_STATUSES: OrchStatus[] = ['planning', 'running', 'integrating', 'testing']

export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'fixing' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface OrchOptions {
  maxRounds: number
  approvePlan: boolean
  parallel: number
  testCommand?: string
  // agente que implementa en el modo D (el otro revisa)
  implementer?: AgentId
}

export interface PlanTask {
  id: string
  title: string
  description: string
  assignee: AgentId
  dependsOn: string[]
  acceptance: string
}

export interface Plan {
  summary: string
  testCommand: string
  tasks: PlanTask[]
}

export interface ReviewIssue {
  severity: 'alta' | 'media' | 'baja'
  file: string
  description: string
}

export interface Review {
  verdict: 'approve' | 'changes'
  summary: string
  issues: ReviewIssue[]
}

export interface TaskResult {
  summary: string
  files: string[]
  commit?: string
  base?: string
}

export interface OrchTask {
  id: string
  orchestrationId: string
  key: string
  title: string
  description: string
  acceptance: string
  assignee: AgentId
  dependsOn: string[]
  status: TaskStatus
  round: number
  sessionId?: string
  reviewSessionId?: string
  result?: TaskResult
  review?: Review
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface OrchMessage {
  id: number
  at: number
  from: AgentId | 'system' | 'user'
  to?: AgentId | 'system' | 'user'
  kind: 'info' | 'plan' | 'handoff' | 'result' | 'review' | 'fix' | 'test' | 'integration' | 'warning' | 'error' | 'summary'
  text: string
}

export interface OrchWorktree {
  owner: AgentId | 'integration'
  path: string
  branch: string
  status: 'active' | 'removed'
}

export interface TestResult {
  command?: string
  ok: boolean
  skipped?: boolean
  output: string
  durationMs?: number
  round: number
}

export interface FileChange {
  path: string
  add: number
  del: number
  agents: AgentId[]
}

export interface Orchestration {
  id: string
  projectId: string
  threadId?: string
  mode: OrchMode
  request: string
  status: OrchStatus
  planner?: AgentId
  plan?: Plan
  options: OrchOptions
  repo: string
  baseBranch?: string
  baseCommit: string
  slug: string
  error?: string
  testResult?: TestResult
  integratedInto?: string
  createdAt: number
  updatedAt: number
  tasks: OrchTask[]
  messages: OrchMessage[]
  worktrees: OrchWorktree[]
}

export interface OrchStart {
  request: string
  mode: OrchMode
  options: OrchOptions
}

export const other = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude')

// ---------- esquemas (compatibles con el modo estricto de Codex: todo requerido, sin propiedades extra) ----------

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'testCommand', 'tasks'],
  properties: {
    summary: { type: 'string', description: 'Resumen del enfoque en 2-4 frases' },
    testCommand: { type: 'string', description: 'Comando para ejecutar las pruebas del proyecto (p. ej. "npm test") o cadena vacía' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'assignee', 'dependsOn', 'acceptance'],
        properties: {
          id: { type: 'string', description: 'Identificador corto: T1, T2…' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Qué hay que hacer, qué ficheros tocar y cómo' },
          assignee: { type: 'string', enum: ['claude', 'codex'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string', description: 'Criterios verificables de aceptación' }
        }
      }
    }
  }
} as const

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'description'],
        properties: {
          severity: { type: 'string', enum: ['alta', 'media', 'baja'] },
          file: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }
} as const

// ---------- validación de salidas ----------

export function parseJsonLoose(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const m = t.match(/\{[\s\S]*\}/)
    if (!m) return undefined
    try {
      return JSON.parse(m[0])
    } catch {
      return undefined
    }
  }
}

// Normaliza el plan: ids únicos, dependencias existentes, sin ciclos y asignaciones según el modo
export function normalizePlan(raw: unknown, mode: OrchMode, planner: AgentId): { plan: Plan; notes: string[] } {
  const notes: string[] = []
  const r = (raw ?? {}) as Partial<Plan>
  if (!Array.isArray(r.tasks) || !r.tasks.length) throw new Error('El plan no contiene tareas')
  const seen = new Set<string>()
  let tasks: PlanTask[] = r.tasks.slice(0, 12).map((t, i) => {
    let id = String(t?.id || `T${i + 1}`).trim().replace(/\s+/g, '')
    if (seen.has(id)) id = `T${i + 1}`
    seen.add(id)
    const assignee: AgentId = t?.assignee === 'codex' ? 'codex' : 'claude'
    return {
      id,
      title: String(t?.title || `Tarea ${i + 1}`).trim(),
      description: String(t?.description || '').trim(),
      assignee,
      dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.map(String) : [],
      acceptance: String(t?.acceptance || '').trim()
    }
  })
  if (r.tasks.length > 12) notes.push(`El plan tenía ${r.tasks.length} tareas; se han tomado las 12 primeras.`)
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    const valid = t.dependsOn.filter((d) => ids.has(d) && d !== t.id)
    if (valid.length !== t.dependsOn.length) notes.push(`${t.id}: se ignoran dependencias inexistentes.`)
    t.dependsOn = [...new Set(valid)]
  }
  // rompe ciclos quitando la arista que cierra el ciclo
  const state = new Map<string, 0 | 1 | 2>()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const visit = (t: PlanTask) => {
    state.set(t.id, 1)
    for (const d of [...t.dependsOn]) {
      const s = state.get(d) ?? 0
      if (s === 1) {
        t.dependsOn = t.dependsOn.filter((x) => x !== d)
        notes.push(`Dependencia circular ${t.id} → ${d} eliminada.`)
      } else if (s === 0) visit(byId.get(d)!)
    }
    state.set(t.id, 2)
  }
  for (const t of tasks) if (!state.get(t.id)) visit(t)

  if (mode === 'A' || mode === 'B') {
    const impl = other(planner)
    tasks = tasks.map((t) => ({ ...t, assignee: impl }))
  } else if (mode === 'C' && tasks.length > 1 && tasks.every((t) => t.assignee === tasks[0].assignee)) {
    // si el planificador no repartió, se alternan las tareas para aprovechar a los dos agentes
    tasks = tasks.map((t, i) => ({ ...t, assignee: i % 2 === 0 ? tasks[0].assignee : other(tasks[0].assignee) }))
    notes.push('El plan asignaba todo a un agente; se ha repartido entre los dos.')
  }
  return { plan: { summary: String(r.summary || '').trim(), testCommand: String(r.testCommand || '').trim(), tasks }, notes }
}

export function normalizeReview(raw: unknown): Review | undefined {
  const r = raw as Partial<Review> | undefined
  if (!r || (r.verdict !== 'approve' && r.verdict !== 'changes')) return undefined
  const issues = Array.isArray(r.issues)
    ? r.issues.map((i) => ({
        severity: (['alta', 'media', 'baja'].includes(String(i?.severity)) ? i.severity : 'media') as ReviewIssue['severity'],
        file: String(i?.file ?? ''),
        description: String(i?.description ?? '')
      }))
    : []
  // "changes" sin problemas concretos no justifica otra ronda
  const verdict = r.verdict === 'changes' && !issues.length ? 'approve' : r.verdict
  return { verdict, summary: String(r.summary ?? ''), issues }
}

// ---------- prompts ----------

const TEAM = 'Formas parte de un equipo de dos agentes de programación, Claude Code y Codex, coordinado por la aplicación Ambidex.'

export function planPrompt(request: string, mode: OrchMode, planner: AgentId): string {
  const rule =
    mode === 'A' || mode === 'B'
      ? `- assignee: siempre "${other(planner)}" (${AGENT_NAMES[planner]} planifica y revisa; ${AGENT_NAMES[other(planner)]} implementa).`
      : '- assignee: reparte entre "claude" y "codex" según la naturaleza de cada tarea y equilibrando la carga. Si hay tareas independientes, asígnalas a agentes distintos para que trabajen en paralelo.'
  return `${TEAM}
Eres el PLANIFICADOR. Petición del usuario:
<peticion>
${request}
</peticion>

Inspecciona el proyecto de la carpeta actual (solo lectura) y divide el trabajo en entre 1 y 6 subtareas concretas.
Reglas:
- Cada tarea la hará un agente en una sola sesión, en su propio git worktree, y debe dejar el código funcionando.
- dependsOn: solo si una tarea necesita de verdad el resultado de otra. Las tareas sin dependencias se ejecutan en paralelo.
- Evita que dos tareas paralelas modifiquen los mismos ficheros.
${rule}
- acceptance: criterios verificables.
- testCommand: el comando para ejecutar las pruebas del proyecto (p. ej. "npm test"), o "" si no hay pruebas.
No modifiques ningún fichero. Responde con el plan estructurado.`
}

// ---------- colaboración (modo C): propuesta conjunta, acuerdo, revisión final y resumen ----------

const planRules = `Reglas del plan:
- Divide el trabajo en entre 1 y 6 subtareas concretas; cada una la hará un agente en una sola sesión, en su propio git worktree, y debe dejar el código funcionando.
- dependsOn: solo si una tarea necesita de verdad el resultado de otra. Las tareas sin dependencias se ejecutan en paralelo. Evita que dos tareas paralelas modifiquen los mismos ficheros.
- assignee: reparte entre "claude" y "codex" según a quién se le da mejor cada tarea y equilibrando la carga.
- acceptance: criterios verificables.
- testCommand: el comando para ejecutar las pruebas (p. ej. "npm test"), o "" si no hay.`

export function proposalPrompt(request: string, agent: AgentId): string {
  return `${TEAM}
Eres el PROPONENTE (${AGENT_NAMES[agent]}). El otro agente prepara su propia propuesta a la vez, sin ver la tuya; después las comparáis y acordáis un plan.
Petición del usuario:
<peticion>
${request}
</peticion>

Inspecciona el proyecto de la carpeta actual (solo lectura) y propón cómo lo harías.
${planRules}
No modifiques ningún fichero. En summary explica tu enfoque y por qué.`
}

export function consolidatePrompt(request: string, proposals: { agent: AgentId; plan: Plan }[]): string {
  const body = proposals.map((p) => `Propuesta de ${AGENT_NAMES[p.agent]}:\n${JSON.stringify(p.plan, null, 1)}`).join('\n\n')
  return `${TEAM}
Eres el PLANIFICADOR. Los dos agentes han hecho una propuesta por separado y ahora hay que acordar UN plan que aproveche lo mejor de cada una.
Petición del usuario:
<peticion>
${request}
</peticion>

${body}

Inspecciona el proyecto (solo lectura), compara ambas propuestas y redacta el plan definitivo: quédate con lo mejor de cada una, resuelve las diferencias y reparte las tareas entre los dos.
${planRules}
En summary explica en 3-5 frases qué has tomado de cada propuesta y por qué reparties así el trabajo. No modifiques ningún fichero.`
}

export function agreementPrompt(request: string, plan: Plan, planner: AgentId): string {
  return `${TEAM}
Eres el REVISOR DEL PLAN. ${AGENT_NAMES[planner]} ha redactado el plan definitivo combinando las dos propuestas.
Petición del usuario:
<peticion>
${request}
</peticion>

Plan:
${JSON.stringify(plan, null, 1)}

Comprueba (solo lectura) que cubre la petición, que el reparto y las dependencias tienen sentido y que no hay tareas paralelas que pisen los mismos ficheros.
verdict "approve" si estás de acuerdo; "changes" solo para problemas reales del plan, con issues concretos (file puede ir vacío).`
}

export function revisePlanPrompt(request: string, plan: Plan, review: Review, reviewer: AgentId): string {
  const issues = review.issues.map((i) => `- [${i.severity}] ${i.description}`).join('\n')
  return `${TEAM}
Eres el PLANIFICADOR. ${AGENT_NAMES[reviewer]} ha revisado tu plan y pide ajustes:
${review.summary}
${issues}

Petición del usuario:
<peticion>
${request}
</peticion>

Plan actual:
${JSON.stringify(plan, null, 1)}

Devuelve el plan corregido con las mismas reglas (1-6 tareas, dependencias solo si son reales, reparto entre "claude" y "codex"). No modifiques ningún fichero.`
}

export function finalReviewPrompt(o: { request: string; plan?: Plan; diff: string; reviewer: AgentId; testNote: string }): string {
  return `${TEAM}
Eres el REVISOR FINAL (${AGENT_NAMES[o.reviewer]}). El trabajo de los dos ya está integrado en una sola rama y vas a comprobar el resultado completo, como si fueras a aprobarlo tú.
Petición del usuario:
<peticion>
${o.request}
</peticion>
${o.plan?.summary ? `\nPlan acordado: ${o.plan.summary}\n` : ''}
${o.testNote}

Cambios integrados (diff respecto al inicio):
\`\`\`diff
${o.diff || '(sin cambios)'}
\`\`\`

Puedes leer los ficheros de la carpeta actual. No modifiques nada. Comprueba que se cumple la petición completa, que las piezas de los dos agentes encajan entre sí y que no quedan errores.
verdict "approve" si está listo; "changes" solo para problemas reales (bugs, partes de la petición sin hacer, piezas que no encajan), nunca por estilo. Cada issue, concreto y accionable.`
}

export function finalFixPrompt(issues: { by: AgentId; review: Review }[]): string {
  const body = issues
    .map((r) => `${AGENT_NAMES[r.by]}: ${r.review.summary}\n${r.review.issues.map((i) => `- [${i.severity}]${i.file ? ` ${i.file}:` : ''} ${i.description}`).join('\n')}`)
    .join('\n\n')
  return `${TEAM}
Tras integrar el trabajo del equipo, la revisión final pide ajustes:
${body}

Aplícalos en esta rama (es la integración de los dos agentes). No hagas commits. Resume lo que has cambiado.`
}

export function summaryPrompt(o: {
  request: string
  plan?: Plan
  tasks: OrchTask[]
  reviews: { by: AgentId; review: Review }[]
  tests: string
  fixed: boolean
}): string {
  const tasks = o.tasks.map((t) => `- ${t.key} (${AGENT_NAMES[t.assignee]}): ${t.title}. ${(t.result?.summary ?? '').split('\n')[0].slice(0, 200)}`).join('\n')
  const reviews = o.reviews.map((r) => `- ${AGENT_NAMES[r.by]}: ${r.review.verdict === 'approve' ? 'aprueba' : 'pidió ajustes'}. ${r.review.summary}`).join('\n')
  return `${TEAM}
Eres el AUTOR DEL RESUMEN: escribe, en nombre de los dos, el RESUMEN final para el usuario. Lo leerá antes de decidir si integra el resultado.
Petición:
${o.request}

${o.plan?.summary ? `Plan acordado: ${o.plan.summary}\n` : ''}Trabajo hecho:
${tasks}

Revisión final cruzada:
${reviews || '(sin revisiones)'}${o.fixed ? '\nSe aplicaron ajustes tras la revisión final.' : ''}
Pruebas: ${o.tests}

Escribe en español, en Markdown breve (máximo ~15 líneas): qué se ha conseguido, quién hizo qué, cómo se revisaron entre ellos, estado de las pruebas y cualquier cosa pendiente o que el usuario deba mirar. Sin modificar ficheros.`
}

export function taskPrompt(o: { request: string; plan?: Plan; task: OrchTask; branch: string; handoffs: string[]; conflicts: string[] }): string {
  const t = o.task
  return `${TEAM}
Trabajas en tu propio git worktree (rama ${o.branch}); el otro agente trabaja en el suyo. No hagas commits ni cambies de rama: Ambidex los gestiona.

Objetivo global del usuario:
${o.request}
${o.plan?.summary ? `\nPlan acordado: ${o.plan.summary}\n` : ''}
TU TAREA (${t.key}): ${t.title}
${t.description}
${t.acceptance ? `\nCriterios de aceptación: ${t.acceptance}` : ''}
${o.handoffs.length ? `\nResultados de tareas previas ya incorporados en tu rama:\n${o.handoffs.join('\n')}` : ''}
${o.conflicts.length ? `\nIMPORTANTE: al incorporar el trabajo del otro agente han quedado conflictos de merge en: ${o.conflicts.join(', ')}. Resuélvelos primero (elimina los marcadores <<<<<<< ======= >>>>>>>) conservando ambos cambios.` : ''}

Implementa la tarea completa. Al terminar, resume en pocas líneas qué has hecho y qué ficheros has cambiado.`
}

export function reviewPrompt(o: { task: OrchTask; implementer: AgentId; diff: string; round: number; maxRounds: number }): string {
  return `${TEAM}
Eres el REVISOR del trabajo de ${AGENT_NAMES[o.implementer]} (ronda ${o.round} de ${o.maxRounds}).
Tarea ${o.task.key}: ${o.task.title}
${o.task.description}
${o.task.acceptance ? `Criterios de aceptación: ${o.task.acceptance}` : ''}

Cambios realizados (diff):
\`\`\`diff
${o.diff || '(sin cambios)'}
\`\`\`

Puedes leer los ficheros de la carpeta actual para comprobarlo. No modifiques nada.
verdict "approve" si cumple los criterios y no hay errores relevantes; "changes" solo para problemas reales (bugs, criterios no cumplidos, código que no compila), nunca por estilo. Cada issue debe ser concreto y accionable.`
}

export function fixPrompt(o: { task: OrchTask; reviewer: AgentId; review: Review; round: number; maxRounds: number }): string {
  const issues = o.review.issues.map((i) => `- [${i.severity}]${i.file ? ` ${i.file}:` : ''} ${i.description}`).join('\n')
  return `${TEAM}
${AGENT_NAMES[o.reviewer]} ha revisado tu trabajo en la tarea ${o.task.key} (${o.task.title}) y pide cambios (ronda ${o.round} de ${o.maxRounds}):
${o.review.summary}
${issues}

Corrige estos problemas en tu worktree. No hagas commits. Resume lo que has cambiado.`
}

export function conflictPrompt(files: string[]): string {
  return `${TEAM}
Al integrar en una sola rama el trabajo de Claude y de Codex han quedado conflictos de merge en: ${files.join(', ')}.
Resuélvelos conservando la funcionalidad de ambos lados y elimina todos los marcadores de conflicto. No hagas commits.`
}

export function testFixPrompt(o: { command: string; output: string; round: number; maxRounds: number }): string {
  return `${TEAM}
Tras integrar el trabajo del equipo, las pruebas fallan (intento ${o.round} de ${o.maxRounds}).
Comando: ${o.command}
Salida (final):
\`\`\`
${o.output.slice(-6000)}
\`\`\`
Corrige el código para que las pruebas pasen. No desactives ni borres pruebas. No hagas commits. Resume lo que has cambiado.`
}

// ---------- comando de pruebas ----------

// Solo se ejecutan comandos de pruebas conocidos, sin metacaracteres de shell
const TEST_CMD = [
  /^(npm|pnpm|yarn|bun) (run )?test$/,
  /^(npm|pnpm|yarn|bun) (run )?test:[\w-]+$/,
  /^npx (vitest|jest)( run)?$/,
  /^(python3?|uv run python) -m (pytest|unittest)$/,
  /^pytest$/,
  /^go test( \.\/\.\.\.)?$/,
  /^cargo test$/,
  /^swift test$/,
  /^make test$/
]

export function safeTestCommand(cmd: string | undefined): string[] | undefined {
  const c = (cmd ?? '').trim().replace(/\s+/g, ' ')
  if (!c || !TEST_CMD.some((re) => re.test(c))) return undefined
  return c.split(' ')
}

export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/g, '')
  return s || 'tarea'
}
