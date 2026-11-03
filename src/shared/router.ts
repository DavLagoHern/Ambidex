import type { AgentId, BuiltinCategory, ModelPolicy, ModelTier, RouteCategory, RouteCategoryDef, RouteDecision, Settings } from './types'
import { AGENT_NAMES } from './types'

export const CATEGORY_LABELS: Record<RouteCategory, string> & Record<BuiltinCategory, string> = {
  plan: 'Planificar y arquitectura',
  explain: 'Explicar y documentar',
  frontend: 'Frontend e interfaz',
  implement: 'Implementar código',
  debug: 'Depurar y corregir errores',
  tests: 'Tests',
  review: 'Revisar código',
  terminal: 'Terminal, scripts y despliegue'
}

// Lo que lee Jev de cada tipo de tarea (criterios de su pregunta «choice») y de cada dificultad. Se pueden editar
// y ampliar en Ajustes; sin cambios, estos.
export const CATEGORY_CRITERIA: Record<BuiltinCategory, string> = {
  plan: 'plan or design the architecture, propose an approach or a roadmap',
  explain: 'explain code or concepts, answer a question, write documentation',
  frontend: 'user interface: screens, layout, styles, CSS, visual components, responsive design',
  implement: 'write new code, add a feature, refactor or migrate code',
  debug: 'fix an error, a crash, a failing build or something that does not work',
  tests: 'write, fix or run tests',
  review: 'review code, look for bugs or security problems in existing changes',
  terminal: 'terminal commands, shell scripts, installing dependencies, docker, CI or deployment'
}
export const DIFFICULTY_CRITERIA: Record<ModelTier, string> = {
  hard: 'complex or risky work: architecture or design decisions, hard-to-find bugs, large refactors, changes across many files, security, performance, concurrency or data migrations',
  easy: 'simple or routine work: a quick question, an explanation, a small edit in one file, renaming, formatting, copy changes, running a command or a small style tweak'
}

export const DEFAULT_CATEGORIES: RouteCategoryDef[] = (Object.keys(CATEGORY_CRITERIA) as BuiltinCategory[]).map((id) => ({
  id,
  label: CATEGORY_LABELS[id],
  description: CATEGORY_CRITERIA[id]
}))

// Los tipos de tarea en uso: los del usuario si los ha tocado; si no, los de serie
export function routeCategories(s: Pick<Settings, 'routeCategories'>): RouteCategoryDef[] {
  const list = (s.routeCategories ?? []).filter((c) => c.id && c.label.trim())
  return list.length ? list : DEFAULT_CATEGORIES
}

export function difficultyCriteria(s: Pick<Settings, 'difficultyCriteria'>): Record<ModelTier, string> {
  const d = s.difficultyCriteria ?? {}
  return { hard: d.hard?.trim() || DIFFICULTY_CRITERIA.hard, easy: d.easy?.trim() || DIFFICULTY_CRITERIA.easy }
}

// Palabras clave (español e inglés) por tipo de petición (solo los de serie: el motor «Reglas» no lee descripciones)
const KEYWORDS: Record<BuiltinCategory, RegExp> = {
  plan: /\b(planific\w*|plan|arquitect\w*|diseñ[ao]\s+(el|la|un|una)\s+(sistema|api|modelo|esquema)|estrategia|enfoque|propón|propon\w*|roadmap|approach|architecture|design\s+(the|a)\s+\w+)\b/i,
  explain: /\b(expl[ií]ca\w*|qu[ée]\s+hace|c[óo]mo\s+funciona|entender|entiendo|document\w*|readme|resum\w*|explain|what\s+does|how\s+does|walk\s+me)\b/i,
  frontend: /\b(css|html|react|vue|svelte|angular|tailwind|componente\w*|component\w*|ui|ux|interfaz|pantalla\w*|estilos?|layout|animaci\w*|responsive|frontend)\b/i,
  implement: /\b(implement\w*|añad\w*|agreg\w*|crea\w*|constru\w*|refactori\w*|escrib\w*|genera\w*|migra\w*|add|create|build|implement|refactor|write|generate)\b/i,
  debug: /\b(error\w*|bug\w*|falla\w*|fallo\w*|crash\w*|excepci\w*|exception|traceback|stack\s*trace|no\s+funciona|roto|arregl\w*|fix\w*|depur\w*|debug\w*|broken)\b/i,
  tests: /\b(tests?|pruebas?|specs?|cobertura|coverage|jest|vitest|pytest|unittest|e2e)\b/i,
  review: /\b(revis\w*|review\w*|audit\w*|code\s+review|busca\s+bugs|seguridad|security|vulnerab\w*)\b/i,
  terminal: /\b(script\w*|bash|zsh|shell|comando\w*|command\w*|docker\w*|ci|pipeline|deploy\w*|despleg\w*|instal\w*|install\w*|sql|cron|makefile|kubernetes|k8s)\b/i
}

