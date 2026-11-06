import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentId, AgentModel, ChatItem, ModelTier, QueuedMessage, RouteDecision, SessionMeta, Settings, ThreadMeta } from '@shared/types'
import { AGENT_NAMES, DEFAULT_MODEL_POLICY, DEFAULT_ROUTE_PREFS } from '@shared/types'
import { titleFromPrompt } from '@shared/chat'
import { aiRoutePrompt, Classification, decideRoute, difficultyCriteria, EFFORT_CONFIDENCE, EFFORT_NAMES, analyzeRoutePrompt, pickEffort, pickModel, weeklyHeadroom, requestsComputerControl, requestsImageGeneration, RouteContext, routeCategories, TIER_LABELS } from '@shared/router'
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

// El usuario eligió a este agente con palabras («dile a Codex que…»): la petición es para él, no tiene que reenviarla.
const DELEGATED_TO_YOU =
  '<ambidex>El usuario ha elegido que lo haga el agente que recibe este mensaje. Si habla de ti en tercera persona («dile a Codex que…»), es para ti: hazlo tú directamente, sin reenviarlo ni lanzar otro agente.</ambidex>'

// Delegar con el CLI del otro agente por terminal lo deja fuera de Ambidex (sin panel, sin chat, sin poder pararlo).
const NO_CLI_DELEGATION =
  '<ambidex>No lances los CLI `codex` o `claude` desde la terminal para delegar trabajo: Ambidex no los vería ni podría pararlos. Si algo debe hacerlo el otro agente, dilo en tu respuesta y Ambidex se lo enviará; tú no lo ejecutes.</ambidex>'

