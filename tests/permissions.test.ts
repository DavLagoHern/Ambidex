import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { PermissionBroker } from '../src/main/agents/permissions'
import { SessionService } from '../src/main/agents/service'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import type { ApprovalRequest, AgentId, ChatItem } from '../src/shared/types'
import { cleanupTmp, memoryStore, tmpDir, waitFor } from './helpers'

const services: SessionService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.cancelAll())); cleanupTmp() })
const ctx = { runId: 'run', sessionId: 'session', projectId: 'project', agent: 'claude' as const }
const input = { nativeId: 'native', kind: 'command' as const, title: 'Comando', command: 'printf marker', grantKey: 'exact', claudeRules: ['Bash(printf marker)'] }

describe('PermissionBroker', () => {
  it('responde una sola vez, conserva la decisión y recupera preguntas pendientes', async () => {
    const changed: ApprovalRequest[] = [], broker = new PermissionBroker(r => changed.push(r))
    const pending = broker.ask(ctx, input, new AbortController().signal)
    expect(broker.list('project')).toHaveLength(1)
    const id = changed[0].id
    expect(broker.answer(id, { allow: true, scope: 'once' })).toEqual({ ok: true, state: 'allowed' })
    expect(await pending).toEqual({ allow: true, scope: 'once' })
    expect(broker.answer(id, { allow: false, scope: 'once' })).toEqual({ ok: false, state: 'allowed' })
    expect(broker.list('project')).toEqual([])
  })
  it('solo reutiliza permisos de la misma conversación, proveedor y acción exacta', async () => {
    const broker = new PermissionBroker(() => {})
    const first = broker.ask(ctx, input, new AbortController().signal)
    broker.answer(broker.list('project')[0].id, { allow: true, scope: 'session' }); await first
    expect(broker.rules('session')).toEqual(['Bash(printf marker)'])
    expect(await broker.ask(ctx, input, new AbortController().signal)).toEqual({ allow: true, scope: 'session' })
    const other = broker.ask({ ...ctx, sessionId: 'another' }, input, new AbortController().signal)
    const altered = broker.ask(ctx, { ...input, nativeId: 0, grantKey: 'different' }, new AbortController().signal)
    expect(broker.list('project')).toHaveLength(2)
    broker.endRun('run'); await Promise.all([other, altered])
    broker.revoke(broker.listGrants('session')[0].id)
    expect(broker.listGrants('session')).toEqual([])
  })
  it('un aborto y el fin del turno caducan la tarjeta y no admiten respuestas tardías', async () => {
    const broker = new PermissionBroker(() => {}), abort = new AbortController()
    const pending = broker.ask(ctx, input, abort.signal), id = broker.list('project')[0].id
    abort.abort('cancelled')
    expect(await pending).toEqual({ allow: false, scope: 'once' })
    expect(broker.answer(id, { allow: true, scope: 'once' })).toEqual({ ok: false, state: 'cancelled' })
    const next = broker.ask(ctx, input, new AbortController().signal), nextId = broker.list('project')[0].id
    broker.endRun('run')
    await next
    expect(broker.answer(nextId, { allow: true, scope: 'once' }).state).toBe('expired')
  })
  it('una petición sin regla admitida no ofrece ni acepta un permiso de conversación', async () => {
    const broker = new PermissionBroker(() => {})
    const pending = broker.ask(ctx, { ...input, grantKey: undefined }, new AbortController().signal)
    const request = broker.list('project')[0]
    expect(request.scopes).toEqual(['once'])
    expect(() => broker.answer(request.id, { allow: true, scope: 'session' })).toThrow('decisión')
    broker.endRun('run'); await pending
  })
})

