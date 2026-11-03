import { describe, expect, it } from 'vitest'
import type { AgentId, AgentModel, ChatItem, ModelTier, RouteCategory } from '../src/shared/types'
import { DEFAULT_MODEL_POLICY } from '../src/shared/types'
import { pickEffort, pickModel } from '../src/shared/router'
import { Dispatcher } from '../src/main/agents/dispatcher'
import type { SendOptions } from '../src/main/agents/service'
import { memoryStore, tmpDir } from './helpers'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const m = (id: string, label: string, efforts = LEVELS): AgentModel => ({ id, label, efforts })
const CATALOG: Record<AgentId, AgentModel[]> = {
  claude: [m('', 'Por defecto'), m('opus', 'Opus (último)'), m('claude-opus-5-5', 'Claude Opus 5.5'), m('claude-sonnet-5-5', 'Claude Sonnet 5.5'), m('claude-haiku-5-5', 'Claude Haiku 5.5', [])],
  codex: [m('', 'Por defecto'), m('gpt-6.1-sol', 'GPT-6.1-Sol'), m('gpt-6.1-terra', 'GPT-6.1 Terra'), m('gpt-6-astra', 'GPT-6-Astra')]
}

describe('modelo según la dificultad', () => {
  const policy = DEFAULT_MODEL_POLICY

  it('elige el modelo de cada caso entre los permitidos', () => {
    expect(pickModel('claude', 'hard', policy)).toEqual({ model: 'claude-opus-5-5', tier: 'hard', guessed: false })
    expect(pickModel('claude', 'easy', policy)).toEqual({ model: 'claude-sonnet-5-5', tier: 'easy', guessed: false })
    expect(pickModel('codex', 'easy', policy)?.model).toBe('gpt-6.1-terra')
    // sin estimación, o difícil con poca seguridad, el de las sencillas (el caro solo si se ve difícil)
    expect(pickModel('codex', undefined, policy)).toEqual({ model: 'gpt-6.1-terra', tier: 'easy', guessed: true })
    expect(pickModel('claude', 'hard', policy, undefined, 0.2)).toEqual({ model: 'claude-sonnet-5-5', tier: 'easy', guessed: true })
    expect(pickModel('claude', 'hard', policy, undefined, 0.3)?.model).toBe('claude-opus-5-5')
  })

  it('nunca elige un modelo sin marcar ni uno que el CLI instalado no tenga', () => {
    const ids = CATALOG.codex.map((x) => x.id)
    // un CLI antiguo sin Terra: las sencillas van al otro permitido, nunca a Astra
    expect(pickModel('codex', 'easy', policy, ids.filter((x) => x !== 'gpt-6.1-terra'))?.model).toBe('gpt-6.1-sol')
    expect(pickModel('codex', 'easy', policy, ['gpt-6-astra'])).toBeUndefined()
    expect(pickModel('claude', 'hard', { ...policy, claude: { allowed: ['claude-sonnet-5-5'], hard: 'claude-opus-5-5', easy: 'claude-sonnet-5-5' } })?.model).toBe('claude-sonnet-5-5')
    expect(pickModel('claude', 'hard', { ...policy, auto: false })).toBeUndefined()
  })
})

