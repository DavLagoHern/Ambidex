import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { attempt, confirmAsync } from '../lib/app-store'
import { Tab, usePS, useStore } from '../lib/project-store'
import { relPath } from '../lib/utils'
import { Icon } from './Icons'

// The welcome panel and chat do not need Monaco, its styles, or language workers.
const FileEditor = lazy(() => import('./FileEditor').then(m => ({ default: m.FileEditor })))
const CommitView = lazy(() => import('./CommitView').then(m => ({ default: m.CommitView })))
const DiffPane = lazy(() => import('./DiffPane').then(m => ({ default: m.DiffPane })))

// La vista inicial se adapta al panel, pero respeta la elección manual.
function useDiffLayout() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [choice, setChoice] = useState<boolean | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, inline: choice ?? width < 760, setInline: setChoice }
}

// Diff entre dos refs (p. ej. la propuesta del equipo frente a la base)
function RefDiffView({ tab }: { tab: Extract<Tab, { kind: 'refdiff' }> }) {
  const [sides, setSides] = useState<{ a: string; b: string } | null>(null)
  const { ref, inline, setInline } = useDiffLayout()
  useEffect(() => {
    Promise.all([api.git.show(tab.cwd, tab.from, tab.rel), api.git.show(tab.cwd, tab.to, tab.rel)])
      .then(([a, b]) => setSides({ a, b }))
      .catch(() => setSides({ a: '', b: '' }))
  }, [tab.id])
  return (
    <div className="diff-wrap" ref={ref}>
      <div className="diff-bar">
        <span className="mono small">{tab.rel}</span>
        <span className="badge accent">{tab.from.slice(0, 7)} ↔ {tab.to}</span>
        <span className="row gap" style={{ marginLeft: 'auto' }}>
          <div className="seg">
            <button className={!inline ? 'on' : ''} onClick={() => setInline(false)}>
              Lado a lado
            </button>
            <button className={inline ? 'on' : ''} onClick={() => setInline(true)}>
              En línea
            </button>
          </div>
        </span>
      </div>
      {sides && <DiffPane id={tab.id} path={tab.rel} original={sides.a} modified={sides.b} inline={inline} />}
    </div>
  )
}

function DiffView({ tab }: { tab: Extract<Tab, { kind: 'diff' }> }) {
  const ps = usePS()
  const gitTick = useStore((s) => s.gitTick)
  const [sides, setSides] = useState<{ a: string; b: string } | null>(null)
  const { ref, inline, setInline } = useDiffLayout()
  const st = useStore((s) => s.repoStatus[tab.cwd]?.files.find((f) => f.path === tab.rel))

  useEffect(() => {
    const abs = `${tab.cwd}/${tab.rel}`
    const working = () =>
      api
        .readFile(abs)
        .then((r) => r.content)
        .catch(() => '')
    const load = async () => {
      if (tab.mode === 'unstaged') return { a: await api.git.show(tab.cwd, ':', tab.rel), b: await working() }
      if (tab.mode === 'staged') return { a: await api.git.show(tab.cwd, 'HEAD', tab.rel), b: await api.git.show(tab.cwd, ':', tab.rel) }
      return { a: await api.git.show(tab.cwd, 'HEAD', tab.rel), b: await working() }
    }
    load()
      .then(setSides)
      .catch(() => setSides({ a: '', b: '' }))
  }, [tab.id, gitTick])

  return (
    <div className="diff-wrap" ref={ref}>
      <div className="diff-bar">
        <span className="mono small">{tab.rel}</span>
        <span className="badge">{tab.mode === 'staged' ? 'HEAD ↔ índice' : tab.mode === 'unstaged' ? 'índice ↔ trabajo' : 'HEAD ↔ trabajo'}</span>
        <span className="row gap" style={{ marginLeft: 'auto' }}>
          <div className="seg">
            <button className={!inline ? 'on' : ''} onClick={() => setInline(false)}>
              Lado a lado
            </button>
            <button className={inline ? 'on' : ''} onClick={() => setInline(true)}>
              En línea
            </button>
          </div>
          <button className="btn ghost small" onClick={() => ps.openFile(`${tab.cwd}/${tab.rel}`)}>
            <Icon.file size={12} /> Abrir
          </button>
          {st?.unstaged && (
            <button className="btn small" onClick={async () => (await attempt(() => api.git.stage(tab.cwd, [tab.rel])), ps.refreshGit())}>
              <Icon.plus size={12} /> Preparar
            </button>
          )}
          {st?.staged && (
            <button className="btn small" onClick={async () => (await attempt(() => api.git.unstage(tab.cwd, [tab.rel])), ps.refreshGit())}>
              <Icon.minus size={12} /> Quitar del stage
            </button>
          )}
        </span>
      </div>
      {sides && <DiffPane id={tab.id} path={tab.rel} original={sides.a} modified={sides.b} inline={inline} />}
    </div>
  )
}

function EditorWelcome() {
  return (
    <div className="editor-welcome">
      <Icon.code size={28} />
      <h2>Editor</h2>
      <p className="muted">Abre ficheros desde el explorador, los resultados de búsqueda o los cambios de los agentes.</p>
      <div className="shortcuts">
        <span><kbd>⌘P</kbd> Ir a fichero</span>
        <span><kbd>⇧⌘F</kbd> Buscar en el proyecto</span>
        <span><kbd>⇧⌘G</kbd> Git</span>
        <span><kbd>⌘E</kbd> Chat / código</span>
      </div>
    </div>
  )
}