function setup(agent: AgentId, extraEnv: Record<string, string> = {}) {
  const store = memoryStore(), cwd = tmpDir(), log = join(tmpDir(), 'rpc.jsonl')
  const project = store.openProject(cwd, 'Permisos', null)
  const service = new SessionService({
    store, adapters: { claude: claudeAdapter, codex: createCodexAdapter(tmpDir()) }, push: () => {},
    resolveBin: () => resolve(__dirname, 'fixtures', agent === 'claude' ? 'fake-claude-permissions.mjs' : 'fake-codex-app-server.mjs'),
    env: () => ({ ...process.env, FAKE_CLAUDE_LOG: log, FAKE_RPC_LOG: log,
      FAKE_APPROVAL_REQUESTS: JSON.stringify([{ id: 0, method: 'item/commandExecution/requestApproval', params: { command: 'printf marker', cwd } }]), ...extraEnv }),
    defaultModel: () => undefined, uiThrottleMs: 1, cancelGraceMs: 100
  })
  services.push(service)
  const session = store.createSession(project.id, cwd, { agent, permission: agent === 'claude' ? 'manual' : 'workspace-write' })
  const messages = () => store.messages(session.id)
  const rpc = (): any[] => { try { return readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
  return { service, store, project, session, messages, rpc }
}

describe('aprobaciones dentro de los turnos del chat', () => {
  it.each(['claude', 'codex'] as const)('%s espera, guarda la tarjeta y continúa al permitir', async agent => {
    const s = setup(agent), { done } = s.service.send(s.session.id, 'Comprueba el comando')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    const request = s.service.permissions.list(s.project.id)[0]
    expect(s.messages().find(i => i.type === 'approval')).toMatchObject({ request: { state: 'pending', nativeId: agent === 'claude' ? 'permission-1' : 0 } })
    expect(s.service.isRunning(s.session.id)).toBe(true)
    s.service.permissions.answer(request.id, { allow: true, scope: 'once' })
    expect((await done).status).toBe('completed')
    expect(s.messages().find(i => i.type === 'approval')).toMatchObject({ request: { state: 'allowed' } })
  })
  it('Claude conserva stdin abierto después del resultado principal si el subagente necesita permiso', async () => {
    const s = setup('claude', { FAKE_CLAUDE_BACKGROUND: '1' })
    const { done } = s.service.send(s.session.id, 'Delega la comprobación')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    const request = s.service.permissions.list(s.project.id)[0]
    expect(request.subagent).toBe('worker-1')
    expect(s.rpc().some(r => r.stdinClosed)).toBe(false)
    s.service.permissions.answer(request.id, { allow: false, scope: 'once', message: 'No ejecutes ese comando' })
    expect((await done).status).toBe('completed')
    expect(s.rpc().find(r => r.type === 'control_response').response.response).toEqual({ behavior: 'deny', message: 'No ejecutes ese comando' })
    const usage = s.messages().filter(i => i.type === 'usage') as Extract<ChatItem, { type: 'usage' }>[]
    expect(usage).toHaveLength(1)
    expect(usage[0].usage.inputTokens).toBe(20)
  })
  it('recuerda una regla de Claude al reanudar, y otra conversación vuelve a preguntar', async () => {
    const s = setup('claude')
    const first = s.service.send(s.session.id, 'Primero')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    s.service.permissions.answer(s.service.permissions.list(s.project.id)[0].id, { allow: true, scope: 'session' })
    await first.done
    const next = s.service.send(s.session.id, 'Segundo')
    await next.done
    expect(s.rpc().filter(r => r.argv).at(-1).argv).toContain('Bash(printf AMBIDEX_PERMISSION)')
    expect(s.service.permissions.list(s.project.id)).toEqual([])
    const other = s.store.createSession(s.project.id, s.session.cwd, { agent: 'claude', permission: 'manual' })
    const third = s.service.send(other.id, 'Otra conversación')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    await s.service.cancel(other.id); await third.done
    await s.service.revokePermission(s.service.permissions.listGrants(s.session.id)[0].id)
    expect(s.service.permissions.grantCount()).toBe(0)
  })
  it.each(['claude', 'codex'] as const)('%s cancela la espera y deja una tarjeta cancelada', async agent => {
    const s = setup(agent), { done } = s.service.send(s.session.id, 'Espera')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    await s.service.cancel(s.session.id)
    expect((await done).status).toBe('cancelled')
    expect(s.messages().find(i => i.type === 'approval')).toMatchObject({ request: { state: 'cancelled' } })
  })
  it('un control_cancel_request de Claude caduca la pregunta sin enviar una respuesta tardía', async () => {
    const s = setup('claude', { FAKE_CLAUDE_CANCEL_REQUEST: '1' }), { done } = s.service.send(s.session.id, 'Espera')
    await done
    expect(s.messages().find(i => i.type === 'approval')).toMatchObject({ request: { state: 'expired' } })
    expect(s.rpc().some(r => r.type === 'control_response')).toBe(false)
  })
  it('revocar una regla detiene el proceso que podría tenerla cargada', async () => {
    const s = setup('claude'), first = s.service.send(s.session.id, 'Recuerda el permiso')
    await waitFor(() => s.service.permissions.list(s.project.id).length === 1)
    s.service.permissions.answer(s.service.permissions.list(s.project.id)[0].id, { allow: true, scope: 'session' })
    await first.done
    const grant = s.service.permissions.listGrants(s.session.id)[0]
    const next = s.service.send(s.session.id, 'Otro turno')
    expect(s.service.isRunning(s.session.id)).toBe(true)
    await s.service.revokePermission(grant.id)
    expect((await next.done).status).toBe('cancelled')
    expect(s.service.permissions.grantCount()).toBe(0)
  })
  it('Equipo conserva never y no abre tarjetas interactivas', async () => {
    const s = setup('codex')
    const team = s.store.createSession(s.project.id, s.session.cwd, { agent: 'codex', orchestrationId: 'team', permission: 'workspace-write' })
    expect((await s.service.send(team.id, 'Tarea del equipo').done).status).toBe('completed')
    expect(s.rpc().find(r => r.method === 'thread/start').params.approvalPolicy).toBe('never')
    expect(s.store.messages(team.id).some(i => i.type === 'approval')).toBe(false)
  })
  it('al recuperar un cierre caducan también las preguntas anteriores al último mensaje dirigido', () => {
    const s = setup('claude'), runId = 'interrupted-permission'
    s.store.createRun({ id: runId, sessionId: s.session.id, projectId: s.project.id, agent: 'claude', cwd: s.session.cwd, bin: '/fake', args: [], startedAt: Date.now() })
    const request: ApprovalRequest = { ...ctx, sessionId: s.session.id, projectId: s.project.id, runId, id: 'old-card', nativeId: 'old-native', kind: 'tool', title: 'Pregunta antigua', scopes: ['once'], state: 'pending', at: Date.now() }
    s.store.upsertMessage(s.session.id, 0, runId, { id: request.id, type: 'approval', request })
    s.store.upsertMessage(s.session.id, 1, runId, { id: 'steered', type: 'user', text: 'Además…', at: Date.now(), steering: true })
    expect(s.service.recoverInterrupted(() => false)).toBe(1)
    expect(s.messages().find(i => i.type === 'approval')).toMatchObject({ request: { state: 'expired' } })
    expect(s.service.permissions.answer(request.id, { allow: true, scope: 'once' })).toEqual({ ok: false, state: 'expired' })
  })
})
