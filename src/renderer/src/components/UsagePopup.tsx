import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AGENTS, AGENT_NAMES } from '@shared/types'
import { api } from '../lib/api'
import { setApp, useApp } from '../lib/app-store'
import { untilText } from '../lib/utils'
import { AgentLogo, Icon } from './Icons'

export function UsagePopup({ onClose }: { onClose: () => void }) {
  const limits = useApp((s) => s.limits)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resetting, setResetting] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())
  const close = useRef<HTMLButtonElement>(null)
  const reset = async () => {
    setResetting(true)
    setError('')
    setNotice('')
    try {
      // Reutilizar incluso tras cerrar el popup o reiniciar evita un doble canje al reintentar.
      const key = localStorage.getItem('codex-reset-attempt') || crypto.randomUUID()
      localStorage.setItem('codex-reset-attempt', key)
      const outcome = await api.resetCredit(key)
      if (!outcome) return
      localStorage.removeItem('codex-reset-attempt')
      setNotice({
        reset: 'Reinicio aplicado. Se ha solicitado una nueva lectura del uso.',
        alreadyRedeemed: 'Este reinicio ya se había aplicado. Se ha solicitado una nueva lectura del uso.',
        nothingToReset: 'Codex indica que no hay ninguna ventana que pueda reiniciarse.',
        noCredit: 'Codex indica que ya no quedan reinicios disponibles.'
      }[outcome])
      setApp({ limits: await api.agentLimits() })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setResetting(false) }
  }
  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const values = await api.agentLimits(true)
      setApp({ limits: values })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'Tab') {
        const buttons = close.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    const ticker = setInterval(() => setNow(Date.now()), 30_000)
    void refresh()
    return () => { clearInterval(ticker); document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [])
  return createPortal(
    <div className="overlay center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="modal usage-popup" role="dialog" aria-modal="true" aria-labelledby="usage-title">
        <div className="row gap usage-popup-head">
          <h3 id="usage-title">Uso de los planes</h3>
          <button ref={close} className="icon-btn" onClick={onClose} aria-label="Cerrar"><Icon.x size={16} /></button>
        </div>
        <p className="muted small">Porcentaje consumido de tu plan en cada ventana. Incluye el uso de la cuenta fuera de Ambidex. No es un importe facturado.</p>
        {AGENTS.map((agent) => {
          const data = limits[agent]
          return <section key={agent} className="usage-agent">
            <div className="row gap"><AgentLogo agent={agent} size={16} /><b>{AGENT_NAMES[agent]}</b>{data?.plan && <span className="badge">{data.plan}</span>}</div>
            {data?.windows.length ? data.windows.map((w) => {
              const expired = !!w.resetsAt && w.resetsAt * 1000 <= now
              return <div className="usage-window" key={w.label}>
                <div className="row gap"><span>{w.label}</span><b>{w.usedPercent}% consumido</b><span className="muted small">{Math.max(0, 100 - w.usedPercent)}% disponible</span></div>
                <div className="meter"><span className={`meter-fill ${w.usedPercent >= 85 ? 'hot' : w.usedPercent >= 60 ? 'warm' : ''}`} style={{ width: `${Math.max(0, Math.min(100, w.usedPercent))}%` }} /></div>
                <div className="small muted">{w.resetsAt ? expired ? 'Ventana vencida; pendiente de una nueva lectura' : `Se reinicia en ${untilText(w.resetsAt)} · ${new Date(w.resetsAt * 1000).toLocaleString()}` : 'Reinicio no comunicado'}</div>
              </div>
            }) : <p className="small muted">Sin datos de uso disponibles.</p>}
            <p className="small muted usage-source">
              {agent === 'claude' ? 'Fuente: eventos de Claude Code. Se actualiza al ejecutar Claude.' : data?.source === 'live' ? 'Fuente: consulta directa a la cuenta de Codex.' : 'Fuente: última lectura guardada de Codex; puede estar desactualizada.'}
              {!!data?.updatedAt && <> Última lectura: {new Date(data.updatedAt).toLocaleString()}.</>}
            </p>
            {data?.refreshError && <p className="small" role="status">No se pudo actualizar: {data.refreshError}. Se conserva la última lectura disponible.</p>}
            {agent === 'codex' && <div className="usage-resets">
              <div className="row gap"><b className="small">Reinicios de cuota</b><span className="badge">{data?.resetCredits ? `${data.resetCredits.availableCount} ${data.resetCredits.availableCount === 1 ? 'disponible' : 'disponibles'}` : 'No comunicados'}</span></div>
              {data?.resetCredits ? <>
                <p className="small muted">Puedes canjear un reinicio concedido por Codex. La ventana que se reinicia la determina tu cuenta.</p>
                {data.resetCredits.credits?.map(c => <div key={c.id} className="small muted">{c.title || 'Reinicio de cuota'}{c.expiresAt ? ` · Caduca el ${new Date(c.expiresAt * 1000).toLocaleString()}` : ''}</div>)}
                <button className="btn small" disabled={loading || resetting || !!data.refreshError || !data.resetCredits.availableCount} onClick={reset}>{resetting ? 'Aplicando…' : 'Usar un reinicio'}</button>
              </> : <p className="small muted">La cuenta o esta versión de Codex no ha comunicado reinicios canjeables.</p>}
            </div>}
            {agent === 'claude' && <div className="usage-resets"><b className="small">Reinicios de cuota</b><p className="small muted">Si tu cuenta tiene un reinicio gratuito, Claude permite canjearlo desde Ajustes → Uso en su web o app de escritorio.</p><button className="btn small" onClick={() => { void api.openExternal('https://claude.ai/settings/usage') }}>Abrir uso de Claude</button></div>}
          </section>
        })}
        {error && <p role="alert">{error}</p>}
        {notice && <p className="small" role="status">{notice}</p>}
        <div className="modal-actions"><span className="small muted" role="status">{loading ? 'Consultando el uso de Codex…' : 'Codex: cada 30 min y al terminar cada respuesta. Claude: con sus ejecuciones.'}</span><button className="btn small" disabled={loading || resetting} onClick={refresh}>Actualizar</button></div>
      </section>
    </div>, document.body)
}
