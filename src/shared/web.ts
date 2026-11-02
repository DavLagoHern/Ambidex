// Utilidades del visor web integrado (compartidas por el proceso principal y el renderer)

// el nombre viene de cuando la app se llamaba Code AI: cambiarlo borraría las cookies de la Web
export const WEB_PARTITION = 'persist:codeai-web'

export interface WebTab {
  id: string
  url: string
  title?: string
  favicon?: string
}

// Solo se navega a páginas http(s); about:blank es la pestaña nueva
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url) || url === 'about:blank'
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.(?:local|localhost|test))(?::\d{1,5})?(?:[/?#]|$)/i

export function isLocalUrl(url: string): boolean {
  return LOCAL_HOST.test(url.replace(/^https?:\/\//i, ''))
}

// Lo que se escribe en la barra de direcciones → URL a cargar (o una búsqueda)
export function normalizeAddress(input: string): string {
  const t = input.trim()
  if (!t) return 'about:blank'
  if (/^https?:\/\//i.test(t)) return t
  if (/^[a-z][\w+.-]*:/i.test(t) && !/^[\w.-]+:\d+/.test(t)) return searchUrl(t)
  if (!/\s/.test(t)) {
    if (LOCAL_HOST.test(t)) return `http://${t}`
    if (/^[\w-]+(\.[\w-]+)+(:\d{1,5})?([/?#].*)?$/.test(t)) return `https://${t}`
  }
  return searchUrl(t)
}

function searchUrl(q: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}

// Texto corto para la pestaña cuando la página aún no tiene título
export function shortUrl(url: string): string {
  if (!url || url === 'about:blank') return 'Nueva pestaña'
  try {
    const u = new URL(url)
    return (u.host + (u.pathname === '/' ? '' : u.pathname)).replace(/^www\./, '')
  } catch {
    return url
  }
}

// Enlaces dentro de un texto: URLs http(s) y direcciones locales sin esquema (localhost:5173/ruta)
const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s<>"'`]*)?/gi

export interface FoundLink {
  start: number
  end: number
  text: string
  url: string
}

export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = []
  for (const m of text.matchAll(LINK)) {
    let s = m[0]
    // la puntuación final pertenece a la frase, no al enlace; un ")" final solo si no está abierto en la URL
    for (;;) {
      const last = s.at(-1)!
      if (/[.,;:!?'"»]/.test(last)) s = s.slice(0, -1)
      else if (last === ')' && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1)
      else if (last === ']' && !s.includes('[')) s = s.slice(0, -1)
      else break
    }
    if (!s) continue
    out.push({ start: m.index!, end: m.index! + s.length, text: s, url: /^https?:/i.test(s) ? s : `http://${s}` })
  }
  return out
}
