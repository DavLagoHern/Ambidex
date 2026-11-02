import type { AgentEvent, ChatItem, TurnUsage } from './types'

export interface ReduceContext {
  cwd: string
  newId: () => string
  now: number
}

export interface ReduceResult {
  // elementos nuevos o modificados, en orden de aparición
  changed: ChatItem[]
  agentSessionId?: string
  usage?: TurnUsage
}

const joinPath = (a: string, b: string) => (b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`)

// Busca hacia atrás hasta el último mensaje del usuario (el turno actual)
function findInTurn(items: ChatItem[], pred: (i: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'user') return -1
    if (pred(items[i])) return i
  }
  return -1
}

// Aplica un evento normalizado de un agente sobre la lista de elementos del chat (la modifica in situ).
export function reduceEvent(items: ChatItem[], ev: AgentEvent, ctx: ReduceContext): ReduceResult {
  const res: ReduceResult = { changed: [] }
  const push = (item: ChatItem) => {
    items.push(item)
    res.changed.push(item)
  }
  const replace = (idx: number, item: ChatItem) => {
    items[idx] = item
    res.changed.push(item)
  }

  switch (ev.kind) {
    case 'session':
      res.agentSessionId = ev.sessionId
      break
    case 'text': {
      const idx = findInTurn(items, (i) => i.type === 'assistant' && !!i.streaming)
      const cur = idx >= 0 ? (items[idx] as Extract<ChatItem, { type: 'assistant' }>) : null
      if (ev.streaming) {
        if (cur && idx === items.length - 1) replace(idx, { ...cur, text: cur.text + ev.text })
        else push({ id: ctx.newId(), type: 'assistant', text: ev.text, streaming: true, at: ctx.now })
      } else if (cur) {
        replace(idx, { ...cur, text: ev.text, streaming: false })
      } else {
        push({ id: ctx.newId(), type: 'assistant', text: ev.text, at: ctx.now })
      }
      break
    }
    case 'thinking':
      push({ id: ctx.newId(), type: 'thinking', text: ev.text, at: ctx.now })
      break
    case 'tool': {
      const idx = items.findIndex((i) => i.type === 'tool' && i.toolId === ev.id)
      const item: ChatItem = {
        id: idx >= 0 ? items[idx].id : ctx.newId(),
        type: 'tool',
        toolId: ev.id,
        name: ev.name,
        input: ev.input,
        status: ev.status,
        output: ev.output,
        at: idx >= 0 ? items[idx].at : ctx.now
      }
      if (idx >= 0) replace(idx, item)
      else push(item)
      break
    }
    case 'files': {
      const files = ev.files.map((f) => ({ ...f, path: joinPath(ctx.cwd, f.path) }))
      const idx = findInTurn(items, (i) => i.type === 'files')
      if (idx >= 0) {
        const prev = items[idx] as Extract<ChatItem, { type: 'files' }>
        const merged = [...prev.files]
        for (const f of files) if (!merged.some((m) => m.path === f.path)) merged.push(f)
        replace(idx, { ...prev, files: merged })
      } else push({ id: ctx.newId(), type: 'files', files, at: ctx.now })
      break
    }
    case 'todo': {
      const idx = findInTurn(items, (i) => i.type === 'todo')
      if (idx >= 0) replace(idx, { ...(items[idx] as Extract<ChatItem, { type: 'todo' }>), items: ev.items })
      else push({ id: ctx.newId(), type: 'todo', items: ev.items, at: ctx.now })
      break
    }
    case 'usage':
      push({ id: ctx.newId(), type: 'usage', usage: ev.usage, at: ctx.now })
      res.usage = ev.usage
      break
    case 'permission':
      if (ev.denials.length) push({ id: ctx.newId(), type: 'permission', denials: ev.denials, at: ctx.now })
      break
    case 'notice':
      push({ id: ctx.newId(), type: 'notice', text: ev.text, at: ctx.now })
      break
    case 'error':
      push({ id: ctx.newId(), type: 'error', text: ev.message, at: ctx.now })
      break
    case 'limits':
    case 'structured':
      break
  }
  return res
}

// Cierra el turno: nada queda en streaming ni "ejecutándose"
export function finalizeTurn(items: ChatItem[], interrupted: boolean): ChatItem[] {
  const changed: ChatItem[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'user') break
    if (it.type === 'assistant' && it.streaming) {
      items[i] = { ...it, streaming: false }
      changed.push(items[i])
    } else if (it.type === 'tool' && it.status === 'running') {
      items[i] = { ...it, status: interrupted ? 'error' : 'done' }
      changed.push(items[i])
    }
  }
  return changed.reverse()
}

// Texto indexable para la búsqueda en el historial
export function searchText(item: ChatItem): string | null {
  switch (item.type) {
    case 'user':
    case 'assistant':
      return item.text
    case 'tool':
      return `${item.name} ${item.input}`
    case 'files':
      return item.files.map((f) => f.path).join(' ')
    case 'error':
      return item.text
    default:
      return null
  }
}

export function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split('\n')[0].replace(/\s+/g, ' ')
  return first.length > 60 ? first.slice(0, 57) + '…' : first || 'Nueva conversación'
}
