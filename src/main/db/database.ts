import { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync

// Cada entrada es una migración; nunca se edita una ya publicada, se añade otra.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    git_root TEXT,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 0,
    tab_order INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    ui_state TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    agent_session_id TEXT,
    model TEXT,
    effort TEXT,
    permission TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    totals TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_project ON sessions(project_id, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    search_text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX messages_order ON messages(session_id, seq);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    pid INTEGER,
    bin TEXT,
    cwd TEXT NOT NULL,
    args TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    signal TEXT,
    error TEXT,
    stderr_tail TEXT
  );
  CREATE INDEX runs_project ON runs(project_id, started_at DESC);
  CREATE INDEX runs_status ON runs(status);

  CREATE TABLE run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    stream TEXT NOT NULL,
    line TEXT NOT NULL
  );
  CREATE INDEX run_log_run ON run_log(run_id, id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX audit_at ON audit_log(at DESC);

  CREATE TABLE agent_limits (
    agent TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2: chat único con enrutado, cola de mensajes y orquestador multiagente
  `
  ALTER TABLE sessions ADD COLUMN thread_id TEXT;
  ALTER TABLE sessions ADD COLUMN orchestration_id TEXT;
  CREATE INDEX sessions_thread ON sessions(thread_id);
  CREATE INDEX sessions_orch ON sessions(orchestration_id);

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX threads_project ON threads(project_id, updated_at DESC);

  CREATE TABLE queue (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    thread_id TEXT,
    prompt TEXT NOT NULL,
    context TEXT,
    agent TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX queue_target ON queue(session_id, thread_id, position);

  CREATE TABLE orchestrations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    thread_id TEXT,
    mode TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_status TEXT,
    planner TEXT,
    plan TEXT,
    options TEXT NOT NULL,
    repo TEXT NOT NULL,
    base_branch TEXT,
    base_commit TEXT NOT NULL,
    slug TEXT NOT NULL,
    error TEXT,
    test_result TEXT,
    integrated_into TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX orch_project ON orchestrations(project_id, created_at DESC);

  CREATE TABLE orch_tasks (
    id TEXT PRIMARY KEY,
    orchestration_id TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    assignee TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    status TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    review_session_id TEXT,
    result TEXT,
    review TEXT,
    error TEXT,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX orch_tasks_orch ON orch_tasks(orchestration_id, seq);

  CREATE TABLE orch_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestration_id TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX orch_messages_orch ON orch_messages(orchestration_id, id);

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    orchestration_id TEXT,
    owner TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX worktrees_orch ON worktrees(orchestration_id);
  `,
  // v3: imágenes en los mensajes en cola y puntos de control de cada ejecución (para deshacer lo que hizo)
  `
  ALTER TABLE queue ADD COLUMN images TEXT;
  ALTER TABLE runs ADD COLUMN checkpoint_before TEXT;
  ALTER TABLE runs ADD COLUMN checkpoint_after TEXT;
  ALTER TABLE runs ADD COLUMN undone_at INTEGER;
  `
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function migrate(db: DB): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  const current = Number(row?.value ?? 0)
  if (current > MIGRATIONS.length) throw new Error(`La base de datos es de una versión más nueva de la app (esquema ${current})`)
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v])
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(v + 1))
    })
  }
  return MIGRATIONS.length
}

export function openDatabase(file: string): DB {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 3000')
  migrate(db)
  return db
}
