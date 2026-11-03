import { AGENT_NAMES, AGENTS } from '@shared/types'
import { openProjectPath, pickAndOpenProject, setApp, useApp } from '../lib/app-store'
import { timeAgo } from '../lib/utils'
import logo from '../assets/logo.png'
import { AgentLogo, Icon } from './Icons'

export function Welcome() {
  const projects = useApp((s) => s.projects)
  const infos = useApp((s) => s.agentInfo)
  const loading = useApp((s) => s.agentsLoading)
  const recent = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 8)

  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo-img" src={logo} width={112} height={112} alt="Ambidex" draggable={false} />
        <h1>Ambidex</h1>
        <p className="muted">Claude Code y Codex trabajando juntos en tus proyectos, con tus cuentas.</p>
        <div className="welcome-actions">
          <button className="btn primary big" onClick={pickAndOpenProject}>
            <Icon.folderOpen size={15} /> Abrir carpeta
          </button>
          <span className="muted small">o arrastra una carpeta desde Finder</span>
          <button className="btn ghost small" onClick={() => setApp({ setupOpen: true })}>Configurar agentes</button>
        </div>

        <div className="welcome-agents">
          {AGENTS.map((a) => {
            const i = infos.find((x) => x.agent === a)
            const ok = !!i?.path && !!i.auth?.loggedIn
            return (
              <div key={a} className={`welcome-agent agent-${a}`}>
                <AgentLogo agent={a} size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <b>{AGENT_NAMES[a]}</b> <span className="muted small">{i?.version ?? ''}</span>
                  </div>
                  <div className="muted small ellipsis">
                    {!i ? (loading ? 'Comprobando…' : '—') : !i.path ? 'No instalado' : i.auth?.loggedIn ? `${i.auth.method}${i.auth.plan ? ` · plan ${i.auth.plan}` : ''}` : 'Sin sesión iniciada'}
                  </div>
                </div>
                {i && !ok && i.path && (
                  <button className="btn small primary" onClick={() => setApp({ loginAgent: a })}>
                    Iniciar sesión
                  </button>
                )}
                {i && ok && <Icon.ok size={16} className="ok" />}
              </div>
            )
          })}
        </div>

        {recent.length > 0 && (
          <div className="recents">
            <div className="menu-sep">Recientes</div>
            {recent.map((p) => (
              <button key={p.id} className="recent" disabled={!p.exists} onClick={() => openProjectPath(p.path)} title={p.path}>
                <span className="proj-avatar small" style={{ background: p.color }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <b>{p.name}</b>
                <span className="muted small ellipsis">{p.path}</span>
                <span className="muted small">{p.exists ? timeAgo(p.lastOpenedAt / 1000) : 'no encontrado'}</span>
              </button>
            ))}
          </div>
        )}
        <div className="welcome-keys muted small">
          <span><kbd>⌘O</kbd> abrir</span>
          <span><kbd>⌘K</kbd> comandos</span>
          <span><kbd>⇧⌘O</kbd> proyectos</span>
        </div>
      </div>
    </div>
  )
}
