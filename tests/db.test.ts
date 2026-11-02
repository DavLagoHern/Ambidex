import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate, SCHEMA_VERSION } from '../src/main/db/database'
import { Store } from '../src/main/db/store'
import type { ChatItem } from '../src/shared/types'
import { cleanupTmp, fileStore, memoryStore, tmpDir } from './helpers'

afterEach(cleanupTmp)

describe('migraciones', () => {
  it('crea el esquema y es idempotente', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db)).toBe(SCHEMA_VERSION)
    expect(migrate(db)).toBe(SCHEMA_VERSION)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'messages', 'runs', 'run_log', 'audit_log', 'settings']))
  })
})

describe('ajustes', () => {
  it('combina valores por defecto y guardados; los vacíos se borran', () => {
    const s = memoryStore()
    expect(s.getSettings().theme).toBe('dark')
    s.saveSettings({ theme: 'light', claudeModel: 'opus' })
    expect(s.getSettings()).toMatchObject({ theme: 'light', claudeModel: 'opus' })
    s.saveSettings({ claudeModel: '' })
    expect(s.getSettings().claudeModel).toBeUndefined()
  })

  it('el estado interno no aparece en los ajustes', () => {
    const s = memoryStore()
    s.kvSet('window', { width: 10 })
    expect(s.kvGet('window')).toEqual({ width: 10 })
    expect(Object.keys(s.getSettings())).not.toContain('_window')
  })
})

describe('proyectos y pestañas', () => {
  it('abre proyectos al final, reordena, cierra y reabre sin duplicar', () => {
    const s = memoryStore()
    const a = s.openProject('/p/a', 'a', null)
    const b = s.openProject('/p/b', 'b', '/p')
    expect([a.tabOrder, b.tabOrder]).toEqual([0, 1])
    s.reorderProjects([b.id, a.id])
    expect(s.listProjects().map((p) => p.name)).toEqual(['b', 'a'])
    s.closeProject(b.id)
    expect(s.getProject(b.id)?.isOpen).toBe(false)
    const again = s.openProject('/p/b', 'b', '/p')
    expect(again.id).toBe(b.id)
    expect(again.isOpen).toBe(true)
    // al reabrir vuelve al final de la barra
    expect(again.tabOrder).toBeGreaterThan(s.getProject(a.id)!.tabOrder)
    expect(s.listProjects()).toHaveLength(2)
  })

  it('guarda el estado visual por proyecto y lo aísla', () => {
    const s = memoryStore()
    const a = s.openProject('/p/a', 'a', null)
    const b = s.openProject('/p/b', 'b', null)
    s.saveUi(a.id, { sidebar: 'git', panels: { right: false } })
    expect(s.getUi(a.id)).toEqual({ sidebar: 'git', panels: { right: false } })
    expect(s.getUi(b.id)).toEqual({})
  })

  it('olvidar un proyecto borra sus conversaciones en cascada', () => {
    const s = memoryStore()
    const p = s.openProject('/p/a', 'a', null)
    const sess = s.createSession(p.id, '/p/a', { agent: 'claude' })
    s.upsertMessage(sess.id, 0, null, { id: 'm1', type: 'user', text: 'hola', at: 1 })
    s.forgetProject(p.id)
    expect(s.getSession(sess.id)).toBeUndefined()
    expect(s.messages(sess.id)).toEqual([])
  })
})

describe('conversaciones y mensajes', () => {
  it('persiste mensajes en orden, actualiza por id y sobrevive a reabrir la base de datos', () => {
    const dir = tmpDir()
    const { store, file } = fileStore(dir)
    const p = store.openProject('/p/a', 'a', null)
    const sess = store.createSession(p.id, '/p/a', { agent: 'codex', model: 'gpt-6-sol', permission: 'read-only' })
    const items: ChatItem[] = [
      { id: 'u1', type: 'user', text: 'Implementa login', at: 1 },
      { id: 'a1', type: 'assistant', text: 'Voy', streaming: true }
    ]
    items.forEach((it, i) => store.upsertMessage(sess.id, i, 'r1', it))
    store.upsertMessage(sess.id, 1, 'r1', { id: 'a1', type: 'assistant', text: 'Voy a implementarlo', streaming: false })
    store.db.close()

    const reopened = new Store(openDatabase(file))
    expect(reopened.messages(sess.id)).toEqual([items[0], { id: 'a1', type: 'assistant', text: 'Voy a implementarlo', streaming: false }])
    const meta = reopened.getSession(sess.id)!
    expect(meta).toMatchObject({ agent: 'codex', model: 'gpt-6-sol', permission: 'read-only', messageCount: 1 })
    reopened.db.close()
  })

  it('las conversaciones de un proyecto no aparecen en otro', () => {
    const s = memoryStore()
    const a = s.openProject('/p/a', 'a', null)
    const b = s.openProject('/p/b', 'b', null)
    s.createSession(a.id, '/p/a', { agent: 'claude', title: 'en A' })
    s.createSession(b.id, '/p/b', { agent: 'claude', title: 'en B' })
    expect(s.listSessions(a.id).map((x) => x.title)).toEqual(['en A'])
    expect(s.listSessions(b.id).map((x) => x.title)).toEqual(['en B'])
  })

  it('busca en títulos y contenido sin interpretar comodines', () => {
    const s = memoryStore()
    const p = s.openProject('/p/a', 'a', null)
    const x = s.createSession(p.id, '/p/a', { agent: 'claude', title: 'Refactor' })
    s.upsertMessage(x.id, 0, null, { id: 'u', type: 'user', text: 'Añade autenticación OAuth al 100%', at: 1 })
    expect(s.search(p.id, 'oauth').map((h) => h.sessionId)).toEqual([x.id])
    expect(s.search(p.id, '100%')[0].snippet).toContain('100%')
    expect(s.search(p.id, '_')).toEqual([])
  })

  it('actualizar sin tocar un campo lo conserva; vaciarlo lo borra', () => {
    const s = memoryStore()
    const p = s.openProject('/p/a', 'a', null)
    const x = s.createSession(p.id, '/p/a', { agent: 'claude', model: 'opus', effort: 'high' })
    expect(s.updateSession(x.id, { title: 'Nuevo' })).toMatchObject({ title: 'Nuevo', model: 'opus', effort: 'high' })
    expect(s.updateSession(x.id, { model: '' }).model).toBeUndefined()
  })
})

describe('ejecuciones', () => {
  it('registra, limita el log y lista las recientes', () => {
    const s = memoryStore()
    const p = s.openProject('/p/a', 'a', null)
    const x = s.createSession(p.id, '/p/a', { agent: 'claude' })
    s.createRun({ id: 'r1', sessionId: x.id, projectId: p.id, agent: 'claude', cwd: '/p/a', bin: '/bin/claude', args: ['-p'], startedAt: 1 })
    for (let i = 0; i < 2100; i++) s.appendLog('r1', 'event', `línea ${i}`)
    const log = s.runLog('r1')
    expect(log.length).toBe(2001)
    expect(log.at(-1)?.stream).toBe('system')
    expect(s.runningRuns().map((r) => r.id)).toEqual(['r1'])
    s.finishRun('r1', { status: 'completed', endedAt: 2, exitCode: 0, signal: null })
    expect(s.runningRuns()).toEqual([])
    expect(s.recentRuns(p.id, 10)[0]).toMatchObject({ id: 'r1', status: 'completed', exitCode: 0 })
  })
})
