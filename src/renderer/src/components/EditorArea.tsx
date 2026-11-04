import { isImagePath } from '@shared/images'
import { ChatImage } from './ChatImage'
import { useEffect, useRef, useState } from 'react'
import Editor, { OnMount } from '@monaco-editor/react'
import type { FileContent } from '@shared/types'
import { api } from '../lib/api'
import { attempt, confirmAsync, toast, useApp } from '../lib/app-store'
import { monacoTheme } from '../lib/monaco'
import { Tab, usePS, useStore } from '../lib/project-store'
import { errMsg, langFor, relPath } from '../lib/utils'
import { CommitView } from './CommitView'
import { DiffPane } from './DiffPane'
import { Icon } from './Icons'

const EDITOR_OPTS = {
  fontSize: 12.5,
  lineHeight: 19,
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  smoothScrolling: true,
  renderWhitespace: 'selection' as const,
  padding: { top: 8 },
  tabSize: 2
}

function FileEditor({ tab, visible }: { tab: Extract<Tab, { kind: 'file' }>; visible: boolean }) {
  const ps = usePS()
  const theme = useApp((s) => s.theme)
  const [file, setFile] = useState<FileContent | null>(null)
  const [external, setExternal] = useState<string | null>(null)
  const saved = useRef('')
  const ed = useRef<Parameters<OnMount>[0] | null>(null)
  const changed = useStore((s) => s.changed)

  useEffect(() => {
    api
      .readFile(tab.path)
      .then((r) => {
        saved.current = r.content
        setFile(r)
      })
      .catch((e) => setFile({ content: errMsg(e), binary: true, tooLarge: false }))
  }, [tab.path])

  // cambios en disco (un agente u otro programa): se recargan si no hay ediciones locales; si las hay, se avisa
  useEffect(() => {
    if (!changed.includes(tab.path) || !ed.current) return
    api
      .readFile(tab.path)
      .then((r) => {
        const model = ed.current?.getModel()
        if (!model || r.content === model.getValue() || r.content === saved.current) return
        if (ps.state.dirty[tab.path]) return setExternal(r.content)
        saved.current = r.content
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.content }], () => null)
      })
      .catch(() => {})
  }, [changed])

  useEffect(() => {
    if (tab.line && ed.current) {
      ed.current.revealLineInCenter(tab.line)
      ed.current.setPosition({ lineNumber: tab.line, column: 1 })
      ed.current.focus()
    }
  }, [tab.line, file])

  useEffect(() => {
    if (visible && ed.current) {
      ps.editorRef.current = {
        path: tab.path,
        getSelection: () => {
          const e = ed.current
          const sel = e?.getSelection()
          if (!e || !sel || sel.isEmpty()) return null
          return { text: e.getModel()!.getValueInRange(sel), from: sel.startLineNumber, to: sel.endLineNumber }
        }
      }
    }
  }, [visible, file])

  if (isImagePath(tab.path)) return <div className="image-editor" style={{ display: visible ? undefined : 'none' }}><ChatImage src={tab.path} alt={tab.path.split('/').pop()} /></div>
  if (!file) return <div className="center-msg" style={{ display: visible ? undefined : 'none' }}>Cargando…</div>
  if (file.binary || file.tooLarge)
    return (
      <div className="center-msg" style={{ display: visible ? undefined : 'none' }}>
        {file.tooLarge ? 'Fichero demasiado grande para abrirlo aquí.' : file.content || 'Fichero binario.'}
        <button className="btn" onClick={() => attempt(() => api.reveal(tab.path))}>
          Mostrar en Finder
        </button>
      </div>
    )

  const save = async (v: string) => {
    try {
      await api.writeFile(tab.path, v)
      saved.current = v
      setExternal(null)
      ps.setDirty(tab.path, false)
      ps.refreshGit()
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }

  return (
    <div className="editor-host" style={{ display: visible ? undefined : 'none' }}>
      {external !== null && (
        <div className="editor-banner">
          <Icon.warn size={14} /> El fichero ha cambiado en disco mientras lo editabas.
          <button
            className="btn small"
            onClick={() => {
              const model = ed.current?.getModel()
              if (model) model.setValue(external)
              saved.current = external
              ps.setDirty(tab.path, false)
              setExternal(null)
            }}
          >
            Recargar del disco
          </button>
          <button className="btn ghost small" onClick={() => setExternal(null)}>
            Mantener mis cambios
          </button>
        </div>
      )}
      <Editor
        path={tab.path}
        defaultValue={file.content}
        language={langFor(tab.path)}
        theme={monacoTheme(theme)}
        options={EDITOR_OPTS}
        onChange={(v) => ps.setDirty(tab.path, (v ?? '') !== saved.current)}
        onMount={(editor, monaco) => {
          ed.current = editor
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(editor.getValue()))
          if (tab.line) {
            editor.revealLineInCenter(tab.line)
            editor.setPosition({ lineNumber: tab.line, column: 1 })
          }
        }}
      />
    </div>
  )
}

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
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTab ? 'active' : ''} tab-${t.kind}`}
              onClick={() => ps.set({ activeTab: t.id })}
              onMouseDown={(e) => e.button === 1 && tryClose(t)}
              title={t.kind === 'file' ? t.path : t.kind === 'commit' ? t.hash : t.rel}
            >
              {(t.kind === 'diff' || t.kind === 'refdiff') && <Icon.compare size={12} className="tab-kind" />}
              {t.kind === 'commit' && <Icon.history size={12} className="tab-kind" />}
              {t.kind === 'file' && <Icon.file size={12} className="tab-kind muted" />}
              <span className="ellipsis">{t.title}</span>
              {t.kind === 'file' && dirty[t.path] ? (
                <span className="dirty-dot" onClick={(e) => (e.stopPropagation(), tryClose(t))}>
                  ●
                </span>
              ) : (
                <span className="tab-close" onClick={(e) => (e.stopPropagation(), tryClose(t))}>
                  <Icon.x size={12} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {active?.kind === 'file' && <div className="breadcrumb mono">{relPath(ws, active.path).split('/').join(' › ')}</div>}
      <div className="editor-content">
        {tabs
          .filter((t): t is Extract<Tab, { kind: 'file' }> => t.kind === 'file')
          .map((t) => (
            <FileEditor key={t.id} tab={t} visible={t.id === activeTab} />
          ))}
        {active?.kind === 'diff' && <DiffView key={active.id} tab={active} />}
        {active?.kind === 'commit' && <CommitView key={active.id} cwd={active.cwd} hash={active.hash} />}
        {active?.kind === 'refdiff' && <RefDiffView key={active.id} tab={active} />}
        {!active && <EditorWelcome />}
      </div>
    </div>
  )
}
