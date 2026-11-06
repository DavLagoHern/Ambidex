import { isImagePath } from '@shared/images'
import { ChatImage } from './ChatImage'
import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { FileContent } from '@shared/types'
import { api } from '../lib/api'
import { attempt, toast, useApp } from '../lib/app-store'
import { monacoTheme } from '../lib/monaco'
import { Tab, usePS, useStore } from '../lib/project-store'
import { errMsg, langFor } from '../lib/utils'
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

export function FileEditor({ tab, visible }: { tab: Extract<Tab, { kind: 'file' }>; visible: boolean }) {
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
      <div className="monaco-host">
      <Editor
        path={tab.path}
        defaultValue={file.content}
        language={langFor(tab.path)}
        theme={monacoTheme(theme)}
        options={EDITOR_OPTS}
        onChange={(v) => ps.setDirty(tab.path, (v ?? '') !== saved.current)}
        onMount={(editor, monaco) => {
          ed.current = editor
          // WebKit can defer ResizeObserver/animation frames while a window is occluded.
          // Establish the initial size and lines synchronously; subsequent resizes stay automatic.
          editor.layout()
          editor.render(true)
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(editor.getValue()))
          if (tab.line) {
            editor.revealLineInCenter(tab.line)
            editor.setPosition({ lineNumber: tab.line, column: 1 })
          }
        }}
      />
      </div>
    </div>
  )
}

