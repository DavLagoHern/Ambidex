import { useEffect, useState } from 'react'
import type { AgentId } from '@shared/types'
import { AGENTS, AGENT_NAMES } from '@shared/types'
import { api } from '../lib/api'
import { refreshAgents, saveSettings, setApp, toast, useApp } from '../lib/app-store'
import { AgentLogo, Icon } from './Icons'

const INSTALL: Record<AgentId, { command: string; url: string }> = {
  claude: { command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/setup' },
  codex: { command: 'npm install -g @openai/codex', url: 'https://developers.openai.com/codex/cli/' }
}

export function SetupGuide() {
  const open = useApp((s) => s.setupOpen)
  const settings = useApp((s) => s.settings)
  const hasProjects = useApp((s) => s.projects.length > 0)
  const infos = useApp((s) => s.agentInfo)
  const loading = useApp((s) => s.agentsLoading)
  const [selected, setSelected] = useState<AgentId[]>([])
  const [touched, setTouched] = useState(false)
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelected(settings?.enabledAgents ?? [])
    setTouched(!!settings?.enabledAgents)
    setStep(0)
    refreshAgents(true)
  }, [open])
  useEffect(() => {
    if (open && !touched && !loading && infos.length) setSelected(AGENTS.filter((a) => !!infos.find((i) => i.agent === a)?.path))
  }, [open, touched, loading, infos])

  if (!open) return null
  const info = (a: AgentId) => infos.find((i) => i.agent === a)
  const available = selected.filter((a) => !!info(a)?.path)
  const toggle = (agent: AgentId) => {
    setTouched(true)
    setSelected((s) => s.includes(agent) ? s.filter((a) => a !== agent) : [...s, agent])
  }
  const finish = async (models = false) => {
    if (!available.length) return
    setSaving(true)
    try {
      await saveSettings({ setupComplete: true, enabledAgents: available, defaultAgent: available.includes(settings?.defaultAgent ?? 'claude') ? settings?.defaultAgent : available[0] })
      setApp({ setupOpen: false, ...(models ? { overlay: 'settings', settingsSection: 'models' } : {}) })
    } catch (e) {
      toast(`No se pudo guardar la configuración: ${(e as Error).message}`, 'error')
    } finally { setSaving(false) }
  }
  return (
    <div className="overlay center setup-overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-guide">
        <div className="setup-header"><span className="setup-brand">AMBIDEX <span> / CONFIGURACIÓN</span></span><span className="setup-progress">{step + 1} / 2</span></div>
        {step === 0 ? <>
          <div className="setup-intro"><div className="setup-logos"><AgentLogo agent="claude" size={28} /><AgentLogo agent="codex" size={28} /></div><h1 id="setup-title">Elige con quién<br />quieres trabajar.</h1><p>Conecta Claude Code, Codex o los dos. Puedes añadir o cambiar agentes más adelante.</p></div>
          <div className="setup-agents">
            {AGENTS.map((agent) => {
              const i = info(agent)
              const installed = !!i?.path
              return <div className={`setup-agent agent-${agent}`} key={agent}>
                <div className="setup-agent-main"><AgentLogo agent={agent} size={22} /><div className="setup-agent-name"><b>{AGENT_NAMES[agent]}</b><span>{loading && !i ? 'Comprobando…' : !installed ? 'Aún no está instalado' : i?.auth?.loggedIn ? 'Instalado · sesión iniciada' : 'Instalado · inicia sesión'}</span></div>
                  {installed && <label className="setup-select"><input type="checkbox" checked={selected.includes(agent)} onChange={() => toggle(agent)} /> Usar</label>}
                </div>
                {!installed && !loading && <div className="setup-install"><span>Abre Terminal, pega este comando y vuelve aquí:</span><div><code>{INSTALL[agent].command}</code><button className="btn small" onClick={() => navigator.clipboard.writeText(INSTALL[agent].command).then(() => toast('Comando copiado', 'success')).catch(() => toast('No se pudo copiar el comando', 'error'))}>Copiar</button></div><button className="setup-link" onClick={() => api.openExternal(INSTALL[agent].url)}>Ver instrucciones oficiales ↗</button></div>}
                {installed && !i?.auth?.loggedIn && <button className="btn small" onClick={() => setApp({ loginAgent: agent })}><Icon.login size={13} /> Iniciar sesión</button>}
              </div>
            })}
          </div>
          <div className="setup-footer">{(settings?.setupComplete || hasProjects) && <button className="btn ghost" onClick={() => setApp({ setupOpen: false })}>Cancelar</button>}<button className="btn ghost" disabled={loading} onClick={() => refreshAgents(true)}><Icon.refresh size={13} className={loading ? 'spin' : ''} /> Volver a comprobar</button><span /> <button className="btn primary" disabled={!available.length || loading} onClick={() => setStep(1)}>Continuar <Icon.forward size={14} /></button></div>
        </> : <>
          <div className="setup-intro"><div className="setup-eyebrow">CASI LISTO</div><h1 id="setup-title">Tu espacio,<br />a tu manera.</h1><p>{available.length === 2 ? 'Tendrás un chat con cada agente y la opción de trabajar con ambos.' : `La interfaz se adaptará para trabajar con ${AGENT_NAMES[available[0]]}.`}</p></div>
          <div className="setup-summary"><div><Icon.cpu size={18} /><span><b>Modelos y razonamiento</b><small>Revisa los modelos disponibles y sus opciones en Ajustes.</small></span></div><div><Icon.folderOpen size={18} /><span><b>Abre tu primer proyecto</b><small>Elige una carpeta y empieza una conversación.</small></span></div></div>
          <div className="setup-footer"><button className="btn ghost" onClick={() => setStep(0)}>Atrás</button><span /><button className="btn" disabled={saving} onClick={() => finish(true)}>Ver modelos</button><button className="btn primary" disabled={saving} onClick={() => finish()}>Empezar</button></div>
        </>}
      </div>
    </div>
  )
}