describe('chat único: agente y modelo de cada mensaje', () => {
  function setup(classify?: (text: string) => { category?: RouteCategory; tier?: ModelTier; tierConfidence?: number }) {
    const store = memoryStore()
    const project = store.openProject(tmpDir(), 'demo', null)
    store.saveSettings({ routerMode: 'jev' })
    const sent: { sessionId: string; opts: SendOptions }[] = []
    const asked: { text: string; difficulty?: boolean }[] = []
    const service = {
      getSession: (id: string) => store.getSession(id),
      send: (sessionId: string, _p: string, _c: string | undefined, opts: SendOptions) => {
        sent.push({ sessionId, opts })
        return { runId: 'r', done: new Promise(() => {}) }
      }
    }
    const jev = {
      classify: async (text: string, ctx: { difficulty?: boolean }) => {
        asked.push({ text, difficulty: ctx.difficulty })
        const c = classify?.(text) ?? { category: /error|arregla/i.test(text) ? 'debug' : 'plan', tier: /arquitectura|refactoriza/i.test(text) ? 'hard' : 'easy' }
        return { via: 'jev' as const, followUp: false, confidence: 0.7, ...c } as never
      }
    }
    const dispatcher = new Dispatcher({ store, service: service as never, push: () => {}, settings: () => store.getSettings(), available: () => true, jev, models: (a) => CATALOG[a] })
    return { store, project, dispatcher, sent, asked }
  }

  it('Jev decide agente y dificultad en la misma consulta; la conversación no fija modelo', async () => {
    const s = setup()
    const t = s.dispatcher.createThread(s.project.id)
    const r1 = await s.dispatcher.sendThread(t.id, 'Diseña la arquitectura del sistema de pagos')
    expect(r1.decision).toMatchObject({ agent: 'claude', method: 'jev', model: 'claude-opus-5-5', tier: 'hard' })
    expect(r1.decision?.reason).toContain('Claude Opus 5.5 (tarea difícil)')
    expect(s.sent[0].opts.model).toBe('claude-opus-5-5')
    expect(s.asked[0]).toEqual({ text: 'Diseña la arquitectura del sistema de pagos', difficulty: true })
    expect(s.store.getSession(r1.sessionId!)!.model).toBeUndefined()

    const r2 = await s.dispatcher.sendThread(t.id, 'Arregla el error del botón')
    expect(r2.decision).toMatchObject({ agent: 'codex', model: 'gpt-6.1-terra', tier: 'easy' })

    // eliges tú el agente (o lo mencionas): la dificultad sigue eligiendo el modelo
    const r3 = await s.dispatcher.sendThread(t.id, 'cambia el texto del título', { agent: 'claude' })
    expect(r3.decision).toMatchObject({ agent: 'claude', method: 'manual', model: 'claude-sonnet-5-5' })
    const r4 = await s.dispatcher.sendThread(t.id, '@codex refactoriza todo el módulo')
    expect(r4.decision).toMatchObject({ agent: 'codex', method: 'mention', model: 'gpt-6.1-sol' })
    expect(s.asked.at(-1)?.text).toBe('refactoriza todo el módulo')
  })

  it('manda el modelo que fijes en la conversación, también antes de que exista', async () => {
    const s = setup()
    const t = s.dispatcher.createThread(s.project.id)
    const r1 = await s.dispatcher.sendThread(t.id, 'Diseña la arquitectura', { models: { claude: 'claude-haiku-5-5' } })
    expect(r1.decision).toMatchObject({ agent: 'claude', model: 'claude-haiku-5-5' })
    expect(r1.decision?.reason).toContain('fijado')
    expect(s.store.getSession(r1.sessionId!)!.model).toBe('claude-haiku-5-5')
    const r2 = await s.dispatcher.sendThread(t.id, 'Diseña otra arquitectura')
    expect(r2.decision?.model).toBe('claude-haiku-5-5')
  })

  it('si Jev duda, el modelo de las sencillas; sin la opción, el de la conversación', async () => {
    const s = setup(() => ({ category: 'plan' }))
    const t = s.dispatcher.createThread(s.project.id)
    const r1 = await s.dispatcher.sendThread(t.id, 'algo')
    expect(r1.decision).toMatchObject({ model: 'claude-sonnet-5-5', tier: 'easy' })
    expect(r1.decision?.reason).toContain('dificultad sin estimar')

    s.store.saveSettings({ modelPolicy: { ...DEFAULT_MODEL_POLICY, auto: false, autoEffort: false }, claudeModel: 'opus' })
    const t2 = s.dispatcher.createThread(s.project.id)
    const r2 = await s.dispatcher.sendThread(t2.id, 'otra cosa', { agent: 'claude' })
    expect(r2.decision?.model).toBeUndefined()
    expect(s.store.getSession(r2.sessionId!)!.model).toBe('opus')
    expect(s.sent.at(-1)?.opts.model).toBeUndefined()
    // sin la opción, al elegir tú el agente no hace falta preguntar a Jev
    expect(s.asked).toHaveLength(1)
  })

  it('razonamiento: medio por defecto, alto o bajo solo si Jev lo ve claro, y nunca por encima de alto', async () => {
    const s = setup((text) => ({
      category: 'plan',
      tier: /arquitectura/.test(text) ? 'hard' : 'easy',
      tierConfidence: /seguro/.test(text) ? 0.9 : 0.3
    }))
    const t = s.dispatcher.createThread(s.project.id)
    // duda (o no contesta): medio
    const r1 = await s.dispatcher.sendThread(t.id, 'arquitectura, quizá')
    expect(r1.decision).toMatchObject({ effort: 'medium' })
    expect(r1.decision?.reason).toContain('razonamiento medio (seguridad 30 %, hace falta 75 %)')
    expect(r1.decision?.tierConfidence).toBe(0.3)
    expect(s.sent.at(-1)?.opts.effort).toBe('medium')
    // la conversación no lo fija: lo decide cada mensaje
    expect(s.store.getSession(r1.sessionId!)!.effort).toBeUndefined()
    // tarea difícil clara: alto (no muy alto ni máximo aunque el modelo los tenga)
    const r2 = await s.dispatcher.sendThread(t.id, 'arquitectura, seguro')
    expect(r2.decision?.effort).toBe('high')
    // sencilla clara: bajo
    const r3 = await s.dispatcher.sendThread(t.id, 'cambia un texto, seguro')
    expect(r3.decision?.effort).toBe('low')
  })

  it('razonamiento: manda el que fijes; un modelo sin niveles no recibe ninguno; se puede apagar', async () => {
    const s = setup(() => ({ category: 'plan', tier: 'hard', tierConfidence: 0.9 }))
    const t = s.dispatcher.createThread(s.project.id)
    const r1 = await s.dispatcher.sendThread(t.id, 'algo difícil', { agent: 'claude', efforts: { claude: 'max' } })
    expect(r1.decision).toMatchObject({ effort: 'max' })
    expect(r1.decision?.reason).toContain('razonamiento máximo (fijado)')
    expect(s.store.getSession(r1.sessionId!)!.effort).toBe('max')

    const t2 = s.dispatcher.createThread(s.project.id)
    const r2 = await s.dispatcher.sendThread(t2.id, 'otra', { agent: 'claude', models: { claude: 'claude-haiku-5-5' } })
    expect(r2.decision?.effort).toBeUndefined()
    expect(s.sent.at(-1)?.opts.effort).toBeUndefined()

    s.store.saveSettings({ modelPolicy: { ...DEFAULT_MODEL_POLICY, autoEffort: false }, claudeEffort: 'xhigh' })
    const t3 = s.dispatcher.createThread(s.project.id)
    const r3 = await s.dispatcher.sendThread(t3.id, 'otra más', { agent: 'claude' })
    expect(r3.decision?.effort).toBeUndefined()
    expect(s.store.getSession(r3.sessionId!)!.effort).toBe('xhigh')
  })
})

