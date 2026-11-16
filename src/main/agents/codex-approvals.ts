// Contrato del transporte de Codex. El broker de Ambidex decide qué recordar;
// este módulo solo concede la acción actual y nunca escribe reglas del CLI.
export type CodexRequestId = string | number
export type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval'

const METHODS = new Set<string>([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval'
])

export interface CodexApprovalRequest {
  id: CodexRequestId
  method: CodexApprovalMethod
  params: Record<string, unknown>
  // fileChange/requestApproval no contiene el parche: llega en item/started.
  item?: Record<string, unknown>
}

export interface CodexPermissionProfile {
  network?: { enabled?: boolean | null } | null
  fileSystem?: {
    read?: string[] | null
    write?: string[] | null
    entries?: unknown[] | null
    globScanMaxDepth?: number
  } | null
}

export interface CodexApprovalDecision {
  action: 'allow' | 'deny' | 'cancel'
  // Si se omite al permitir, se concede lo solicitado. El transporte siempre
  // limita una selección explícita al subconjunto de la solicitud original.
  permissions?: CodexPermissionProfile
}

export type CodexApprovalEnd = 'answered' | 'server-resolved' | 'turn-ended' | 'process-exited' | 'cancelled'

export interface CodexApprovalHandler {
  request(request: CodexApprovalRequest, signal: AbortSignal): Promise<CodexApprovalDecision>
  resolved?(request: CodexApprovalRequest, reason: CodexApprovalEnd): void
}

export function approvalFromCodex(request: CodexApprovalRequest, fallbackCwd: string): import('./types').NativeApproval {
  const p = request.params
  const command = typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? JSON.stringify(p.command) : undefined
  const cwd = typeof p.cwd === 'string' ? p.cwd : fallbackCwd
  const network = p.networkApprovalContext as { host?: string; protocol?: string } | undefined
  const isCommand = request.method === 'item/commandExecution/requestApproval' || request.method === 'execCommandApproval'
  const isPermissions = request.method === 'item/permissions/requestApproval'
  const paths = request.item && Array.isArray(request.item.changes)
    ? request.item.changes.map((c: any) => String(c.path ?? '')).filter(Boolean)
    : p.fileChanges && typeof p.fileChanges === 'object' ? Object.keys(p.fileChanges) : undefined
  return {
    nativeId: request.id, kind: network ? 'network' : isCommand ? 'command' : isPermissions ? 'permissions' : 'file',
    title: network ? `Acceso de red a ${network.host ?? 'un destino'}` : isCommand ? 'Ejecutar un comando' : isPermissions ? 'Permisos adicionales para este turno' : 'Cambiar archivos',
    tool: isCommand ? 'Terminal' : undefined, command, cwd, paths,
    reason: typeof p.reason === 'string' ? p.reason : isPermissions ? JSON.stringify(p.permissions, null, 2) : undefined,
    // Los cambios de archivos y las concesiones de red se revisan cada vez.
    grantKey: isCommand && command && !network && (!p.kind || p.kind === 'command')
      ? JSON.stringify(['codex', command, cwd, p.environmentId ?? null, p.additionalPermissions ?? null]) : undefined
  }
}

export function isCodexApprovalMethod(method: string): method is CodexApprovalMethod {
  return METHODS.has(method)
}

export function isCodexRequestId(id: unknown): id is CodexRequestId {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

export function isApprovalContextValid(request: CodexApprovalRequest, threadId?: string, turnId?: string): boolean {
  const p = request.params
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return typeof p.conversationId === 'string' && (!threadId || p.conversationId === threadId)
      && typeof p.callId === 'string'
  }
  return typeof p.threadId === 'string' && (!threadId || p.threadId === threadId)
    && typeof p.turnId === 'string' && (!turnId || p.turnId === turnId) && typeof p.itemId === 'string'
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

// Comparar con lo solicitado, no normalizar rutas ni ampliar prefijos.
export function grantedSubset(requested: CodexPermissionProfile, selected = requested): CodexPermissionProfile {
  const result: CodexPermissionProfile = {}
  if (requested.network?.enabled === true && selected.network?.enabled === true) result.network = { enabled: true }
  const wanted = requested.fileSystem, chosen = selected.fileSystem
  if (wanted && chosen) {
    const fs: NonNullable<CodexPermissionProfile['fileSystem']> = {}
    for (const key of ['read', 'write'] as const) {
      if (Array.isArray(wanted[key]) && Array.isArray(chosen[key])) {
        const paths = chosen[key]!.filter(p => typeof p === 'string' && wanted[key]!.includes(p))
        if (paths.length) fs[key] = [...new Set(paths)]
      }
    }
    if (Array.isArray(wanted.entries) && Array.isArray(chosen.entries)) {
      const allowed = new Set(wanted.entries.map(canonical))
      const entries = chosen.entries.filter(entry => allowed.has(canonical(entry)))
      if (entries.length) fs.entries = entries
    }
    if (Object.keys(fs).length) {
      if (Number.isInteger(wanted.globScanMaxDepth) && wanted.globScanMaxDepth === chosen.globScanMaxDepth) fs.globScanMaxDepth = wanted.globScanMaxDepth
      result.fileSystem = fs
    }
  }
  return result
}

export function codexApprovalResponse(request: CodexApprovalRequest, decision: CodexApprovalDecision): object {
  const action = decision.action
  if (request.method === 'item/permissions/requestApproval') {
    const permissions = action === 'allow'
      ? grantedSubset((request.params.permissions ?? {}) as CodexPermissionProfile, decision.permissions)
      : {}
    return { permissions, scope: 'turn' }
  }
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return { decision: action === 'allow' ? 'approved' : action === 'cancel' ? 'abort' : { denied: { rejection: 'Permiso denegado en Ambidex' } } }
  }
  return { decision: action === 'allow' ? 'accept' : action === 'cancel' ? 'cancel' : 'decline' }
}