function EditorTabs({ close }: { close: (tab: Tab) => void }) {
  const ps = usePS()
  const tabs = useStore(s => s.tabs)
  const active = useStore(s => s.activeTab)
  const dirty = useStore(s => s.dirty)
  const strip = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ left: false, right: false })
  const read = () => {
    const el = strip.current
    if (!el) return
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
    setScroll(old => old.left === next.left && old.right === next.right ? old : next)
  }
  const reveal = () => {
    const el = strip.current
    const selected = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el || !selected) return
    if (selected.offsetLeft < el.scrollLeft) el.scrollLeft = selected.offsetLeft
    else if (selected.offsetLeft + selected.offsetWidth > el.scrollLeft + el.clientWidth)
      el.scrollLeft = selected.offsetLeft + selected.offsetWidth - el.clientWidth
    read()
  }
  useLayoutEffect(reveal, [tabs, active])
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const observer = new ResizeObserver(reveal)
    observer.observe(el)
    window.addEventListener('resize', reveal)
    return () => { observer.disconnect(); window.removeEventListener('resize', reveal) }
  }, [])
  const move = (direction: number) => {
    const el = strip.current
    if (el) el.scrollLeft += direction * Math.max(100, el.clientWidth * .75)
    read()
  }
  const choose = async () => {
    const id = await attempt(() => api.contextMenu(tabs.map(t => ({
      id: t.id, label: t.title, type: 'checkbox', checked: t.id === active
    }))))
    if (id) ps.set({ activeTab: id })
  }
  return <div className="editor-tabs">
    <div className="tabs" ref={strip} role="tablist" aria-label="Archivos abiertos" onScroll={read}
      onWheel={e => {
        const el = strip.current
        if (el && el.scrollWidth > el.clientWidth && !e.deltaX && e.deltaY) {
          el.scrollLeft += e.deltaY
          e.preventDefault()
        }
      }}>
      {tabs.map(t => <div key={t.id} role="tab" aria-selected={t.id === active}
        className={`tab ${t.id === active ? 'active' : ''} tab-${t.kind}`}
        onClick={() => ps.set({ activeTab: t.id })} onMouseDown={e => e.button === 1 && close(t)}
        title={t.kind === 'file' ? t.path : t.kind === 'commit' ? t.hash : t.rel}>
        {(t.kind === 'diff' || t.kind === 'refdiff') && <Icon.compare size={12} className="tab-kind" />}
        {t.kind === 'commit' && <Icon.history size={12} className="tab-kind" />}
        {t.kind === 'file' && <Icon.file size={12} className="tab-kind muted" />}
        <span className="ellipsis">{t.title}</span>
        <span className={t.kind === 'file' && dirty[t.path] ? 'dirty-dot' : 'tab-close'}
          role="button" aria-label={`Cerrar ${t.title}`} onClick={e => { e.stopPropagation(); close(t) }}>
          {t.kind === 'file' && dirty[t.path] ? '●' : <Icon.x size={12} />}
        </span>
      </div>)}
    </div>
    {tabs.length > 1 && <div className="editor-tab-actions">
      <button className="icon-btn" title="Desplazar pestañas a la izquierda" disabled={!scroll.left} onClick={() => move(-1)}><Icon.back size={13} /></button>
      <button className="icon-btn" title="Desplazar pestañas a la derecha" disabled={!scroll.right} onClick={() => move(1)}><Icon.chevronRight size={13} /></button>
      <button className="icon-btn" title="Ver todas las pestañas abiertas" onClick={choose}><Icon.chevronDown size={13} /></button>
    </div>}
  </div>
}

export function EditorArea() {
  const ps = usePS()
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const dirty = useStore((s) => s.dirty)
  const ws = useStore((s) => s.workspace)
  const active = tabs.find((t) => t.id === activeTab)

  const tryClose = async (t: Tab) => {
    if (t.kind === 'file' && dirty[t.path] && !(await confirmAsync(`${t.title} tiene cambios sin guardar`, '¿Cerrar igualmente? Se perderán los cambios.', true))) return
    if (t.kind === 'file') ps.setDirty(t.path, false)
    ps.closeTab(t.id)
  }

  useEffect(() => {
    // ⌘W cierra la pestaña del editor activa si el foco está en este proyecto
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.key.toLowerCase() !== 'w') return
      const cur = ps.state.tabs.find((t) => t.id === ps.state.activeTab)
      if (!cur || !document.querySelector(`.workspace.active[data-project="${ps.id}"]`)) return
      // dentro del visor web, ⌘W cierra la pestaña web
      if ((document.activeElement as HTMLElement | null)?.closest('.webpanel')) return
      e.preventDefault()
      tryClose(cur)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="editor-area">
      {tabs.length > 0 && <EditorTabs close={tryClose} />}
      {active?.kind === 'file' && <div className="breadcrumb mono">{relPath(ws, active.path).split('/').join(' › ')}</div>}
      <div className="editor-content">
        <Suspense fallback={<div className="center-msg muted">Cargando editor…</div>}>
        {tabs
          .filter((t): t is Extract<Tab, { kind: 'file' }> => t.kind === 'file')
          .map((t) => (
            <FileEditor key={t.id} tab={t} visible={t.id === activeTab} />
          ))}
        {active?.kind === 'diff' && <DiffView key={active.id} tab={active} />}
        {active?.kind === 'commit' && <CommitView key={active.id} cwd={active.cwd} hash={active.hash} />}
        {active?.kind === 'refdiff' && <RefDiffView key={active.id} tab={active} />}
        {!active && <EditorWelcome />}
        </Suspense>
      </div>
    </div>
  )
}
