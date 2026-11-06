import { useLayoutEffect, useRef, useState } from 'react'
import { activate, projectStore, unsplitProjects, useApp } from '../lib/app-store'
import { ProjectProvider } from '../lib/project-store'
import { LayoutControls } from './Dock'
import { Icon } from './Icons'
import { Workspace } from './Workspace'

export function ProjectSpaces() {
  const mounted = useApp(s => s.mounted)
  const open = useApp(s => s.openIds)
  const projects = useApp(s => s.projects)
  const active = useApp(s => s.activeId)
  const split = useApp(s => s.projectSplit)
  const [ratio, setRatio] = useState(50)
  const dragging = useRef(false)
  const spaces = useRef<HTMLDivElement>(null)
  const keyboardProject = useRef<string | null>(null)
  useLayoutEffect(() => {
    const selected = spaces.current?.querySelectorAll<HTMLButtonElement>('.project-space.visible .pane-project-tab[aria-selected="true"]')
    selected?.forEach(tab => {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      if (tab.dataset.projectTab === keyboardProject.current) tab.focus()
    })
    keyboardProject.current = null
  }, [split])
  const visible: string[] = split ?? (active ? [active] : [])
  return <div ref={spaces} className={`project-spaces ${split ? 'is-split' : ''}`}>
    {mounted.filter(id => open.includes(id)).map(id => {
      const ps = projectStore(id)
      const project = projects.find(p => p.id === id)
      if (!ps || !project) return null
      const index = visible.indexOf(id)
      const tabs = open.filter(x => x === id || !split?.includes(x)).flatMap(x => {
        const tab = projects.find(p => p.id === x)
        return tab ? [tab] : []
      })
      const select = (next: string) => { activate(id); activate(next) }
      return <ProjectProvider key={id} value={ps}>
        <section className={`project-space ${index >= 0 ? 'visible' : ''} ${active === id ? 'focused' : ''}`}
          data-project-space={id} aria-label={`Proyecto ${project.name}`}
          style={{ order: index, flexBasis: split ? `${index === 0 ? ratio : 100 - ratio}%` : '100%', ['--proj' as string]: project.color }}
          onPointerDownCapture={() => activate(id)} onFocusCapture={() => activate(id)}>
          {split && <div className="project-space-head">
            <div className="pane-project-tabs" role="tablist" aria-label={`Proyectos del lado ${index === 0 ? 'izquierdo' : 'derecho'}`}
              onKeyDown={e => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                const at = tabs.findIndex(p => p.id === id)
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                keyboardProject.current = tabs[next].id
                select(tabs[next].id)
              }}>
              {tabs.map(tab => {
                return <button key={tab.id} role="tab" aria-label={tab.name} aria-selected={tab.id === id} tabIndex={tab.id === id ? 0 : -1} data-project-tab={tab.id}
                  className="pane-project-tab" style={{ ['--proj' as string]: tab.color }}
                  title={`${tab.name} · Abrir en el lado ${index === 0 ? 'izquierdo' : 'derecho'}`}
                  onClick={() => select(tab.id)}>
                  <span className="ptab-avatar" aria-hidden="true">{tab.name.slice(0, 1).toUpperCase()}</span>
                  <span className="ellipsis">{tab.name}</span>
                </button>
              })}
            </div>
            <LayoutControls />
            <button className="icon-btn" title="Ver solo este proyecto" aria-label={`Ver solo ${project.name}`} onClick={() => unsplitProjects(id)}><Icon.x size={13} /></button>
          </div>}
          <Workspace active={index >= 0} />
        </section>
      </ProjectProvider>
    })}
    {split && <div className="project-divider" role="separator" aria-label="Ancho de los proyectos" aria-orientation="vertical"
      aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} tabIndex={0} style={{ left: `${ratio}%` }}
      onPointerDown={e => { e.preventDefault(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={e => {
        if (!dragging.current) return
        const box = e.currentTarget.parentElement!.getBoundingClientRect()
        const min = Math.min(45, Math.max(20, 300 / box.width * 100))
        setRatio(Math.max(min, Math.min(100 - min, (e.clientX - box.left) / box.width * 100)))
      }}
      onPointerUp={() => { dragging.current = false }} onLostPointerCapture={() => { dragging.current = false }}
      onDoubleClick={() => setRatio(50)}
      onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        setRatio(r => e.key === 'Home' ? 20 : e.key === 'End' ? 80 : Math.max(20, Math.min(80, r + (e.key === 'ArrowRight' ? 5 : -5))))
      }} />}
  </div>
}
