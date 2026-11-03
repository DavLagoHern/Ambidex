import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// Sin un proyecto tsconfig real, evitamos falsos errores de módulos no encontrados
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true })
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true })
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.languages.typescript.JsxEmit.React,
  allowJs: true,
  target: monaco.languages.typescript.ScriptTarget.ESNext
})

monaco.editor.defineTheme('ambidex-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6c717d', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b4a7ff' },
    { token: 'string', foreground: '9fd49a' },
    { token: 'number', foreground: 'f2b880' },
    { token: 'type', foreground: '7cc4f8' }
  ],
  colors: {
    'editor.background': '#16171c',
    'editorGutter.background': '#16171c',
    'editor.lineHighlightBackground': '#1c1e24',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4a4e58',
    'editorLineNumber.activeForeground': '#a6aab5',
    'editor.selectionBackground': '#8b7cf640',
    'editorCursor.foreground': '#b4a7ff',
    'editorIndentGuide.background1': '#23252c',
    'editorWidget.background': '#1c1e24',
    'editorWidget.border': '#2f323b',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'diffEditor.insertedTextBackground': '#3fb98a70',
    'diffEditor.removedTextBackground': '#f0616d70',
    'diffEditor.insertedLineBackground': '#3fb98a38',
    'diffEditor.removedLineBackground': '#f0616d38',
    'diffEditorGutter.insertedLineBackground': '#3fb98a38',
    'diffEditorGutter.removedLineBackground': '#f0616d38'
  }
})

monaco.editor.defineTheme('ambidex-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a8d96', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6d5ce8' },
    { token: 'string', foreground: '2f7d32' },
    { token: 'number', foreground: 'b4561b' },
    { token: 'type', foreground: '1f6fbf' }
  ],
  colors: {
    'editor.background': '#fbfbfa',
    'editorGutter.background': '#fbfbfa',
    'editor.lineHighlightBackground': '#f1f1ee',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#b5b7bd',
    'editorLineNumber.activeForeground': '#50535c',
    'editor.selectionBackground': '#6d5ce830',
    'editorCursor.foreground': '#6d5ce8',
    'diffEditor.insertedTextBackground': '#138a6255',
    'diffEditor.removedTextBackground': '#d7364455',
    'diffEditor.insertedLineBackground': '#138a6228',
    'diffEditor.removedLineBackground': '#d7364428',
    'diffEditorGutter.insertedLineBackground': '#138a6228',
    'diffEditorGutter.removedLineBackground': '#d7364428'
  }
})

loader.config({ monaco })

export const monacoTheme = (theme: 'dark' | 'light') => (theme === 'dark' ? 'ambidex-dark' : 'ambidex-light')

export { monaco }
