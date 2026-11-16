import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApprovalRequest, ApprovalScope, ApprovalState, SessionGrant } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { api, on } from '../../lib/api'
import { toast } from '../../lib/app-store'
import { errMsg } from '../../lib/utils'
import { Icon } from '../Icons'

const STATES = { pending: 'Necesita tu permiso', allowed: 'Permitido', denied: 'Denegado', expired: 'Esta petición ya no está activa', cancelled: 'Cancelado' }

export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const card = useRef<HTMLElement>(null), grantsVersion = useRef(0)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [grants, setGrants] = useState<SessionGrant[]>([]), [showGrants, setShowGrants] = useState(false)
  const [settled, setSettled] = useState<ApprovalState | null>(null)
  const state = settled ?? request.state
  const pending = state === 'pending'
  const loadGrants = () => {
    const version = ++grantsVersion.current
    return api.permissions.grants(request.sessionId).then(list => { if (version === grantsVersion.current) setGrants(list) }).catch(() => {})
  }
  useLayoutEffect(() => {
    const element = card.current, chat = element?.closest<HTMLDivElement>('.chat')
    if (!pending || !element || !chat) return
    const reveal = () => {
      const actions = element.querySelector('.approval-actions')?.getBoundingClientRect(), viewport = chat.getBoundingClientRect()
      if (!actions || !chat.clientHeight) return
      // Desplazar solo el chat: scrollIntoView también puede mover los paneles
      // exteriores con overflow:hidden y sacar el proyecto de la ventana.
      if (actions.bottom > viewport.bottom) chat.scrollTop += actions.bottom - viewport.bottom
      else if (actions.top < viewport.top) chat.scrollTop += actions.top - viewport.top
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(chat); observer.observe(element)
    return () => observer.disconnect()
  }, [request.id, pending])
  useEffect(() => {
    void loadGrants(); setSettled(null)
    return on('perm:grantsChanged', p => { if (p.sessionId === request.sessionId) void loadGrants() })
  }, [request.sessionId, request.state])
  const answer = async (allow: boolean, scope: ApprovalScope = 'once') => {
    setBusy(true)
    try {
      const result = await api.permissions.answer(request.id, { allow, scope, ...(message.trim() ? { message: message.trim() } : {}) })
      setSettled(result.state)
      if (!result.ok) toast('Esta petición ya no está activa', 'info')
      await loadGrants()
    } catch (error) { toast(errMsg(error), 'error') }
    finally { setBusy(false) }
  }
  return <section ref={card} className={`approval-card approval-${state}`} data-approval-id={request.id} aria-label="Solicitud de permiso">
    <div className="approval-heading"><Icon.shield size={15} /><strong>{STATES[state]}</strong><span className="muted small">{AGENT_NAMES[request.agent]}</span></div>
    <div>{request.title}{request.subagent && <span className="muted small"> · subagente</span>}</div>
    {request.command && <pre className="approval-command">{request.command}</pre>}
    {request.paths?.length ? <div className="small mono approval-paths approval-files">{request.paths.join('\n')}</div> : null}
    {pending && <>
      {!!request.rules?.length && <div className="small approval-paths">Si lo recuerdas: <span className="mono">{request.rules.join(', ')}</span></div>}
      <div className="approval-actions">
        <button className="btn primary small" disabled={busy} onClick={() => answer(true)}>{request.kind === 'permissions' ? 'Permitir este turno' : 'Permitir una vez'}</button>
        <button className="btn ghost small" disabled={busy} onClick={() => answer(false)}>Denegar</button>
        {request.scopes.includes('session') && <button className="btn small approval-remember" disabled={busy} onClick={() => answer(true, 'session')}>Permitir en esta conversación</button>}
      </div>
      {request.agent === 'claude' && <input className="input" aria-label="Motivo de denegación" placeholder="Motivo al denegar (opcional)" value={message} onChange={e => setMessage(e.target.value)} disabled={busy} />}
      {request.scopes.includes('session') && <div className="muted small">Los permisos recordados se borran al cerrar Ambidex.</div>}
    </>}
    {request.cwd && <div className="muted small approval-cwd" title={request.cwd}>Carpeta: {request.cwd}</div>}
    {request.reason && <details className="small"><summary>Motivo y detalles</summary><pre className="approval-command">{request.reason}</pre></details>}
    {grants.length > 0 && <details open={showGrants} onToggle={e => setShowGrants(e.currentTarget.open)} className="approval-grants small">
      <summary>Permisos de esta conversación ({grants.length})</summary>
      {grants.map(grant => <div className="approval-grant" key={grant.id}><span className="mono approval-paths">{grant.rule}</span><button className="btn ghost small" disabled={busy} title="Revoca el permiso y detiene el agente si sigue trabajando" onClick={async () => {
        setBusy(true)
        try { await api.permissions.revoke(grant.id); await loadGrants() } catch (error) { toast(errMsg(error), 'error') } finally { setBusy(false) }
      }}>Revocar</button></div>)}
      <div className="muted">Revocar detiene el agente si está trabajando.</div>
    </details>}
  </section>
}