const FOLLOW_UP = /^(y\s|también|tambien|ahora\s|vale|ok\b|okay|perfecto|genial|sigue|continúa|continua|hazlo|haz\s+eso|eso\b|lo\s+mismo|otra\s+vez|mejor\b|pero\s|and\s|also\s|now\s|continue|go\s+on|do\s+it|same|again)/i

export function classify(text: string): { category?: RouteCategory; scores: Partial<Record<RouteCategory, number>> } {
  const scores: Partial<Record<RouteCategory, number>> = {}
  for (const [cat, re] of Object.entries(KEYWORDS) as [RouteCategory, RegExp][]) {
    const m = text.match(new RegExp(re.source, 'gi'))
    if (m) scores[cat] = m.length
  }
  // "implementar" es genérico: cede ante una categoría más específica
  const ranked = (Object.entries(scores) as [RouteCategory, number][]).sort((a, b) => b[1] - a[1] || (a[0] === 'implement' ? 1 : b[0] === 'implement' ? -1 : 0))
  return { category: ranked[0]?.[0], scores }
}

export interface RouteContext {
  available: Record<AgentId, boolean>
  busy: Record<AgentId, boolean>
  // % de uso de la ventana de límite más ajustada
  usage: Partial<Record<AgentId, number>>
  lastAgent?: AgentId
  prefs: Record<RouteCategory, AgentId | 'any'>
  // nombres de los tipos de tarea (los editados por el usuario)
  labels?: Record<RouteCategory, string>
  defaultAgent: AgentId
}

const otherOf = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude')

// Lo que un modelo (Jev) ha entendido del mensaje; sustituye a las palabras clave
export interface Classification {
  category?: RouteCategory
  confidence?: number
  followUp: boolean
  // dificultad, si se preguntó y la tiene clara, y lo segura que está (0 = duda, 1 = segura)
  tier?: ModelTier
  tierConfidence?: number
  via: 'jev'
}

export const TIER_LABELS: Record<ModelTier, string> = { hard: 'difícil', easy: 'sencilla' }

// Modelo de un agente para un mensaje según su dificultad y los modelos permitidos en Ajustes → Modelos.
// Sin estimación (Jev duda, no contesta a tiempo o deciden las reglas) se usa el de las tareas difíciles.
// `catalog`: modelos que ofrece el CLI instalado; uno que no esté (CLI antiguo) no se elige.
export function pickModel(agent: AgentId, tier: ModelTier | undefined, policy: ModelPolicy, catalog?: string[]): { model: string; tier: ModelTier; guessed: boolean } | undefined {
  const p = policy.auto ? policy[agent] : undefined
  const allowed = (p?.allowed ?? []).filter((m) => !catalog || catalog.includes(m))
  if (!p || !allowed.length) return undefined
  const t = tier ?? 'hard'
  const want = [p[t], p[t === 'hard' ? 'easy' : 'hard']].find((m) => allowed.includes(m))
  return { model: want ?? allowed[0], tier: t, guessed: !tier }
}

// Razonamiento de un turno en Auto. Por defecto medio; Jev solo lo mueve si lo ve claro: alto para una tarea
// claramente difícil, bajo para una claramente sencilla. Nunca por encima de alto (muy alto, máximo…): gastan
// mucho límite y tardan, y eso no se elige sin que lo pidas tú.
// `supported`: niveles del modelo (undefined = no se sabe; [] = el modelo no tiene niveles).
export const EFFORT_CONFIDENCE = 0.6
export type AutoEffort = 'low' | 'medium' | 'high'
export function pickEffort(tier: ModelTier | undefined, confidence: number | undefined, supported?: string[]): { effort?: string; level: AutoEffort; sure: boolean } {
  const sure = !!tier && (confidence ?? 0) >= EFFORT_CONFIDENCE
  const level: AutoEffort = sure ? (tier === 'hard' ? 'high' : 'low') : 'medium'
  if (!supported || supported.includes(level)) return { effort: level, level, sure }
  if (supported.includes('medium')) return { effort: 'medium', level: 'medium', sure: false }
  // el modelo no tiene niveles (o ninguno de estos): lo que traiga por defecto el CLI
  return { effort: undefined, level, sure: false }
}

export const EFFORT_NAMES: Record<string, string> = {
  minimal: 'mínimo',
  low: 'bajo',
  medium: 'medio',
  high: 'alto',
  xhigh: 'muy alto',
  max: 'máximo'
}

const labelOf = (ctx: RouteContext, c: RouteCategory) => ctx.labels?.[c] ?? CATEGORY_LABELS[c] ?? c

