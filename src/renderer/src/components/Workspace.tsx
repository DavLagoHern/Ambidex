import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { AgentId, AgentLimits, DevScript } from '@shared/types'
import { AGENT_NAMES, AGENTS } from '@shared/types'
import { api } from '../lib/api'
import { setApp, toast, useApp } from '../lib/app-store'
import { SidebarView, usePS, useStore } from '../lib/project-store'
import { basename, untilText } from '../lib/utils'
import { ActivityLogPanel, AgentsPanel } from './ActivityPanel'
import { AgentPanel } from './AgentPanel'
import { BottomPanel } from './BottomPanel'
import { insertIntoComposer } from './chat/parts'
import { ChatsPanel } from './ChatsPanel'
import { Dock } from './Dock'
import { Explorer } from './Explorer'
import { GitPanel } from './GitPanel'
import { HistoryPanel } from './HistoryPanel'
import { AgentLogo, Icon, IconName } from './Icons'
import { SearchPanel } from './SearchPanel'
import { WebModel, WebPanel } from './WebPanel'

// El editor (Monaco) solo se carga cuando se abre el primer fichero, diff o commit
const EditorArea = lazy(() => import('./EditorArea').then((m) => ({ default: m.EditorArea })))

const VIEWS: { id: SidebarView; icon: IconName; title: string }[] = [
  { id: 'chats', icon: 'chat', title: 'Conversaciones (⇧⌘C)' },
  { id: 'explorer', icon: 'files', title: 'Explorador (⇧⌘E)' },
  { id: 'git', icon: 'git', title: 'Control de código (⇧⌘G)' },
  { id: 'history', icon: 'history', title: 'Historial (⇧⌘H)' },
  { id: 'search', icon: 'search', title: 'Buscar (⇧⌘F)' }
]

function ActivityBar() {
  const ps = usePS()
  const sidebar = useStore((s) => s.sidebar)
  const open = useStore((s) => s.panels.sidebar)
  const changes = useApp((s) => s.changes[ps.id] ?? 0)
  const running = useStore((s) => Object.values(s.sessions).some((x) => x.running))
  return (
    <div className="activitybar">
      {VIEWS.map((v) => {
        const I = Icon[v.icon]
        const on = open && sidebar === v.id
        return (
          <button
            key={v.id}
            className={`ab-btn ${on ? 'on' : ''}`}
            title={v.title}
            onClick={() => (on ? ps.togglePanel('sidebar', false) : ps.set((s) => ({ sidebar: v.id, panels: { ...s.panels, sidebar: true } })))}
          >
            <I size={18} />
            {v.id === 'git' && changes > 0 && <span className="ab-badge">{changes > 99 ? '99+' : changes}</span>}
            {v.id === 'chats' && running && <span className="ab-dot" />}
          </button>
        )
      })}
    </div>
  )
}

