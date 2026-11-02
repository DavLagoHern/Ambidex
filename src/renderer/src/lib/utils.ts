export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export const basename = (p: string) => p.split('/').filter(Boolean).pop() || p
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/')
export const relPath = (root: string, p: string) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p)
// Nombre legible de una herramienta: las de la Web de la app y las de otros servidores MCP (mcp__servidor__herramienta)
const WEB_TOOLS: Record<string, string> = {
  web_open: 'abrir',
  web_snapshot: 'leer la página',
  web_click: 'pulsar',
  web_type: 'escribir',
  web_press: 'tecla',
  web_scroll: 'desplazar',
  web_back: 'atrás',
  web_screenshot: 'captura',
  web_console: 'consola'
}
export function toolName(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  if (!m) return name
  if (m[1] === 'ambidex_web' || m[1] === 'codeai_web') return `Web · ${WEB_TOOLS[m[2]] ?? m[2]}`
  return `${m[1]} · ${m[2]}`
}

export const joinPath = (a: string, b: string) => (b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`)

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', zsh: 'shell',
  bash: 'shell', sql: 'sql', toml: 'ini', ini: 'ini', env: 'ini', dockerfile: 'dockerfile', graphql: 'graphql', lua: 'lua', dart: 'dart'
}

export function langFor(path: string): string {
  const name = basename(path).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return LANGS[ext] || 'plaintext'
}

export function timeAgo(epochSec: number): string {
  const s = Math.floor(Date.now() / 1000 - epochSec)
  if (s < 60) return 'ahora'
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`
  return new Date(epochSec * 1000).toLocaleDateString()
}

export function untilText(epochSec?: number): string {
  if (!epochSec) return ''
  const s = Math.max(0, Math.floor(epochSec - Date.now() / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  return `${m} min`
}

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const errMsg = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

// Puntuación para búsqueda difusa de rutas: prefijo del nombre > contiene > letras en orden
export function fuzzyScore(path: string, q: string): number {
  if (!q) return 1
  const p = path.toLowerCase()
  const name = basename(p)
  if (name.startsWith(q)) return 100 - name.length
  if (name.includes(q)) return 60 - name.length
  if (p.includes(q)) return 30 - p.length / 100
  let i = 0
  for (const ch of p) if (ch === q[i]) i++
  return i === q.length ? 10 - p.length / 100 : -1
}
