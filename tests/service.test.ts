import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import { isAlive, ManagedProcess } from '../src/main/agents/runner'
import { ServiceDeps, SessionService } from '../src/main/agents/service'
import type { PushChannel, PushContract } from '../src/shared/ipc'
import type { AgentId } from '../src/shared/types'
import { cleanupTmp, FAKE_CLI, FIXTURES, memoryStore, tmpDir, waitFor } from './helpers'

afterEach(cleanupTmp)

function setup(env: Record<string, string>, over: Partial<ServiceDeps> = {}) {
  const store = memoryStore()
  const dir = tmpDir()
  const project = store.openProject(dir, 'demo', null)
  const pushed: { channel: PushChannel; payload: unknown }[] = []
  const finished: string[] = []
  const service = new SessionService({
    store,
    push: <K extends PushChannel>(channel: K, payload: PushContract[K]) => void pushed.push({ channel, payload }),
    adapters: { claude: claudeAdapter, codex: createCodexAdapter(tmpDir()) },
    resolveBin: () => FAKE_CLI,
    env: () => ({ ...process.env, ...env }),
    defaultModel: (a: AgentId) => (a === 'codex' ? 'gpt-6-sol' : undefined),
    onFinished: (run) => void finished.push(run.status),
    uiThrottleMs: 5,
    dbThrottleMs: 10,
    cancelGraceMs: 300,
    ...over
  })
  return { store, service, project, dir, pushed, finished }
}

describe('ManagedProcess', () => {
  it('cancelar mata también a los procesos nietos', async () => {
    const pidfile = join(tmpDir(), 'pid')
    const proc = new ManagedProcess(
      { bin: FAKE_CLI, args: [], cwd: tmpDir(), env: { ...process.env, FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile }, stdin: '' },
      { onStdout: () => {}, onStderr: () => {} }
    )
    await waitFor(() => {
      try {
        return !!readFileSync(pidfile, 'utf8')
      } catch {
        return false
      }
    })
    const grandchild = Number(readFileSync(pidfile, 'utf8'))
    expect(isAlive(grandchild)).toBe(true)
    await proc.cancel(300)
    const exit = await proc.done
    expect(exit.cancelled).toBe(true)
    await waitFor(() => !isAlive(grandchild), 3000)
  })

  it('si el proceso ignora SIGTERM se escala a SIGKILL', async () => {
    const pidfile = join(tmpDir(), 'pid')
    const proc = new ManagedProcess(
      { bin: FAKE_CLI, args: [], cwd: tmpDir(), env: { ...process.env, FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile, FAKE_STUBBORN: '1' }, stdin: '' },
      { onStdout: () => {}, onStderr: () => {} }
    )
    await waitFor(() => {
      try {
        return !!readFileSync(pidfile, 'utf8')
      } catch {
        return false
      }
    })
    const t = Date.now()
    await proc.cancel(300)
    expect((await proc.done).signal).toBe('SIGKILL')
    expect(Date.now() - t).toBeLessThan(3000)
  })

  it('informa de un binario inexistente sin lanzar excepciones', async () => {
    const proc = new ManagedProcess({ bin: '/no/existe/claude', args: [], cwd: tmpDir(), env: process.env }, { onStdout: () => {}, onStderr: () => {} })
    const exit = await proc.done
    expect(exit.spawnError).toMatch(/ENOENT/)
  })
})

