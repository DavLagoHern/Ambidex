import type { AgentId, RouteCategory, RouteDecision } from './types'
import { AGENT_NAMES } from './types'

export const CATEGORY_LABELS: Record<RouteCategory, string> = {
  plan: 'Planificar y arquitectura',
  explain: 'Explicar y documentar',
  frontend: 'Frontend e interfaz',
  implement: 'Implementar código',
  debug: 'Depurar y corregir errores',
  tests: 'Tests',
  review: 'Revisar código',
  terminal: 'Terminal, scripts y despliegue'
}

// Palabras clave (español e inglés) por tipo de petición
const KEYWORDS: Record<RouteCategory, RegExp> = {
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
  defaultAgent: AgentId
}

const otherOf = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude')

// Lo que un modelo (Jev) ha entendido del mensaje; sustituye a las palabras clave
export interface Classification {
  category?: RouteCategory
  confidence?: number
  followUp: boolean
  via: 'jev'
}

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
  } else if (category && ctx.prefs[category] !== 'any') {
    agent = ctx.prefs[category] as AgentId
    reason = `${CATEGORY_LABELS[category]} → ${AGENT_NAMES[agent]}`
  } else {
    // sin preferencia: el más libre y con más margen de uso
    const score = (a: AgentId) => (ctx.busy[a] ? 100 : 0) + (ctx.usage[a] ?? 0) / 10 + (a === ctx.lastAgent ? 0.5 : 0)
    agent = score('claude') <= score('codex') ? 'claude' : 'codex'
    if (score('claude') === score('codex')) agent = ctx.lastAgent ? otherOf(ctx.lastAgent) : ctx.defaultAgent
    reason = category ? `${CATEGORY_LABELS[category]} · reparto de carga → ${AGENT_NAMES[agent]}` : `Reparto de carga → ${AGENT_NAMES[agent]}`
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
    .map(([c, a]) => `- ${CATEGORY_LABELS[c]}: ${a === 'any' ? 'cualquiera' : AGENT_NAMES[a]}`)
    .join('\n')
  return `Eres el enrutador de una app con dos agentes de programación: Claude Code ("claude") y Codex ("codex").
Decide cuál debe atender el mensaje del usuario. Preferencias del usuario por tipo de tarea:
${prefs}
Estado: Claude ${ctx.busy.claude ? 'ocupado' : 'libre'}${ctx.usage.claude !== undefined ? ` (${ctx.usage.claude}% de uso)` : ''}; Codex ${ctx.busy.codex ? 'ocupado' : 'libre'}${ctx.usage.codex !== undefined ? ` (${ctx.usage.codex}% de uso)` : ''}.
${ctx.lastAgent ? `El mensaje anterior lo atendió ${ctx.lastAgent}. Si es una continuación, mantén ese agente.` : ''}
Responde SOLO con JSON: {"agent":"claude"|"codex","reason":"motivo breve en español"}

Mensaje:
${text.slice(0, 4000)}`
}
