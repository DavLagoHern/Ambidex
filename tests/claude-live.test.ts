import { resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeLiveProcess } from '../src/main/agents/claude-live'
import { isAlive } from '../src/main/agents/runner'
import { cleanupTmp, tmpDir } from './helpers'

const active: ClaudeLiveProcess[] = []
afterEach(async () => { await Promise.all(active.splice(0).map(p => p.cancel(50))); cleanupTmp() })

function run(mode: string) {
  const cwd = tmpDir(), output: any[] = []
  const process = new ClaudeLiveProcess({
    bin: globalThis.process.execPath, args: [resolve(__dirname, 'fixtures/fake-claude-lifecycle.mjs')], cwd,
    env: { ...globalThis.process.env, FAKE_LIFECYCLE_MODE: mode }, stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Comprueba' } }) + '\n'
  }, { cwd }, { onStdout: line => output.push(JSON.parse(line)), onStderr: () => {} }, { exitGraceMs: 150, killGraceMs: 50 })
  active.push(process)
  return { process, output }
}

describe('finalización de Claude por stdio', () => {
  it.each(['foreground', 'foreground-without-notification', 'completed-task', 'failed-task', 'stopped-task'])('%s libera stdin y entrega el último resultado una sola vez', async mode => {
    const { process, output } = run(mode)
    const exit = await process.done
    expect(exit).toMatchObject({ code: 0, cancelled: false })
    expect(output.filter(o => o.type === 'result')).toEqual([expect.objectContaining({ usage: { input_tokens: 20 } })])
    expect(process.inputOpen).toBe(false)
    expect(isAlive(process.pid!)).toBe(false)
  })
  it('termina un CLI que ignora EOF y SIGTERM después del resultado confirmado', async () => {
    const { process, output } = run('ignore-eof')
    const exit = await process.done
    expect(exit).toMatchObject({ code: 0, signal: null, cancelled: false })
    expect(output.filter(o => o.type === 'result')).toEqual([expect.objectContaining({ usage: { input_tokens: 10 } })])
    expect(isAlive(process.pid!)).toBe(false)
  })
})
