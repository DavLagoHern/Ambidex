import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import { Dispatcher } from '../src/main/agents/dispatcher'
import { SessionService } from '../src/main/agents/service'
import { Orchestrator } from '../src/main/orchestrator/engine'
import type { PushChannel, PushContract } from '../src/shared/ipc'
import type { OrchMode } from '../src/shared/orchestrator'
import { cleanupTmp, FAKE_CLI, FIXTURES, git, initRepo, memoryStore, tmpDir, waitFor } from './helpers'

afterEach(cleanupTmp)

function setup(env: Record<string, string> = {}) {
  const store = memoryStore()
  const repo = initRepo()
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }))
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'package')
  const project = store.openProject(repo, 'demo', repo)
  const state = tmpDir()
  const pushed: { channel: PushChannel; payload: unknown }[] = []
  const push = <K extends PushChannel>(channel: K, payload: PushContract[K]) => void pushed.push({ channel, payload })
  const childEnv = { ...process.env, FAKE_MODE: 'orch', FAKE_STATE: state, ...env }
  let dispatcher: Dispatcher
  const service = new SessionService({
    store,
    push,
    adapters: { claude: claudeAdapter, codex: createCodexAdapter(tmpDir()) },
    resolveBin: () => FAKE_CLI,
    env: () => childEnv,
    defaultModel: () => undefined,
    onIdle: (s) => dispatcher?.onIdle(s),
    uiThrottleMs: 5,
    dbThrottleMs: 10
  })
  dispatcher = new Dispatcher({ store, service, push, settings: () => store.getSettings(), available: () => true })
  const wtBase = tmpDir()
  const orch = new Orchestrator({ store, service, push, settings: () => store.getSettings(), worktreeBase: () => wtBase, env: () => process.env })
  return { store, repo, project, orch, service, dispatcher, pushed }
}

const start = (s: ReturnType<typeof setup>, mode: OrchMode, approvePlan = false) =>
  s.orch.start(s.project.id, { request: 'Implementa la funcionalidad X', mode, options: { maxRounds: 2, approvePlan, parallel: 2 } })

