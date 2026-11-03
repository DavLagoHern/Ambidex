import { DiffEditor } from '@monaco-editor/react'
import { useApp } from '../lib/app-store'
import { monacoTheme } from '../lib/monaco'
import { langFor } from '../lib/utils'

// Los modelos se conservan con rutas estables: evita el error "TextModel got disposed before DiffEditorWidget model got reset"
export function DiffPane({ id, path, original, modified, inline }: { id: string; path: string; original: string; modified: string; inline: boolean }) {
  const theme = useApp((s) => s.theme)
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : ''
  return (
    <DiffEditor
      key={id + inline}
      original={original}
      modified={modified}
      originalModelPath={`diff-a://m/${encodeURIComponent(id)}${ext}`}
      modifiedModelPath={`diff-b://m/${encodeURIComponent(id)}${ext}`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      language={langFor(path)}
      theme={monacoTheme(theme)}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
        automaticLayout: true,
        // sin ajuste de línea (desplazamiento horizontal, como VS Code): con ajuste, la vista en línea se vuelve ilegible
        wordWrap: 'off',
        diffWordWrap: 'off',
        renderSideBySideInlineBreakpoint: 700,
        useInlineViewWhenSpaceIsLimited: true,
        renderOverviewRuler: false,
        renderMarginRevertIcon: false,
        lightbulb: { enabled: 'off' as never },
        diffAlgorithm: 'advanced',
        padding: { top: 8, bottom: 8 },
        smoothScrolling: true,
        lineDecorationsWidth: 6,
        folding: false,
        scrollBeyondLastLine: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 }
      }}
    />
  )
}
