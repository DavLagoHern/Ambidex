import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { zstdDecompressSync } from 'zlib'
import type { ChatItem, ExternalSession } from '@shared/types'
import { toolSummary } from './agents/claude'

// Conversaciones de Claude Code y Codex empezadas fuera de la app (terminal, VS Code…) en la carpeta del proyecto.
// Solo se leen; al continuarlas, la app guarda su propia copia y le pide al CLI que siga la misma sesión.

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Carpeta de ~/.claude/projects que corresponde a una ruta (como la calcula Claude Code)
export function claudeSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  return `${slug.slice(0, 200)}-${Math.abs(h).toString(36)}`
}

function readPart(file: string, bytes: number, fromEnd: boolean): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const lines = (text: string): any[] =>
  text.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })

// Bloques que el editor o la app inyectan en el mensaje del usuario (no los escribió él)
const INJECTED = /<(system-reminder|browser_instruction|ide_[\w-]+|command-[\w-]+|local-command-[\w-]+|environment_context|recommended_plugins|user_instructions)>[\s\S]*?<\/\1>\s*/g
const clean = (t: string) => t.replace(INJECTED, '').trim()

function claudeUserText(d: any): string {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return ''
  const c = d.message?.content
  if (typeof c === 'string') return clean(c)
  if (!Array.isArray(c)) return ''
  return clean(c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n'))
}

function liveClaude(home: string): Set<string> {
  const out = new Set<string>()
  const dir = join(home, '.claude', 'sessions')
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      process.kill(Number(s.pid), 0)
      if (s.sessionId) out.add(String(s.sessionId))
    } catch {
      /* proceso que ya no existe */
    }
  }
  return out
}

export const isClaudeLive = (home: string, sessionId: string) => liveClaude(home).has(sessionId)

const ENTRY: Record<string, string> = { cli: 'Terminal', 'claude-vscode': 'VS Code', 'sdk-cli': 'SDK', 'sdk-ts': 'SDK', 'sdk-py': 'SDK' }

export function claudeSessions(home: string, root: string, limit = 40): ExternalSession[] {
  const dir = join(home, '.claude', 'projects', claudeSlug(real(root)))
  if (!existsSync(dir)) return []
  const live = liveClaude(home)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
  const out: ExternalSession[] = []
  for (const { f, m } of files) {
    const head = lines(readPart(f, 256 * 1024, false))
    const first = head.map(claudeUserText).find(Boolean)
    if (!first) continue
    const tail = lines(readPart(f, 256 * 1024, true))
    const title = [...tail].reverse().find((d) => d.type === 'custom-title')?.customTitle ?? [...tail].reverse().find((d) => d.type === 'ai-title')?.aiTitle
    const meta = head.find((d) => d.sessionId && d.entrypoint) ?? head.find((d) => d.sessionId)
    const id = meta?.sessionId ?? f.split('/').pop()!.replace(/\.jsonl$/, '')
    out.push({
      agent: 'claude',
      id,
      title: String(title || first).split('\n')[0].slice(0, 120),
      updatedAt: m,
      source: ENTRY[meta?.entrypoint] ?? meta?.entrypoint ?? 'Claude Code',
      live: live.has(id)
    })
  }
  return out
}

export function claudeTranscript(home: string, root: string, id: string): ChatItem[] {
  const f = join(home, '.claude', 'projects', claudeSlug(real(root)), `${id}.jsonl`)
  if (!/^[\w-]+$/.test(id) || !existsSync(f)) throw new Error('Esa conversación ya no existe')
  const out: ChatItem[] = []
  let lastMsg = ''
  for (const d of lines(readFileSync(f, 'utf8'))) {
    const at = Date.parse(d.timestamp) || Date.now()
    const user = claudeUserText(d)
    if (user) {
      out.push({ id: d.uuid ?? `u${out.length}`, type: 'user', text: user, at })
      lastMsg = ''
      continue
    }
    if (d.type !== 'assistant' || d.isSidechain || !Array.isArray(d.message?.content)) continue
    for (const b of d.message.content) {
      if (b?.type === 'text' && b.text?.trim()) {
        const prev = out[out.length - 1]
        // las respuestas largas llegan partidas en varios registros del mismo mensaje
        if (prev?.type === 'assistant' && lastMsg && lastMsg === d.message.id) prev.text += '\n\n' + b.text
        else out.push({ id: `${d.uuid}-t${out.length}`, type: 'assistant', text: b.text, at })
        lastMsg = d.message.id
      } else if (b?.type === 'tool_use') {
        out.push({ id: `${d.uuid}-${b.id}`, type: 'tool', toolId: String(b.id), name: String(b.name), input: toolSummary(String(b.name), b.input ?? {}), status: 'done', at })
        lastMsg = ''
      }
    }
  }
  return out
}

