import { describe, expect, it } from 'vitest'
import { collapseTurn } from '../src/shared/turn-layout'
import type { ChatItem } from '../src/shared/types'

const text = (id: string): ChatItem => ({ id, type: 'assistant', text: id })
const tool = (id: string, status: 'done' | 'running' = 'done'): ChatItem => ({ id, type: 'tool', toolId: id, name: 'Read', input: '', status })

describe('plegado progresivo del turno', () => {
  it('pliega las acciones anteriores a un mensaje y conserva visibles las actuales', () => {
    const entries = collapseTurn([text('a'), tool('t1'), tool('t2'), text('b'), tool('t3')], false)
    expect(entries.map(e => e.kind)).toEqual(['item', 'steps', 'item', 'item'])
    expect(entries[1]).toMatchObject({ steps: [{ id: 't1' }, { id: 't2' }] })
  })
  it('no oculta una herramienta que sigue trabajando', () => {
    const entries = collapseTurn([tool('t1', 'running'), text('a')], false)
    expect(entries[0]).toMatchObject({ kind: 'item', item: { id: 't1' } })
  })
  it('al acabar agrupa toda la actividad y conserva la respuesta y los errores', () => {
    const error: ChatItem = { id: 'error', type: 'error', text: 'falló' }
    const entries = collapseTurn([text('a'), tool('t1'), error, text('b'), tool('t2'), text('final')], true)
    expect(entries.map(e => e.kind)).toEqual(['steps', 'item', 'item'])
    expect(entries[0]).toMatchObject({ steps: [{ id: 'a' }, { id: 't1' }, { id: 'b' }, { id: 't2' }] })
    expect(entries[2]).toMatchObject({ item: { id: 'final' } })
  })
})
