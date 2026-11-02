// Lector de TOML suficiente para config.toml de Codex: tablas, claves con puntos y comillas, cadenas,
// números, booleanos, listas (también en varias líneas) y tablas en línea. Lo que no entiende lo ignora.

type Table = Record<string, unknown>

function splitKey(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === '.') i++
    if (i >= s.length) break
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      let v = ''
      while (j < s.length && s[j] !== q) {
        if (q === '"' && s[j] === '\\' && j + 1 < s.length) v += s[++j]
        else v += s[j]
        j++
      }
      out.push(v)
      i = j + 1
    } else {
      let j = i
      while (j < s.length && s[j] !== '.' && s[j] !== ' ' && s[j] !== '\t') j++
      out.push(s.slice(i, j))
      i = j
    }
  }
  return out
}

// Parte una lista o tabla en línea por comas de primer nivel
function splitTop(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += s[++i] ?? ''
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") (quote = c), (cur += c)
    else if (c === '[' || c === '{') depth++, (cur += c)
    else if (c === ']' || c === '}') depth--, (cur += c)
    else if (c === ',' && depth === 0) parts.push(cur), (cur = '')
    else cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function value(raw: string): unknown {
  const s = raw.trim()
  if (s.startsWith('"')) {
    let out = ''
    for (let i = 1; i < s.length && s[i] !== '"'; i++) {
      if (s[i] === '\\') {
        const n = s[++i]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n
      } else out += s[i]
    }
    return out
  }
  if (s.startsWith("'")) return s.slice(1, s.indexOf("'", 1))
  if (s === 'true' || s === 'false') return s === 'true'
  if (s.startsWith('[')) return splitTop(s.slice(1, s.lastIndexOf(']'))).map(value)
  if (s.startsWith('{')) {
    const t: Table = {}
    for (const kv of splitTop(s.slice(1, s.lastIndexOf('}')))) {
      const eq = kv.indexOf('=')
      if (eq > 0) set(t, splitKey(kv.slice(0, eq)), value(kv.slice(eq + 1)))
    }
    return t
  }
  const n = Number(s.replace(/_/g, ''))
  return Number.isFinite(n) ? n : s
}

function set(root: Table, path: string[], v: unknown) {
  let t = root
  for (const k of path.slice(0, -1)) {
    if (typeof t[k] !== 'object' || t[k] === null || Array.isArray(t[k])) t[k] = {}
    t = t[k] as Table
  }
  t[path[path.length - 1]] = v
}

function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

const balance = (s: string) => {
  let d = 0
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') d++
    else if (c === ']' || c === '}') d--
  }
  return d
}

export function parseToml(text: string): Table {
  const root: Table = {}
  let section: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim()
    if (!line) continue
    if (line.startsWith('[[')) {
      section = ['__array__'] // listas de tablas: no se usan aquí
      continue
    }
    if (line.startsWith('[')) {
      section = splitKey(line.slice(1, line.lastIndexOf(']')))
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0 || section[0] === '__array__') continue
    // listas y tablas en varias líneas
    while (balance(line) > 0 && i + 1 < lines.length) line += ' ' + stripComment(lines[++i]).trim()
    try {
      set(root, [...section, ...splitKey(line.slice(0, eq))], value(line.slice(eq + 1)))
    } catch {
      /* línea que no se entiende */
    }
  }
  return root
}