function codexIndex(codexHome: string): DatabaseSync | null {
  const f = join(codexHome, 'state_5.sqlite')
  if (!existsSync(f)) return null
  try {
    return new DatabaseSync(f, { readOnly: true })
  } catch {
    return null
  }
}

const CODEX_SOURCE: Record<string, string> = { cli: 'Terminal', exec: 'codex exec', vscode: 'VS Code' }

export function codexSessions(codexHome: string, root: string, limit = 40): ExternalSession[] {
  const db = codexIndex(codexHome)
  if (!db) return []
  try {
    const rows = db
      .prepare('SELECT id, title, first_user_message, updated_at, source FROM threads WHERE cwd IN (?, ?) AND archived = 0 ORDER BY updated_at DESC LIMIT ?')
      .all(root, real(root), limit) as any[]
    return rows
      .filter((r) => typeof r.source !== 'string' || !r.source.startsWith('{')) // los subagentes de Codex no se listan
      .map((r) => ({
        agent: 'codex' as const,
        id: String(r.id),
        title: clean(String(r.title || r.first_user_message || 'Conversación de Codex')).split('\n')[0].slice(0, 120),
        updatedAt: Number(r.updated_at) * 1000,
        source: CODEX_SOURCE[r.source] ?? String(r.source ?? 'Codex')
      }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function codexTranscript(codexHome: string, root: string, id: string): ChatItem[] {
  const db = codexIndex(codexHome)
  if (!db) throw new Error('No se encuentra el índice de conversaciones de Codex')
  let path: string | undefined
  try {
    path = (db.prepare('SELECT rollout_path FROM threads WHERE id = ? AND cwd IN (?, ?)').get(id, root, real(root)) as any)?.rollout_path
  } finally {
    db.close()
  }
  if (!path) throw new Error('Esa conversación ya no existe')
  // Codex comprime las conversaciones antiguas (.jsonl.zst) aunque el índice siga diciendo .jsonl
  const text = existsSync(path) ? readFileSync(path, 'utf8') : existsSync(path + '.zst') ? zstdDecompressSync(readFileSync(path + '.zst')).toString('utf8') : null
  if (text === null) throw new Error('No se encuentra el fichero de la conversación')
  const out: ChatItem[] = []
  const records = lines(text)
  for (const d of records) {
    const item = d.type === 'event_msg' && d.payload?.type === 'item_completed' ? d.payload.item : null
    if (!item) continue
    const at = Date.parse(d.timestamp) || Date.now()
    const t = clean((item.content ?? []).map((c: any) => c?.text ?? '').join('\n'))
    if (!t) continue
    if (item.type === 'UserMessage') out.push({ id: `${item.id ?? out.length}`, type: 'user', text: t, at })
    else if (item.type === 'AgentMessage') out.push({ id: `${item.id ?? out.length}`, type: 'assistant', text: t, at })
  }
  if (out.length) return out
  // formato anterior: mensajes como response_item
  for (const d of records) {
    const p = d.type === 'response_item' ? d.payload : null
    if (p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
    const t = clean((p.content ?? []).map((c: any) => c?.text ?? '').join('\n'))
    if (t) out.push({ id: `r${out.length}`, type: p.role, text: t, at: Date.parse(d.timestamp) || Date.now() } as ChatItem)
  }
  return out
}
