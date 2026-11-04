import type { IpcArgs, IpcChannel, IpcResult, PushChannel, PushContract } from '@shared/ipc'

export type { CommitDetail, GitLogEntry, GrepHit } from '@shared/types'

// Llamada tipada al proceso principal
export function invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<Awaited<IpcResult<K>>> {
  return window.bridge.invoke(channel, ...args)
}

export function on<K extends PushChannel>(channel: K, fn: (payload: PushContract[K]) => void): () => void {
  return window.bridge.on(channel, fn as (p: unknown) => void)
}

const bind =
  <K extends IpcChannel>(channel: K) =>
  (...args: IpcArgs<K>) =>
    invoke(channel, ...args)

export const api = {
  info: bind('app:info'),
  pickFolder: bind('app:pickFolder'),
  reveal: bind('app:reveal'),
  revealData: bind('app:revealData'),
  openExternal: bind('app:openExternal'),
  openInVSCode: bind('app:openInVSCode'),
  contextMenu: bind('app:contextMenu'),
  confirm: bind('app:confirm'),
  getSettings: bind('settings:get'),
  web: {
    popout: bind('web:popout'),
    setOnTop: bind('web:setOnTop'),
    favicon: bind('web:favicon'),
    capture: bind('web:capture'),
    active: bind('web:active'),
    revokeAgent: bind('web:revokeAgent')
  },
  readImage: bind('fs:image'),
  attachments: {
    save: bind('attachments:save'),
    read: bind('attachments:read')
  },
  saveSettings: bind('settings:save'),

  projects: {
    list: bind('projects:list'),
    open: bind('projects:open'),
    close: bind('projects:close'),
    update: bind('projects:update'),
    reorder: bind('projects:reorder'),
    forget: bind('projects:forget'),
    getUi: bind('projects:getUi'),
    saveUi: bind('projects:saveUi')
  },

  sessions: {
    list: bind('sessions:list'),
    create: bind('sessions:create'),
    update: bind('sessions:update'),
    remove: bind('sessions:delete'),
    messages: bind('sessions:messages'),
    search: bind('sessions:search'),
    send: bind('sessions:send'),
    cancel: bind('sessions:cancel'),
    compact: bind('sessions:compact'),
    undoPreview: bind('runs:undoPreview'),
    undo: bind('runs:undo')
  },
  runs: { recent: bind('runs:recent'), log: bind('runs:log') },

  jev: {
    status: bind('jev:status'),
    install: bind('jev:install'),
    cancel: bind('jev:cancel'),
    stop: bind('jev:stop'),
    remove: bind('jev:remove'),
    test: bind('jev:test'),
    warm: bind('jev:warm')
  },
  cli: {
    updates: bind('cli:updates'),
    check: bind('cli:check'),
    update: bind('cli:update')
  },
  self: {
    status: bind('self:status'),
    check: bind('self:check'),
    restart: bind('self:restart')
  },
  threads: {
    list: bind('threads:list'),
    create: bind('threads:create'),
    rename: bind('threads:rename'),
    remove: bind('threads:delete'),
    preview: bind('threads:preview'),
    send: bind('threads:send')
  },
  queue: {
    list: bind('queue:list'),
    add: bind('queue:add'),
    remove: bind('queue:remove'),
    update: bind('queue:update'),
    sendNow: bind('queue:sendNow')
  },
  orch: {
    list: bind('orch:list'),
    get: bind('orch:get'),
    start: bind('orch:start'),
    approvePlan: bind('orch:approvePlan'),
    cancel: bind('orch:cancel'),
    resume: bind('orch:resume'),
    integrate: bind('orch:integrate'),
    discard: bind('orch:discard'),
    cleanup: bind('orch:cleanup'),
    changes: bind('orch:changes')
  },

  agentInfo: bind('agents:info'),
  agentLimits: bind('agents:limits'),
  oneShot: bind('agents:oneShot'),

  listDir: bind('fs:list'),
  readFile: bind('fs:read'),
  writeFile: bind('fs:write'),
  watch: bind('fs:watch'),
  unwatch: bind('fs:unwatch'),

  git: {
    status: bind('git:status'),
    numstat: bind('git:numstat'),
    stage: bind('git:stage'),
    unstage: bind('git:unstage'),
    discard: bind('git:discard'),
    show: bind('git:show'),
    diffText: bind('git:diffText'),
    commit: bind('git:commit'),
    lastMessage: bind('git:lastMessage'),
    log: bind('git:log'),
    commitDetail: bind('git:commitDetail'),
    commitPatch: bind('git:commitPatch'),
    branches: bind('git:branches'),
    checkout: bind('git:checkout'),
    createBranch: bind('git:createBranch'),
    deleteBranch: bind('git:deleteBranch'),
    fetch: bind('git:fetch'),
    pull: bind('git:pull'),
    push: bind('git:push'),
    init: bind('git:init'),
    worktrees: bind('git:worktrees'),
    addWorktree: bind('git:addWorktree'),
    removeWorktree: bind('git:removeWorktree'),
    listFiles: bind('git:listFiles'),
    grep: bind('git:grep'),
    findRepos: bind('git:findRepos'),
    addRepo: bind('git:addRepo'),
    clone: bind('git:clone'),
    run: bind('git:run'),
    remotes: bind('git:remotes'),
    tags: bind('git:tags'),
    stashes: bind('git:stashes'),
    output: bind('git:output'),
    prInfo: bind('git:prInfo'),
    createPR: bind('git:createPR'),
    commitsSince: bind('git:commitsSince')
  },

  devScripts: bind('project:devScripts'),
  panel: {
    open: bind('panel:open'),
    openWeb: bind('panel:openWeb'),
    sync: bind('panel:sync')
  },
  external: {
    list: bind('external:list'),
    read: bind('external:read'),
    import: bind('external:import')
  },
  extensions: {
    list: bind('extensions:list'),
    read: bind('extensions:read'),
    reveal: bind('extensions:reveal')
  },

  term: {
    create: bind('term:create'),
    write: bind('term:write'),
    resize: bind('term:resize'),
    kill: bind('term:kill')
  },

  pathForFile: (f: File) => window.bridge.pathForFile(f)
}
