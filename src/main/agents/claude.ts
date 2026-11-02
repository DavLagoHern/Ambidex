import { readFileSync } from 'fs'
import type { AgentEvent, AgentLimits, ClaudeMode, LimitWindow } from '@shared/types'
import { imageMime } from '../attachments'
import { Adapter, parseJson, RunRequest, short } from './types'

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 h',
  seven_day: 'Semana',
  seven_day_opus: 'Semana Opus',
  seven_day_sonnet: 'Semana Sonnet'
}

const CLAUDE_MODES: ClaudeMode[] = ['plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual']

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const i = input || {}
  switch (name) {
    case 'Bash':
      return String(i.command ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return String(i.file_path ?? i.notebook_path ?? '')
    case 'Grep':
      return `${i.pattern ?? ''}${i.path ? `  en ${i.path}` : ''}`
    case 'Glob':
      return String(i.pattern ?? '')
    case 'WebFetch':
      return String(i.url ?? '')
    case 'WebSearch':
      return String(i.query ?? '')
    case 'Task':
    case 'Agent':
      return String(i.description ?? i.prompt ?? '')
    default:
      return short(i, 600)
  }
}

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

export const claudeAdapter: Adapter = {
  agent: 'claude',

  buildArgs(req: RunRequest) {
    const mode = CLAUDE_MODES.includes(req.permission as ClaudeMode) ? (req.permission as ClaudeMode) : 'acceptEdits'
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      mode,
      // sin un host que responda, lo que requeriría permiso se deniega y se informa en el resultado
      '--permission-prompts',
      'none'
    ]
    // con imágenes, el mensaje va como JSON con bloques de texto e imagen (ver stdin)
    if (req.images?.length) args.push('--input-format', 'stream-json')
    if (req.resumeId) args.push('--resume', req.resumeId)
    if (req.resumeId && req.fork) args.push('--fork-session')
    if (req.model) args.push('--model', req.model)
    if (req.effort) args.push('--effort', req.effort)
    if (req.schema) args.push('--json-schema', req.schema.json)
    if (req.allowedTools?.length) args.push('--allowedTools', req.allowedTools.join(','))
    if (req.extra?.length) args.push(...req.extra)
    return args
  },

  stdin(text, req) {
    if (!req.images?.length) return text
    const content = [
      { type: 'text', text },
      ...req.images.map((p) => ({ type: 'image', source: { type: 'base64', media_type: imageMime(p), data: readFileSync(p).toString('base64') } }))
    ]
    return JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }) + '\n'
  },

  createParser() {
    const tools = new Map<string, { name: string; input: Record<string, unknown> }>()
    return {
      onLine(line) {
        const d = parseJson(line)
        if (!d || typeof d !== 'object') return []
        const out: AgentEvent[] = []
        switch (d.type) {
          case 'system':
            if (d.subtype === 'init') out.push({ kind: 'session', sessionId: d.session_id, model: d.model })
            else if (d.subtype === 'compact_boundary') out.push({ kind: 'notice', text: 'Contexto compactado' })
            break
          case 'rate_limit_event': {
            const info = d.rate_limit_info || {}
            const windows: LimitWindow[] = Object.entries(info.unifiedWindows || {}).map(([k, w]: [string, any]) => ({
              label: WINDOW_LABELS[k] || k,
              usedPercent: Math.round((w?.utilization ?? 0) * 100),
              resetsAt: w?.resetsAt
            }))
            const limits: AgentLimits = { agent: 'claude', windows, status: info.status, updatedAt: Date.now() }
            out.push({ kind: 'limits', limits })
            break
          }
          case 'stream_event': {
            const e = d.event
            if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !d.parent_tool_use_id)
              out.push({ kind: 'text', text: e.delta.text, streaming: true })
            break
          }
          case 'assistant':
            if (d.parent_tool_use_id) break // texto de subagentes: ya se resume en la herramienta Task
            for (const block of d.message?.content || []) {
              if (block.type === 'text') out.push({ kind: 'text', text: block.text })
              else if (block.type === 'thinking' && block.thinking) out.push({ kind: 'thinking', text: block.thinking })
              else if (block.type === 'tool_use') {
                tools.set(block.id, { name: block.name, input: block.input })
                // con --json-schema, Claude entrega el resultado mediante esta herramienta
                if (block.name === 'StructuredOutput') out.push({ kind: 'structured', data: block.input })
                else if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
                  out.push({ kind: 'todo', items: block.input.todos.map((t: any) => ({ text: String(t.content ?? ''), done: t.status === 'completed' })) })
                } else {
                  out.push({ kind: 'tool', id: block.id, name: block.name, input: toolSummary(block.name, block.input), status: 'running' })
                }
              }
            }
            break
          case 'user':
            for (const block of d.message?.content || []) {
              if (block.type !== 'tool_result') continue
              const t = tools.get(block.tool_use_id)
              if (t?.name === 'TodoWrite' || t?.name === 'StructuredOutput') continue
              const content = Array.isArray(block.content)
                ? block.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
                : block.content
              out.push({
                kind: 'tool',
                id: block.tool_use_id,
                name: t?.name || 'tool',
                input: t ? toolSummary(t.name, t.input) : '',
                status: block.is_error ? 'error' : 'done',
                output: short(content ?? '')
              })
              if (t && !block.is_error && EDIT_TOOLS.includes(t.name)) {
                out.push({
                  kind: 'files',
                  id: block.tool_use_id,
                  files: [{ path: String(t.input.file_path ?? t.input.notebook_path), change: t.name === 'Write' ? 'write' : 'edit' }]
                })
              }
            }
            break
          case 'result': {
            if (d.structured_output !== undefined && d.structured_output !== null) out.push({ kind: 'structured', data: d.structured_output })
            const u = d.usage || {}
            out.push({
              kind: 'usage',
              usage: {
                inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                cachedTokens: u.cache_read_input_tokens || 0,
                outputTokens: u.output_tokens || 0,
                reasoningTokens: u.output_tokens_details?.thinking_tokens,
                costUsd: d.total_cost_usd,
                durationMs: d.duration_ms,
                numTurns: d.num_turns
              }
            })
            const denials = Array.isArray(d.permission_denials) ? d.permission_denials : []
            if (denials.length)
              out.push({
                kind: 'permission',
                denials: denials.map((p: any) => ({ tool: String(p.tool_name ?? 'tool'), input: toolSummary(p.tool_name, p.tool_input) }))
              })
            if (d.is_error) out.push({ kind: 'error', message: String(d.result || d.subtype || 'Error de Claude Code') })
            break
          }
        }
        return out
      }
    }
  },

  isNoise(line) {
    return /OAuth|oauth/.test(line)
  }
}
