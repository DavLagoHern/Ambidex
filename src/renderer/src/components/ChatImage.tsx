import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { setApp } from '../lib/app-store'
import { imageMenu } from '../lib/image-menu'

export function ChatImage({ src, alt = 'Imagen', compact = false }: { src: string; alt?: string; compact?: boolean }) {
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    setUrl(undefined)
    setError(false)
    const load = /^(data:image\/(png|jpeg|gif|webp);base64,|https?:\/\/)/.test(src) ? Promise.resolve(src) : api.readImage(src)
    load.then(u => { if (alive) setUrl(u) }, () => { if (alive) setError(true) })
    return () => { alive = false }
  }, [src])
  if (error) return <span className="chat-image-error" title={src}>No se pudo cargar la imagen: {alt}</span>
  return <button type="button" className={`chat-image ${compact ? 'compact' : ''}`} disabled={!url} title="Ampliar imagen" onClick={() => url && setApp({ lightbox: url })} onContextMenu={e => imageMenu(e, url ?? null, { view: true })}>
    {url ? <img src={url} alt={alt} loading="lazy" onError={() => setError(true)} /> : <span>Cargando imagen…</span>}
  </button>
}