function LimitMini({ agent, limits }: { agent: AgentId; limits?: AgentLimits }) {
  if (!limits?.windows.length) return null
  return (
    <span className="limit-mini" title={limits.windows.map((w) => `${w.label}: ${w.usedPercent}%${w.resetsAt ? ` · se reinicia en ${untilText(w.resetsAt)}` : ''}`).join('\n')}>
      <AgentLogo agent={agent} size={11} />
      {limits.windows.slice(0, 2).map((w) => (
        <span key={w.label} className="limit-mini-item">
          <span className="muted">{w.label}</span>
          <span className="meter">
            <span className={`meter-fill ${w.usedPercent >= 85 ? 'hot' : w.usedPercent >= 60 ? 'warm' : ''}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
          </span>
          <span className="tabular">{w.usedPercent}%</span>
        </span>
      ))}
    </span>
  )
}

function StatusBar() {
  const ps = usePS()
  const ws = useStore((s) => s.workspace)
  const root = useStore((s) => s.meta.path)
  const git = useStore((s) => s.git)
  const repos = useStore((s) => s.repos.length)
  const changes = useApp((s) => s.changes[ps.id] ?? 0)
  const limits = useApp((s) => s.limits)
  const runningKey = useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.running)
      .map((x) => x.agent)
      .join(',')
  )
  const running = runningKey ? (runningKey.split(',') as AgentId[]) : []
  return (
    <div className="statusbar">
      <button className="sb-item" onClick={() => ps.set((s) => ({ sidebar: 'git', panels: { ...s.panels, sidebar: true } }))} title={ws}>
        {ws !== root ? <Icon.layers size={12} /> : <Icon.folder size={12} />} {basename(ws)}
      </button>
      {git?.isRepo && (
        <button className="sb-item" onClick={() => ps.set((s) => ({ sidebar: 'git', panels: { ...s.panels, sidebar: true } }))}>
          <Icon.branch size={12} /> {git.branch}
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="muted">
              {git.behind > 0 && ` ${git.behind}↓`}
              {git.ahead > 0 && ` ${git.ahead}↑`}
            </span>
          )}
          {changes > 0 && <span className="sb-changes">● {changes}</span>}
          {repos > 1 && <span className="muted"> · {repos} repos</span>}
        </button>
      )}
      <span style={{ flex: 1 }} />
      {running.length > 0 && (
        <span className="sb-item">
          {running.map((a, i) => (
            <span key={i} className={`pulse small agent-${a}`} />
          ))}{' '}
          {running.length === 1 ? `${AGENT_NAMES[running[0]]} trabajando` : `${running.length} agentes trabajando`}
        </span>
      )}
      <button className="sb-item" onClick={() => setApp({ overlay: 'settings', settingsSection: 'agents' })} title="Uso de los planes (ventanas de límite)">
        {AGENTS.map((a) => (
          <LimitMini key={a} agent={a} limits={limits[a]} />
        ))}
        {!limits.claude && !limits.codex && <span className="muted">Los límites de uso aparecerán tras el primer mensaje</span>}
      </button>
    </div>
  )
}

// El visor web del proyecto: sus pestañas viven en el estado del proyecto y se restauran al reabrir
function ProjectWeb() {
  const ps = usePS()
  const web = useStore((s) => s.web)
  const model = useMemo<WebModel>(
    () => ({
      tabs: web.tabs,
      active: web.active,
      select: (id) => ps.selectWebTab(id),
      add: (url) => ps.addWebTab(url),
      close: (id) => ps.closeWebTab(id),
      update: (id, patch) => ps.updateWebTab(id, patch)
    }),
    [web, ps]
  )
  return (
    <WebPanel
      model={model}
      onHide={() => ps.toggleWeb()}
      extra={<DevServerButtons />}
      onActiveContents={(id) => api.web.active(ps.id, id).catch(() => {})}
      banner={<AgentWebBanner />}
      onToChat={(payload) => insertIntoComposer(ps.id, payload) || toast('Abre el chat del proyecto para enviarlo', 'error')}
    />
  )
}

// Mientras un agente usa la Web del proyecto: quién, qué está haciendo y cómo quitarle el control
function AgentWebBanner() {
  const ps = usePS()
  const a = useStore((s) => s.webAgent)
  const [, tick] = useState(0)
  const fresh = !!a && Date.now() - a.at < 8000
  useEffect(() => {
    if (!fresh) return
    const t = setTimeout(() => tick((n) => n + 1), 8000 - (Date.now() - a!.at))
    return () => clearTimeout(t)
  }, [a?.at])
  if (!a || !fresh) return null
  return (
    <div className={`web-agent agent-${a.agent}`}>
      <AgentLogo agent={a.agent} size={13} />
      <span className="ellipsis">
        <b>{AGENT_NAMES[a.agent]}</b> está usando esta pestaña · {a.action}
      </span>
      <span style={{ flex: 1 }} />
      <button
        className="btn small"
        title="El agente ya no podrá usar la Web hasta tu próximo mensaje"
        onClick={() => (api.web.revokeAgent(ps.id).catch(() => {}), ps.set({ webAgent: null }), toast('Control de la Web retirado al agente'))}
      >
        Quitar el control
      </button>
    </div>
  )
}

// En la página en blanco del visor: arrancar el servidor de desarrollo del proyecto
function DevServerButtons() {
  const ps = usePS()
  const ws = useStore((s) => s.workspace)
  const [scripts, setScripts] = useState<DevScript[]>([])
  useEffect(() => {
    let alive = true
    ps.devScripts().then((s) => alive && setScripts(s))
    return () => {
      alive = false
    }
  }, [ws])
  if (!scripts.length) return null
  return (
    <div className="web-dev">
      {scripts.slice(0, 3).map((s) => (
        <button key={s.name} className="btn small" title={s.script} onClick={() => ps.runDevServer(s.name)}>
          <Icon.play size={11} /> {s.command}
        </button>
      ))}
      <span className="muted small">se abre aquí en cuanto el servidor diga su dirección</span>
    </div>
  )
}

function Sidebar() {
  const view = useStore((s) => s.sidebar)
  return (
    <div className="sidebar">
      {view === 'chats' && <ChatsPanel />}
      {view === 'explorer' && <Explorer />}
      {view === 'git' && <GitPanel />}
      {view === 'history' && <HistoryPanel />}
      {view === 'search' && <SearchPanel />}
    </div>
  )
}

export function Workspace({ active }: { active: boolean }) {
  const ps = usePS()
  const sidebar = useStore((s) => s.panels.sidebar)
  const right = useStore((s) => s.panels.right)
  const activityOn = useStore((s) => s.panels.activity)
  const bottom = useStore((s) => s.panels.bottom)
  const editorVisible = useStore((s) => s.layout === 'code' || s.tabs.length > 0)
  const webOpen = useStore((s) => s.web.open)
  const popped = useStore((s) => s.popped)
  const exists = useStore((s) => s.meta.exists)
  const loaded = useStore((s) => s.loaded)

  // Lo que no se ve no se monta, salvo las terminales, que siguen vivas aunque el panel esté oculto o en otra ventana
  const content = useMemo(
    () => ({
      sidebar: sidebar ? <Sidebar /> : null,
      chat: popped.includes('chat') ? null : loaded ? <AgentPanel /> : <div className="center-msg">Cargando…</div>,
      editor: editorVisible && !popped.includes('editor') ? (
        <Suspense fallback={<div className="center-msg muted">Cargando el editor…</div>}>
          <EditorArea />
        </Suspense>
      ) : null,
      web: webOpen ? <ProjectWeb /> : null,
      terminal: <BottomPanel visible={active && bottom && !popped.includes('terminal')} />,
      agents: right && !popped.includes('agents') ? <AgentsPanel /> : null,
      activity: activityOn && !popped.includes('activity') ? <ActivityLogPanel /> : null
    }),
    [sidebar, loaded, editorVisible, webOpen, active, bottom, right, activityOn, popped]
  )

  return (
    <div className={`workspace ${active ? 'active' : ''}`} data-project={ps.id}>
      {!exists && (
        <div className="ws-warning">
          <Icon.warn size={14} /> La carpeta de este proyecto ya no existe: {ps.root}
        </div>
      )}
      <div className="ws-body">
        <ActivityBar />
        <Dock content={content} />
      </div>
      <StatusBar />
    </div>
  )
}