describe('chat único: lo que hizo el otro agente', () => {
  it('el que entra recibe lo que se pidió, qué ficheros cambió el otro y cómo terminó', async () => {
    const store = memoryStore()
    const dir = tmpDir()
    const project = store.openProject(dir, 'demo', null)
    const sent: { sessionId: string; context?: string }[] = []
    const service = {
      getSession: (id: string) => store.getSession(id),
      send: (sessionId: string, _p: string, context: string | undefined) => {
        sent.push({ sessionId, context })
        return { runId: 'r', done: new Promise(() => {}) }
      }
    }
    const dispatcher = new Dispatcher({ store, service: service as never, push: () => {}, settings: () => store.getSettings(), available: () => true, models: (a) => CATALOG[a] })
    const t = dispatcher.createThread(project.id)
    const r = await dispatcher.sendThread(t.id, 'pon un degradado con el color del proyecto', { agent: 'codex' })
    // lo que habría escrito Codex en su turno
    const items = [
      { id: 'u1', type: 'user', text: 'pon un degradado con el color del proyecto', at: 10 },
      { id: 'f1', type: 'files', files: [{ path: `${dir}/src/styles.css`, change: 'edit' }, { path: `${dir}/src/App.tsx`, change: 'edit' }] },
      { id: 'a1', type: 'assistant', text: 'Hecho: degradado arriba del espacio de trabajo.' }
    ] as ChatItem[]
    items.forEach((it, i) => store.upsertMessage(r.sessionId!, i, null, it))

    await dispatcher.sendThread(t.id, 'quita el degradado', { agent: 'claude' })
    const ctx = sent.at(-1)!.context!
    expect(ctx).toContain('<conversacion_previa>')
    expect(ctx).toContain('Usuario: pon un degradado con el color del proyecto')
    expect(ctx).toContain('Ficheros que cambió: src/styles.css (edit), src/App.tsx (edit)')
    expect(ctx).toContain('Codex: Hecho: degradado arriba del espacio de trabajo.')
  })
})

