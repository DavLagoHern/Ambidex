/** Headless compatibility engine. No Electron or DOM dependency. Native services live in src-tauri. */
import { consumeResetCredit, fetchAccountLimits } from '../main/agents/usage-limits'
import { UsageRefresh } from '../main/agents/usage-refresh'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import type { PushChannel, PushContract, IpcContract } from '@shared/ipc'
import type { AgentId, AgentInfo, AgentLimits, Settings } from '@shared/types'
import { AGENT_NAMES, DEFAULT_MODEL_POLICY } from '@shared/types'
import { openDatabase } from '../main/db/database'
import { Store } from '../main/db/store'
import { claudeAdapter } from '../main/agents/claude'
import { codexDefaultModel, codexHome, CodexModels, createCodexAdapter, latestCodexLimits, readCodexModels } from '../main/agents/codex'
import { detectAgents, resolveBin } from '../main/agents/detect'
import { agentEnv, binVersion, loadShellPath, run } from '../main/agents/env'
import { oneShot } from '../main/agents/oneshot'
import { SessionService } from '../main/agents/service'
import { Dispatcher } from '../main/agents/dispatcher'
import { claudeChannel, CliUpdater } from '../main/agents/updates'
import { AppUpdater, type Exec } from '../main/app-update'
import { difficultyCriteria, pickModel, routeCategories } from '@shared/router'
import { ACTIVE_STATUSES } from '@shared/orchestrator'
import { Orchestrator } from '../main/orchestrator/engine'
import * as files from '../main/files'
import * as gitApi from '../main/git'
import * as github from '../main/github'
import { logger } from '../main/logger'
import { checkGitArgs, PathGuard } from '../main/security'
import { checkImage } from '../main/attachments'
import { snapshot, undo, undoPlan } from '../main/checkpoints'
import { detectDevScripts } from '../main/devserver'
import { scanExtensions } from '../main/extensions'
import { claudeSessions, claudeTranscript, codexSessions, codexTranscript, isClaudeLive } from '../main/external-sessions'
import { agentMcpArgs, createWebAgent, WEB_TOKEN_ENV } from '../main/web-agent'
import { Jev } from '../main/jev'
import { APP_HOME, dbFile } from '../main/paths'
import { NativeBrowser } from './web'

