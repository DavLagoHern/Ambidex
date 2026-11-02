import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { ExtItem, Extensions } from '@shared/types'
import { parseToml } from './toml-lite'

// Lo que cada CLI tiene instalado o configurado: plugins, skills, subagentes, comandos, servidores MCP, hooks
// e instrucciones. Solo se lee. De los servidores MCP se enseña nombre, tipo y comando o URL, nunca variables
// de entorno, cabeceras ni tokens.

const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return undefined
  }
}
const readText = (f: string) => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const list = (dir: string) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') || n === '.system')
  } catch {
    return []
  }
}

// Cabecera YAML de un .md (name, description…): lo justo para enseñarlo
export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    // texto en varias líneas (description: > o |)
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      v = block.join(' ')
    }
    out[kv[1]] = v.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return out
}

// SKILL.md dentro de una carpeta (hasta dos niveles: skills/<nombre>/SKILL.md y skills/<grupo>/<nombre>/SKILL.md)
function skills(dir: string, source: string): ExtItem[] {
  const out: ExtItem[] = []
  const visit = (d: string, depth: number) => {
    for (const n of list(d)) {
      const p = join(d, n)
      if (!isDir(p)) continue
      const f = join(p, 'SKILL.md')
      if (existsSync(f)) {
        const fm = frontmatter(readText(f))
        out.push({ kind: 'skill', name: fm.name || n, description: fm.description, source, path: f })
      } else if (depth < 2) visit(p, depth + 1)
    }
  }
  visit(dir, 0)
  return out
}

function markdowns(dir: string, kind: 'agent' | 'command', source: string): ExtItem[] {
  const out: ExtItem[] = []
  const visit = (d: string, prefix: string) => {
    for (const n of list(d)) {
      const p = join(d, n)
      if (isDir(p)) visit(p, `${prefix}${n}:`)
      else if (n.endsWith('.md')) {
        const fm = frontmatter(readText(p))
        out.push({ kind, name: kind === 'command' ? `/${prefix}${n.slice(0, -3)}` : fm.name || n.slice(0, -3), description: fm.description, source, path: p })
      }
    }
  }
  visit(dir, '')
  return out
}

// Servidor MCP sin secretos: tipo y qué ejecuta o a qué se conecta
function mcp(name: string, s: any, source: string, path: string): ExtItem {
  const url = typeof s?.url === 'string' ? s.url.replace(/([?&](?:key|token|api_key|apikey)=)[^&]*/gi, '$1…') : undefined
  const cmd = typeof s?.command === 'string' ? [s.command, ...(Array.isArray(s.args) ? s.args.filter((a: unknown) => typeof a === 'string') : [])].join(' ') : undefined
  const type = s?.type ?? (url ? 'http' : 'stdio')
  const what = (url ?? cmd ?? '').slice(0, 160)
  return { kind: 'mcp', name, source, path, enabled: s?.enabled !== false && !s?.disabled, detail: what ? `${type} · ${what}` : type }
}

function hooks(h: any, source: string, path: string): ExtItem[] {
  if (!h || typeof h !== 'object') return []
  return Object.entries(h).map(([event, v]) => ({
    kind: 'hook' as const,
    name: event,
    source,
    path,
    detail: `${Array.isArray(v) ? v.length : 1} ${Array.isArray(v) && v.length === 1 ? 'regla' : 'reglas'}`
  }))
}

function instructions(files: string[], source: string): ExtItem[] {
  return files.filter((f) => existsSync(f) && readText(f).trim()).map((f) => ({ kind: 'instructions' as const, name: basename(f), source, path: f }))
}

// Un plugin y lo que trae dentro (skills, subagentes, comandos, MCP, hooks)
function pluginContents(root: string, label: string, manifestDir: string): { info: any; items: ExtItem[] } {
  const info = readJson(join(root, manifestDir, 'plugin.json')) ?? {}
  const src = `Plugin ${label}`
  const items = [
    ...skills(join(root, 'skills'), src),
    ...markdowns(join(root, 'agents'), 'agent', src),
    ...markdowns(join(root, 'commands'), 'command', src),
    ...Object.entries(readJson(join(root, '.mcp.json'))?.mcpServers ?? info.mcpServers ?? {}).map(([n, s]) => mcp(n, s, src, join(root, '.mcp.json'))),
    ...hooks(readJson(join(root, 'hooks', 'hooks.json'))?.hooks, src, join(root, 'hooks', 'hooks.json'))
  ]
  return { info, items }
}

