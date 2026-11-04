import { cleanFileRef, isImagePath } from '@shared/images'
import { ChatImage } from './ChatImage'
import { Fragment, MouseEvent, ReactNode, memo, useMemo } from 'react'
import { findLinks } from '@shared/web'
import { api } from '../lib/api'
import { toast } from '../lib/app-store'
import { highlight } from '../lib/highlight'
import { useOptionalPS } from '../lib/project-store'
import { joinPath } from '../lib/utils'
import { Icon } from './Icons'

type OpenFile = ((file: string, line?: number) => void) & { imagePath?: (file: string) => string }

// Rutas de ficheros en el texto de los agentes: src/app.ts, ./a/b.tsx:12, package.json#L3
const FILE_REF = /^(\.{0,2}\/)?[\w@.-]+(\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}((:|#L)\d+)?$/

function parseRef(ref: string): { file: string; line?: number } {
  const m = cleanFileRef(ref).match(/^([^#:]+)(?:#L?(\d+)|:(\d+))?/)
  return { file: m?.[1] ?? ref, line: Number(m?.[2] ?? m?.[3]) || undefined }
}

// Texto plano con sus URLs (y localhost:puerto) convertidas en enlaces
function linkify(text: string, key: string): ReactNode[] {
  const links = findLinks(text)
  if (!links.length) return [text]
  const out: ReactNode[] = []
  let last = 0
  links.forEach((l, i) => {
    if (l.start > last) out.push(text.slice(last, l.start))
    out.push(
      <a key={`${key}-l${i}`} className="web-link" href={l.url} data-url={l.url}>
        {l.text}
      </a>
    )
    last = l.end
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

function inline(text: string, open: OpenFile, key = 0): ReactNode[] {
  const openImagePath = (file: string) => open.imagePath?.(file) ?? file
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(!?\[[^\]]*\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    const k = `${key}-${i++}`
    if (m.index > last) out.push(...linkify(text.slice(last, m.index), k))
    const t = m[0]
    if (m[1]) {
      const code = t.slice(1, -1)
      const url = findLinks(code)[0]
      if (url && url.start === 0 && url.end === code.length)
        out.push(
          <a key={k} className="web-link" href={url.url} data-url={url.url}>
            <code>{code}</code>
          </a>
        )
      else if (isImagePath(code)) out.push(<ChatImage key={k} src={openImagePath(cleanFileRef(code))} alt={code.split('/').pop()} />)
      else if (FILE_REF.test(code) && (code.includes('/') || code.includes(':') || /\.(ts|tsx|js|jsx|py|go|rs|swift|json|md|css|html|java|kt|rb|php|sh|yml|yaml|toml)$/.test(code))) {
        const r = parseRef(code)
        out.push(
          <code key={k} className="file-ref" title="Abrir en el editor" onClick={() => open(r.file, r.line)}>
            {code}
          </code>
        )
      } else out.push(<code key={k}>{code}</code>)
    } else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), open, i)}</strong>)
    else if (m[3]) out.push(<em key={k}>{t.slice(1, -1)}</em>)
    else if (m[4]) {
      const lm = t.match(/^!?\[([^\]]*)\]\(([^)]+)\)$/)!
      const href = cleanFileRef(lm[2])
      if (t.startsWith('!') || isImagePath(href)) {
        out.push(<ChatImage key={k} src={/^(https?:|data:|\/)/.test(href) ? href : openImagePath(href)} alt={lm[1]} />)
      } else
      if (/^https?:/.test(href))
        out.push(
          <a key={k} className="web-link" href={href} data-url={href} title={href}>
            {lm[1]}
          </a>
        )
      else {
        const r = parseRef(href)
        out.push(
          <a key={k} href="#" onClick={(e) => (e.preventDefault(), open(r.file, r.line))}>
            {lm[1]}
          </a>
        )
      }
    }
    last = m.index + t.length
  }
  if (last < text.length) out.push(...linkify(text.slice(last), `${key}-end`))
  return out
}

// Clic en un enlace: se abre en el visor web del proyecto; ⌘-clic, en el navegador
// Sin proyecto (Ajustes…), los enlaces van al navegador
export function useLinkHandlers() {
  const ps = useOptionalPS()
  const openWeb = (url: string) => (ps ? ps.openWeb(url) : api.openExternal(url).catch(() => {}))
  const target = (e: MouseEvent) => (e.target as HTMLElement).closest('a.web-link') as HTMLAnchorElement | null
  return {
    onClick: (e: MouseEvent) => {
      const a = target(e)
      if (!a) return
      e.preventDefault()
      const url = a.dataset.url!
      if (e.metaKey) api.openExternal(url).catch(() => {})
      else openWeb(url)
    },
    onContextMenu: async (e: MouseEvent) => {
      const a = target(e)
      if (!a) return
      e.preventDefault()
      const url = a.dataset.url!
      const c = await api.contextMenu([
        ...(ps ? [{ id: 'web', label: 'Abrir en Web' }] : []),
        { id: 'ext', label: 'Abrir en el navegador' },
        { type: 'separator' },
        { id: 'copy', label: 'Copiar enlace' }
      ])
      if (c === 'web') openWeb(url)
      if (c === 'ext') api.openExternal(url).catch(() => {})
      if (c === 'copy') navigator.clipboard.writeText(url).then(() => toast('Enlace copiado', 'success'))
    }
  }
}

// Resaltado propio y ligero: se recalcula al vuelo mientras llega el texto sin cargar Monaco
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const toks = useMemo(() => highlight(code, lang), [code, lang])
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || 'código'}</span>
        <button className="icon-btn" title="Copiar" onClick={() => (navigator.clipboard.writeText(code), toast('Copiado', 'success'))}>
          <Icon.copy size={12} />
        </button>
      </div>
      <pre>
        <code>{toks.map((t, i) => (t.k ? <span key={i} className={`hl-${t.k}`}>{t.v}</span> : t.v))}</code>
      </pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ps = useOptionalPS()
  const links = useLinkHandlers()
  // las rutas de ficheros solo se abren dentro de un proyecto
  const open: OpenFile = (file, line) => ps?.openFile(joinPath(ps.state.workspace, cleanFileRef(file)), line)
  open.imagePath = (file) => ps ? joinPath(ps.state.workspace, file) : file
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++
      blocks.push(<CodeBlock key={k++} lang={fence[1]} code={buf.join('\n')} />)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)/)
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}` as 'h3'
      blocks.push(<Tag key={k++}>{inline(h[2], open)}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)![0].length
        items.push(
          <li key={i} style={indent ? { marginLeft: indent * 6 } : undefined}>
            {inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/^\[( |x)\]\s+/i, (_, c) => (c.trim() ? '☑ ' : '☐ ')), open)}
          </li>
        )
        i++
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()))
        i++
      }
      blocks.push(
        <div key={k++} className="md-table">
          <table>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c, open)}</th> : <td key={ci}>{inline(c, open)}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (line.startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={k++}>{inline(buf.join(' '), open)}</blockquote>)
      continue
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={k++} />)
      i++
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+\.\s|\||>)/.test(lines[i])) para.push(lines[i++])
    if (!para.length) para.push(lines[i++])
    blocks.push(
      <p key={k++}>
        {para.map((p, pi) => (
          <Fragment key={pi}>
            {pi > 0 && <br />}
            {inline(p, open, pi)}
          </Fragment>
        ))}
      </p>
    )
  }
  return (
    <div className="md" {...links}>
      {blocks}
    </div>
  )
})