// stdout is exclusively a framed JSON protocol. Diagnostics must never corrupt it.
console.log = (...args: unknown[]) => console.error(...args)
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
function host(channel: string, ...args: unknown[]): Promise<any> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`El servicio nativo no respondió: ${channel}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    send({ host: channel, id, args })
  })
}
const dataDir = process.env.AMBIDEX_USER_DATA
if (!dataDir) throw new Error('El host debe indicar AMBIDEX_USER_DATA')
mkdirSync(dataDir, { recursive: true })
logger.init(join(dataDir, 'logs'))
if (!process.env.AMBIDEX_TEST) loadShellPath()
const db = openDatabase(dbFile(dataDir))
const store = new Store(db)
const settings = (): Settings => store.getSettings()
const childEnv = () => agentEnv(process.env, { stripApiKeys: settings().stripApiKeys })
const attachmentsDir = () => join(dataDir, 'attachments')
let quitting = false
let agentInfo: AgentInfo[] = store.kvGet<AgentInfo[]>('nativeAgentInfo') ?? []
let codexModels: CodexModels | undefined = store.kvGet<CodexModels>('nativeCodexModels')
const codexDefault = () => codexDefaultModel(codexModels ?? readCodexModels()).model
async function refreshAgents() {
  const r = await detectAgents(settings(), childEnv())
  agentInfo = r.agents
  codexModels = r.codexModels ?? codexModels
  return agentInfo
}
const available = (agent: AgentId) => { const a = agentInfo.find(a => a.agent === agent); return !a || (!!a.path && a.auth?.loggedIn !== false) }
const push = <K extends PushChannel>(channel: K, payload: PushContract[K]) => send({ event: channel, payload })
const updateDockBadge = () => send({ event: 'native:busy', payload: service.runningCount() })
const browser = new NativeBrowser(host)
const webAgent = createWebAgent({
  tab: id => browser.tab(id), open: (id, url) => browser.open(id, url), issues: wc => browser.issues(wc),
  activity: (ctx, action) => push('web:agent', { projectId: ctx.projectId, agent: ctx.agent, action })
})
const worktreeBase = () => settings().worktreeDir || gitApi.WORKTREE_BASE
const roots = () => [...new Set([gitApi.WORKTREE_BASE, worktreeBase(), ...store.listProjects().flatMap(p => [p.path, ...(p.gitRoot ? [p.gitRoot] : []), ...(settings().extraRepos?.[p.path] ?? [])])])]
const guard = new PathGuard(roots)
const g = (cwd: string) => guard.check(cwd, 'El repositorio')
const service = new SessionService({
  store, push, adapters: { claude: claudeAdapter, codex: createCodexAdapter() },
  resolveBin: agent => resolveBin(agent, settings()), env: childEnv,
  defaultModel: agent => agent === 'codex' ? codexDefault() : undefined,
  checkImage: p => checkImage(attachmentsDir(), p), checkpoint: snapshot,
  forkIfLive: (agent, id) => agent === 'claude' && isClaudeLive(homedir(), id),
  tools: ({ projectId, runId, agent }) => {
    if (settings().agentWeb === false || !webAgent.started) return undefined
    const token = webAgent.grant({ projectId, runId, agent })
    return { ...agentMcpArgs(agent, webAgent.url), env: { [WEB_TOKEN_ENV]: token }, release: () => webAgent.revoke(token) }
  },
  agentEnv: (agent): Record<string, string> => agent === 'claude' && settings().autoCompact > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(settings().autoCompact)) } : {},
  extraArgs: agent => {
    if (agent !== 'codex') return []
    const s = settings(), args: string[] = []
    if (s.codexNetwork) args.push('-c', 'sandbox_workspace_write.network_access=true')
    if (s.autoCompact > 0) args.push('-c', `model_auto_compact_token_limit=${Math.round(s.autoCompact)}`)
    if (s.codexWebSearch !== 'default') args.push('-c', `web_search="${s.codexWebSearch}"`)
    return args
  },
  onIdle: s => dispatcher.onIdle(s),
  onFinished: (run) => { updateDockBadge(); usageRefresh.afterTurn(); send({ event: 'native:finished', payload: run }) }
})
const jev = new Jev({ dir: join(APP_HOME, 'jev'), onStatus: s => push('jev:status', s), log: (m, d) => logger.info(m, d) })
const dispatcher = new Dispatcher({
  store, service, push, settings, available, jev,
  models: agent => agentInfo.find(a => a.agent === agent)?.models,
  aiRoute: (prompt, cwd) => {
    const bin = resolveBin('claude', settings())
    if (!bin) return Promise.reject(new Error('Claude Code no encontrado'))
    return oneShot({ agent: 'claude', bin, cwd, prompt, stdin: '', model: 'haiku', env: childEnv() })
  }
})
const orchestrator = new Orchestrator({ store, service, push, settings, worktreeBase, env: childEnv })
const updater = new CliUpdater({
  bin: agent => resolveBin(agent, settings()), version: binVersion,
  run: (file, args) => run(file, args, { env: { ...childEnv(), HOMEBREW_NO_ENV_HINTS: '1' }, timeout: 600000 }),
  busy: agent => service.agentBusy(agent), onStatus: s => push('cli:update', s),
  onUpdated: async (agent, from, to) => { store.audit(null, 'system', 'cli.update', { agent, from, to }); await refreshAgents() },
  log: (m, d) => logger.info(m, d), channel: agent => agent === 'claude' ? claudeChannel() : 'latest'
})
const SOURCE = process.env.AMBIDEX_SOURCE || undefined
function sourceExec(file: string, args: string[], timeout: number): Promise<Exec> {
  return new Promise(resolve => {
    const log = createWriteStream(join(dataDir!, 'logs/update.log'), { flags: 'a' })
    let stdout = '', stderr = ''
    const p = spawn(file, args, { cwd: SOURCE, env: childEnv() })
    const timer = setTimeout(() => p.kill('SIGTERM'), timeout)
    p.stdout.on('data', d => { if (stdout.length < 1000000) stdout += String(d); log.write(d) })
    p.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-4000); log.write(d) })
    p.on('error', e => { stderr += e.message })
    p.on('close', code => { clearTimeout(timer); log.end(); resolve({ code: code ?? 1, stdout, stderr }) })
  })
}
const appUpdater = new AppUpdater({
  source: SOURCE, builtCommit: __AMBIDEX_COMMIT__ || undefined, exists: existsSync,
  git: args => sourceExec('git', args, 120000), npm: args => sourceExec('/usr/bin/nice', ['-n', '10', 'npm', ...args], 1200000),
  version: () => { try { return JSON.parse(readFileSync(join(SOURCE!, 'package.json'), 'utf8')).version } catch { return undefined } },
  onStatus: s => push('self:update', s), log: (m, d) => logger.info(m, d)
})
let usageResetting = false
function savedLimits(): Partial<Record<AgentId, AgentLimits>> {
  const all = store.getLimits(), codex = latestCodexLimits()
  if (codex && (!all.codex || codex.updatedAt > all.codex.updatedAt)) all.codex = codex
  return all
}
async function refreshAccountUsage() {
  if (quitting) return
  let value: AgentLimits
  try {
    const bin = resolveBin('codex', settings())
    if (!bin) return
    value = await fetchAccountLimits(bin, homedir(), childEnv())
  } catch (e) {
    value = { ...(savedLimits().codex ?? { agent: 'codex', windows: [], updatedAt: 0 }), refreshError: String(e) }
  }
  if (quitting) return
  store.saveLimits(value); push('limits', value)
}
const usageRefresh = new UsageRefresh(refreshAccountUsage)
let usageStart: ReturnType<typeof setTimeout> | undefined
function warmJev() {
  if (settings().routerMode === 'jev' && jev.installed()) jev.ensure().catch(e => logger.warn('jev.warm', { error: String(e) }))
}
function externalTranscript(projectId: string, agent: AgentId, id: string) {
  const p = store.getProject(projectId)
  if (!p) throw new Error('Proyecto no encontrado')
  return agent === 'claude' ? claudeTranscript(homedir(), p.path, id) : codexTranscript(codexHome(), p.path, id)
}
function undoable(runId: string) {
  const c = store.checkpoint(runId)
  if (!c?.before || !c.after) throw new Error('Este turno no tiene punto de control')
  if (c.undoneAt) throw new Error('Este turno ya se deshizo')
  return { ...c, before: c.before, after: c.after }
}
type Handlers = { [K in keyof IpcContract]?: (...args: Parameters<IpcContract[K]>) => ReturnType<IpcContract[K]> | Promise<ReturnType<IpcContract[K]>> }

function handlers(): Handlers { return {
'settings:get': () => settings(),
'settings:save': async (patch) => {
      const prev = settings()
      const next = store.saveSettings(patch)
      
      if (patch.claudePath !== undefined || patch.codexPath !== undefined || patch.stripApiKeys !== prev.stripApiKeys) refreshAgents()
      if (patch.autoUpdateClis && !prev.autoUpdateClis) updater.check(true).catch(() => {})
      return next
    },
'projects:list': () => store.listProjects().map((p) => ({ ...p, exists: existsSync(p.path) })),
'projects:open': async (path) => {
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('La carpeta no existe')
      const root = await gitApi.repoRoot(path)
      const p = store.openProject(path, basename(path), root)
      store.audit(p.id, 'user', 'project.open', { path })
      return { ...p, exists: true }
    },
'projects:close': (id) => {
      store.closeProject(id)
      files.unwatch(id)
    },
'projects:update': (id, patch) => ({ ...store.updateProject(id, patch), exists: true }),
'projects:reorder': (ids) => store.reorderProjects(ids),
'projects:forget': (id) => {
      if (store.listSessions(id).some((s) => service.isRunning(s.id))) throw new Error('Hay agentes trabajando en este proyecto')
      store.audit(id, 'user', 'project.forget', {})
      store.forgetProject(id)
      files.unwatch(id)
    },
'projects:getUi': (id) => store.getUi(id),
'projects:saveUi': (id, ui) => store.saveUi(id, ui),
'sessions:list': (projectId) => service.listSessions(projectId),
'sessions:create': (projectId, opts) => {
      const p = store.getProject(projectId)
      if (!p) throw new Error('Proyecto no encontrado')
      const s = settings()
      const cwd = guard.check(opts.cwd || p.path, 'La carpeta de trabajo')
      return store.createSession(projectId, cwd, {
        ...opts,
        model: opts.model ?? (opts.agent === 'claude' ? s.claudeModel : s.codexModel),
        effort: opts.effort ?? (opts.agent === 'claude' ? s.claudeEffort : s.codexEffort),
        permission: opts.permission ?? (opts.agent === 'claude' ? s.claudeMode : s.codexSandbox)
      })
    },
'sessions:update': (id, patch) => service.withRunState(store.updateSession(id, patch)),
'sessions:delete': (id) => {
      if (service.isRunning(id)) throw new Error('Detén el agente antes de borrar la conversación')
      store.deleteSession(id)
    },
'sessions:messages': (id) => store.messages(id),
'sessions:search': (projectId, q) => (q.trim() ? store.search(projectId, q.trim()) : []),
'sessions:send': async (id, prompt, context, images) => {
      if (service.isRunning(id)) {
        if (await service.steer(id, prompt, context, images)) return { steered: true }
        dispatcher.enqueue({ projectId: store.getSession(id)!.projectId, sessionId: id, prompt, context, images })
        // Puede haber terminado entre comprobar el estado y añadir el mensaje a la cola.
        if (!service.isRunning(id)) void dispatcher.onIdle(store.getSession(id)!)
        return { queued: true }
      }
      const { runId } = service.send(id, prompt, context, { images })
      updateDockBadge()
      return { runId }
    },
'sessions:cancel': (id) => service.cancel(id),
'sessions:compact': (id) => void service.compact(id),
'runs:undoPreview': async (runId) => {
      const c = undoable(runId)
      const plan = await undoPlan(c.cwd, c.before, c.after)
      return { files: plan.files.map(({ path, action }) => ({ path, action })), overlapping: store.overlappingRuns(runId) }
    },
'runs:undo': async (runId) => {
      const c = undoable(runId)
      const busy = store.runningRuns().find((r) => store.checkpoint(r.id)?.cwd === c.cwd)
      if (busy) throw new Error('Hay un agente trabajando en esa carpeta: espera a que termine para deshacer')
      const r = await undo(c.cwd, c.before, c.after)
      store.markUndone(runId)
      store.audit(c.projectId, 'user', 'agent.undo', { runId, restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length })
      const info = store.getRun(runId)
      if (info) push('run:status', info)
      return r
    },
'runs:recent': (projectId, limit) => store.recentRuns(projectId, Math.min(limit, 200)),
'threads:list': (projectId) => store.listThreads(projectId),
'threads:create': (projectId) => dispatcher.createThread(projectId),
'threads:rename': (id, title) => {
      const t = store.updateThread(id, { title })
      for (const sid of Object.values(t.sessions)) if (sid) store.updateSession(sid, { title: t.title })
      return t
    },
'threads:delete': (id) => {
      const t = store.getThread(id)
      if (t && Object.values(t.sessions).some((sid) => sid && service.isRunning(sid))) throw new Error('Detén los agentes antes de borrar la conversación')
      store.deleteThread(id)
    },
'threads:preview': (threadId, text) => dispatcher.preview(threadId, text),
'jev:status': () => jev.status(),
'jev:install': async () => {
      store.audit(null, 'user', 'jev.install', { release: jev.status().release, source: jev.status().source })
      await jev.install()
      // recién instalado, pasa a ser el enrutador
      store.saveSettings({ routerMode: 'jev' })
      jev.ensure().catch(() => {})
      return settings()
    },
'jev:cancel': () => jev.cancelInstall(),
'jev:stop': () => jev.stop(),
'jev:remove': async () => {
      await jev.remove()
      if (settings().routerMode === 'jev') store.saveSettings({ routerMode: 'rules' })
      return settings()
    },
'jev:warm': () => warmJev(),
'jev:test': (text) => {
      const s = settings()
      return jev.test(text, { categories: Object.fromEntries(routeCategories(s).map((c) => [c.id, c.description.trim() || c.label])), difficultyCriteria: difficultyCriteria(s) })
    },
'threads:send': async (threadId, text, opts) => {
      const r = await dispatcher.sendThread(threadId, text, opts)
      updateDockBadge()
      return { decision: r.decision, sessionId: r.sessionId, queued: !!r.queued, steered: !!r.steered }
    },
'queue:list': (projectId) => store.listQueue(projectId),
'queue:add': (m) => dispatcher.enqueue(m),
'queue:remove': (id) => dispatcher.remove(id),
'queue:update': (id, prompt) => dispatcher.update(id, prompt),
'queue:sendNow': (id, to) => dispatcher.sendNow(id, to),
'orch:list': (projectId) => orchestrator.list(projectId),
'orch:get': (id) => orchestrator.get(id),
'orch:start': async (projectId, req, threadId) => {
      const o = await orchestrator.start(projectId, req, threadId)
      // la petición al equipo da nombre a la conversación si aún no lo tiene
      const t = threadId ? store.getThread(threadId) : undefined
      if (t && t.title === 'Nueva conversación') push('thread:meta', store.updateThread(t.id, { title: req.request.split('\n')[0].slice(0, 60), updatedAt: Date.now() }))
      return o
    },
'orch:approvePlan': (id, tasks) => orchestrator.approvePlan(id, tasks),
'orch:cancel': (id) => orchestrator.cancel(id),
'orch:resume': (id) => orchestrator.resume(id),
'orch:integrate': (id, opts) => orchestrator.integrate(id, opts),
'orch:discard': (id) => orchestrator.discard(id),
'orch:cleanup': (id) => orchestrator.cleanup(id),
'orch:changes': (id, candidate) => orchestrator.changes(id, candidate),
'runs:log': (runId) => store.runLog(runId),
'agents:info': (refresh) => (refresh || !agentInfo.length ? refreshAgents() : agentInfo),
'agents:limits': async (refresh) => {
      if (refresh) await usageRefresh.refresh()
      return savedLimits()
    },
'agents:resetCredit': async (key) => {
      if (usageResetting) throw new Error('Ya hay un reinicio en curso')
      const bin = resolveBin('codex', settings())
      if (!bin) throw new Error('Codex no está instalado')
      usageResetting = true
      try {
        // Confirmación nativa: ningún cliente puede canjear un crédito en segundo plano.
        const answer = { response: (await host('app:confirm', '¿Usar un reinicio de cuota de Codex?', 'Se canjeará un reinicio de tu cuenta. Esta acción no se puede deshacer.', true)) ? 1 : 0 }
        if (answer.response !== 1) return null
        const outcome = await consumeResetCredit(bin, homedir(), childEnv(), key)
        // Si había una lectura anterior en curso, volver a consultar después del canje.
        await usageRefresh.refreshAfterChange()
        return outcome
      } finally { usageResetting = false }
    },
'agents:oneShot': (agent, cwd, prompt, stdin, model) => {
      const bin = resolveBin(agent, settings())
      if (!bin) throw new Error(`No se encontró el CLI de ${AGENT_NAMES[agent]}`)
      // tareas cortas (mensaje de commit…): siempre el modelo más rápido y barato, nunca el que uses para programar
      const fast = agent === 'claude' ? 'haiku' : pickModel('codex', 'easy', settings().modelPolicy ?? DEFAULT_MODEL_POLICY, agentInfo.find((a) => a.agent === 'codex')?.models?.map((m) => m.id))?.model
      return oneShot({ agent, bin, cwd: guard.check(cwd), prompt, stdin, model: fast || model || (agent === 'codex' ? codexDefault() : undefined), env: childEnv() })
    },
'cli:updates': () => updater.status(),
'cli:check': () => updater.check(settings().autoUpdateClis !== false),
'cli:update': (agent) => updater.checkOne(agent, true),
'self:status': () => appUpdater.status(),
'self:check': () => appUpdater.check(),
'git:status': (cwd) => gitApi.status(g(cwd)),
'git:numstat': (cwd, staged) => gitApi.numstat(g(cwd), staged),
'git:stage': async (cwd, paths) => void (await gitApi.stage(g(cwd), paths)),
'git:unstage': async (cwd, paths) => void (await gitApi.unstage(g(cwd), paths)),
'git:discard': async (cwd, list) => {
      await gitApi.discard(g(cwd), list)
      store.audit(null, 'user', 'git.discard', { cwd, files: list.map((f) => f.path) })
    },
'git:show': (cwd, ref, path) => gitApi.showFile(g(cwd), ref, path),
'git:diffText': (cwd, staged) => gitApi.diffText(g(cwd), staged),
'git:commit': async (cwd, msg, amend) => {
      const out = await gitApi.commit(g(cwd), msg, amend)
      store.audit(null, 'user', 'git.commit', { cwd, amend })
      return out
    },
'git:lastMessage': (cwd) => gitApi.lastCommitMessage(g(cwd)),
'git:log': (cwd, limit, skip, all) => gitApi.log(g(cwd), limit, skip, all),
'git:commitDetail': (cwd, hash) => gitApi.commitDetail(g(cwd), hash),
'git:commitPatch': (cwd, hash) => gitApi.commitPatch(g(cwd), hash),
'git:branches': (cwd) => gitApi.branches(g(cwd)),
'git:checkout': async (cwd, name, remote) => void (await gitApi.checkout(g(cwd), name, remote)),
'git:createBranch': async (cwd, name, from) => void (await gitApi.createBranch(g(cwd), name, from)),
'git:deleteBranch': async (cwd, name, force) => {
      await gitApi.deleteBranch(g(cwd), name, force)
      store.audit(null, 'user', 'git.deleteBranch', { cwd, name, force })
    },
'git:fetch': async (cwd) => void (await gitApi.fetch(g(cwd))),
'git:pull': async (cwd) => {
      await gitApi.pull(g(cwd))
      store.audit(null, 'user', 'git.pull', { cwd })
    },
'git:push': async (cwd) => {
      await gitApi.push(g(cwd))
      store.audit(null, 'user', 'git.push', { cwd })
    },
'git:init': async (cwd) => void (await gitApi.init(g(cwd))),
'git:worktrees': (cwd) => gitApi.worktrees(g(cwd)),
'git:addWorktree': (cwd, name) => gitApi.addWorktree(g(cwd), name, worktreeBase()),
'git:removeWorktree': async (cwd, path) => {
      await gitApi.removeWorktree(g(cwd), guard.check(path, 'El worktree'))
      store.audit(null, 'user', 'git.removeWorktree', { cwd, path })
    },
'git:listFiles': (cwd) => gitApi.listFiles(g(cwd)),
'git:grep': (cwd, q, regex, cs) => gitApi.grep(g(cwd), q, regex, cs),
'git:findRepos': (root) => {
      const extra = (settings().extraRepos?.[root] ?? []).filter((p) => existsSync(p))
      return [...new Set([...gitApi.findRepos(g(root)), ...extra])]
    },
'git:run': async (cwd, args) => {
      const out = await gitApi.run(g(cwd), checkGitArgs(args))
      store.audit(null, 'user', 'git.run', { cwd, args })
      return out
    },
'git:remotes': (cwd) => gitApi.remotes(g(cwd)),
'git:tags': (cwd) => gitApi.tags(g(cwd)),
'git:stashes': (cwd) => gitApi.stashes(g(cwd)),
'git:output': () => gitApi.gitOutput(),
'git:prInfo': (cwd) => github.prInfo(g(cwd)),
'git:createPR': async (cwd, pr) => {
      const url = await github.createPR(g(cwd), pr)
      store.audit(null, 'user', 'git.createPR', { cwd, url })
      return url
    },
'git:commitsSince': (cwd, base) => gitApi.commitsSince(g(cwd), base),
'external:list': (projectId) => {
      const p = store.getProject(projectId)
      if (!p) return []
      // las que ya continúan en la app no se repiten
      const known = new Set(store.listSessions(projectId).map((s) => s.agentSessionId))
      return [...claudeSessions(homedir(), p.path), ...codexSessions(codexHome(), p.path)].filter((s) => !known.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)
    },
'external:read': (projectId, agent, id) => externalTranscript(projectId, agent, id),
'external:import': (projectId, agent, id) => {
      const p = store.getProject(projectId)
      if (!p) throw new Error('Proyecto no encontrado')
      const ext = (agent === 'claude' ? claudeSessions(homedir(), p.path, 500) : codexSessions(codexHome(), p.path, 500)).find((s) => s.id === id)
      if (!ext) throw new Error('Esa conversación ya no existe')
      const items = externalTranscript(projectId, agent, id)
      const s = store.createSession(projectId, p.path, { agent, title: ext.title, permission: agent === 'claude' ? settings().claudeMode : settings().codexSandbox })
      store.updateSession(s.id, { agentSessionId: id, updatedAt: ext.updatedAt })
      items.forEach((it, i) => store.upsertMessage(s.id, i, null, it))
      store.upsertMessage(s.id, items.length, null, {
        id: randomUUID(),
        type: 'notice',
        text: `Conversación traída de ${ext.source}: lo que escribas aquí continúa la misma sesión de ${AGENT_NAMES[agent]}.`,
        at: Date.now()
      })
      store.audit(projectId, 'user', 'session.import', { agent, source: ext.source })
      const meta = service.getSession(s.id)!
      push('session:meta', meta)
      return meta
    }
} }

const api: Record<string, (...args: any[]) => any> = handlers() as any
api['extensions:list'] = (root?: string) => scanExtensions(homedir(), codexHome(), root ? guard.check(root) : undefined)
api['project:devScripts'] = (dir: string) => detectDevScripts(guard.check(dir))
api['engine:canSleep'] = () => service.runningCount() === 0
  && !store.listProjects().some(p => orchestrator.list(p.id).some(o => ACTIVE_STATUSES.includes(o.status)))
  && !updater.status().some(s => ['checking','updating'].includes(s.state))
  && !['checking','pulling','building','ready'].includes(appUpdater.status().state)
  && !['starting','installing'].includes(jev.status().state)
const previousOutput = store.kvGet<ReturnType<typeof gitApi.gitOutput>>('nativeGitOutput') ?? []
api['git:output'] = () => [...previousOutput, ...gitApi.gitOutput()].slice(-200)
const previousUpdates = store.kvGet<ReturnType<typeof updater.status>>('nativeCliUpdates') ?? []
api['cli:updates'] = () => updater.status().length ? updater.status() : previousUpdates
api['engine:park'] = async () => {
  store.kvSet('nativeAgentInfo', agentInfo)
  store.kvSet('nativeCodexModels', codexModels ?? null)
  store.kvSet('nativeGitOutput', api['git:output']())
  store.kvSet('nativeCliUpdates', api['cli:updates']())
  await shutdown()
  return true
}
api['engine:background'] = async () => {
  const last = store.kvGet<number>('nativeCliCheckedAt') ?? 0
  if (settings().autoUpdateClis !== false && Date.now() - last >= 6 * 3600_000) {
    store.kvSet('nativeCliCheckedAt', Date.now())
    await updater.check(true)
  }
}
api['engine:roots'] = roots
api['engine:window'] = () => store.kvGet('window')
api['engine:busy'] = () => service.runningCount()
api['engine:cloneInto'] = async (url: string, dir: string) => {
  const target = await gitApi.clone(url, dir)
  store.audit(null, 'user', 'git.clone', { url, target })
  return target
}
api['engine:auditFile'] = (path: string, bytes: number) => store.audit(null, 'user', 'file.write', { path, bytes })
api['engine:browser'] = (data: any) => browser.update(data)
api['engine:revokeWeb'] = (id: string) => webAgent.revokeWhere(c => c.projectId === id)
api['engine:login'] = (agent: AgentId) => {
  if (!['claude', 'codex'].includes(agent)) throw new Error('Agente inválido')
  const file = resolveBin(agent, settings())
  if (!file) throw new Error('No se encontró el CLI del agente')
  store.audit(null, 'user', 'agent.login', { agent })
  return { file, args: agent === 'claude' ? ['auth', 'login'] : ['login'] }
}
let stopped = false
async function shutdown() {
  if (stopped) return
  stopped = true; quitting = true
  updater.stop(); appUpdater.stop(); usageRefresh.stop(); clearTimeout(usageStart)
  webAgent.stop()
  await Promise.all([service.cancelAll(), jev.stop()])
  db.close()
}
api['engine:shutdown'] = async () => {
  const update = appUpdater.status().state === 'ready' ? SOURCE : undefined
  const autoInstall = settings().autoUpdateApp !== false
  await shutdown()
  setTimeout(() => process.exit(0), 100).unref()
  return { update, autoInstall }
}
service.recoverInterrupted(); orchestrator.recover()
if (!process.env.AMBIDEX_TEST) {
  updater.start(() => settings().autoUpdateClis !== false)
  const recentUsage = savedLimits().codex?.updatedAt ?? 0
  const delay = Math.max(0, 30 * 60_000 - (Date.now() - recentUsage))
  usageStart = setTimeout(() => usageRefresh.start(), delay)
  usageStart.unref?.()
  if (SOURCE) appUpdater.start(() => settings().autoUpdateApp !== false)
}
await webAgent.start()
send({ event: 'native:roots', payload: roots() })
send({ ready: true })
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', async line => {
  let msg: any
  try {
    msg = JSON.parse(line)
    if (msg.hostResult) {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result) }
      return
    }
    const handler = api[msg.channel]
    if (!handler) throw new Error('Canal desconocido: ' + msg.channel)
    const result = await handler(...(msg.args ?? []))
    if (['projects:open', 'projects:forget', 'settings:save'].includes(msg.channel)) send({ event: 'native:roots', payload: roots() })
    send({ id: msg.id, result: result ?? null })
  } catch (e) { send({ id: msg?.id, error: e instanceof Error ? e.message : String(e) }) }
})
lines.on('close', () => { void shutdown().finally(() => process.exit()) })
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit()) })
