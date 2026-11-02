import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
import { extname, join, sep } from 'path'

// Imágenes adjuntas a los mensajes. Viven en una carpeta de la app y los agentes solo reciben rutas de ahí:
// el renderer nunca puede hacer que se envíe un fichero cualquiera del disco.
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
export const MAX_IMAGE = 8 * 1024 * 1024

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

export function saveImage(dir: string, data: Uint8Array, mime: string): string {
  const ext = EXT[mime]
  if (!ext) throw new Error('Solo se pueden adjuntar imágenes PNG, JPEG, GIF o WebP')
  if (data.byteLength > MAX_IMAGE) throw new Error(`La imagen pesa demasiado (máximo ${MAX_IMAGE / 1048576} MB)`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}${ext}`)
  writeFileSync(file, data)
  return file
}

// Ruta de una imagen adjunta, comprobada: dentro de la carpeta, de un tipo permitido y que no pase del límite
export function checkImage(dir: string, path: string): string {
  let real: string
  let root: string
  try {
    real = realpathSync(path)
    root = realpathSync(dir)
  } catch {
    throw new Error('La imagen adjunta ya no existe')
  }
  if (!real.startsWith(root + sep)) throw new Error('Esa imagen no es un adjunto de la app')
  if (!IMAGE_TYPES[extname(real).toLowerCase()]) throw new Error('Tipo de imagen no admitido')
  if (statSync(real).size > MAX_IMAGE) throw new Error('La imagen pesa demasiado')
  return real
}

export const imageMime = (path: string) => IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'

export function imageDataUrl(dir: string, path: string): string {
  const p = checkImage(dir, path)
  return `data:${imageMime(p)};base64,${readFileSync(p).toString('base64')}`
}
