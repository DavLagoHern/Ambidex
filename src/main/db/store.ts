import { randomUUID } from 'crypto'
import type {
  AgentId, AgentLimits, ChatItem, Permission, ProjectMeta, ProjectPatch, QueuedMessage, RunInfo, RunLogLine, RunStatus, SearchHit,
  SessionCreate, SessionMeta, SessionPatch, SessionTotals, Settings, ThreadMeta
} from '@shared/types'
import type {
  OrchMessage, OrchOptions, OrchStatus, OrchTask, OrchWorktree, Orchestration, Plan, Review, TaskResult, TaskStatus, TestResult
} from '@shared/orchestrator'
import { DEFAULT_SETTINGS, emptyTotals } from '@shared/types'
import { searchText } from '@shared/chat'
import { DB, tx } from './database'

type Row = Record<string, any>

const PROJECT_COLORS = ['#e8825f', '#5fb3e8', '#8bd17c', '#c792ea', '#f2c46d', '#5fd4c4', '#f07fa0', '#9aa5ff', '#e8a35f', '#7fc8f8']

export function colorFor(path: string): string {
  let h = 0
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
}

const json = <T>(s: string | null | undefined, def: T): T => {
  if (!s) return def
  try {
    return JSON.parse(s) as T
  } catch {
    return def
  }
}

const nil = <T>(v: T | undefined): T | null => (v === undefined ? null : v)

const LOG_CAP_PER_RUN = 2000

export class Store {
  private logCount = new Map<string, number>()

  constructor(readonly db: DB) {}

