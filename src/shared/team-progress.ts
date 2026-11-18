import type { AgentId, ChatItem, RunInfo, RunStatus, SessionMeta } from './types'
import { AGENT_NAMES } from './types'

type TeamSession = SessionMeta & { items?: ChatItem[] }
export interface TeamStep {
  session: TeamSession
  run?: RunInfo
  status: RunStatus | 'pending'
  phase: string
  elapsedMs: number
  lastSignalAt?: number
  quiet: boolean
  tools: number
  lastTool?: Extract<ChatItem, { type: 'tool' }>
  lastMessage?: string
}

export function mergeTeamRuns(saved: RunInfo[], live: RunInfo[]): RunInfo[] {
  const result = new Map(saved.map(r => [r.id, r]))
  for (const run of live) {
    const prev = result.get(run.id)
    if (prev && prev.status !== 'running' && run.status === 'running') continue
    if (!prev || run.status !== 'running' || (run.lastActivityAt ?? run.startedAt) >= (prev.lastActivityAt ?? prev.startedAt)) result.set(run.id, run)
  }
  return [...result.values()]
}

export function teamSteps(id: string, sessions: TeamSession[], runs: RunInfo[], now: number): TeamStep[] {
  return sessions.filter(s => s.orchestrationId === id).sort((a, b) => a.createdAt - b.createdAt).map(session => {
    const run = session.runId ? runs.find(r => r.id === session.runId) : runs.filter(r => r.sessionId === session.id).sort((a, b) => b.startedAt - a.startedAt)[0]
    const status = run?.status ?? (session.running ? 'running' : 'pending')
    const tools = (session.items ?? []).filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
    const message = session.items?.findLast(i => i.type === 'assistant')
    const lastSignalAt = run?.lastActivityAt ?? tools.at(-1)?.at ?? run?.startedAt
    return {
      session, run, status, phase: session.title.split(' · ')[0],
      elapsedMs: run ? Math.max(0, (run.endedAt ?? now) - run.startedAt) : 0,
      lastSignalAt, quiet: status === 'running' && lastSignalAt !== undefined && now - lastSignalAt >= 90_000,
      tools: tools.length, lastTool: tools.at(-1),
      // Solo mensajes públicos: no convertir el razonamiento interno en feedback.
      lastMessage: message?.type === 'assistant' ? message.text.replace(/\s+/g, ' ').slice(0, 240) : undefined
    }
  })
}

export function proposalProgress(steps: TeamStep[]): string | undefined {
  const latest = new Map<AgentId, TeamStep>()
  for (const step of steps) if (step.phase.startsWith('Propuesta de ')) latest.set(step.session.agent, step)
  if (!latest.size) return undefined
  const ready = [...latest.values()].filter(s => s.status === 'completed').length
  const waiting = [...latest.values()].filter(s => s.status === 'running' || s.status === 'pending').map(s => AGENT_NAMES[s.session.agent])
  return `${ready} de 2 propuestas listas.${waiting.length ? ` Esperando a ${waiting.join(' y ')}.` : ''}`
}
