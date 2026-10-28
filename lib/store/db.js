/* SQLite 连接和事务。拒绝 v1 与异常版本；v2/v3 在事务内升级并校验外键。 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

import { DDL, SCHEMA_VERSION } from './schema.js'

const require = createRequire(import.meta.url)
const revisions = new WeakMap()
const databaseRevisions = new Map()
export function cachedRevision(db) {
  const state = revisions.get(db)
  return state ? databaseRevisions.get(state.key) ?? state.value : 0
}
export function refreshRevision(db) {
  const value = Number(getMeta(db, 'revision') ?? 0)
  const key = getMeta(db, 'db_id') ?? db
  revisions.set(db, { key, value })
  databaseRevisions.set(key, Math.max(value, databaseRevisions.get(key) ?? 0))
  return value
}

/** Only invalidate derived summaries that actually depend on changed facts. */
export function invalidateProfiles(db, ids) {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM profiles WHERE EXISTS (
    SELECT 1 FROM json_each(profiles.sections) s,
      json_each(s.value, '$.bullets') b, json_each(b.value, '$.refs') r
    WHERE r.value IN (${placeholders})
  )`).run(...ids)
}

export function loadSqlite() {
  return require('node:sqlite')
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((entry) => String(entry.name) === column)
}

export function openDatabase(path, { wal = true, busyTimeoutMs = 3000 } = {}) {
  const { DatabaseSync } = loadSqlite()
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  let journalMode = 'unknown'
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 3000}`)
    db.exec('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    refreshRevision(db)
    // journal_mode 会写数据库头，必须在校验成功后才能修改。
    const row = db.prepare(wal && path !== ':memory:' ? 'PRAGMA journal_mode = WAL' : 'PRAGMA journal_mode').get()
    journalMode = String(row?.journal_mode ?? '').toLowerCase()
  } catch (error) {
    try { db.close() } catch { /* 已关闭 */ }
    throw error
  }
  return { db, journalMode, path }
}

export function ensureSchema(db) {
  const hasMeta = tableExists(db, 'meta')

  if (!hasMeta && db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get() !== undefined) {
    throw new Error('SCHEMA_CORRUPT: missing meta table in existing database')
  }

  let existing = null
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    if (row === undefined) throw new Error('SCHEMA_CORRUPT: missing schema_version')
    const version = String(row.value)
    existing = Number(version)
    if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(existing)) {
      throw new Error(`SCHEMA_CORRUPT: invalid schema_version "${version}"`)
    }
    if (existing > SCHEMA_VERSION) throw new Error(`SCHEMA_TOO_NEW: db=${existing} code=${SCHEMA_VERSION}`)
    if (existing === 1) throw new Error('SCHEMA_V1_REQUIRES_REBUILD: db=1 code=3')
  }

  if (existing === 2 || existing === 3) {
    // SQLite cannot alter CHECK constraints. Rebuild the parent with FKs disabled
    // outside the transaction, then validate the entire graph before commit.
    db.exec('PRAGMA foreign_keys=OFF')
    try {
      transaction(db, () => {
        db.exec("CREATE TABLE scopes_next(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('global','project','unbound')),path_key TEXT,label TEXT,created_at INTEGER NOT NULL,UNIQUE(kind,path_key))")
        db.exec('INSERT INTO scopes_next SELECT * FROM scopes; DROP TABLE scopes; ALTER TABLE scopes_next RENAME TO scopes')
        const oldJobs = tableExists(db, 'jobs') ? db.prepare('SELECT * FROM jobs').all() : []
        db.exec('DROP TABLE IF EXISTS jobs')
        if (!columnExists(db, 'memories', 'reason')) db.exec('ALTER TABLE memories ADD COLUMN reason TEXT')
        db.exec(DDL)
        // Old development jobs had no fencing token/content identity: keep an
        // explicit dead receipt, never execute unknown or unscoped payloads.
        for (const job of oldJobs) db.prepare("INSERT INTO jobs(id,kind,state,stage,attempts,error,created_at,updated_at) VALUES(?,?,'dead','legacy-unresumable',?,'LEGACY_JOB_UNRESUMABLE',?,?)")
          .run(job.id, job.kind ?? 'extract', job.attempts ?? 0, job.created_at ?? Date.now(), Date.now())
        ensureGlobalScope(db)
        ensureUnboundScope(db)
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SCHEMA_CORRUPT: foreign key violation')
        setMeta(db, 'schema_version', String(SCHEMA_VERSION))
      })
    } finally { db.exec('PRAGMA foreign_keys=ON') }
    return
  }
  if (!hasMeta) {
    transaction(db, () => {
      db.exec(DDL)
      setMeta(db, 'schema_version', String(SCHEMA_VERSION))
      setMeta(db, 'revision', '0')
      setMeta(db, 'db_id', randomUUID())
      ensureGlobalScope(db)
      ensureUnboundScope(db)
    })
    return
  }
  // A version marker alone does not make a valid schema. Do not silently repair it.
  for (const table of ['scopes','memories','memory_versions','memory_sources','profiles','vectors','jobs','session_cursors','forgotten','oplog']) {
    if (!tableExists(db, table)) throw new Error('SCHEMA_CORRUPT: missing ' + table)
  }
  for (const table of ['memory_versions','memory_sources','vectors']) {
    if (!db.prepare(`PRAGMA foreign_key_list(${table})`).all().some(fk => fk.table === 'memories' && fk.on_delete === 'CASCADE')) throw new Error('SCHEMA_CORRUPT: missing cascade ' + table)
  }
  if (!columnExists(db, 'jobs', 'lease_token') || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SCHEMA_CORRUPT')
}