describe('cola: «Enviar ya»', () => {
  it('si no admite entrada mantiene la cola y nunca cancela el turno', async () => {
    const store = memoryStore()
    const project = store.openProject(tmpDir(), 'demo', null)
    const running = new Set<string>()
    const cancelled: string[] = []
    const service = {
      getSession: (id: string) => {
        const s = store.getSession(id)
        return s && { ...s, running: running.has(id) }
      },
      send: (sessionId: string) => {
        running.add(sessionId)
        return { runId: 'r', done: new Promise(() => {}) }
      },
      isRunning: (id: string) => running.has(id),
      // como Codex: no admite mensajes a mitad de turno
      steer: () => false,
      cancel: async (id: string) => void cancelled.push(id)
    }
    const dispatcher = new Dispatcher({ store, service: service as never, push: () => {}, settings: () => store.getSettings(), available: () => true, models: (a) => CATALOG[a] })
    const t = dispatcher.createThread(project.id)
    await dispatcher.sendThread(t.id, 'primero', { agent: 'claude' })
    const a = await dispatcher.sendThread(t.id, 'en cola 1', { agent: 'claude' })
    const b = await dispatcher.sendThread(t.id, 'en cola 2', { agent: 'claude' })
    expect(a.queued && b.queued).toBeTruthy()
    // sin permiso para interrumpir: no se toca nada y la cola sigue igual
    await dispatcher.sendNow(b.queued!.id)
    expect(store.nextQueued({ threadId: t.id })?.prompt).toBe('en cola 1')
    await dispatcher.sendNow(b.queued!.id)
    expect(cancelled).toEqual([])
    expect(store.nextQueued({ threadId: t.id })?.prompt).toBe('en cola 1')
    expect(store.listQueue(project.id)).toHaveLength(2)
    // con el agente libre sale en el acto
    running.clear()
    expect(await dispatcher.sendNow(a.queued!.id)).toBe('sent')
    expect(store.listQueue(project.id).map((q) => q.prompt)).toEqual(['en cola 2'])
  })
})

describe('razonamiento automático', () => {
  it('sube o baja solo con confianza y respeta los niveles del modelo', () => {
    expect(pickEffort(undefined, undefined)).toEqual({ effort: 'medium', level: 'medium', sure: false })
    expect(pickEffort('hard', 0.4)).toMatchObject({ effort: 'medium', sure: false })
    // alto exige más seguridad (75 %) que bajo (60 %): es lo que más gasta
    expect(pickEffort('hard', 0.7)).toMatchObject({ effort: 'medium', sure: false })
    expect(pickEffort('hard', 0.75)).toMatchObject({ effort: 'high', sure: true })
    expect(pickEffort('easy', 0.6)).toMatchObject({ effort: 'low', sure: true })
    expect(pickEffort('easy', 0.95)).toMatchObject({ effort: 'low', sure: true })
    // un modelo sin «alto»: medio; sin niveles: ninguno
    expect(pickEffort('hard', 0.9, ['low', 'medium'])).toMatchObject({ effort: 'medium', sure: false })
    expect(pickEffort('hard', 0.9, []).effort).toBeUndefined()
  })
})

