/* SQLite v4 表结构：记忆、历史、来源、摘要、向量、任务和作用域。 */
export const SCHEMA_VERSION = 4

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('global','project','unbound')),
  path_key TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, path_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_global ON scopes(kind) WHERE kind = 'global';

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','goal','constraint','rule','project')),
  subject TEXT,
  predicate TEXT,
  value TEXT,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('explicit','auto')),
  importance TEXT NOT NULL DEFAULT 'medium' CHECK (importance IN ('high','medium','low')),
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','review')),
  protected INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (memory_id, version)
);

CREATE TABLE IF NOT EXISTS memory_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  session_id TEXT,
  event_seq INTEGER,
  excerpt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  scope_id TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  built_at_revision INTEGER NOT NULL,
  sections TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  event_seq INTEGER,
  event_id TEXT,
  scope_id TEXT REFERENCES scopes(id) ON DELETE CASCADE,
  dedupe_key TEXT UNIQUE,
  payload_hash TEXT,
  lease_token TEXT,
  model_attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending','running','completed','retry','dead','cancelled')),
  stage TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  result TEXT,
  error TEXT,
  provider TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_identity ON jobs(kind, session_id, event_seq) WHERE event_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(state, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS session_cursors (
  session_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oplog (
  op_id TEXT PRIMARY KEY,
  op_key TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forgotten (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(scope_id, subject, predicate);
CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_sources_memory ON memory_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_forgotten_hash ON forgotten(scope_id, content_hash);
`
