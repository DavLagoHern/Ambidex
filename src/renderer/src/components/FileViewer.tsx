import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { attempt } from '../lib/app-store'
import { errMsg } from '../lib/utils'

// Documentos de Office y PDF: se muestran en solo lectura; las librerías se cargan al abrir el primero
export type ViewerKind = 'docx' | 'xlsx' | 'pptx' | 'pdf'
const KINDS: Record<string, ViewerKind> = { docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx', pdf: 'pdf' }
export const viewerKind = (path: string): ViewerKind | null => KINDS[path.split('.').pop()?.toLowerCase() ?? ''] ?? null

function toBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

type Render = (buf: ArrayBuffer, host: HTMLElement, cancelled: () => boolean) => Promise<void>

const renderDocx: Render = async (buf, host) => {
  const { renderAsync } = await import('docx-preview')
  await renderAsync(buf, host, undefined, { inWrapper: true, ignoreWidth: false, breakPages: true })
}

const renderPptx: Render = async (buf, host) => {
  const { init } = await import('pptx-preview')
  const width = Math.max(480, Math.min(host.clientWidth - 32, 1100))
  init(host, { width, height: Math.round((width * 9) / 16), mode: 'list' }).preview(buf)
}

const renderXlsx: Render = async (buf, host, cancelled) => {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  if (cancelled()) return
  const tabs = document.createElement('div')
  tabs.className = 'viewer-sheet-tabs'
  const body = document.createElement('div')
  body.className = 'viewer-sheet'
  const show = (i: number) => {
    const ws = wb.worksheets[i]
    const cols = Math.min(ws.columnCount, 100)
    const rows = Math.min(ws.rowCount, 2000)
    const table = document.createElement('table')
    for (let r = 1; r <= rows; r++) {
      const tr = table.insertRow()
      for (let c = 1; c <= cols; c++) {
        const cell = tr.insertCell()
        const v = ws.getCell(r, c).text
        cell.textContent = v
        if (r === 1) cell.className = 'head'
      }
    }
    body.replaceChildren(table)
    if (ws.rowCount > rows) {
      const note = document.createElement('div')
      note.className = 'viewer-note'
      note.textContent = `Se muestran las primeras ${rows} de ${ws.rowCount} filas.`
      body.append(note)
    }
    tabs.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i))
  }
  wb.worksheets.forEach((ws, i) => {
    const b = document.createElement('button')
    b.textContent = ws.name
    b.onclick = () => show(i)
    tabs.append(b)
  })
  host.replaceChildren(tabs, body)
  if (wb.worksheets.length) show(0)
  else body.textContent = 'El libro no tiene hojas.'
}

const renderPdf: Render = async (buf, host, cancelled) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  host.replaceChildren()
  const scale = Math.min(2, window.devicePixelRatio || 1) * 1.25
  for (let n = 1; n <= doc.numPages && !cancelled(); n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = vp.width
    canvas.height = vp.height
    canvas.className = 'viewer-pdf-page'
    host.append(canvas)
    await page.render({ canvas, viewport: vp }).promise
  }
}

const RENDER: Record<ViewerKind, Render> = { docx: renderDocx, xlsx: renderXlsx, pptx: renderPptx, pdf: renderPdf }

export function FileViewer({ path, kind, visible }: { path: string; kind: ViewerKind; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ok' | string>('loading')

  useEffect(() => {
    let stop = false
    setState('loading')
    api
      .readBinary(path)
      .then((b64) => {
        if (stop || !host.current) return
        host.current.replaceChildren()
        return RENDER[kind](toBuffer(b64), host.current, () => stop)
      })
      .then(() => !stop && setState('ok'))
      .catch((e) => !stop && setState(errMsg(e)))
    return () => {
      stop = true
    }
  }, [path, kind])

  const failed = state !== 'loading' && state !== 'ok'
  return (
    <div className={`file-viewer viewer-${kind}`} style={{ display: visible ? undefined : 'none' }}>
      {state === 'loading' && <div className="center-msg">Cargando…</div>}
      {failed && (
        <div className="center-msg">
          No se puede mostrar este fichero: {state}
          <button className="btn" onClick={() => attempt(() => api.reveal(path))}>
            Mostrar en Finder
          </button>
        </div>
      )}
      <div ref={host} className="viewer-host" style={{ display: state === 'ok' || state === 'loading' ? undefined : 'none' }} />
    </div>
  )
}