export function claudeExtensions(home: string, project?: string): ExtItem[] {
  const base = join(home, '.claude')
  const settings = readJson(join(base, 'settings.json')) ?? {}
  const enabled: Record<string, boolean> = settings.enabledPlugins ?? {}
  const out: ExtItem[] = []
  const installed = readJson(join(base, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  for (const [id, entries] of Object.entries<any>(installed)) {
    const e = Array.isArray(entries) ? entries[0] : entries
    const name = id.split('@')[0]
    const { info, items } = e?.installPath && isDir(e.installPath) ? pluginContents(e.installPath, name, '.claude-plugin') : { info: {}, items: [] }
    const count = (k: ExtItem['kind']) => items.filter((i) => i.kind === k).length
    const parts = [count('skill') && `${count('skill')} skills`, count('agent') && `${count('agent')} agentes`, count('command') && `${count('command')} comandos`, count('mcp') && `${count('mcp')} MCP`].filter(Boolean)
    out.push({
      kind: 'plugin',
      name,
      description: info.description,
      source: id.includes('@') ? `Marketplace ${id.split('@')[1]}` : 'Usuario',
      path: e?.installPath,
      enabled: enabled[id] !== false,
      detail: [e?.version ?? info.version, ...parts].filter(Boolean).join(' · ')
    })
    out.push(...items)
  }
  out.push(...skills(join(base, 'skills'), 'Usuario'))
  out.push(...markdowns(join(base, 'agents'), 'agent', 'Usuario'))
  out.push(...markdowns(join(base, 'commands'), 'command', 'Usuario'))
  out.push(...hooks(settings.hooks, 'Usuario', join(base, 'settings.json')))
  const userJson = readJson(join(home, '.claude.json')) ?? {}
  out.push(...Object.entries(userJson.mcpServers ?? {}).map(([n, s]) => mcp(n, s, 'Usuario', join(home, '.claude.json'))))
  out.push(...instructions([join(base, 'CLAUDE.md')], 'Usuario'))
  if (project) {
    const pc = join(project, '.claude')
    out.push(...skills(join(pc, 'skills'), 'Proyecto'))
    out.push(...markdowns(join(pc, 'agents'), 'agent', 'Proyecto'))
    out.push(...markdowns(join(pc, 'commands'), 'command', 'Proyecto'))
    out.push(...hooks(readJson(join(pc, 'settings.json'))?.hooks, 'Proyecto', join(pc, 'settings.json')))
    out.push(...Object.entries(readJson(join(project, '.mcp.json'))?.mcpServers ?? {}).map(([n, s]) => mcp(n, s, 'Proyecto', join(project, '.mcp.json'))))
    out.push(...Object.entries(userJson.projects?.[project]?.mcpServers ?? {}).map(([n, s]) => mcp(n, s, 'Proyecto (local)', join(home, '.claude.json'))))
    out.push(...instructions([join(project, 'CLAUDE.md'), join(pc, 'CLAUDE.md')], 'Proyecto'))
  }
  return out
}

export function codexExtensions(codexHome: string, project?: string): ExtItem[] {
  const out: ExtItem[] = []
  const configFile = join(codexHome, 'config.toml')
  const config = parseToml(readText(configFile)) as any
  const enabled: Record<string, any> = config.plugins ?? {}
  // plugins: caché/<marketplace>/<plugin>/<versión>/.codex-plugin/plugin.json
  const cache = join(codexHome, 'plugins', 'cache')
  const seen = new Set<string>()
  for (const mkt of list(cache))
    for (const plugin of list(join(cache, mkt))) {
      const versions = list(join(cache, mkt, plugin)).map((v) => join(cache, mkt, plugin, v))
      const root = versions.filter((v) => existsSync(join(v, '.codex-plugin', 'plugin.json'))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      const id = `${plugin}@${mkt}`
      if (!root || seen.has(id)) continue
      seen.add(id)
      const { info, items } = pluginContents(root, plugin, '.codex-plugin')
      // solo los instalados (los que config.toml nombra); la caché trae también los del catálogo
      const on = enabled[id]?.enabled
      if (on === undefined) continue
      out.push({
        kind: 'plugin',
        name: info.interface?.displayName ?? info.name ?? plugin,
        description: info.description ?? info.interface?.shortDescription,
        source: `Marketplace ${mkt}`,
        path: root,
        enabled: on === true,
        detail: [info.version, items.filter((i) => i.kind === 'skill').length && `${items.filter((i) => i.kind === 'skill').length} skills`].filter(Boolean).join(' · ')
      })
      if (on === true) out.push(...items)
    }
  for (const s of skills(join(codexHome, 'skills'), 'Usuario')) out.push(s.path?.includes(`${join('skills', '.system')}`) ? { ...s, source: 'Sistema' } : s)
  out.push(...markdowns(join(codexHome, 'prompts'), 'command', 'Usuario'))
  out.push(...Object.entries(config.mcp_servers ?? {}).map(([n, s]) => mcp(n, s, 'Usuario', configFile)))
  out.push(...instructions([join(codexHome, 'AGENTS.md')], 'Usuario'))
  if (project) {
    const pf = join(project, '.codex', 'config.toml')
    out.push(...Object.entries((parseToml(readText(pf)) as any).mcp_servers ?? {}).map(([n, s]) => mcp(n, s, 'Proyecto', pf)))
    out.push(...skills(join(project, '.codex', 'skills'), 'Proyecto'))
    out.push(...instructions([join(project, 'AGENTS.md'), join(project, 'AGENTS.override.md')], 'Proyecto'))
  }
  return out
}

export function scanExtensions(home: string, codexHome: string, project?: string): Extensions {
  const errors: string[] = []
  const safe = (f: () => ExtItem[], label: string) => {
    try {
      return f()
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`)
      return []
    }
  }
  return {
    claude: safe(() => claudeExtensions(home, project), 'Claude Code'),
    codex: safe(() => codexExtensions(codexHome, project), 'Codex'),
    errors
  }
}