describe('orquestador (agentes simulados con el formato real de cada CLI)', () => {
  it('modo C: plan → paralelo → intercambio → revisión cruzada → integración → pruebas → aprobación → integrar', async () => {
    const s = setup()
    const o = await start(s, 'C', true)
    await waitFor(() => s.orch.get(o.id)!.status === 'awaiting_plan', 15000)
    const planned = s.orch.get(o.id)!
    expect(planned.tasks.map((t) => [t.key, t.assignee, t.dependsOn])).toEqual([
      ['T1', 'claude', []],
      ['T2', 'codex', []],
      ['T3', 'claude', ['T1', 'T2']]
    ])
    s.orch.approvePlan(o.id)
    await waitFor(() => ['awaiting_approval', 'failed', 'needs_user'].includes(s.orch.get(o.id)!.status), 30000)
    const done = s.orch.get(o.id)!
    expect(done.error).toBeUndefined()
    expect(done.status).toBe('awaiting_approval')
    expect(done.tasks.every((t) => t.status === 'done')).toBe(true)
    // revisión cruzada: cada tarea la revisa el otro agente
    const reviewers = done.messages.filter((m) => m.kind === 'review').map((m) => [m.from, m.to])
    expect(reviewers).toEqual(expect.arrayContaining([['codex', 'claude'], ['claude', 'codex']]))
    // T3 (Claude) recibió el trabajo de Codex (T2) en su rama antes de empezar
    expect(done.messages.some((m) => m.kind === 'handoff' && m.from === 'codex' && m.to === 'claude')).toBe(true)
    const claudeWt = done.worktrees.find((w) => w.owner === 'claude')!
    expect(readFileSync(join(claudeWt.path, 'T3.txt'), 'utf8')).toContain('T1.txt,T2.txt')
    expect(done.testResult).toMatchObject({ command: 'npm test', ok: true })
    // las sesiones de cada paso quedan como conversaciones visibles
    expect(s.store.listSessions(s.project.id).filter((x) => x.orchestrationId === o.id).length).toBeGreaterThanOrEqual(7)
    // los cambios propuestos, con su autoría
    const ch = await s.orch.changes(o.id)
    expect(ch.files.map((f) => f.path).sort()).toEqual(['T1.txt', 'T2.txt', 'T3.txt'])
    expect(ch.files.find((f) => f.path === 'T2.txt')!.agents).toEqual(['codex'])
    // el repositorio del usuario no se ha tocado hasta aprobar
    expect(existsSync(join(s.repo, 'T1.txt'))).toBe(false)
    await s.orch.integrate(o.id, { strategy: 'squash' })
    expect(s.orch.get(o.id)!.status).toBe('integrated')
    const staged = git(s.repo, 'diff', '--cached', '--name-only').trim().split('\n').sort()
    expect(staged).toEqual(['T1.txt', 'T2.txt', 'T3.txt'])
    await s.orch.cleanup(o.id)
    expect(s.orch.get(o.id)!.worktrees.every((w) => w.status === 'removed')).toBe(true)
    expect(existsSync(claudeWt.path)).toBe(false)
    expect(git(s.repo, 'branch', '--list', 'ambidex/*').trim()).toBe('')
  })

  it('modo C: los dos proponen, acuerdan el plan, se revisan, comprueban el resultado juntos y escriben un resumen', async () => {
    const s = setup({ FAKE_FINAL_CHANGES: '1' })
    const o = await start(s, 'C', false)
    await waitFor(() => ['awaiting_approval', 'failed', 'needs_user'].includes(s.orch.get(o.id)!.status), 45000)
    const d = s.orch.get(o.id)!
    expect(d.error).toBeUndefined()
    expect(d.status).toBe('awaiting_approval')
    const texts = d.messages.map((m) => `${m.kind}|${m.from}|${m.text}`)
    // 1) las dos propuestas, cada una de su agente
    const proposals = d.messages.filter((m) => m.kind === 'plan' && / propone: /.test(m.text)).map((m) => m.from).sort()
    expect(proposals).toEqual(['claude', 'codex'])
    // 2) el plan acordado y la conformidad del otro agente
    expect(texts.some((t) => t.startsWith('plan|claude|Plan acordado'))).toBe(true)
    expect(d.messages.some((m) => m.kind === 'review' && m.from === 'codex' && m.to === 'claude' && /de acuerdo con el plan/.test(m.text))).toBe(true)
    // 3) el reparto entre los dos
    expect(new Set(d.tasks.map((t) => t.assignee))).toEqual(new Set(['claude', 'codex']))
    // 4) revisión final de los dos: uno pidió ajustes, se aplicaron y el resultado los incluye
    const finals = d.messages.filter((m) => m.kind === 'review' && m.to === 'user')
    expect(finals.map((m) => m.from).sort()).toEqual(['claude', 'codex'])
    expect(finals.some((m) => /pide ajustes finales/.test(m.text))).toBe(true)
    expect(d.messages.some((m) => m.kind === 'fix' && /Ajustes aplicados/.test(m.text))).toBe(true)
    const ch = await s.orch.changes(o.id)
    expect(ch.files.map((f) => f.path)).toContain('final.txt')
    expect(d.testResult).toMatchObject({ ok: true })
    // 5) el resumen, en el último mensaje de contenido
    const summary = d.messages.find((m) => m.kind === 'summary')
    expect(summary?.text).toContain('Resumen')
    expect(summary?.to).toBe('user')
    // el resumen llega después de las revisiones finales
    expect(d.messages.findIndex((m) => m.kind === 'summary')).toBeGreaterThan(d.messages.findLastIndex((m) => m.kind === 'review'))
  })

  it('modo C: si un agente no puede proponer, el plan sale de la propuesta del otro', async () => {
    const s = setup({ FAKE_FAIL_PROPOSAL: 'codex' })
    const o = await start(s, 'C', true)
    await waitFor(() => ['awaiting_plan', 'failed'].includes(s.orch.get(o.id)!.status), 30000)
    const d = s.orch.get(o.id)!
    expect(d.status).toBe('awaiting_plan')
    expect(d.messages.some((m) => m.kind === 'warning' && /Codex no pudo hacer su propuesta/.test(m.text))).toBe(true)
    expect(d.messages.some((m) => m.kind === 'warning' && /Solo hay una propuesta/.test(m.text))).toBe(true)
    expect(d.tasks.length).toBeGreaterThan(0)
  })

  it('la revisión pide cambios, el implementador corrige y se vuelve a revisar', async () => {
    const s = setup({ FAKE_REVIEW_CHANGES_ONCE: '1' })
    const o = await start(s, 'D')
    await waitFor(() => ['awaiting_approval', 'failed', 'needs_user'].includes(s.orch.get(o.id)!.status), 30000)
    const done = s.orch.get(o.id)!
    expect(done.status).toBe('awaiting_approval')
    const t = done.tasks[0]
    expect(t.round).toBe(2)
    expect(t.review?.verdict).toBe('approve')
    expect(t.result?.files.sort()).toEqual(['T1.txt', 'fix.txt'])
    expect(done.messages.map((m) => m.kind)).toEqual(expect.arrayContaining(['review', 'fix']))
  })

  it('modo E: dos implementaciones independientes y se integra la elegida', async () => {
    const s = setup()
    const o = await start(s, 'E')
    await waitFor(() => ['awaiting_approval', 'failed'].includes(s.orch.get(o.id)!.status), 30000)
    expect(s.orch.get(o.id)!.status).toBe('awaiting_approval')
    expect((await s.orch.changes(o.id, 'codex')).files.map((f) => f.path)).toEqual(['Codex.txt'])
    await expect(s.orch.integrate(o.id, { strategy: 'squash' })).rejects.toThrow(/Elige/)
    await s.orch.integrate(o.id, { candidate: 'codex', strategy: 'merge' })
    expect(existsSync(join(s.repo, 'Codex.txt'))).toBe(true)
    expect(existsSync(join(s.repo, 'Claude.txt'))).toBe(false)
  })

  it('no integra encima de cambios sin commit del usuario', async () => {
    const s = setup()
    const o = await start(s, 'D')
    await waitFor(() => s.orch.get(o.id)!.status === 'awaiting_approval', 30000)
    writeFileSync(join(s.repo, 'README.md'), 'cambio del usuario\n')
    await expect(s.orch.integrate(o.id, { strategy: 'squash' })).rejects.toThrow(/sin commit/)
  })

  it('tras un cierre inesperado queda interrumpida y se puede reanudar', async () => {
    const s = setup()
    const o = await start(s, 'C', true)
    await waitFor(() => s.orch.get(o.id)!.status === 'awaiting_plan', 15000)
    s.store.updateOrchestration(o.id, { status: 'running' })
    // simula reinicio: un motor nuevo sobre la misma base de datos
    const fresh = new Orchestrator({ store: s.store, service: s.service, push: () => {}, settings: () => s.store.getSettings(), worktreeBase: () => tmpDir(), env: () => process.env })
    expect(fresh.recover()).toBe(1)
    expect(fresh.get(o.id)!.status).toBe('interrupted')
    fresh.resume(o.id)
    await waitFor(() => ['awaiting_approval', 'failed'].includes(fresh.get(o.id)!.status), 30000)
    expect(fresh.get(o.id)!.status).toBe('awaiting_approval')
  })
})

