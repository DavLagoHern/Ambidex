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
  const close = useRef<HTMLButtonElement>(null)
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
    void refresh()
    return () => { document.removeEventListener('keydown', key, true); previous?.focus() }
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
              const expired = !!w.resetsAt && w.resetsAt * 1000 <= Date.now()
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
          </section>
        })}
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions"><span className="small muted" role="status">{loading ? 'Consultando el uso de Codex…' : 'Claude se actualiza con sus ejecuciones'}</span><button className="btn small" disabled={loading} onClick={refresh}>Actualizar</button></div>
      </section>
    </div>, document.body)
}