export interface ThreadSendResult {
  decision?: RouteDecision
  sessionId?: string
  queued?: QueuedMessage
  // añadido al turno en curso (sin pararlo)
  steered?: boolean
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
    const withModel = (d: RouteDecision, cls?: Pick<Classification, 'tier' | 'tierConfidence' | 'ultra'>) => this.withModel(thread, d, cls, pins)
    if (requestsImageGeneration(text)) {
      if (!ctx.available.codex) throw new Error('Activa Codex para generar imágenes')
      return withModel({ agent: 'codex', reason: 'Generación de imágenes → Codex', method: 'rules' })
    }
    if (mode === 'jev') {
      const cls = await this.understand(thread, text, ctx, JEV_BUDGET.send, !override)
      const target: AgentId | undefined = cls?.delegate === 'other' ? (ctx.lastAgent ? (ctx.lastAgent === 'claude' ? 'codex' : 'claude') : undefined) : cls?.delegate
      if (!override && cls && target && (cls.delegateConfidence ?? 0) >= 0.6 && ctx.available[target]) {
        const agent = target
        return withModel({ agent, reason: `Se lo pides a ${AGENT_NAMES[agent]}`, method: 'jev', category: cls.category, delegated: true }, cls)
      }
      if (!override) {
        const deep = await this.analyze(thread, text, ctx, cls)
        if (deep) return withModel(deep.decision, { tier: cls?.tier ?? deep.tier, tierConfidence: cls?.tierConfidence })
      }
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

  // Análisis a fondo con un modelo rápido (Haiku) cuando el mensaje nombra a un agente, trata de manejar el ordenador o Jev
  // no lo tiene claro. Entiende la intención («dile a Codex que…» ≠ «cómo funciona Codex»), que unas palabras clave no captan.
  // Si no contesta a tiempo o falla, se usa lo que decidió Jev con sus reglas.
  private async analyze(thread: ThreadMeta | undefined, text: string, ctx: RouteContext, cls?: Classification): Promise<{ decision: RouteDecision; tier?: ModelTier } | undefined> {
    const t = text.trim()
    if (!this.d.aiRoute || !t || /^@(claude|codex)\b/i.test(t)) return
    const unsure = !cls || cls.category === undefined || (cls.confidence ?? 0) < 0.6
    if (!(requestsComputerControl(t) || unsure)) return
    try {
      const last = ctx.lastAgent && thread ? this.sessionOf(thread, ctx.lastAgent) : undefined
      const cwd = (thread && this.d.store.getProject(thread.projectId)?.path) ?? process.cwd()
      const out = await within(this.d.aiRoute(analyzeRoutePrompt(t, ctx, last ? this.d.store.lastUserText(last.id) : undefined), cwd), 8000)
      const m = out?.match(/\{[\s\S]*\}/)
      const j = m ? JSON.parse(m[0]) : null
      if (j?.agent !== 'claude' && j?.agent !== 'codex') return
      const agent = j.agent as AgentId
      if (!ctx.available[agent]) return
      const tier = j.difficulty === 'hard' || j.difficulty === 'easy' ? (j.difficulty as ModelTier) : undefined
      const delegated = j.delegated === true
      const reason = String(j.reason || `Analizado → ${AGENT_NAMES[agent]}`).slice(0, 160)
      return { tier, decision: { agent, reason: `${reason} · analizado con IA`, method: 'ai', category: cls?.category, delegated } }
    } catch {
      return
    }
  }

  private autoEffort() {
    return this.policy().autoEffort !== false
  }

  // Modelo del turno: el que fijaste en la conversación o, si no, el de su dificultad según Ajustes → Modelos.
  // Sin esa opción, el de la conversación, como siempre. Después, el razonamiento.
  private withModel(thread: ThreadMeta | undefined, d: RouteDecision, cls?: Pick<Classification, 'tier' | 'tierConfidence' | 'ultra'>, pins?: PinSet): RouteDecision {
    const models = this.d.models?.(d.agent)
    const label = (id: string) => models?.find((m) => m.id === id)?.label ?? id
    const session = thread && this.sessionOf(thread, d.agent)
    let out = d
    if (this.policy().auto) {
      const pinned = session?.model || pins?.models?.[d.agent]
      const remaining = weeklyHeadroom(this.d.store.getLimits()[d.agent])
      const abundant = remaining !== undefined && remaining > 80
      const pick = pinned ? undefined : pickModel(d.agent, abundant ? 'hard' : cls?.tier, this.policy(), models?.length ? models.map((m) => m.id) : undefined, abundant ? 1 : cls?.tierConfidence)
      if (pinned) out = { ...out, model: pinned, reason: `${out.reason} · ${label(pinned)} (fijado en la conversación)` }
      else if (pick)
        out = {
          ...out,
          model: pick.model,
          tier: pick.tier,
          reason: `${out.reason} · ${label(pick.model)} (${abundant ? `cuota semanal disponible ${Math.round(remaining!)} %` : pick.guessed ? (cls?.tier ? `tarea ${TIER_LABELS[cls.tier]}${pct(cls.tierConfidence)}, poco segura` : 'dificultad sin estimar') : `tarea ${TIER_LABELS[pick.tier]}${pct(cls?.tierConfidence)}`})`
        }
    }
    if (cls?.tierConfidence !== undefined) out = { ...out, tierConfidence: cls.tierConfidence }
    return this.autoEffort() ? this.withEffort(out, session ?? undefined, cls, pins, models) : out
  }

  // Razonamiento del turno: el que fijaste en la conversación o, si no, medio salvo que Jev vea clara la dificultad
  private withEffort(d: RouteDecision, session: SessionMeta | undefined, cls: Pick<Classification, 'tier' | 'tierConfidence' | 'ultra'> | undefined, pins: PinSet | undefined, models?: AgentModel[]): RouteDecision {
    const name = (e: string) => EFFORT_NAMES[e] ?? e
    const pinned = session?.effort || pins?.efforts?.[d.agent]
    if (pinned) return { ...d, effort: pinned, reason: `${d.reason} · razonamiento ${name(pinned)} (fijado)` }
    const modelId = d.model || session?.model || this.d.settings()[d.agent === 'claude' ? 'claudeModel' : 'codexModel']
    // sin modelo conocido se toman los niveles del primero del catálogo (el que usaría el CLI por defecto)
    const info = modelId ? models?.find((m) => m.id === modelId) : models?.[0]
    const pick = pickEffort(cls?.tier, cls?.tierConfidence, info ? info.efforts : undefined, cls?.ultra)
    if (!pick.effort) return d
    // si no subió/bajó, por qué: sin estimar o con poca seguridad
    const why = pick.sure ? '' : cls?.tier ? ` (seguridad${pct(cls.tierConfidence)}, hace falta ${Math.round(EFFORT_CONFIDENCE[cls.tier] * 100)} %)` : ' (por defecto)'
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

  private parallelContext(thread: ThreadMeta, agent: AgentId): string {
    const other = this.sessionOf(thread, agent === 'claude' ? 'codex' : 'claude')
    if (!other?.running) return ''
    return `<agente_en_paralelo>\n${AGENT_NAMES[other.agent]} está trabajando ahora en esta misma conversación y carpeta.\n${this.d.service.coordinationSnapshot?.(other.id) ?? ''}\nCoordina tu tarea con ese trabajo: revisa los cambios actuales antes de editar, conserva los cambios del otro y evita duplicar su tarea. Esta información es una instantánea, no un bloqueo de ficheros.\n</agente_en_paralelo>`
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
    let thread = this.d.store.getThread(threadId)
    if (!thread) throw new Error('Conversación no encontrada')
    // Con un agente del hilo trabajando, el mensaje va directo a la cola, sin pasar por Jev. Desde ahí decides:
    // añadirlo al turno en curso, mandarlo al otro agente o dejarlo para que Jev lo reparta cuando quede libre.
    if (!opts.fromQueue) {
      const busy = (['claude', 'codex'] as AgentId[]).filter((a) => this.sessionOf(thread!, a)?.running)
      const mention = text.trim().match(/^@(claude|codex)\b/i)?.[1].toLowerCase() as AgentId | undefined
      const want = opts.agent ?? mention
      if (want ? busy.includes(want) : busy.length > 0) {
        const agent = want ?? busy[0]
        const queued = this.d.store.enqueue({ projectId: thread.projectId, threadId, prompt: text, context: opts.context, images: opts.images, agent: want })
        this.pushQueue(thread.projectId)
        // si terminó justo ahora, no se queda esperando
        if (!busy.some((a) => this.d.service.isRunning(this.sessionOf(thread!, a)!.id))) void this.onIdle(this.sessionOf(thread, busy[0])!)
        const decision: RouteDecision = { agent, reason: `En cola mientras ${AGENT_NAMES[busy[0]]} trabaja`, method: opts.agent ? 'manual' : mention ? 'mention' : 'rules' }
        return { queued, decision }
      }
    }
    const decision = await this.decide(thread, text, opts.agent, { models: opts.models, efforts: opts.efforts })
    thread = this.d.store.getThread(threadId) ?? thread
    const target = this.sessionOf(thread, decision.agent)
    // si el agente elegido está ocupado (o los dos), el mensaje espera en la cola del hilo
    if (target?.running) {
      if (opts.fromQueue) return { decision }
      // Los dos agentes admiten entrada durante el turno; el transporte confirma la entrega.
      if (await this.d.service.steer(target.id, text, opts.context, opts.images)) return { decision, sessionId: target.id, steered: true }
      const queued = this.d.store.enqueue({
        projectId: thread.projectId,
        threadId,
        prompt: text,
        context: opts.context,
        images: opts.images,
        agent: decision.method === 'rules' ? undefined : decision.agent
      })
      this.pushQueue(thread.projectId)
      // Si acabó mientras se intentaba enviar, no dejamos el mensaje esperando para siempre.
      if (!this.d.service.isRunning(target.id)) void this.onIdle(this.d.store.getSession(target.id)!)
      return { queued, decision }
    }
    const session = this.ensureSession(thread, decision.agent, { model: opts.models?.[decision.agent], effort: opts.efforts?.[decision.agent] })
    thread = this.d.store.getThread(threadId) ?? thread
    const cross = this.crossContext(thread, decision.agent)
    const context = [cross, this.parallelContext(thread, decision.agent), opts.context, NO_CLI_DELEGATION, decision.delegated ? DELEGATED_TO_YOU : undefined].filter(Boolean).join('\n\n') || undefined
    const prompt = text.replace(/^@(claude|codex)\b\s*/i, '') || text
    this.d.service.send(session.id, prompt, context, { route: decision, images: opts.images, model: decision.model, effort: decision.effort })
    // El agente que ya estaba trabajando también recibe la tarea del que acaba de entrar.
    const other = this.sessionOf(thread, decision.agent === 'claude' ? 'codex' : 'claude')
    if (other?.running) {
      const state = this.parallelContext(this.d.store.getThread(threadId)!, other.agent)
      if (state) void Promise.resolve(this.d.service.steer(other.id, state, undefined, undefined, true)).catch(() => false)
    }
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

  // «Enviar ya» añade al turno activo o inicia el siguiente si ya está libre. Nunca lo cancela.
  async sendNow(id: string, to: 'current' | 'other' = 'current'): Promise<'sent'> {
    const q = this.d.store.getQueued(id)
    if (!q) throw new Error('Ese mensaje ya no está en la cola')
    let busy: string | undefined
    const thread = q.threadId ? this.d.store.getThread(q.threadId) : undefined
    if (thread) {
      const running = (['claude', 'codex'] as AgentId[]).filter((a) => this.sessionOf(thread, a)?.running)
      const current = q.agent && running.includes(q.agent) ? q.agent : running[0]
      const agent = to === 'other' ? (current ?? q.agent) === 'claude' ? 'codex' : 'claude' : current
      if (agent) {
        if (to === 'other' && !this.routeContext(thread).available[agent]) throw new Error(`${AGENT_NAMES[agent]} no está disponible`)
        const s = this.sessionOf(thread, agent)
        const prompt = q.prompt.replace(/^@(claude|codex)\b\s*/i, '') || q.prompt
        const ok = s?.running
          ? await this.d.service.steer(s.id, prompt, q.context, q.images)
          : !!(await this.sendThread(thread.id, prompt, { agent, context: q.context, images: q.images, fromQueue: true })).sessionId
        // si el turno justo termina, el mensaje sigue en la cola y sale solo a continuación, sin avisos
        if (!ok) return 'sent'
        this.d.store.removeQueued(id)
        this.pushQueue(q.projectId)
        return 'sent'
      }
    }
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
        this.d.service.send(q.sessionId, q.prompt, q.context, { images: q.images })
        this.d.store.removeQueued(id)
        this.pushQueue(q.projectId)
        return 'sent'
      }
      busy = q.sessionId
    }
    if (!busy) throw new Error('No se pudo enviar el mensaje')
    // si el agente admite mensajes a mitad de turno, entra en lo que está haciendo (sin pararlo)
    if (await this.d.service.steer(busy, q.prompt, q.context, q.images)) {
      this.d.store.removeQueued(id)
      this.pushQueue(q.projectId)
      return 'sent'
    }
    return 'sent'
  }

  // Una conversación ha quedado libre: siguiente mensaje de su cola
  async onIdle(session: SessionMeta) {
    try {
      if (session.threadId) {
        const thread = this.d.store.getThread(session.threadId)
        const other = thread && this.sessionOf(thread, session.agent === 'claude' ? 'codex' : 'claude')
        if (other?.running) {
          const summary = this.d.service.coordinationSnapshot?.(session.id) ?? ''
          const last = this.d.store.recentRuns(session.projectId, 200).find((r) => r.sessionId === session.id)
          const status = last?.status === 'failed' ? 'con error' : last?.status === 'cancelled' || last?.status === 'interrupted' ? 'interrumpida' : 'finalizada'
          await Promise.resolve(this.d.service.steer(other.id, `<agente_en_paralelo>\n${AGENT_NAMES[session.agent]} tiene su ejecución ${status} en esta conversación.\n${summary}\nRevisa los ficheros actuales antes de continuar y conserva su trabajo.\n</agente_en_paralelo>`, undefined, undefined, true)).catch(() => false)
        }
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
        this.d.service.send(session.id, next.prompt, next.context, { images: next.images })
        this.d.store.removeQueued(next.id)
        this.pushQueue(session.projectId)
      }
    } catch {
      this.pushQueue(session.projectId)
    }
  }

  pushQueue(projectId: string) {
    this.d.push('queue:changed', { projectId, items: this.d.store.listQueue(projectId) })
  }
}