describe('SessionService', () => {
  it('ejecuta un turno real de Claude (reproducido), lo persiste y lo emite a la UI', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, pushed, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_ARGS_FILE: argsFile })
    const s = store.createSession(project.id, project.path, { agent: 'claude', permission: 'plan', model: 'opus' })
    service.send(s.id, '-v Lee a.txt')
    expect(service.isRunning(s.id)).toBe(true)
    await waitFor(() => finished.length === 1)

    // el prompt va por stdin, nunca como argumento
    const call = JSON.parse(readFileSync(argsFile, 'utf8'))
    // Claude va con la entrada stream-json abierta: el texto llega dentro del mensaje JSON
    expect(JSON.parse(call.stdin).message.content[0].text).toBe('-v Lee a.txt')
    expect(call.argv).not.toContain('-v Lee a.txt')
    expect(call.argv).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--model', 'opus']))

    const items = store.messages(s.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'tool', 'assistant', 'usage'])
    expect(items[1]).toMatchObject({ type: 'tool', name: 'Read', status: 'done' })
    expect(items[2]).toMatchObject({ type: 'assistant', text: 'HOLA', streaming: false })

    const meta = store.getSession(s.id)!
    expect(meta.title).toBe('-v Lee a.txt')
    expect(meta.agentSessionId).toBe('3f1c2b4a-1111-4222-8333-944455556666')
    expect(meta.totals.turns).toBe(1)
    expect(store.recentRuns(project.id, 5)[0]).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(store.getLimits().claude?.windows[0].usedPercent).toBe(25)

    // la UI recibe los mismos elementos que se guardaron, y el estado final
    const uiItems = new Map<string, unknown>()
    for (const p of pushed) if (p.channel === 'session:items') for (const it of (p.payload as PushContract['session:items']).items) uiItems.set(it.id, it)
    expect([...uiItems.values()]).toEqual(items)
    const lastMeta = pushed.filter((p) => p.channel === 'session:meta').at(-1)!.payload as PushContract['session:meta']
    expect(lastMeta.running).toBe(false)
    expect(finished).toEqual(['completed'])
  })

  it('el segundo turno reanuda la sesión del CLI', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_ARGS_FILE: argsFile })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    service.send(s.id, 'uno')
    await waitFor(() => finished.length === 1)
    service.send(s.id, 'dos')
    await waitFor(() => finished.length === 2)
    expect(JSON.parse(readFileSync(argsFile, 'utf8')).argv).toEqual(expect.arrayContaining(['--resume', '3f1c2b4a-1111-4222-8333-944455556666']))
    expect(store.messages(s.id).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual(['uno', 'dos'])
  })

  it('usa el modelo efectivo de Codex si la conversación no fija uno', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'codex-stream.jsonl'), FAKE_ARGS_FILE: argsFile })
    const s = store.createSession(project.id, project.path, { agent: 'codex' })
    service.send(s.id, 'hola')
    await waitFor(() => finished.length === 1)
    const call = JSON.parse(readFileSync(argsFile, 'utf8'))
    expect(call.argv[0]).toBe('app-server')
    expect(call.received.find((r: any) => r.method === 'turn/start').params.model).toBe('gpt-6-sol')
    expect(store.messages(s.id).filter((i) => i.type === 'assistant').map((i) => (i as { text: string }).text)).toEqual([
      'Voy a leer a.txt y convertir su contenido a mayúsculas.',
      'HOLA'
    ])
  })

  it('compactar: solo Claude con conversación ya empezada; manda /compact y en el chat se ve como «Compactar»', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_ARGS_FILE: argsFile })
    const codex = store.createSession(project.id, project.path, { agent: 'codex' })
    expect(() => service.compact(codex.id)).toThrow(/Codex compacta solo/)
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    expect(() => service.compact(s.id)).toThrow(/nada que compactar/)
    service.send(s.id, 'uno')
    await waitFor(() => finished.length === 1)
    service.compact(s.id)
    await waitFor(() => finished.length === 2)
    const args = JSON.parse(readFileSync(argsFile, 'utf8'))
    expect(args.stdin).toBe('/compact')
    expect(args.argv).toEqual(expect.arrayContaining(['--resume', '3f1c2b4a-1111-4222-8333-944455556666']))
    expect(store.messages(s.id).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual(['uno', 'Compactar la conversación'])
  })

  it('pasa a cada agente sus variables propias (el tope de contexto de Claude Code)', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup(
      { FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_ARGS_FILE: argsFile },
      { agentEnv: (a): Record<string, string> => (a === 'claude' ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } : {}) }
    )
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    service.send(s.id, 'uno')
    await waitFor(() => finished.length === 1)
    expect(JSON.parse(readFileSync(argsFile, 'utf8')).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000')
  })

  it('no permite dos ejecuciones simultáneas en la misma conversación', async () => {
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl') })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    service.send(s.id, 'uno')
    expect(() => service.send(s.id, 'dos')).toThrow(/ya está trabajando/)
    await waitFor(() => finished.length === 1)
  })

  it('cancelar detiene el proceso, cierra el turno y marca la ejecución como cancelada', async () => {
    const pidfile = join(tmpDir(), 'pid')
    const { store, service, project, finished } = setup({ FAKE_MODE: 'hang', FAKE_PIDFILE: pidfile })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    service.send(s.id, 'tarea larga')
    await waitFor(() => store.messages(s.id).some((i) => i.type === 'assistant'))
    await service.cancel(s.id)
    await waitFor(() => finished.length === 1)
    const items = store.messages(s.id)
    expect(items.find((i) => i.type === 'assistant')).toMatchObject({ text: 'Trabajando', streaming: false })
    expect(items.at(-1)).toMatchObject({ type: 'notice', text: 'Detenido' })
    expect(store.recentRuns(project.id, 1)[0].status).toBe('cancelled')
    expect(service.isRunning(s.id)).toBe(false)
  })

  it('un fallo del CLI se muestra con su stderr útil (sin ruido)', async () => {
    const { store, service, project, finished } = setup({ FAKE_MODE: 'fail' })
    const s = store.createSession(project.id, project.path, { agent: 'codex' })
    service.send(s.id, 'x')
    await waitFor(() => finished.length === 1)
    const err = store.messages(s.id).find((i) => i.type === 'error') as { text: string }
    expect(err.text).toBe('error: algo salió mal en el CLI')
    expect(store.recentRuns(project.id, 1)[0]).toMatchObject({ status: 'failed', exitCode: 2 })
    expect(store.runLog(store.recentRuns(project.id, 1)[0].id).some((l) => l.stream === 'stderr')).toBe(true)
  })

  it('tras un cierre inesperado, marca las ejecuciones como interrumpidas y no finge que siguen vivas', async () => {
    const { store, service, project } = setup({})
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    // estado que dejaría un crash: ejecución "running" con un turno a medias
    store.createRun({ id: 'r-crash', sessionId: s.id, projectId: project.id, agent: 'claude', cwd: project.path, bin: '/bin/claude', args: [], startedAt: 1 })
    store.setRunPid('r-crash', 999999)
    store.upsertMessage(s.id, 0, 'r-crash', { id: 'u', type: 'user', text: 'hola', at: 1 })
    store.upsertMessage(s.id, 1, 'r-crash', { id: 'a', type: 'assistant', text: 'medio', streaming: true })
    store.upsertMessage(s.id, 2, 'r-crash', { id: 't', type: 'tool', toolId: 'x', name: 'Bash', input: 'npm test', status: 'running' })

    const killed: number[] = []
    expect(service.recoverInterrupted((pid) => (killed.push(pid), false))).toBe(1)
    expect(killed).toEqual([999999])
    const items = store.messages(s.id)
    expect(items[1]).toMatchObject({ streaming: false })
    expect(items[2]).toMatchObject({ status: 'error' })
    expect(items.at(-1)).toMatchObject({ type: 'notice' })
    expect(store.recentRuns(project.id, 1)[0].status).toBe('interrupted')
    expect(service.recoverInterrupted(() => false)).toBe(0)
  })
})

