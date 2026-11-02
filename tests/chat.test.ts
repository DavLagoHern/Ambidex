import { describe, expect, it } from 'vitest'
import { finalizeTurn, reduceEvent, titleFromPrompt } from '../src/shared/chat'
import type { AgentEvent, ChatItem } from '../src/shared/types'

let n = 0
const ctx = { cwd: '/repo', newId: () => `id${n++}`, now: 1 }
const run = (items: ChatItem[], evs: AgentEvent[]) => evs.flatMap((e) => reduceEvent(items, e, ctx).changed)

describe('reductor del chat', () => {
  it('acumula deltas en un mensaje y lo cierra con el texto final', () => {
    const items: ChatItem[] = [{ id: 'u', type: 'user', text: 'hola', at: 0 }]
    run(items, [
      { kind: 'text', text: 'Ho', streaming: true },
      { kind: 'text', text: 'la', streaming: true },
      { kind: 'text', text: 'Hola.' }
    ])
    expect(items.slice(1)).toEqual([expect.objectContaining({ type: 'assistant', text: 'Hola.', streaming: false })])
  })

  it('un mensaje nuevo tras una herramienta crea otra burbuja', () => {
    const items: ChatItem[] = [{ id: 'u', type: 'user', text: 'x', at: 0 }]
    run(items, [
      { kind: 'text', text: 'Leo', streaming: true },
      { kind: 'text', text: 'Leo' },
      { kind: 'tool', id: 't1', name: 'Read', input: 'a', status: 'running' },
      { kind: 'tool', id: 't1', name: 'Read', input: 'a', status: 'done', output: 'ok' },
      { kind: 'text', text: 'Listo', streaming: true }
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(items[2]).toMatchObject({ status: 'done', output: 'ok' })
  })

  it('agrupa los ficheros modificados del turno y resuelve rutas relativas', () => {
    const items: ChatItem[] = [{ id: 'u', type: 'user', text: 'x', at: 0 }]
    run(items, [
      { kind: 'files', id: 'f1', files: [{ path: 'src/a.ts', change: 'edit' }] },
      { kind: 'files', id: 'f2', files: [{ path: '/repo/src/a.ts', change: 'edit' }, { path: 'b.ts', change: 'add' }] }
    ])
    expect(items.filter((i) => i.type === 'files')).toEqual([
      expect.objectContaining({ files: [{ path: '/repo/src/a.ts', change: 'edit' }, { path: '/repo/b.ts', change: 'add' }] })
    ])
  })

  it('cerrar un turno interrumpido marca herramientas y streaming', () => {
    const items: ChatItem[] = [
      { id: 'u', type: 'user', text: 'x', at: 0 },
      { id: 'a', type: 'assistant', text: 'y', streaming: true },
      { id: 't', type: 'tool', toolId: 't', name: 'Bash', input: 'ls', status: 'running' }
    ]
    expect(finalizeTurn(items, true).map((i) => i.id)).toEqual(['a', 't'])
    expect(items[2]).toMatchObject({ status: 'error' })
  })

  it('genera títulos legibles', () => {
    expect(titleFromPrompt('  Implementa el login\ncon tests')).toBe('Implementa el login')
    expect(titleFromPrompt('x'.repeat(100))).toHaveLength(58)
  })
})