export function ensureGlobalScope(db) {
  const existing = db.prepare("SELECT id FROM scopes WHERE kind = 'global' LIMIT 1").get()
  if (existing !== undefined) return String(existing.id)
  const id = randomUUID()
  try {
    db.prepare('INSERT INTO scopes(id, kind, path_key, label, created_at) VALUES(?,?,?,?,?)')
      .run(id, 'global', null, 'global', Date.now())
    return id
  } catch {
    const row = db.prepare("SELECT id FROM scopes WHERE kind = 'global' LIMIT 1").get()
    if (row !== undefined) return String(row.id)
    throw new Error('GLOBAL_SCOPE_FAILED')
  }
}

/** 旧 JSON 的 project 条目没有目录信息，统一进入该未绑定作用域，不猜 cwd。 */
export function ensureUnboundScope(db) {
  const existing = db.prepare("SELECT id FROM scopes WHERE kind = 'unbound' LIMIT 1").get()
  if (existing !== undefined) return String(existing.id)
  const id = randomUUID()
  try {
    db.prepare('INSERT INTO scopes(id, kind, path_key, label, created_at) VALUES(?,?,?,?,?)')
      .run(id, 'unbound', null, '未绑定项目', Date.now())
    return id
  } catch {
    const row = db.prepare("SELECT id FROM scopes WHERE kind = 'unbound' LIMIT 1").get()
    if (row !== undefined) return String(row.id)
    throw new Error('UNBOUND_SCOPE_FAILED')
  }
}

export function transaction(db, fn, { immediate = true } = {}) {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    refreshRevision(db)
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ }
    refreshRevision(db)
    throw error
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : String(row.value)
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value))
}

export function bumpRevision(db) {
  const current = Number.parseInt(getMeta(db, 'revision') ?? '0', 10)
  const next = (Number.isInteger(current) ? current : 0) + 1
  setMeta(db, 'revision', String(next))
  return next
}

export function getEpoch(db, scopeId) {
  const value = Number.parseInt(getMeta(db, `epoch:${scopeId}`) ?? '0', 10)
  return Number.isInteger(value) ? value : 0
}

export function bumpEpoch(db, scopeId) {
  const next = getEpoch(db, scopeId) + 1
  setMeta(db, `epoch:${scopeId}`, String(next))
  return next
}

export function setEpoch(db, scopeId, value) {
  setMeta(db, `epoch:${scopeId}`, String(Number(value) || 0))
}

export function integrityCheck(db) {
  const row = db.prepare('PRAGMA integrity_check').get()
  return String(row?.integrity_check ?? 'unknown')
}

export function closeDatabase(db) {
  try { db.close() } catch { /* 已关闭 */ }
}

export function cancelScopeJobs(db, scopeIds) {
  const ids = [...new Set(scopeIds)]
  if (!ids.length) return
  const global = db.prepare("SELECT id FROM scopes WHERE kind='global'").get()?.id
  const update = "UPDATE jobs SET state='cancelled',payload=NULL,result=NULL,lease_until=NULL,lease_token=NULL WHERE state IN ('pending','running','retry')"
  // Every project reads global facts. Deleting global data invalidates all
  // queued contexts, even if their write destination is a project scope.
  if (ids.includes(global)) db.prepare(update).run()
  else for (const id of ids) db.prepare(update + ' AND scope_id=?').run(id)
}
