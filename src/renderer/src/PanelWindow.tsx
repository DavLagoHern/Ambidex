import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from './lib/api'
import { initPanel, useApp } from './lib/app-store'
import { DOCK_NAMES, DockPanel } from './lib/dock'
import { ProjectProvider, ProjectStore } from './lib/project-store'
import { ActivityLogPanel, AgentsPanel } from './components/ActivityPanel'
import { AgentPanel } from './components/AgentPanel'
import { BottomPanel } from './components/BottomPanel'
import { Icon } from './components/Icons'
import { Lightbox, Toasts } from './components/Overlays'

const EditorArea = lazy(() => import('./components/EditorArea').then((m) => ({ default: m.EditorArea })))

// Un panel de un proyecto en su propia ventana (p. ej. en otro monitor). Al cerrarla, vuelve a la principal.
export default function PanelWindow({ projectId, panel }: { projectId: string; panel: DockPanel }) {
  const [ps, setPs] = useState<ProjectStore | null | undefined>(null)
  const [onTop, setOnTop] = useState(false)
  const name = useApp((s) => s.projects.find((p) => p.id === projectId)?.name)

  useEffect(() => {
    initPanel(projectId).then(setPs, () => setPs(undefined))
  }, [projectId])

  useEffect(() => {
    document.title = `${DOCK_NAMES[panel]} · ${name ?? 'Ambidex'}`
  }, [name, panel])

  if (ps === undefined) return <div className="center-msg muted">Este proyecto ya no está abierto.</div>
  if (!ps) return <div className="center-msg muted">Cargando…</div>

  return (
    <ProjectProvider value={ps}>
      <div className="panelwin">
        <div className="panelwin-bar" data-tauri-drag-region="deep">
          <span className="panelwin-title">
            <b>{DOCK_NAMES[panel]}</b> <span className="muted">· {name}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            className={`icon-btn ${onTop ? 'on' : ''}`}
            title={onTop ? 'Dejar de mostrar siempre encima' : 'Mostrar siempre encima de las demás ventanas'}
            onClick={() => api.web.setOnTop(!onTop).then(() => setOnTop(!onTop))}
          >
            <Icon.pin size={13} />
          </button>
          <button className="icon-btn" title="Devolver a la ventana principal" onClick={() => window.close()}>
            <Icon.undo size={13} />
          </button>
        </div>
        <div className={`panelwin-body dock-${panel}`}>
          {panel === 'chat' && <AgentPanel />}
          {panel === 'terminal' && <BottomPanel visible />}
          {panel === 'agents' && <AgentsPanel />}
          {panel === 'activity' && <ActivityLogPanel />}
          {panel === 'editor' && (
            <Suspense fallback={<div className="center-msg muted">Cargando el editor…</div>}>
              <EditorArea />
            </Suspense>
          )}
        </div>
      </div>
      <Lightbox />
      <Toasts />
    </ProjectProvider>
  )
}
