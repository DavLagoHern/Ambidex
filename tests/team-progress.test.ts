import { describe, expect, it } from 'vitest'
import { emptyTotals, type RunInfo, type SessionMeta } from '../src/shared/types'
import { mergeTeamRuns, proposalProgress, teamSteps } from '../src/shared/team-progress'

const session = (id: string, agent: 'claude' | 'codex', extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id, agent, projectId: 'project', orchestrationId: 'team', cwd: '/project', title: `Propuesta de ${agent} · Tarea`, totals: emptyTotals(),
  createdAt: 1000, updatedAt: 1000, messageCount: 1, running: false, ...extra
})
const run = (id: string, sessionId: string, extra: Partial<RunInfo> = {}): RunInfo => ({ id, sessionId, projectId: 'project', agent: 'claude', status: 'running', startedAt: 1000, ...extra })

describe('feedback del equipo', () => {
  it('muestra la propuesta terminada mientras espera al otro agente y omite otros equipos', () => {
    const steps = teamSteps('team', [session('a', 'claude', { running: true }), session('b', 'codex'), session('other', 'claude', { orchestrationId: 'other' })], [run('ra', 'a', { lastActivityAt: 9900 }), run('rb', 'b', { agent: 'codex', status: 'completed', endedAt: 6000 })], 10_000)
    expect(steps).toHaveLength(2)
    expect(steps.map(s => s.status)).toEqual(['running', 'completed'])
    expect(proposalProgress(steps)).toBe('1 de 2 propuestas listas. Esperando a Claude Code.')
    expect(steps[1].elapsedMs).toBe(5000)
  })
  it('avisa de silencio real sin fabricar actividad ni mostrar el razonamiento interno', () => {
    const s = { ...session('a', 'claude'), items: [
      { id: 't', type: 'tool' as const, toolId: 't', name: 'Read', input: 'README.md', status: 'done' as const, at: 2000 },
      { id: 'private', type: 'thinking' as const, text: 'razonamiento interno', at: 3000 }
    ] }
    const [step] = teamSteps('team', [s], [run('r', 'a', { lastActivityAt: 4000 })], 100_000)
    expect(step).toMatchObject({ quiet: true, lastSignalAt: 4000, tools: 1, lastMessage: undefined })
    expect(step.lastTool?.input).toBe('README.md')
    expect(teamSteps('team', [s], [run('r', 'a', { lastActivityAt: 99_000 })], 100_000)[0].quiet).toBe(false)
  })
  it('no confunde el turno anterior con uno nuevo ni convierte una cancelación en éxito', () => {
    const s = session('a', 'claude', { runId: 'new', running: true })
    expect(teamSteps('team', [s], [run('old', 'a', { status: 'completed', endedAt: 3000 })], 10_000)[0].run).toBeUndefined()
    const [step] = teamSteps('team', [s], [run('new', 'a', { status: 'cancelled', endedAt: 5000 })], 100_000)
    expect(step).toMatchObject({ status: 'cancelled', elapsedMs: 4000, quiet: false })
  })
  it('combina recuperación y eventos sin resucitar procesos terminados ni perder actividad más reciente', () => {
    const finished = run('r', 'a', { status: 'completed', endedAt: 5000 })
    expect(mergeTeamRuns([finished], [run('r', 'a')])[0]).toEqual(finished)
    expect(mergeTeamRuns([run('r', 'a')], [finished])[0]).toEqual(finished)
    const fresh = run('r', 'a', { lastActivityAt: 4000 })
    expect(mergeTeamRuns([fresh], [run('r', 'a', { lastActivityAt: 2000 })])[0]).toEqual(fresh)
  })
})