describe('chat único con enrutado', () => {
  it('reparte los mensajes, pasa el contexto del otro agente y encola si están ocupados', async () => {
    const s = setup({ FAKE_MODE: 'replay', FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl') })
    const t = s.dispatcher.createThread(s.project.id)
    const r1 = await s.dispatcher.sendThread(t.id, 'Planifica la estructura del módulo de pagos')
    expect(r1.decision).toMatchObject({ agent: 'claude', category: 'plan' })
    await waitFor(() => !s.service.isRunning(r1.sessionId!))
    const r2 = await s.dispatcher.sendThread(t.id, 'Arregla el error del checkout')
    expect(r2.decision?.agent).toBe('codex')
    const codexFirst = s.store.messages(r2.sessionId!)[0] as { context?: string; route?: { agent: string } }
    // Codex recibe lo que se habló con Claude
    expect(codexFirst.context).toContain('Planifica la estructura')
    expect(codexFirst.route?.agent).toBe('codex')
    // mientras Codex trabaja, otro mensaje para Codex espera en la cola y sale solo al terminar
    const r3 = await s.dispatcher.sendThread(t.id, '@codex y añade un test')
    expect(r3.queued).toBeTruthy()
    await waitFor(() => s.store.listQueue(s.project.id).length === 0, 10000)
    await waitFor(() => s.store.messages(r2.sessionId!).filter((i) => i.type === 'user').length === 2, 10000)
    expect(s.store.getThread(t.id)!.title).toBe('Planifica la estructura del módulo de pagos')
  })
})
