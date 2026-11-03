import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentId, AgentModel, ChatItem, ModelTier, QueuedMessage, RouteDecision, SessionMeta, Settings, ThreadMeta } from '@shared/types'
import { AGENT_NAMES, DEFAULT_MODEL_POLICY, DEFAULT_ROUTE_PREFS } from '@shared/types'
import { titleFromPrompt } from '@shared/chat'
import { aiRoutePrompt, Classification, decideRoute, difficultyCriteria, EFFORT_CONFIDENCE, EFFORT_NAMES, pickEffort, pickModel, RouteContext, routeCategories, TIER_LABELS } from '@shared/router'
import type { Store } from '../db/store'
import type { SessionService } from './service'

const NEW_TITLE = 'Nueva conversación'

export interface DispatcherDeps {
  store: Store
  service: SessionService
  push: <K extends PushChannel>(channel: K, payload: PushContract[K]) => void
  settings: () => Settings
  available: (agent: AgentId) => boolean
  // enrutado con IA: devuelve el texto de un modelo rápido
  aiRoute?: (prompt: string, cwd: string) => Promise<string>
  // enrutado con Jev (modelo local de decisiones): tipo de tarea, si continúa la conversación y su dificultad
  jev?: {
    classify: (
      text: string,
      ctx: { previousAgent?: string; previousRequest?: string; difficulty?: boolean; categories?: Record<string, string>; difficultyCriteria?: Record<ModelTier, string> }
    ) => Promise<Classification>
  }
  // modelos que ofrece cada CLI instalado (para no elegir uno que no exista y para nombrarlo)
  models?: (agent: AgentId) => AgentModel[] | undefined
}

// Tiempo máximo que se espera a Jev; si no contesta (p. ej. arrancando), deciden las reglas y Jev sigue arrancando
const JEV_BUDGET = { send: 3000, preview: 1200 }

const pct = (x?: number) => (x === undefined ? '' : ` ${Math.round(x * 100)} %`)

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
}

// modelo y razonamiento que el usuario fijó en el chat único antes de que existiera la conversación de ese agente
type Pins = Partial<Record<AgentId, string>>
interface PinSet {
  models?: Pins
  efforts?: Pins
}

export interface ThreadSendResult {
  decision?: RouteDecision
  sessionId?: string
  queued?: QueuedMessage
}

// Chat único con dos agentes (enrutado) y colas de mensajes
export class Dispatcher {
  private processing = new Set<string>()

  constructor(private d: DispatcherDeps) {}

  // ---------- hilos ----------

  createThread(projectId: string): ThreadMeta {
    const t = this.d.store.createThread(projectId)
    this.d.push('thread:meta', t)
    return t
  }

  private sessionOf(thread: ThreadMeta, agent: AgentId): SessionMeta | undefined {
    const id = thread.sessions[agent]
    return id ? this.d.service.getSession(id) : undefined
  }