// Decide qué agente atiende un mensaje del chat único: con lo que entendió Jev o, sin él, por palabras clave.
// Las preferencias por tipo de tarea, la disponibilidad, los límites y la carga se aplican igual en los dos casos.
export function decideRoute(text: string, ctx: RouteContext, cls?: Classification): RouteDecision {
  const t = text.trim()
  const mention = t.match(/^@(claude|codex)\b/i)
  if (mention) {
    const agent = mention[1].toLowerCase() as AgentId
    return { agent, reason: `Mencionado con @${agent}`, method: 'mention' }
  }

  const category = cls ? cls.category : classify(t).category
  const followUp = !!ctx.lastAgent && (cls ? cls.followUp : FOLLOW_UP.test(t) || (!category && t.length < 80))
  const method = cls?.via ?? 'rules'
  const tag = cls ? ` · Jev${cls.confidence !== undefined && category ? ` ${Math.round(cls.confidence * 100)}%` : ''}` : ''

  let agent: AgentId
  let reason: string
  if (followUp) {
    agent = ctx.lastAgent!
    reason = `Sigue la conversación con ${AGENT_NAMES[agent]}`
  } else if (category && (ctx.prefs[category] ?? 'any') !== 'any') {
    agent = ctx.prefs[category] as AgentId
    reason = `${labelOf(ctx, category)} → ${AGENT_NAMES[agent]}`
  } else {
    // sin preferencia: el más libre y con más margen de uso
    const score = (a: AgentId) => (ctx.busy[a] ? 100 : 0) + (ctx.usage[a] ?? 0) / 10 + (a === ctx.lastAgent ? 0.5 : 0)
    agent = score('claude') <= score('codex') ? 'claude' : 'codex'
    if (score('claude') === score('codex')) agent = ctx.lastAgent ? otherOf(ctx.lastAgent) : ctx.defaultAgent
    reason = category ? `${labelOf(ctx, category)} · reparto de carga → ${AGENT_NAMES[agent]}` : `Reparto de carga → ${AGENT_NAMES[agent]}`
  }
  reason += tag

  // restricciones: disponibilidad, límites de uso y carga
  const alt = otherOf(agent)
  if (!ctx.available[agent] && ctx.available[alt]) return { agent: alt, reason: `${AGENT_NAMES[agent]} no está disponible → ${AGENT_NAMES[alt]}${tag}`, method, category }
  const usage = ctx.usage[agent] ?? 0
  if (usage >= 95 && ctx.available[alt] && (ctx.usage[alt] ?? 0) < 95)
    return { agent: alt, reason: `${AGENT_NAMES[agent]} está al ${usage}% de su límite → ${AGENT_NAMES[alt]}${tag}`, method, category }
  if (ctx.busy[agent] && !ctx.busy[alt] && ctx.available[alt] && !followUp)
    return { agent: alt, reason: `${AGENT_NAMES[agent]} está ocupado → ${AGENT_NAMES[alt]}${tag}`, method, category }
  return { agent, reason, method, category }
}

// Prompt para el enrutado con IA (modelo rápido, sin herramientas)
export function aiRoutePrompt(text: string, ctx: RouteContext): string {
  const prefs = (Object.entries(ctx.prefs) as [RouteCategory, AgentId | 'any'][])
    .filter(([c]) => !ctx.labels || c in ctx.labels)
    .map(([c, a]) => `- ${labelOf(ctx, c)}: ${a === 'any' ? 'cualquiera' : AGENT_NAMES[a]}`)
    .join('\n')
  return `Eres el enrutador de una app con dos agentes de programación: Claude Code ("claude") y Codex ("codex").
Decide cuál debe atender el mensaje del usuario. Preferencias del usuario por tipo de tarea:
${prefs}
Estado: Claude ${ctx.busy.claude ? 'ocupado' : 'libre'}${ctx.usage.claude !== undefined ? ` (${ctx.usage.claude}% de uso)` : ''}; Codex ${ctx.busy.codex ? 'ocupado' : 'libre'}${ctx.usage.codex !== undefined ? ` (${ctx.usage.codex}% de uso)` : ''}.
${ctx.lastAgent ? `El mensaje anterior lo atendió ${ctx.lastAgent}. Si es una continuación, mantén ese agente.` : ''}
Indica también la dificultad: "hard" si pide arquitectura, errores difíciles, refactorizaciones grandes o cambios en muchos ficheros; "easy" si es una pregunta, una explicación o un cambio pequeño.
Responde SOLO con JSON: {"agent":"claude"|"codex","difficulty":"hard"|"easy","reason":"motivo breve en español"}

Mensaje:
${text.slice(0, 4000)}`
}
