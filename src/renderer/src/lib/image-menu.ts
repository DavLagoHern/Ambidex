import type { MouseEvent } from 'react'
import { api } from './api'
import { setApp, toast } from './app-store'

// El portapapeles solo acepta PNG: cualquier imagen (data URL) se redibuja en un canvas y se copia como PNG
export async function copyImage(url: string) {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error('no se pudo convertir')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    toast('Imagen copiada', 'success')
  } catch (e) {
    toast(`No se pudo copiar la imagen: ${(e as Error).message}`, 'error')
  }
}

// Clic derecho sobre una imagen del chat: copiarla (y verla en grande, si no se está viendo ya)
export async function imageMenu(e: MouseEvent, url: string | null | undefined, opts: { view?: boolean } = {}) {
  e.preventDefault()
  e.stopPropagation()
  if (!url) return
  const choice = await api.contextMenu([{ id: 'copy', label: 'Copiar imagen' }, ...(opts.view ? [{ id: 'view', label: 'Ver en grande' }] : [])])
  if (choice === 'copy') copyImage(url)
  else if (choice === 'view') setApp({ lightbox: url })
}
