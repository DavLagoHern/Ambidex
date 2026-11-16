import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexLiveProcess } from '../src/main/agents/codex-live'
import { createCodexAdapter } from '../src/main/agents/codex'
import {
  codexApprovalResponse, grantedSubset,
  type CodexApprovalDecision, type CodexApprovalHandler, type CodexApprovalMethod, type CodexApprovalRequest
} from '../src/main/agents/codex-approvals'
import type { RunRequest } from '../src/main/agents/types'
import { cleanupTmp, tmpDir, waitFor } from './helpers'

const fixture = resolve(__dirname, 'fixtures/fake-codex-app-server.mjs')
const processes: CodexLiveProcess[] = []
afterEach(async () => { await Promise.all(processes.splice(0).map(p => p.cancel(100))); cleanupTmp() })

function setup(requests: object[], handler?: CodexApprovalHandler, overrides: Partial<RunRequest> = {}, env: Record<string, string> = {}) {
  const dir = tmpDir(), file = join(dir, 'rpc.jsonl'), output: any[] = []
  const proc = new CodexLiveProcess(
    { bin: process.execPath, args: [fixture], cwd: dir, env: { ...process.env, FAKE_RPC_LOG: file, FAKE_APPROVAL_REQUESTS: JSON.stringify(requests), ...env }, stdin: 'Prueba' },
    { cwd: dir, permission: 'workspace-write', ...overrides },
    { onStdout: line => output.push(JSON.parse(line)), onStderr: () => {} }, handler
  )
  processes.push(proc)
  const rpc = (): any[] => { try { return readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
  return { proc, rpc, output }
}

const methods: CodexApprovalMethod[] = [
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval'
]
const allowedReplies: Record<CodexApprovalMethod, object> = {
  'item/commandExecution/requestApproval': { decision: 'accept' },
  'item/fileChange/requestApproval': { decision: 'accept' },
  'item/permissions/requestApproval': { permissions: { network: { enabled: true } }, scope: 'turn' },
  execCommandApproval: { decision: 'approved' },
  applyPatchApproval: { decision: 'approved' }
}

describe('aprobaciones de Codex (protocolo app-server)', () => {
  it.each(methods)('contesta %s con su forma exacta y mantiene el id', async method => {
    const seen: CodexApprovalRequest[] = []
    const { proc, rpc } = setup([{ id: 'rpc-0', method, params: { permissions: { network: { enabled: true }, fileSystem: null } } }], {
      request: async r => { seen.push(r); return { action: 'allow' } }
    })
    expect((await proc.done).code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(rpc().find(r => r.id === 'rpc-0' && !r.method)?.result).toEqual(allowedReplies[method])
    expect(rpc().find(r => r.method === 'thread/start').params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  })

  it.each(methods)('sin host deniega %s sin enviar una forma de respuesta ajena', async method => {
    const { proc, rpc } = setup([{ id: 0, method }])
    await proc.done
    const reply = rpc().find(r => r.id === 0 && !r.method)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual(method === 'item/permissions/requestApproval'
      ? { permissions: {}, scope: 'turn' }
      : { decision: ['execCommandApproval', 'applyPatchApproval'].includes(method) ? { denied: { rejection: 'Permiso denegado en Ambidex' } } : 'decline' })
    expect(rpc().find(r => r.method === 'thread/start').params.approvalPolicy).toBe('never')
  })

  it('distingue 0 de "0" y permite resolver solicitudes simultáneas fuera de orden', async () => {
    const answers = new Map<string | number, (d: CodexApprovalDecision) => void>()
    const { proc, rpc } = setup([0, '0'].map(id => ({ id, method: methods[0] })), {
      request: r => new Promise(resolve => answers.set(r.id, resolve))
    })
    await waitFor(() => answers.size === 2)
    answers.get('0')!({ action: 'deny' }); answers.get(0)!({ action: 'allow' })
    await proc.done
    expect(rpc().filter(r => r.result?.decision).map(r => [r.id, r.result.decision])).toEqual([['0', 'decline'], [0, 'accept']])
  })

  it.each(['resolved', 'turn-ended', 'process-exited'] as const)('caduca una espera con %s e ignora su respuesta tardía', async end => {
    let answer!: (d: CodexApprovalDecision) => void
    let signal!: AbortSignal
    const expired: string[] = []
    const { proc, rpc } = setup([{ id: 'late', method: methods[0] }], {
      request: (_r, s) => { signal = s; return new Promise(resolve => { answer = resolve }) },
      resolved: (_r, reason) => { expired.push(reason) }
    }, {}, { FAKE_APPROVAL_END: end })
    const exit = await proc.done
    expect(exit.code).toBe(end === 'process-exited' ? 1 : 0)
    expect(signal?.aborted).toBe(true)
    answer({ action: 'allow' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(rpc().some(r => r.id === 'late' && !r.method)).toBe(false)
    expect(expired).toEqual([end === 'resolved' ? 'server-resolved' : end === 'turn-ended' ? 'turn-ended' : 'process-exited'])
  })

  it('cancelar el proceso caduca la aprobación y cancela la espera del broker', async () => {
    let signal!: AbortSignal
    const { proc } = setup([{ id: 5, method: methods[0] }], {
      request: (_r, s) => { signal = s; return new Promise(() => {}) }
    })
    await waitFor(() => !!signal)
    await proc.cancel(100)
    expect(signal.aborted).toBe(true)
    expect((await proc.done).cancelled).toBe(true)
  })

  it('cancelar permisos responde sin concesiones e interrumpe el turno', async () => {
    const { proc, rpc, output } = setup([{ id: 'permissions', method: methods[2] }], { request: async () => ({ action: 'cancel' }) })
    expect((await proc.done).cancelled).toBe(true)
    expect(rpc().find(r => r.id === 'permissions' && !r.method).result).toEqual({ permissions: {}, scope: 'turn' })
    expect(rpc().some(r => r.method === 'turn/interrupt')).toBe(true)
    expect(output.some(r => r.type === 'turn.failed')).toBe(false)
  })

  it.each(['immediate', 'late'])('una solicitud duplicada (%s) no abre otra tarjeta ni escribe dos respuestas', async mode => {
    let count = 0
    const { proc, rpc } = setup([{ id: 'duplicate', method: methods[0] }], {
      request: async () => { count++; return { action: 'allow' } }
    }, {}, { FAKE_APPROVAL_DUPLICATE: mode })
    await proc.done
    expect(count).toBe(1)
    expect(rpc().filter(r => r.id === 'duplicate' && !r.method)).toHaveLength(1)
  })

  it('no presenta solicitudes pertenecientes a otro hilo o turno', async () => {
    let count = 0
    const { proc, rpc } = setup([
      { id: 'thread', method: methods[0], params: { threadId: 'otro' } },
      { id: 'turn', method: methods[0], params: { turnId: 'otro' } }
    ], { request: async () => { count++; return { action: 'allow' } } })
    await proc.done
    expect(count).toBe(0)
    expect(rpc().filter(r => r.result?.decision === 'decline')).toHaveLength(2)
  })

  it('entrega al broker el parche de item/started', async () => {
    const item = { id: 'item-test', type: 'fileChange', changes: [{ path: 'a.ts', diff: '+nuevo' }] }
    let seen: CodexApprovalRequest | undefined
    const { proc } = setup([{ id: 'patch', method: methods[1], item }], { request: async r => { seen = r; return { action: 'deny' } } })
    await proc.done
    expect(seen?.item).toEqual(item)
  })

  it.each([{ permission: 'danger-full-access' }, { schema: { json: '{}', file: '/schema.json' } }] as Partial<RunRequest>[])('mantiene never para acceso total o salida estructurada (%j)', async override => {
    let count = 0
    const { proc, rpc } = setup([], { request: async () => { count++; return { action: 'allow' } } }, override)
    await proc.done
    expect(rpc().find(r => r.method === 'thread/start').params.approvalPolicy).toBe('never')
    expect(count).toBe(0)
  })

  it('un fallo del broker deniega y permite terminar el turno', async () => {
    const { proc, rpc, output } = setup([{ id: 'failure', method: methods[0] }], { request: async () => { throw new Error('UI cerrada') } })
    expect((await proc.done).code).toBe(0)
    expect(rpc().find(r => r.id === 'failure' && !r.method).result).toEqual({ decision: 'decline' })
    const parser = createCodexAdapter(tmpDir()).createParser()
    expect(output.flatMap(item => parser.onLine(JSON.stringify(item)))).toContainEqual({ kind: 'notice', text: 'No se pudo contestar el permiso; se ha denegado la acción.' })
  })
})

describe('permisos concedidos', () => {
  it('no concede rutas, entradas ni red que no se pidieron', () => {
    const entry = { access: 'write', path: { type: 'path', path: '/project/a' } }
    expect(grantedSubset({ fileSystem: { write: ['/project/a'], entries: [entry] } }, {
      network: { enabled: true }, fileSystem: { write: ['/project/a', '/'], entries: [entry, { access: 'write', path: { type: 'path', path: '/' } }] }
    })).toEqual({ fileSystem: { write: ['/project/a'], entries: [entry] } })
  })
  it('omite las concesiones nulas y nunca genera reglas persistentes', () => {
    expect(grantedSubset({ network: null, fileSystem: null })).toEqual({})
    expect(codexApprovalResponse({ id: 1, method: methods[0], params: {} }, { action: 'allow' })).toEqual({ decision: 'accept' })
  })
})