  // ---------- ajustes ----------

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'").all() as Row[]
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const r of rows) s[r.key] = json(r.value, undefined)
    return s as unknown as Settings
  }

  // Estado interno de la app (no forma parte de los ajustes visibles)
  kvGet<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('_' + key) as Row | undefined
    return json<T | undefined>(r?.value, undefined)
  }

  kvSet(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('_' + key, JSON.stringify(value))
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const set = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    const del = this.db.prepare('DELETE FROM settings WHERE key = ?')
    tx(this.db, () => {
      for (const [k, v] of Object.entries(patch)) {
        if (k.startsWith('_')) continue
        if (v === undefined || v === null || v === '') del.run(k)
        else set.run(k, JSON.stringify(v))
      }
    })
    return this.getSettings()
  }

  // ---------- proyectos ----------

  private toProject(r: Row): Omit<ProjectMeta, 'exists'> {
    return {
      id: r.id,
      path: r.path,
      name: r.name,
      color: r.color,
      gitRoot: r.git_root ?? null,
      createdAt: r.created_at,
      lastOpenedAt: r.last_opened_at,
      isOpen: !!r.is_open,
      tabOrder: r.tab_order,
      pinned: !!r.pinned
    }
  }

  listProjects(): Omit<ProjectMeta, 'exists'>[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY is_open DESC, pinned DESC, tab_order, last_opened_at DESC').all() as Row[]).map(
      (r) => this.toProject(r)
    )
  }

  getProject(id: string): Omit<ProjectMeta, 'exists'> | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return r ? this.toProject(r) : undefined
  }

  getProjectByPath(path: string): Omit<ProjectMeta, 'exists'> | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Row | undefined
    return r ? this.toProject(r) : undefined
  }

  // Abre (o reabre) un proyecto como pestaña al final de la barra
  openProject(path: string, name: string, gitRoot: string | null, now = Date.now()): Omit<ProjectMeta, 'exists'> {
    return tx(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Row | undefined
      const maxOrder = (this.db.prepare('SELECT COALESCE(MAX(tab_order), -1) AS m FROM projects WHERE is_open = 1').get() as Row).m as number
      if (existing) {
        const order = existing.is_open ? existing.tab_order : maxOrder + 1
        this.db
          .prepare('UPDATE projects SET is_open = 1, tab_order = ?, last_opened_at = ?, git_root = ? WHERE id = ?')
          .run(order, now, gitRoot, existing.id)
        return this.getProject(existing.id)!
      }
      const id = randomUUID()
      this.db
        .prepare(
          `INSERT INTO projects (id, path, name, color, git_root, created_at, last_opened_at, is_open, tab_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(id, path, name, colorFor(path), gitRoot, now, now, maxOrder + 1)
      return this.getProject(id)!
    })
  }

  closeProject(id: string) {
    this.db.prepare('UPDATE projects SET is_open = 0, pinned = 0 WHERE id = ?').run(id)
  }

  touchProject(id: string, now = Date.now()) {
    this.db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(now, id)
  }

  updateProject(id: string, patch: ProjectPatch): Omit<ProjectMeta, 'exists'> {
    const cur = this.getProject(id)
    if (!cur) throw new Error('Proyecto no encontrado')
    this.db
      .prepare('UPDATE projects SET name = ?, color = ?, pinned = ? WHERE id = ?')
      .run(patch.name?.trim() || cur.name, patch.color ?? cur.color, (patch.pinned ?? cur.pinned) ? 1 : 0, id)
    return this.getProject(id)!
  }

  reorderProjects(ids: string[]) {
    const st = this.db.prepare('UPDATE projects SET tab_order = ? WHERE id = ?')
    tx(this.db, () => ids.forEach((id, i) => st.run(i, id)))
  }

  forgetProject(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  getUi(id: string): unknown {
    const r = this.db.prepare('SELECT ui_state FROM projects WHERE id = ?').get(id) as Row | undefined
    return json(r?.ui_state, {})
  }

  saveUi(id: string, ui: unknown) {
    this.db.prepare('UPDATE projects SET ui_state = ? WHERE id = ?').run(JSON.stringify(ui ?? {}), id)
  }

  // ---------- conversaciones ----------

  private toSession(r: Row): SessionMeta {
    return {
      id: r.id,
      projectId: r.project_id,
      agent: r.agent,
      title: r.title,
      cwd: r.cwd,
      agentSessionId: r.agent_session_id ?? undefined,
      model: r.model ?? undefined,
      effort: r.effort ?? undefined,
      permission: (r.permission ?? undefined) as Permission | undefined,
      worktree: r.worktree_path ? { path: r.worktree_path, branch: r.worktree_branch ?? '' } : undefined,
      totals: { ...emptyTotals(), ...json<Partial<SessionTotals>>(r.totals, {}) },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count ?? 0,
      running: false,
      threadId: r.thread_id ?? undefined,
      orchestrationId: r.orchestration_id ?? undefined
    }
  }

  private sessionSelect = `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.type = 'user') AS message_count FROM sessions s`

  listSessions(projectId: string): SessionMeta[] {
    return (this.db.prepare(`${this.sessionSelect} WHERE s.project_id = ? AND s.archived = 0 ORDER BY s.updated_at DESC`).all(projectId) as Row[]).map(
      (r) => this.toSession(r)
    )
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare(`${this.sessionSelect} WHERE s.id = ?`).get(id) as Row | undefined
    return r ? this.toSession(r) : undefined
  }

  createSession(projectId: string, cwd: string, opts: SessionCreate, now = Date.now()): SessionMeta {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, agent, title, cwd, model, effort, permission, worktree_path, worktree_branch, totals, created_at, updated_at, thread_id, orchestration_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        projectId,
        opts.agent,
        opts.title || 'Nueva conversación',
        cwd,
        nil(opts.model),
        nil(opts.effort),
        nil(opts.permission),
        nil(opts.worktree?.path),
        nil(opts.worktree?.branch),
        JSON.stringify(emptyTotals()),
        now,
        now,
        nil(opts.threadId),
        nil(opts.orchestrationId)
      )
    return this.getSession(id)!
  }

  // ---------- hilos del chat único ----------

  private toThread(r: Row): ThreadMeta {
    const sessions: Partial<Record<AgentId, string>> = {}
    for (const s of this.db.prepare('SELECT id, agent FROM sessions WHERE thread_id = ? ORDER BY created_at').all(r.id) as Row[]) sessions[s.agent as AgentId] = s.id
    return { id: r.id, projectId: r.project_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, sessions }
  }

  createThread(projectId: string, title = 'Nueva conversación', now = Date.now()): ThreadMeta {
    const id = randomUUID()
    this.db.prepare('INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, title, now, now)
    return this.getThread(id)!
  }

  getThread(id: string): ThreadMeta | undefined {
    const r = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined
    return r ? this.toThread(r) : undefined
  }

  listThreads(projectId: string): ThreadMeta[] {
    return (this.db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Row[]).map((r) => this.toThread(r))
  }

  updateThread(id: string, patch: { title?: string; updatedAt?: number }): ThreadMeta {
    const cur = this.getThread(id)
    if (!cur) throw new Error('Conversación no encontrada')
    this.db.prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?').run(patch.title?.trim() || cur.title, patch.updatedAt ?? cur.updatedAt, id)
    return this.getThread(id)!
  }

  deleteThread(id: string) {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM sessions WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM queue WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
    })
  }

  // ---------- cola de mensajes ----------

  private toQueued(r: Row): QueuedMessage {
    return {
      id: r.id,
      projectId: r.project_id,
      sessionId: r.session_id ?? undefined,
      threadId: r.thread_id ?? undefined,
      prompt: r.prompt,
      context: r.context ?? undefined,
      agent: r.agent ?? undefined,
      images: r.images ? JSON.parse(r.images) : undefined,
      createdAt: r.created_at
    }
  }

  enqueue(m: Omit<QueuedMessage, 'id' | 'createdAt'>, now = Date.now()): QueuedMessage {
    const id = randomUUID()
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM queue').get() as Row).m + 1
    this.db
      .prepare('INSERT INTO queue (id, project_id, session_id, thread_id, prompt, context, agent, images, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, m.projectId, nil(m.sessionId), nil(m.threadId), m.prompt, nil(m.context), nil(m.agent), m.images?.length ? JSON.stringify(m.images) : null, pos, now)
    return this.toQueued(this.db.prepare('SELECT * FROM queue WHERE id = ?').get(id) as Row)
  }

  listQueue(projectId: string): QueuedMessage[] {
    return (this.db.prepare('SELECT * FROM queue WHERE project_id = ? ORDER BY position').all(projectId) as Row[]).map((r) => this.toQueued(r))
  }

  // el primero de la cola (lo siguiente que se enviará)
  moveQueuedToFront(id: string) {
    this.db.prepare('UPDATE queue SET position = (SELECT COALESCE(MIN(position), 0) - 1 FROM queue) WHERE id = ?').run(id)
  }

  nextQueued(target: { sessionId?: string; threadId?: string }): QueuedMessage | undefined {
    const r = target.threadId
      ? (this.db.prepare('SELECT * FROM queue WHERE thread_id = ? ORDER BY position LIMIT 1').get(target.threadId) as Row | undefined)
      : (this.db.prepare('SELECT * FROM queue WHERE session_id = ? AND thread_id IS NULL ORDER BY position LIMIT 1').get(target.sessionId ?? '') as Row | undefined)
    return r ? this.toQueued(r) : undefined
  }

  getQueued(id: string): QueuedMessage | undefined {
    const r = this.db.prepare('SELECT * FROM queue WHERE id = ?').get(id) as Row | undefined
    return r ? this.toQueued(r) : undefined
  }

  updateQueued(id: string, prompt: string) {
    this.db.prepare('UPDATE queue SET prompt = ? WHERE id = ?').run(prompt, id)
  }

  removeQueued(id: string) {
    this.db.prepare('DELETE FROM queue WHERE id = ?').run(id)
  }

  // ---------- orquestaciones ----------

  createOrchestration(o: Omit<Orchestration, 'tasks' | 'messages' | 'worktrees' | 'updatedAt'> & { threadId?: string }) {
    this.db
      .prepare(
        `INSERT INTO orchestrations (id, project_id, thread_id, mode, request, status, planner, options, repo, base_branch, base_commit, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(o.id, o.projectId, nil(o.threadId), o.mode, o.request, o.status, nil(o.planner), JSON.stringify(o.options), o.repo, nil(o.baseBranch), o.baseCommit, o.slug, o.createdAt, o.createdAt)
  }

  updateOrchestration(
    id: string,
    patch: Partial<{ status: OrchStatus; resumeStatus: OrchStatus | null; plan: Plan; error: string | null; testResult: TestResult; integratedInto: string }>,
    now = Date.now()
  ) {
    const cols: string[] = []
    const vals: (string | number | null)[] = []
    const map: Record<string, [string, (v: any) => string | number | null]> = {
      status: ['status', (v) => v],
      resumeStatus: ['resume_status', (v) => v],
      plan: ['plan', (v) => JSON.stringify(v)],
      error: ['error', (v) => v],
      testResult: ['test_result', (v) => JSON.stringify(v)],
      integratedInto: ['integrated_into', (v) => v]
    }
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k]
      if (!m) continue
      cols.push(`${m[0]} = ?`)
      vals.push(v === null ? null : m[1](v))
    }
    cols.push('updated_at = ?')
    vals.push(now)
    this.db.prepare(`UPDATE orchestrations SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  private toTask(r: Row): OrchTask {
    return {
      id: r.id,
      orchestrationId: r.orchestration_id,
      key: r.key,
      title: r.title,
      description: r.description,
      acceptance: r.acceptance,
      assignee: r.assignee,
      dependsOn: json(r.depends_on, []),
      status: r.status,
      round: r.round,
      sessionId: r.session_id ?? undefined,
      reviewSessionId: r.review_session_id ?? undefined,
      result: json<TaskResult | undefined>(r.result, undefined),
      review: json<Review | undefined>(r.review, undefined),
      error: r.error ?? undefined,
      startedAt: r.started_at ?? undefined,
      endedAt: r.ended_at ?? undefined
    }
  }

  orchTasks(orchestrationId: string): OrchTask[] {
    return (this.db.prepare('SELECT * FROM orch_tasks WHERE orchestration_id = ? ORDER BY seq').all(orchestrationId) as Row[]).map((r) => this.toTask(r))
  }

  replaceTasks(orchestrationId: string, tasks: Omit<OrchTask, 'id' | 'orchestrationId' | 'status' | 'round'>[]) {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM orch_tasks WHERE orchestration_id = ?').run(orchestrationId)
      const ins = this.db.prepare(
        `INSERT INTO orch_tasks (id, orchestration_id, seq, key, title, description, acceptance, assignee, depends_on, status, round)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`
      )
      tasks.forEach((t, i) => ins.run(randomUUID(), orchestrationId, i, t.key, t.title, t.description, t.acceptance, t.assignee, JSON.stringify(t.dependsOn)))
    })
  }

  updateTask(
    id: string,
    patch: Partial<{ status: TaskStatus; round: number; sessionId: string; reviewSessionId: string; result: TaskResult; review: Review | null; error: string | null; startedAt: number; endedAt: number | null; assignee: AgentId }>
  ) {
    const map: Record<string, [string, (v: any) => string | number | null]> = {
      status: ['status', (v) => v],
      round: ['round', (v) => v],
      sessionId: ['session_id', (v) => v],
      reviewSessionId: ['review_session_id', (v) => v],
      result: ['result', (v) => JSON.stringify(v)],
      review: ['review', (v) => JSON.stringify(v)],
      error: ['error', (v) => v],
      startedAt: ['started_at', (v) => v],
      endedAt: ['ended_at', (v) => v],
      assignee: ['assignee', (v) => v]
    }
    const cols: string[] = []
    const vals: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k]
      if (!m) continue
      cols.push(`${m[0]} = ?`)
      vals.push(v === null ? null : m[1](v))
    }
    if (cols.length) this.db.prepare(`UPDATE orch_tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  addOrchMessage(orchestrationId: string, m: Omit<OrchMessage, 'id' | 'at'>, at = Date.now()) {
    this.db
      .prepare('INSERT INTO orch_messages (orchestration_id, at, from_agent, to_agent, kind, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orchestrationId, at, m.from, nil(m.to), m.kind, m.text)
  }

  addWorktree(w: { projectId: string; orchestrationId: string; owner: OrchWorktree['owner']; path: string; branch: string; baseCommit: string }) {
    this.db
      .prepare('INSERT INTO worktrees (id, project_id, orchestration_id, owner, path, branch, base_commit, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), w.projectId, w.orchestrationId, w.owner, w.path, w.branch, w.baseCommit, 'active', Date.now())
  }

  setWorktreeStatus(orchestrationId: string, path: string, status: OrchWorktree['status']) {
    this.db.prepare('UPDATE worktrees SET status = ? WHERE orchestration_id = ? AND path = ?').run(status, orchestrationId, path)
  }

  orchWorktrees(orchestrationId: string): OrchWorktree[] {
    return (this.db.prepare('SELECT owner, path, branch, status FROM worktrees WHERE orchestration_id = ? ORDER BY created_at').all(orchestrationId) as Row[]).map((r) => ({
      owner: r.owner,
      path: r.path,
      branch: r.branch,
      status: r.status
    }))
  }

  getOrchestration(id: string): Orchestration | undefined {
    const r = this.db.prepare('SELECT * FROM orchestrations WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    return {
      id: r.id,
      projectId: r.project_id,
      threadId: r.thread_id ?? undefined,
      mode: r.mode,
      request: r.request,
      status: r.status,
      planner: r.planner ?? undefined,
      plan: json<Plan | undefined>(r.plan, undefined),
      options: json<OrchOptions>(r.options, { maxRounds: 2, approvePlan: true, parallel: 2 }),
      repo: r.repo,
      baseBranch: r.base_branch ?? undefined,
      baseCommit: r.base_commit,
      slug: r.slug,
      error: r.error ?? undefined,
      testResult: json<TestResult | undefined>(r.test_result, undefined),
      integratedInto: r.integrated_into ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tasks: this.orchTasks(id),
      messages: (this.db.prepare('SELECT * FROM orch_messages WHERE orchestration_id = ? ORDER BY id').all(id) as Row[]).map((m) => ({
        id: m.id,
        at: m.at,
        from: m.from_agent,
        to: m.to_agent ?? undefined,
        kind: m.kind,
        text: m.text
      })),
      worktrees: this.orchWorktrees(id)
    }
  }

  resumeStatusOf(id: string): OrchStatus | undefined {
    return ((this.db.prepare('SELECT resume_status FROM orchestrations WHERE id = ?').get(id) as Row | undefined)?.resume_status ?? undefined) as OrchStatus | undefined
  }

  orchThreadId(id: string): string | undefined {
    return ((this.db.prepare('SELECT thread_id FROM orchestrations WHERE id = ?').get(id) as Row | undefined)?.thread_id ?? undefined) as string | undefined
  }

  listOrchestrations(projectId: string): Orchestration[] {
    return (this.db.prepare('SELECT id FROM orchestrations WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').all(projectId) as Row[]).map(
      (r) => this.getOrchestration(r.id)!
    )
  }

  orchestrationsWithStatus(statuses: OrchStatus[]): { id: string; status: OrchStatus }[] {
    return this.db
      .prepare(`SELECT id, status FROM orchestrations WHERE status IN (${statuses.map(() => '?').join(',')})`)
      .all(...statuses) as { id: string; status: OrchStatus }[]
  }

  updateSession(id: string, patch: SessionPatch & { agentSessionId?: string; totals?: SessionTotals; updatedAt?: number }): SessionMeta {
    const cur = this.getSession(id)
    if (!cur) throw new Error('Conversación no encontrada')
    const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k)
    this.db
      .prepare(
        `UPDATE sessions SET title = ?, model = ?, effort = ?, permission = ?, agent_session_id = ?, totals = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        patch.title?.trim() || cur.title,
        has('model') ? nil(patch.model || undefined) : nil(cur.model),
        has('effort') ? nil(patch.effort || undefined) : nil(cur.effort),
        has('permission') ? nil(patch.permission) : nil(cur.permission),
        nil(patch.agentSessionId ?? cur.agentSessionId),
        JSON.stringify(patch.totals ?? cur.totals),
        patch.updatedAt ?? cur.updatedAt,
        id
      )
    return this.getSession(id)!
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  messages(sessionId: string): ChatItem[] {
    return (this.db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as Row[]).map((r) =>
      JSON.parse(r.data)
    )
  }

  // último mensaje del usuario en una sesión (contexto para el enrutado)
  lastUserText(sessionId: string): string | undefined {
    const r = this.db.prepare("SELECT data FROM messages WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1").get(sessionId) as Row | undefined
    return r ? (JSON.parse(r.data) as { text?: string }).text : undefined
  }

  messagesForRun(runId: string): { item: ChatItem; seq: number; sessionId: string }[] {
    return (this.db.prepare('SELECT data, seq, session_id FROM messages WHERE run_id = ? ORDER BY seq').all(runId) as Row[]).map((r) => ({
      item: JSON.parse(r.data),
      seq: r.seq,
      sessionId: r.session_id
    }))
  }

  nextSeq(sessionId: string): number {
    return ((this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?').get(sessionId) as Row).m as number) + 1
  }

  upsertMessage(sessionId: string, seq: number, runId: string | null, item: ChatItem, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, run_id, type, data, search_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, search_text = excluded.search_text, updated_at = excluded.updated_at`
      )
      .run(item.id, sessionId, seq, runId, item.type, JSON.stringify(item), searchText(item), now, now)
  }

  search(projectId: string, query: string, limit = 50): SearchHit[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => '\\' + c)}%`
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.agent, s.updated_at,
           (SELECT m.search_text FROM messages m WHERE m.session_id = s.id AND m.search_text LIKE ? ESCAPE '\\' ORDER BY m.seq DESC LIMIT 1) AS hit
         FROM sessions s
         WHERE s.project_id = ? AND s.archived = 0 AND (
           s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.search_text LIKE ? ESCAPE '\\')
         )
         ORDER BY s.updated_at DESC LIMIT ?`
      )
      .all(like, projectId, like, like, limit) as Row[]
    const ql = query.toLowerCase()
    return rows.map((r) => {
      const text: string = r.hit ?? r.title
      const i = text.toLowerCase().indexOf(ql)
      const snippet = i < 0 ? text.slice(0, 120) : (i > 40 ? '…' : '') + text.slice(Math.max(0, i - 40), i + 80)
      return { sessionId: r.id, title: r.title, agent: r.agent as AgentId, snippet: snippet.replace(/\s+/g, ' '), updatedAt: r.updated_at }
    })
  }

  // ---------- ejecuciones ----------

  private toRun(r: Row): RunInfo {
    return {
      id: r.id,
      sessionId: r.session_id,
      projectId: r.project_id,
      agent: r.agent,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      exitCode: r.exit_code,
      error: r.error ?? undefined,
      pid: r.pid ?? undefined,
      sessionTitle: r.title ?? undefined,
      undo: r.undone_at ? 'done' : r.checkpoint_before && r.checkpoint_after && r.checkpoint_before !== r.checkpoint_after ? 'available' : undefined
    }
  }

  setCheckpoint(id: string, which: 'before' | 'after', tree: string) {
    this.db.prepare(`UPDATE runs SET checkpoint_${which} = ? WHERE id = ?`).run(tree, id)
  }

  checkpoint(id: string): { before?: string; after?: string; undoneAt?: number; cwd: string; startedAt: number; endedAt?: number; projectId: string } | undefined {
    const r = this.db.prepare('SELECT checkpoint_before, checkpoint_after, undone_at, cwd, started_at, ended_at, project_id FROM runs WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    return {
      before: r.checkpoint_before ?? undefined,
      after: r.checkpoint_after ?? undefined,
      undoneAt: r.undone_at ?? undefined,
      cwd: r.cwd,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      projectId: r.project_id
    }
  }

  markUndone(id: string, at = Date.now()) {
    this.db.prepare('UPDATE runs SET undone_at = ? WHERE id = ?').run(at, id)
  }

  // otras ejecuciones en la misma carpeta que se solaparon en el tiempo (sus cambios entran en la misma foto)
  overlappingRuns(id: string): number {
    const r = this.db.prepare('SELECT cwd, started_at, ended_at FROM runs WHERE id = ?').get(id) as Row | undefined
    if (!r) return 0
    const end = r.ended_at ?? Date.now()
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id != ? AND cwd = ? AND started_at < ? AND COALESCE(ended_at, ?) > ?').get(id, r.cwd, end, end, r.started_at) as Row
    ).n
  }

  createRun(run: { id: string; sessionId: string; projectId: string; agent: AgentId; cwd: string; bin: string; args: string[]; startedAt: number }) {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, project_id, agent, status, bin, cwd, args, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(run.id, run.sessionId, run.projectId, run.agent, run.bin, run.cwd, JSON.stringify(run.args), run.startedAt)
  }

  setRunPid(id: string, pid: number) {
    this.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id)
  }

  finishRun(id: string, f: { status: RunStatus; endedAt: number; exitCode: number | null; signal: string | null; error?: string; stderrTail?: string }) {
    this.db
      .prepare('UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, signal = ?, error = ?, stderr_tail = ? WHERE id = ?')
      .run(f.status, f.endedAt, f.exitCode, f.signal, nil(f.error), nil(f.stderrTail), id)
    this.logCount.delete(id)
  }

  getRun(id: string): RunInfo | undefined {
    const r = this.db.prepare('SELECT r.*, s.title FROM runs r LEFT JOIN sessions s ON s.id = r.session_id WHERE r.id = ?').get(id) as Row | undefined
    return r ? this.toRun(r) : undefined
  }

  recentRuns(projectId: string, limit: number): RunInfo[] {
    return (
      this.db
        .prepare('SELECT r.*, s.title FROM runs r LEFT JOIN sessions s ON s.id = r.session_id WHERE r.project_id = ? ORDER BY r.started_at DESC LIMIT ?')
        .all(projectId, limit) as Row[]
    ).map((r) => this.toRun(r))
  }

  runningRuns(): (RunInfo & { bin: string | null })[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as Row[]).map((r) => ({ ...this.toRun(r), bin: r.bin }))
  }

  appendLog(runId: string, stream: RunLogLine['stream'], line: string, at = Date.now()) {
    const n = this.logCount.get(runId) ?? 0
    if (n >= LOG_CAP_PER_RUN) return
    this.logCount.set(runId, n + 1)
    this.db.prepare('INSERT INTO run_log (run_id, at, stream, line) VALUES (?, ?, ?, ?)').run(runId, at, stream, line.slice(0, 8000))
    if (n + 1 === LOG_CAP_PER_RUN)
      this.db.prepare('INSERT INTO run_log (run_id, at, stream, line) VALUES (?, ?, ?, ?)').run(runId, at, 'system', `Registro truncado a ${LOG_CAP_PER_RUN} líneas`)
  }

  runLog(runId: string): RunLogLine[] {
    return this.db.prepare('SELECT at, stream, line FROM run_log WHERE run_id = ? ORDER BY id').all(runId) as unknown as RunLogLine[]
  }

  // ---------- límites, auditoría ----------

  saveLimits(l: AgentLimits) {
    this.db
      .prepare('INSERT INTO agent_limits (agent, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(l.agent, JSON.stringify(l), l.updatedAt)
  }

  getLimits(): Partial<Record<AgentId, AgentLimits>> {
    const out: Partial<Record<AgentId, AgentLimits>> = {}
    for (const r of this.db.prepare('SELECT agent, data FROM agent_limits').all() as Row[]) out[r.agent as AgentId] = json(r.data, undefined)
    return out
  }

  audit(projectId: string | null, actor: string, action: string, detail: unknown, at = Date.now()) {
    this.db.prepare('INSERT INTO audit_log (at, project_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(at, projectId, actor, action, JSON.stringify(detail ?? {}))
  }

  auditTail(limit = 200): { at: number; projectId: string | null; actor: string; action: string; detail: unknown }[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      at: r.at,
      projectId: r.project_id,
      actor: r.actor,
      action: r.action,
      detail: json(r.detail, {})
    }))
  }
}