  private lastAgent(thread: ThreadMeta): AgentId | undefined {
    let best: { agent: AgentId; at: number } | undefined
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      const s = this.sessionOf(thread, agent)
      if (!s || !s.messageCount) continue
      if (!best || s.updatedAt > best.at) best = { agent, at: s.updatedAt }
    }
    return best?.agent
  }

  routeContext(thread?: ThreadMeta): RouteContext {
    const s = this.d.settings()
    const limits = this.d.store.getLimits()
    const usage: Partial<Record<AgentId, number>> = {}
    for (const a of ['claude', 'codex'] as AgentId[]) {
      const w = limits[a]?.windows
      if (w?.length) usage[a] = Math.max(...w.map((x) => x.usedPercent))
    }
    return {
      available: { claude: this.d.available('claude'), codex: this.d.available('codex') },
      busy: {
        claude: !!thread && !!this.sessionOf(thread, 'claude')?.running,
        codex: !!thread && !!this.sessionOf(thread, 'codex')?.running
      },
      usage,
      lastAgent: thread ? this.lastAgent(thread) : undefined,
      prefs: { ...DEFAULT_ROUTE_PREFS, ...(s.routePrefs ?? {}) },
      labels: Object.fromEntries(routeCategories(s).map((c) => [c.id, c.label])),
      defaultAgent: s.defaultAgent
    }
  }

  private policy() {
    return this.d.settings().modelPolicy ?? DEFAULT_MODEL_POLICY
  }

  // Vista previa mientras el usuario escribe: con Jev si está activo (unas decenas de ms), si no por reglas
  async preview(threadId: string | null, text: string): Promise<RouteDecision> {
    const thread = threadId ? this.d.store.getThread(threadId) ?? undefined : undefined
    const ctx = this.routeContext(thread)
    const cls = await this.understand(thread, text, ctx, JEV_BUDGET.preview, true)
    return this.withModel(thread, decideRoute(text, ctx, cls), cls)
  }

  // `pickAgent`: hace falta saber a quién va (no lo ha elegido el usuario). La dificultad se pregunta siempre que
  // el modelo dependa de ella, también si el agente lo eliges tú.
  private async understand(thread: ThreadMeta | undefined, text: string, ctx: RouteContext, budget: number, pickAgent: boolean): Promise<Classification | undefined> {
    const t = text.trim()
    const mention = /^@(claude|codex)\b/i.test(t)
    // la dificultad decide el modelo y el razonamiento: se pregunta si cualquiera de los dos es automático
    const difficulty = this.policy().auto || this.autoEffort()
    if (this.d.settings().routerMode !== 'jev' || !this.d.jev || !t || (!difficulty && (mention || !pickAgent))) return
    const last = ctx.lastAgent && thread ? this.sessionOf(thread, ctx.lastAgent) : undefined
    const previousRequest = last ? this.d.store.lastUserText(last.id) : undefined
    const message = t.replace(/^@(claude|codex)\b\s*/i, '') || t
    const s = this.d.settings()
    const categories = Object.fromEntries(routeCategories(s).map((c) => [c.id, c.description.trim() || c.label]))
    return within(
      this.d.jev.classify(message, { previousAgent: ctx.lastAgent && AGENT_NAMES[ctx.lastAgent], previousRequest, difficulty, categories, difficultyCriteria: difficultyCriteria(s) }),
      budget
    )
  }

  private async decide(thread: ThreadMeta, text: string, override?: AgentId, pins?: PinSet): Promise<RouteDecision> {
    const ctx = this.routeContext(thread)
    const manual = (agent: AgentId): RouteDecision => ({ agent, reason: `Elegido por ti → ${AGENT_NAMES[agent]}`, method: 'manual' })
    const mode = this.d.settings().routerMode
    const withModel = (d: RouteDecision, cls?: Pick<Classification, 'tier' | 'tierConfidence'>) => this.withModel(thread, d, cls, pins)
    if (mode === 'jev') {
      const cls = await this.understand(thread, text, ctx, JEV_BUDGET.send, !override)
      return withModel(override ? manual(override) : decideRoute(text, ctx, cls), cls)
    }
    if (override) return withModel(manual(override))
    const rules = decideRoute(text, ctx)
    if (rules.method === 'mention' || mode !== 'ai' || !this.d.aiRoute) return withModel(rules)
    try {
      const cwd = this.d.store.getProject(thread.projectId)?.path ?? process.cwd()
      const out = await this.d.aiRoute(aiRoutePrompt(text, ctx), cwd)
      const m = out.match(/\{[\s\S]*\}/)
      const j = m ? JSON.parse(m[0]) : null
      if (j?.agent === 'claude' || j?.agent === 'codex') {
        const agent = j.agent as AgentId
        if (!ctx.available[agent]) return withModel(rules)
        const tier = j.difficulty === 'hard' || j.difficulty === 'easy' ? (j.difficulty as ModelTier) : undefined
        return withModel({ agent, reason: String(j.reason || `Decidido por IA → ${AGENT_NAMES[agent]}`).slice(0, 160), method: 'ai', category: rules.category }, { tier })
      }
    } catch {
      /* si falla, se usan las reglas */
    }
    return withModel(rules)
  }

  private autoEffort() {
    return this.policy().autoEffort !== false
  }

  // Modelo del turno: el que fijaste en la conversación o, si no, el de su dificultad según Ajustes → Modelos.
  // Sin esa opción, el de la conversación, como siempre. Después, el razonamiento.
  private withModel(thread: ThreadMeta | undefined, d: RouteDecision, cls?: Pick<Classification, 'tier' | 'tierConfidence'>, pins?: PinSet): RouteDecision {
    const models = this.d.models?.(d.agent)
    const label = (id: string) => models?.find((m) => m.id === id)?.label ?? id
    const session = thread && this.sessionOf(thread, d.agent)
    let out = d
    if (this.policy().auto) {
      const pinned = session?.model || pins?.models?.[d.agent]
      const pick = pinned ? undefined : pickModel(d.agent, cls?.tier, this.policy(), models?.length ? models.map((m) => m.id) : undefined)
      if (pinned) out = { ...out, model: pinned, reason: `${out.reason} · ${label(pinned)} (fijado en la conversación)` }
      else if (pick)
        out = {
          ...out,
          model: pick.model,
          tier: pick.tier,
          reason: `${out.reason} · ${label(pick.model)} (${pick.guessed ? 'dificultad sin estimar' : `tarea ${TIER_LABELS[pick.tier]}${pct(cls?.tierConfidence)}`})`
        }
    }
    if (cls?.tierConfidence !== undefined) out = { ...out, tierConfidence: cls.tierConfidence }
    return this.autoEffort() ? this.withEffort(out, session ?? undefined, cls, pins, models) : out
  }

  // Razonamiento del turno: el que fijaste en la conversación o, si no, medio salvo que Jev vea clara la dificultad
  private withEffort(d: RouteDecision, session: SessionMeta | undefined, cls: Pick<Classification, 'tier' | 'tierConfidence'> | undefined, pins: PinSet | undefined, models?: AgentModel[]): RouteDecision {
    const name = (e: string) => EFFORT_NAMES[e] ?? e
    const pinned = session?.effort || pins?.efforts?.[d.agent]
    if (pinned) return { ...d, effort: pinned, reason: `${d.reason} · razonamiento ${name(pinned)} (fijado)` }
    const modelId = d.model || session?.model || this.d.settings()[d.agent === 'claude' ? 'claudeModel' : 'codexModel']
    // sin modelo conocido se toman los niveles del primero del catálogo (el que usaría el CLI por defecto)
    const info = modelId ? models?.find((m) => m.id === modelId) : models?.[0]
    const pick = pickEffort(cls?.tier, cls?.tierConfidence, info ? info.efforts : undefined)
    if (!pick.effort) return d
    // si no subió/bajó, por qué: sin estimar o con poca seguridad
    const why = pick.sure ? '' : cls?.tier ? ` (seguridad${pct(cls.tierConfidence)}, hace falta ${Math.round(EFFORT_CONFIDENCE * 100)} %)` : ' (por defecto)'
    return { ...d, effort: pick.effort, reason: `${d.reason} · razonamiento ${name(pick.effort)}${why}` }
  }

  // Lo que el otro agente ha hecho en este hilo desde la última vez que habló este, para no perder el hilo: lo que
  // se le pidió, qué ficheros cambió y cómo terminó. Los ficheros van todos (aunque el turno sea antiguo) para que
  // el que entra sepa qué se ha tocado y pueda leerlo él mismo.
  private crossContext(thread: ThreadMeta, agent: AgentId): string {
    const mine = this.sessionOf(thread, agent)
    const otherId = thread.sessions[agent === 'claude' ? 'codex' : 'claude']
    if (!otherId) return ''
    const cwd = this.d.store.getSession(otherId)?.cwd
    const rel = (p: string) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
    const myItems = mine ? this.d.store.messages(mine.id) : []
    const since = [...myItems].reverse().find((i) => i.type === 'user')?.at ?? 0
    const items = this.d.store.messages(otherId)
    type Turn = { user: string; answer: string; at: number; files: Set<string>; failed: boolean }
    const turns: Turn[] = []
    let cur: Turn | null = null
    for (const it of items as ChatItem[]) {
      if (it.type === 'user') {
        if (cur && cur.at > since) turns.push(cur)
        cur = { user: it.text, answer: '', at: it.at, files: new Set(), failed: false }
      } else if (!cur) continue
      else if (it.type === 'assistant') cur.answer = it.text
      else if (it.type === 'files') for (const f of it.files) cur.files.add(`${rel(f.path)} (${f.change})`)
      else if (it.type === 'error') cur.failed = true
    }
    if (cur && cur.at > since) turns.push(cur)
    if (!turns.length) return ''
    const otherName = AGENT_NAMES[agent === 'claude' ? 'codex' : 'claude']
    const shown = turns.slice(-6)
    const body = shown
      .map((t) => {
        const files = [...t.files]
        const lines = [`Usuario: ${t.user.slice(0, 1200)}`]
        if (files.length) lines.push(`Ficheros que cambió: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ` y ${files.length - 30} más` : ''}`)
        if (t.failed) lines.push('(ese turno terminó con error)')
        lines.push(`${otherName}: ${t.answer.slice(-2000)}`)
        return lines.join('\n')
      })
      .join('\n\n')
    // de los turnos que no caben, al menos los ficheros
    const older = [...new Set(turns.slice(0, -6).flatMap((t) => [...t.files]))]
    const olderNote = older.length ? `\n\nAntes de eso también cambió: ${older.slice(0, 40).join(', ')}${older.length > 40 ? '…' : ''}` : ''
    return `<conversacion_previa>\nEn esta conversación también participa ${otherName}. Esto es lo que se habló con él desde tu última respuesta (lo que cambió está en los ficheros: léelos si lo necesitas):\n\n${body}${olderNote}\n</conversacion_previa>`
  }

  private ensureSession(thread: ThreadMeta, agent: AgentId, pinned?: { model?: string; effort?: string }): SessionMeta {
    const existing = this.sessionOf(thread, agent)
    if (existing) return existing
    const s = this.d.settings()
    const project = this.d.store.getProject(thread.projectId)
    if (!project) throw new Error('Proyecto no encontrado')
    const session = this.d.store.createSession(thread.projectId, project.path, {
      agent,
      title: thread.title,
      threadId: thread.id,
      // con el modelo según la dificultad, la conversación no fija ninguno: lo elige cada mensaje
      model: pinned?.model || (this.policy().auto ? undefined : agent === 'claude' ? s.claudeModel : s.codexModel),
      // con el razonamiento automático tampoco se fija: lo decide cada mensaje (salvo que lo eligieras tú)
      effort: pinned?.effort || (this.autoEffort() ? undefined : agent === 'claude' ? s.claudeEffort : s.codexEffort),
      permission: agent === 'claude' ? s.claudeMode : s.codexSandbox
    })
    this.d.push('session:meta', session)
    return session
  }

  async sendThread(
    threadId: string,
    text: string,
    opts: { agent?: AgentId; context?: string; images?: string[]; models?: Pins; efforts?: Pins; fromQueue?: boolean } = {}
  ): Promise<ThreadSendResult> {
    const thread = this.d.store.getThread(threadId)
    if (!thread) throw new Error('Conversación no encontrada')
    const decision = await this.decide(thread, text, opts.agent, { models: opts.models, efforts: opts.efforts })
    const target = this.sessionOf(thread, decision.agent)
    // si el agente elegido está ocupado (o los dos), el mensaje espera en la cola del hilo
    if (target?.running) {
      if (opts.fromQueue) return { decision }
      const queued = this.d.store.enqueue({
        projectId: thread.projectId,
        threadId,
        prompt: text,
        context: opts.context,
        images: opts.images,
        agent: decision.method === 'rules' ? undefined : decision.agent
      })
      this.pushQueue(thread.projectId)
      return { queued, decision }
    }
    const session = this.ensureSession(thread, decision.agent, { model: opts.models?.[decision.agent], effort: opts.efforts?.[decision.agent] })
    const cross = this.crossContext(thread, decision.agent)
    const context = [cross, opts.context].filter(Boolean).join('\n\n') || undefined
    const prompt = text.replace(/^@(claude|codex)\b\s*/i, '') || text
    this.d.service.send(session.id, prompt, context, { route: decision, images: opts.images, model: decision.model, effort: decision.effort })
    const updated = this.d.store.updateThread(threadId, {
      title: thread.title === NEW_TITLE ? titleFromPrompt(prompt) : undefined,
      updatedAt: Date.now()
    })
    if (updated.title !== thread.title) for (const sid of Object.values(updated.sessions)) if (sid) this.d.store.updateSession(sid, { title: updated.title })
    this.d.push('thread:meta', updated)
    return { decision, sessionId: session.id }
  }

  // ---------- cola ----------

  enqueue(m: { projectId: string; sessionId?: string; threadId?: string; prompt: string; context?: string; images?: string[] }): QueuedMessage {
    const q = this.d.store.enqueue(m)
    this.pushQueue(m.projectId)
    return q
  }

  remove(id: string) {
    const q = this.d.store.getQueued(id)
    this.d.store.removeQueued(id)
    if (q) this.pushQueue(q.projectId)
  }

  update(id: string, prompt: string) {
    const q = this.d.store.getQueued(id)
    if (!q) return
    this.d.store.updateQueued(id, prompt)
    this.pushQueue(q.projectId)
  }

  // «Enviar ya» un mensaje de la cola. Con el destino libre sale en el acto. Ocupado: sin `interrupt` se avisa; con él,
  // el mensaje pasa a ser el primero de la cola y se detiene el turno en curso: al pararse, sale este (onIdle).
  async sendNow(id: string, interrupt = false): Promise<'sent' | 'interrupting'> {
    const q = this.d.store.getQueued(id)
    if (!q) throw new Error('Ese mensaje ya no está en la cola')
    let busy: string | undefined
    if (q.threadId) {
      const r = await this.sendThread(q.threadId, q.prompt, { agent: q.agent, context: q.context, images: q.images, fromQueue: true })
      if (r.sessionId) {
        this.d.store.removeQueued(id)
        this.pushQueue(q.projectId)
        return 'sent'
      }
      const thread = this.d.store.getThread(q.threadId)
      busy = r.decision && thread?.sessions[r.decision.agent]
    } else if (q.sessionId) {
      if (!this.d.service.isRunning(q.sessionId)) {
        this.d.store.removeQueued(id)
        this.pushQueue(q.projectId)
        this.d.service.send(q.sessionId, q.prompt, q.context, { images: q.images })
        return 'sent'
      }
      busy = q.sessionId
    }
    if (!busy) throw new Error('No se pudo enviar el mensaje')
    if (!interrupt) throw new Error('El agente sigue trabajando; se enviará cuando termine')
    this.d.store.moveQueuedToFront(id)
    this.pushQueue(q.projectId)
    await this.d.service.cancel(busy)
    return 'interrupting'
  }

  // Una conversación ha quedado libre: siguiente mensaje de su cola
  async onIdle(session: SessionMeta) {
    try {
      if (session.threadId) {
        // los dos agentes del hilo pueden quedar libres a la vez: un solo procesado
        const key = session.threadId
        if (this.processing.has(key)) return
        this.processing.add(key)
        try {
          const next = this.d.store.nextQueued({ threadId: key })
          if (!next) return
          const r = await this.sendThread(key, next.prompt, { agent: next.agent, context: next.context, images: next.images, fromQueue: true })
          // si el destino sigue ocupado, el mensaje se queda en su sitio de la cola
          if (r.sessionId) this.d.store.removeQueued(next.id)
        } finally {
          this.processing.delete(key)
          this.pushQueue(session.projectId)
        }
      } else if (!session.orchestrationId) {
        const next = this.d.store.nextQueued({ sessionId: session.id })
        if (!next) return
        this.d.store.removeQueued(next.id)
        this.pushQueue(session.projectId)
        this.d.service.send(session.id, next.prompt, next.context, { images: next.images })
      }
    } catch {
      this.pushQueue(session.projectId)
    }
  }

  pushQueue(projectId: string) {
    this.d.push('queue:changed', { projectId, items: this.d.store.listQueue(projectId) })
  }
}
