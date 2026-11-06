import type { AgentLimits, ResetCreditOutcome } from '@shared/types'
import { ManagedProcess } from './runner'
import { windowLabel } from './codex'

export function parseAccountLimits(result: any, now = Date.now()): AgentLimits {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits
  const windows = [bucket?.primary, bucket?.secondary].flatMap((w) =>
    w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      ? [{ label: windowLabel(w.windowDurationMins), usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt ?? undefined }]
      : [])
  if (!windows.length) throw new Error('Codex no ha devuelto límites de uso para esta cuenta')
  const reset = result?.rateLimitResetCredits
  const resetCredits = reset && Number.isSafeInteger(reset.availableCount) && reset.availableCount >= 0 ? {
    availableCount: reset.availableCount,
    credits: Array.isArray(reset.credits) ? reset.credits.flatMap((c: any) =>
      c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id
        ? [{ id: c.id, title: typeof c.title === 'string' ? c.title : undefined, expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : undefined }]
        : []) : undefined
  } : undefined
  return { agent: 'codex', windows, plan: bucket.planType, status: bucket.rateLimitReachedType ? 'limit_reached' : 'allowed', updatedAt: now, source: 'live', resetCredits }
}

// RPC de cuenta: no crea conversaciones ni ejecuta inferencia.
function accountRequest(bin: string, cwd: string, env: NodeJS.ProcessEnv, method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void proc.cancel(500)
      if (error) reject(error)
      else resolve(result)
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
          proc.write(JSON.stringify({ id: 2, method, params }) + '\n')
        } else {
          finish(undefined, message.result)
        }
      }
    })
    const timer = setTimeout(() => finish(new Error('Codex no respondió a la consulta de uso')), 15000)
    void proc.done.then(() => finish(new Error('Se cerró la consulta de uso de Codex')))
    proc.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ambidex', title: 'Ambidex', version: '0.2.0' } } }) + '\n')
  })
}

export async function fetchAccountLimits(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<AgentLimits> {
  return parseAccountLimits(await accountRequest(bin, cwd, env, 'account/rateLimits/read'))
}

export async function consumeResetCredit(bin: string, cwd: string, env: NodeJS.ProcessEnv, idempotencyKey: string): Promise<ResetCreditOutcome> {
  if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new Error('Identificador de reinicio inválido')
  const result = await accountRequest(bin, cwd, env, 'account/rateLimitResetCredit/consume', { idempotencyKey })
  if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw new Error('Codex devolvió un resultado de reinicio desconocido; actualiza el uso antes de reintentarlo')
  return result.outcome
}
