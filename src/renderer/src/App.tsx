import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { initApp, openProjectPath, projectStore, useApp } from './lib/app-store'
import { handleKey, runCommand } from './lib/commands'
import { ProjectProvider } from './lib/project-store'
import { GitOutput, Picker } from './components/GitMenu'
import { Icon } from './components/Icons'
import { CommandPalette, Lightbox, LoginModal, ProjectsOverlay, Toasts } from './components/Overlays'
import { QuickOpen } from './components/QuickOpen'
import { SettingsModal, TextDialog } from './components/Settings'
import { TabBar } from './components/TabBar'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { SetupGuide } from './components/SetupGuide'

// Carpetas soltadas sobre la ventana → se abren como proyecto
function useFolderDrop() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => isFiles(e) && (depth++, setOver(true))
    const leave = (e: DragEvent) => isFiles(e) && --depth <= 0 && ((depth = 0), setOver(false))
    const overFn = (e: DragEvent) => isFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      depth = 0
      setOver(false)
      if (!isFiles(e) || e.defaultPrevented) return
      e.preventDefault()
      const items = [...(e.dataTransfer?.items ?? [])]
      items.forEach((it, i) => {
        const entry = it.webkitGetAsEntry?.()
        const file = e.dataTransfer!.files[i]
        if (entry?.isDirectory && file) openProjectPath(api.pathForFile(file))
      })
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

export default function App() {
  const ready = useApp((s) => s.ready)
  const openIds = useApp((s) => s.openIds)
  const mounted = useApp((s) => s.mounted)
  const activeId = useApp((s) => s.activeId)
  const overlay = useApp((s) => s.overlay)
  const dropping = useFolderDrop()

  useEffect(() => {
    initApp(runCommand)
    const onKey = (e: KeyboardEvent) => handleKey(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const active = projectStore(activeId)
  // el color del proyecto activo tiñe toda la ventana (línea bajo las pestañas, borde del espacio de trabajo…)
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeId))
  useEffect(() => {
    document.title = project ? `${project.name} — Ambidex` : 'Ambidex'
  }, [project?.name])

  return (
    <div className="app" style={project ? { ['--proj' as string]: project.color } : undefined}>
      <TabBar />
      <div className="workspaces">
        {mounted
          .filter((id) => openIds.includes(id))
          .map((id) => {
            const ps = projectStore(id)
            return (
              ps && (
                <ProjectProvider key={id} value={ps}>
                  <Workspace active={id === activeId} />
                </ProjectProvider>
              )
            )
          })}
        {ready && !activeId && <Welcome />}
      </div>

      {overlay === 'palette' && <CommandPalette />}
      {overlay === 'files' && active && (
        <ProjectProvider value={active}>
          <QuickOpen />
        </ProjectProvider>
      )}
      {overlay === 'projects' && <ProjectsOverlay />}
      {overlay === 'settings' && <SettingsModal />}
      <GitOutput />
      <Picker />
      <TextDialog />
      <SetupGuide />
      <LoginModal />
      <Lightbox />
      <Toasts />
      {dropping && (
        <div className="drop-overlay">
          <Icon.folderOpen size={28} />
          <span>Suelta una carpeta para abrirla como proyecto</span>
        </div>
      )}
    </div>
  )
}
