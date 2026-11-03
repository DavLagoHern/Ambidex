import type { ChatItem } from './types'

export type Step = Extract<ChatItem, { type: 'tool' | 'thinking' | 'assistant' }>
export type TurnEntry = { kind: 'item'; item: ChatItem } | { kind: 'steps'; key: string; steps: Step[] }

// Pliega bloques anteriores mientras trabaja y agrupa la actividad al finalizar.
export function collapseTurn(items: ChatItem[], done: boolean): TurnEntry[] {
  if (!done) {
    const out: TurnEntry[] = []
    let group: Extract<TurnEntry, { kind: 'steps' }> | null = null
    // Un mensaje nuevo cierra el bloque anterior. Las acciones actuales siguen visibles.
    const lastMessage = items.findLastIndex((item) => item.type === 'assistant' || item.type === 'user')
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (index < lastMessage && (item.type === 'tool' || item.type === 'thinking') && !(item.type === 'tool' && item.status === 'running')) {
        if (!group) {
          group = { kind: 'steps', key: `steps-${item.id}`, steps: [] }
          out.push(group)
        }
        group.steps.push(item)
      } else {
        group = null
        out.push({ kind: 'item', item })
      }
    }
    return out
  }
  const final = items.findLast((i) => i.type === 'assistant')
  const out: TurnEntry[] = []
  let group: Extract<TurnEntry, { kind: 'steps' }> | null = null
  for (const it of items) {
    if ((it.type === 'tool' || it.type === 'thinking' || it.type === 'assistant') && it !== final) {
      if (!group) {
        group = { kind: 'steps', key: `steps-${it.id}`, steps: [] }
        out.push(group)
      }
      group.steps.push(it)
    } else out.push({ kind: 'item', item: it })
  }
  return out
}