describe('mensajes a mitad de turno', () => {
  function setup(jevCalls?: { n: number }) {
    const store = memoryStore()
    const project = store.openProject(tmpDir(), 'demo', null)
    if (jevCalls) store.saveSettings({ routerMode: 'jev' })
    const running = new Set<string>()
    const steered: { id: string; text: string }[] = []
    const cancelled: string[] = []
    const sent: string[] = []
    const service = {
      getSession: (id: string) => {
        const s = store.getSession(id)
        return s && { ...s, running: running.has(id) }
      },
      send: (sessionId: string, prompt: string) => (running.add(sessionId), sent.push(prompt), { runId: 'r', done: new Promise(() => {}) }),
      isRunning: (id: string) => running.has(id),
      steer: (id: string, text: string) => (steered.push({ id, text }), true),
      cancel: async (id: string) => void cancelled.push(id)
    }
    const jev = jevCalls && { classify: async () => (jevCalls.n++, { via: 'jev' as const, followUp: false, confidence: 0.9, category: 'plan', tier: 'easy' }) as never }
    const dispatcher = new Dispatcher({ store, service: service as never, push: () => {}, settings: () => store.getSettings(), available: () => true, jev, models: (a) => CATALOG[a] })
    return { store, project, dispatcher, steered, cancelled, sent, t: dispatcher.createThread(project.id) }
  }

  it.each(['claude', 'codex'] as const)('con %s trabajando, va a la cola y «al turno actual» lo añade sin cancelar', async (agent) => {
    const s = setup()
    const r1 = await s.dispatcher.sendThread(s.t.id, 'primero', { agent })
    const r = await s.dispatcher.sendThread(s.t.id, 'y además esto', { agent })
    expect(r.queued).toBeDefined()
    expect(s.steered).toEqual([])
    expect(await s.dispatcher.sendNow(r.queued!.id)).toBe('sent')
    expect(s.steered).toEqual([{ id: r1.sessionId, text: 'y además esto' }])
    expect(s.cancelled).toEqual([])
    expect(s.store.listQueue(s.project.id)).toHaveLength(0)
  })

  it('con un agente trabajando, va a la cola al momento sin consultar a Jev', async () => {
    const calls = { n: 0 }
    const s = setup(calls)
    await s.dispatcher.sendThread(s.t.id, 'primero')
    const before = calls.n
    const r = await s.dispatcher.sendThread(s.t.id, 'y además esto')
    expect(r.queued).toBeDefined()
    expect(calls.n).toBe(before)
  })

  it('«al otro agente» lo lanza en el agente libre', async () => {
    const s = setup()
    await s.dispatcher.sendThread(s.t.id, 'primero', { agent: 'claude' })
    const r = await s.dispatcher.sendThread(s.t.id, 'revisa los tests')
    expect(await s.dispatcher.sendNow(r.queued!.id, 'other')).toBe('sent')
    // Claude solo recibe el aviso de que Codex trabaja en paralelo, no el mensaje
    expect(s.steered.map((x) => x.text)).not.toContain('revisa los tests')
    expect(s.store.getThread(s.t.id)!.sessions.codex).toBeDefined()
    expect(s.sent.at(-1)).toBe('revisa los tests')
    expect(s.store.listQueue(s.project.id)).toHaveLength(0)
  })
})

it('en Ambos los agentes simultáneos reciben su tarea mutua y el resultado al finalizar', async () => {
  const store = memoryStore()
  const project = store.openProject(tmpDir(), 'demo', null)
  const running = new Set<string>()
  const requests = new Map<string, string>()
  const contexts = new Map<string, string | undefined>()
  const delivered: { id: string; text: string; internal?: boolean }[] = []
  const service = {
    getSession: (id: string) => { const s = store.getSession(id); return s && { ...s, running: running.has(id) } },
    send: (id: string, prompt: string, context?: string) => { running.add(id); requests.set(id, prompt); contexts.set(id, context) },
    coordinationSnapshot: (id: string) => requests.get(id) ?? '',
    steer: async (id: string, text: string, _ctx?: string, _images?: string[], internal?: boolean) => { delivered.push({ id, text, internal }); return true }
  }
  const dispatcher = new Dispatcher({ store, service: service as never, push: () => {}, settings: () => store.getSettings(), available: () => true })
  const thread = dispatcher.createThread(project.id)
  const claude = await dispatcher.sendThread(thread.id, 'Revisa la interfaz', { agent: 'claude' })
  const codex = await dispatcher.sendThread(thread.id, 'Corrige el motor', { agent: 'codex' })
  expect(contexts.get(codex.sessionId!)).toContain('Claude Code está trabajando ahora')
  expect(contexts.get(codex.sessionId!)).toContain('Revisa la interfaz')
  expect(delivered).toEqual([expect.objectContaining({ id: claude.sessionId, internal: true, text: expect.stringContaining('Corrige el motor') })])
  running.delete(codex.sessionId!)
  requests.set(codex.sessionId!, 'Motor corregido: src/engine.ts')
  await dispatcher.onIdle(store.getSession(codex.sessionId!)!)
  expect(delivered.at(-1)).toMatchObject({ id: claude.sessionId, internal: true, text: expect.stringContaining('Motor corregido: src/engine.ts') })
  expect(store.listQueue(project.id)).toHaveLength(0)
})
