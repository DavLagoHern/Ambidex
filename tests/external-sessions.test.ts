import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'zlib'
import { claudeSessions, claudeSlug, claudeTranscript, codexSessions, codexTranscript } from '../src/main/external-sessions'
import { tmpDir } from './helpers'

const line = (o: object) => JSON.stringify(o) + '\n'

describe('Conversaciones empezadas fuera de la app', () => {
  it('calcula la carpeta de Claude Code como el propio CLI', () => {
    expect(claudeSlug('/Users/ana/Mis Proyectos/web.v2')).toBe('-Users-ana-Mis-Proyectos-web-v2')
    const long = '/x/' + 'a'.repeat(300)
    expect(claudeSlug(long)).toMatch(/^-x-a{197}-[0-9a-z]+$/)
  })

  it('lista y lee una conversación de Claude: título, origen y mensajes sin lo que inyecta el editor', () => {
    const home = tmpDir('ambidex-h-')
    const root = tmpDir('ambidex-p-')
    const dir = join(home, '.claude', 'projects', claudeSlug(root))
    mkdirSync(dir, { recursive: true })
    const id = '0a5b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d'
    const t = '2026-11-01T10:00:00.000Z'
    writeFileSync(
      join(dir, `${id}.jsonl`),
      line({ type: 'queue-operation', sessionId: id }) +
        line({ type: 'user', sessionId: id, entrypoint: 'cli', uuid: 'u1', timestamp: t, message: { role: 'user', content: '<system-reminder>ruido</system-reminder>Arregla el login' } }) +
        line({ type: 'assistant', uuid: 'a1', timestamp: t, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Miro el código' }] } }) +
        line({ type: 'assistant', uuid: 'a2', timestamp: t, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'login.ts' } }] } }) +
        line({ type: 'user', uuid: 'u2', timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }) +
        line({ type: 'user', uuid: 'u3', isMeta: true, timestamp: t, message: { role: 'user', content: 'meta' } }) +
        line({ type: 'assistant', uuid: 'a3', timestamp: t, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Listo, era el token' }] } }) +
        line({ type: 'ai-title', aiTitle: 'Título viejo', sessionId: id }) +
        line({ type: 'ai-title', aiTitle: 'Arreglar el login', sessionId: id })
    )
    const [s] = claudeSessions(home, root)
    expect(s).toMatchObject({ agent: 'claude', id, title: 'Arreglar el login', source: 'Terminal', live: false })
    const items = claudeTranscript(home, root, id)
    expect(items.map((i) => [i.type, 'text' in i ? i.text : (i as any).name])).toEqual([
      ['user', 'Arregla el login'],
      ['assistant', 'Miro el código'],
      ['tool', 'Read'],
      ['assistant', 'Listo, era el token']
    ])
    // el id lo pone la app al pedirlo: nunca una ruta
    expect(() => claudeTranscript(home, root, '../../etc/passwd')).toThrow(/ya no existe/)
  })

  it('lista y lee una conversación de Codex aunque esté comprimida (.jsonl.zst)', () => {
    const home = tmpDir('ambidex-cx-')
    const root = tmpDir('ambidex-p-')
    const rollout = join(home, 'sessions', '2026', '11', '01', 'rollout-x.jsonl')
    mkdirSync(join(home, 'sessions', '2026', '11', '01'), { recursive: true })
    const ev = (item: object) => line({ timestamp: '2026-11-01T10:00:00.000Z', type: 'event_msg', payload: { type: 'item_completed', item } })
    const text =
      line({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }) +
      ev({ type: 'UserMessage', id: 'i1', content: [{ type: 'text', text: 'Añade tests al carrito' }] }) +
      ev({ type: 'AgentMessage', id: 'i2', content: [{ type: 'Text', text: 'Hecho: 4 tests nuevos' }] })
    // en disco solo existe la versión comprimida, aunque el índice diga .jsonl
    writeFileSync(rollout + '.zst', zstdCompressSync(Buffer.from(text)))
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, updated_at INTEGER, source TEXT, archived INTEGER)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('th-1', rollout, root, '', 'Añade tests al carrito', 1762000000, 'cli', 0)
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('th-2', rollout, root, 'Archivada', '', 1762000000, 'cli', 1)
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('th-3', rollout, '/otra/carpeta', 'Otra', '', 1762000000, 'cli', 0)
    db.close()
    expect(codexSessions(home, root)).toEqual([{ agent: 'codex', id: 'th-1', title: 'Añade tests al carrito', updatedAt: 1762000000000, source: 'Terminal' }])
    expect(codexTranscript(home, root, 'th-1').map((i) => [i.type, (i as any).text])).toEqual([
      ['user', 'Añade tests al carrito'],
      ['assistant', 'Hecho: 4 tests nuevos']
    ])
    // de otra carpeta no se puede leer aunque se sepa el id
    expect(() => codexTranscript(home, root, 'th-3')).toThrow(/ya no existe/)
  })
})