describe('contexto adjunto', () => {
  it('llega al agente pero no ensucia el mensaje guardado', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, 'claude-stream.jsonl'), FAKE_ARGS_FILE: argsFile })
    const s = store.createSession(project.id, project.path, { agent: 'claude' })
    service.send(s.id, 'Explica esto', '<contexto>src/a.ts líneas 1-3</contexto>')
    await waitFor(() => finished.length === 1)
    expect(JSON.parse(JSON.parse(readFileSync(argsFile, 'utf8')).stdin).message.content[0].text).toBe('Explica esto\n\n<contexto>src/a.ts líneas 1-3</contexto>')
    expect(store.messages(s.id)[0]).toMatchObject({ type: 'user', text: 'Explica esto', context: '<contexto>src/a.ts líneas 1-3</contexto>' })
  })
})


describe('entrada durante un turno', () => {
  it.each(['claude', 'codex'] as const)('%s recibe información adicional sin cancelar ni crear otra ejecución', async (agent) => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project, finished } = setup({ FAKE_FIXTURE: join(FIXTURES, `${agent}-stream.jsonl`), FAKE_ARGS_FILE: argsFile, FAKE_HOLD_MS: '300' })
    const s = store.createSession(project.id, project.path, { agent })
    const run = service.send(s.id, 'tarea larga')
    await waitFor(() => { try { return !!readFileSync(argsFile, 'utf8') } catch { return false } })
    expect(await service.steer(s.id, 'también revisa esto', '<contexto>extra</contexto>')).toBe(true)
    const result = await run.done
    expect(result.status).toBe('completed')
    expect(finished).toEqual(['completed'])
    expect(store.recentRuns(project.id, 10)).toHaveLength(1)
    expect(store.messages(s.id).filter((i) => i.type === 'user').map((i: any) => i.text)).toEqual(['tarea larga', 'también revisa esto'])
    const call = JSON.parse(readFileSync(argsFile, 'utf8'))
    if (agent === 'codex') {
      const steer = call.received.find((r: any) => r.method === 'turn/steer')
      expect(steer.params).toMatchObject({ expectedTurnId: 'fake-live-turn', input: [{ type: 'text', text: 'también revisa esto\n\n<contexto>extra</contexto>' }] })
      expect(call.received.filter((r: any) => r.method === 'turn/start')).toHaveLength(1)
      expect(call.received.some((r: any) => r.method === 'turn/interrupt')).toBe(false)
    } else expect(call.stdin.split('\n').filter(Boolean).map((line: string) => JSON.parse(line).message.content[0].text)).toEqual(['tarea larga', 'también revisa esto\n\n<contexto>extra</contexto>'])
    expect(await service.steer(s.id, 'demasiado tarde')).toBe(false)
  })

  it('acepta la entrada que llega mientras se prepara el inicio del agente', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    let release!: (value: string | null) => void
    let first = true
    const checkpoint = () => {
      if (!first) return Promise.resolve(null)
      first = false
      return new Promise<string | null>((resolve) => { release = resolve })
    }
    const { store, service, project } = setup({ FAKE_FIXTURE: join(FIXTURES, 'codex-stream.jsonl'), FAKE_ARGS_FILE: argsFile, FAKE_HOLD_MS: '300' }, { checkpoint })
    const s = store.createSession(project.id, project.path, { agent: 'codex' })
    const run = service.send(s.id, 'tarea inicial')
    expect(await service.steer(s.id, 'Claude también trabaja', undefined, undefined, true)).toBe(true)
    const extra = service.steer(s.id, 'información adicional')
    release(null)
    expect(await extra).toBe(true)
    await run.done
    const call = JSON.parse(readFileSync(argsFile, 'utf8'))
    expect(call.received.filter((r: any) => r.method === 'turn/steer').map((r: any) => r.params.input[0].text)).toEqual(['Claude también trabaja', 'información adicional'])
    expect(store.messages(s.id).filter((i) => i.type === 'user')).toHaveLength(2)
  })

  it('no guarda como enviado un mensaje que Codex rechaza', async () => {
    const argsFile = join(tmpDir(), 'args.json')
    const { store, service, project } = setup({ FAKE_FIXTURE: join(FIXTURES, 'codex-stream.jsonl'), FAKE_ARGS_FILE: argsFile, FAKE_HOLD_MS: '300', FAKE_REJECT_STEER: '1' })
    const s = store.createSession(project.id, project.path, { agent: 'codex' })
    const run = service.send(s.id, 'tarea larga')
    await waitFor(() => { try { return !!readFileSync(argsFile, 'utf8') } catch { return false } })
    expect(await service.steer(s.id, 'nuevo dato')).toBe(false)
    await run.done
    expect(store.messages(s.id).filter((i) => i.type === 'user')).toHaveLength(1)
  })
})
