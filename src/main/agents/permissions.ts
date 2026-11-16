import { randomUUID } from 'crypto'
import type { AgentId, ApprovalDecision, ApprovalRequest, ApprovalState, SessionGrant } from '@shared/types'
import type { NativeApproval } from './types'

interface Context { runId: string; sessionId: string; projectId: string; agent: AgentId }
interface Pending {
  request: ApprovalRequest; input: NativeApproval; signal: AbortSignal
  resolve: (decision: ApprovalDecision) => void; detach: () => void
}
interface Grant extends SessionGrant { key: string; claudeRules: string[]; projectId: string }

export class PermissionBroker {
  private pending = new Map<string, Pending>()
  private grants = new Map<string, Grant>()
  private states = new Map<string, ApprovalState>()
  constructor(private changed: (request: ApprovalRequest) => void) {}
  grantCount() { return this.grants.size }

  list(projectId: string) { return [...this.pending.values()].map(p => p.request).filter(r => r.projectId === projectId) }
  listGrants(sessionId: string): SessionGrant[] {
    return [...this.grants.values()].filter(g => g.sessionId === sessionId).map(g => ({ id: g.id, sessionId: g.sessionId, agent: g.agent, title: g.title, rule: g.rule, at: g.at }))
  }
  getGrant(id: string) { return this.grants.get(id) }
  revoke(id: string) { this.grants.delete(id) }
  forgetSession(sessionId: string) { for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id) }
  forgetProject(projectId: string) { for (const [id, grant] of this.grants) if (grant.projectId === projectId) this.grants.delete(id) }
  rules(sessionId: string): string[] {
    return [...new Set([...this.grants.values()].filter(g => g.sessionId === sessionId && g.agent === 'claude').flatMap(g => g.claudeRules))]
  }

  ask(ctx: Context, input: NativeApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ allow: false, scope: 'once' })
    const request: ApprovalRequest = {
      ...ctx, nativeId: input.nativeId, kind: input.kind, title: input.title,
      tool: input.tool, command: input.command, cwd: input.cwd, paths: input.paths, reason: input.reason, subagent: input.subagent,
      id: randomUUID(), scopes: input.grantKey ? ['once', 'session'] : ['once'], state: 'pending', at: Date.now(), rules: input.claudeRules
    }
    const grant = input.grantKey && [...this.grants.values()].find(g => g.sessionId === ctx.sessionId && g.agent === ctx.agent && g.key === input.grantKey)
    if (grant) {
      this.publish({ ...request, state: 'allowed', decision: { allow: true, scope: 'session', by: 'grant', at: Date.now() } })
      return Promise.resolve({ allow: true, scope: 'session' })
    }
    return new Promise(resolve => {
      const abort = () => this.close(request.id, signal.reason === 'cancelled' ? 'cancelled' : 'expired')
      this.pending.set(request.id, { request, input, signal, resolve, detach: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
      this.publish(request)
      if (signal.aborted) abort()
    })
  }

  answer(id: string, decision: ApprovalDecision): { ok: boolean; state: ApprovalState } {
    const pending = this.pending.get(id)
    if (!pending) return { ok: false, state: this.states.get(id) ?? 'expired' }
    if (pending.signal.aborted) { this.close(id, 'expired'); return { ok: false, state: 'expired' } }
    if (typeof decision?.allow !== 'boolean' || !pending.request.scopes.includes(decision.scope)) throw new Error('La decisión de permiso no es válida')
    const normalized: ApprovalDecision = { allow: decision.allow, scope: decision.allow ? decision.scope : 'once', ...(decision.message ? { message: String(decision.message).slice(0, 2000) } : {}) }
    this.pending.delete(id); pending.detach()
    if (normalized.allow && normalized.scope === 'session' && pending.input.grantKey) {
      const grant: Grant = {
        id: randomUUID(), sessionId: pending.request.sessionId, agent: pending.request.agent, projectId: pending.request.projectId,
        title: pending.request.title, rule: pending.input.claudeRules?.length ? pending.input.claudeRules.join(', ') : pending.request.command ?? pending.request.title, at: Date.now(),
        key: pending.input.grantKey, claudeRules: pending.input.claudeRules ?? []
      }
      this.grants.set(grant.id, grant)
    }
    const state = normalized.allow ? 'allowed' : 'denied'
    this.publish({ ...pending.request, state, decision: { ...normalized, by: 'user', at: Date.now() } })
    pending.resolve(normalized)
    return { ok: true, state }
  }

  endRun(runId: string, state: 'expired' | 'cancelled' = 'expired') {
    for (const [id, p] of this.pending) if (p.request.runId === runId) this.close(id, state)
  }
  private close(id: string, state: 'expired' | 'cancelled') {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id); p.detach(); this.publish({ ...p.request, state })
    p.resolve({ allow: false, scope: 'once' })
  }
  private publish(request: ApprovalRequest) {
    this.states.set(request.id, request.state)
    // El historial completo vive en SQLite; aquí basta conservar decisiones recientes.
    if (this.states.size > 2000) this.states.delete(this.states.keys().next().value!)
    this.changed(request)
  }
}
