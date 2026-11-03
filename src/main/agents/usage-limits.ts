import type { AgentLimits } from '@shared/types'
import { ManagedProcess } from './runner'
import { windowLabel } from './codex'

export function parseAccountLimits(result: any, now = Date.now()): AgentLimits {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits
  const windows = [bucket?.primary, bucket?.secondary].flatMap((w) =>
    w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      ? [{ label: windowLabel(w.windowDurationMins), usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt ?? undefined }]
      : [])
  if (!windows.length) throw new Error('Codex no ha devuelto límites de uso para esta cuenta')
  return { agent: 'codex', windows, plan: bucket.planType, status: bucket.rateLimitReachedType ? 'limit_reached' : 'allowed', updatedAt: now, source: 'live' }
}

// Solo lee la cuenta: no crea conversaciones ni ejecuta inferencia.
export function fetchAccountLimits(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<AgentLimits> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, limits?: AgentLimits) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void proc.cancel(500)
      if (error) reject(error)
      else resolve(limits!)
    }
    const proc = new ManagedProcess({ bin, args: ['app-server'], cwd, env, keepOpen: true }, {
      onStderr: () => {},
      onStdout: (line) => {
        let message: any
        try { message = JSON.parse(line) } catch { return }
        if (message.id !== 1 && message.id !== 2) return
        if (message.error) return finish(new Error(message.error.message || 'No se pudo consultar el uso de Codex'))
        if (message.id === 1) {
          proc.write(JSON.stringify({ method: 'initialized' }) + '\n')
          proc.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }) + '\n')
        } else {
          try { finish(undefined, parseAccountLimits(message.result)) } catch (e) { finish(e as Error) }
        }
      }
    })
    const timer = setTimeout(() => finish(new Error('Codex no respondió a la consulta de uso')), 15000)
    void proc.done.then(() => finish(new Error('Se cerró la consulta de uso de Codex')))
    proc.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ambidex', title: 'Ambidex', version: '0.2.0' } } }) + '\n')
  })
}
