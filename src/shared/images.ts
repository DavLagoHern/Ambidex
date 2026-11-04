// Local image references and supported inline image blocks from agent tools.
export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path)
export function cleanFileRef(ref: string): string {
  const value = ref.trim().replace(/^<([\s\S]*)>$/, '$1').replace(/^file:\/\//, '')
  try { return decodeURI(value) } catch { return value }
}
export function toolImages(value: unknown): string[] {
  const found = new Set<string>()
  function visit(v: any, depth = 0) {
    if (!v || depth > 12 || found.size >= 20) return
    if (typeof v === 'string') {
      if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(v)) found.add(v)
      else if (v.startsWith('/') && isImagePath(v) && !v.includes('\n')) found.add(v)
      else {
        // Paths in CLI output (including generated_images save notices).
        // Scan each token once. Nested repetitions over slash-separated paths can
        // backtrack exponentially on ordinary tool output with no image suffix.
        for (const [token] of v.matchAll(/[^\s<>"'`]+/g)) {
          const start = token.indexOf('/')
          if (start < 0) continue
          const suffix = /\.(?:png|jpe?g|gif|webp)\b/i.exec(token.slice(start))
          if (suffix) found.add(token.slice(start, start + suffix.index + suffix[0].length))
          if (found.size >= 20) break
        }
      }
    } else if (Array.isArray(v)) v.forEach(x => visit(x, depth + 1))
    else if (typeof v === 'object') {
      const source = v.source ?? v
      if ((v.type === 'image' || v.mimeType?.startsWith('image/')) && source.data && /^image\/(png|jpeg|gif|webp)$/.test(source.media_type ?? v.mimeType))
        found.add(`data:${source.media_type ?? v.mimeType};base64,${source.data}`)
      for (const [key, x] of Object.entries(v)) if (key !== 'data') visit(x, depth + 1)
    }
  }
  visit(value)
  return [...found]
}
