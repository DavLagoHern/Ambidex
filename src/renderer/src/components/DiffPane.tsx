import { DiffEditor } from '@monaco-editor/react'
import type { DiffOnMount } from '@monaco-editor/react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/app-store'
import { monacoTheme } from '../lib/monaco'
import { langFor } from '../lib/utils'

// Los modelos se conservan con rutas estables: evita el error "TextModel got disposed before DiffEditorWidget model got reset"
export function DiffPane({ id, path, original, modified, inline }: { id: string; path: string; original: string; modified: string; inline: boolean }) {
  const theme = useApp((s) => s.theme)
  const instance = useRef<Parameters<DiffOnMount>[0] | null>(null)
  const [ready, setReady] = useState(false)
  const paint = () => {
    const editor = instance.current
    if (!editor) return
    editor.layout()
    editor.getOriginalEditor().render(true)
    editor.getModifiedEditor().render(true)
  }
  useEffect(() => { setReady(false) }, [original, modified])
  useEffect(() => {
    window.addEventListener('resize', paint)
    return () => window.removeEventListener('resize', paint)
  }, [])
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : ''
  return (
    <div className="monaco-host diff-editor-host" aria-busy={!ready}>
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`diff-a://m/${encodeURIComponent(id)}${ext}`}
      modifiedModelPath={`diff-b://m/${encodeURIComponent(id)}${ext}`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      language={langFor(path)}
      theme={monacoTheme(theme)}
      onMount={(editor) => {
        instance.current = editor
        editor.onDidDispose(() => { if (instance.current === editor) instance.current = null })
        editor.onDidUpdateDiff(() => { setReady(true); paint() })
        if (editor.getLineChanges() !== null) setReady(true)
        paint()
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
        automaticLayout: true,
        wordWrap: 'on',
        diffWordWrap: 'on',
        wrappingIndent: 'same',
        useInlineViewWhenSpaceIsLimited: false,
        renderOverviewRuler: false,
        renderMarginRevertIcon: false,
        lightbulb: { enabled: 'off' as never },
        diffAlgorithm: 'advanced',
        padding: { top: 8, bottom: 8 },
        smoothScrolling: true,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 12,
        renderGutterMenu: false,
        glyphMargin: false,
        folding: false,
        scrollBeyondLastLine: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 }
      }}
    />
    </div>
  )
}
