import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { DDL, SCHEMA_VERSION } from '../lib/store/schema.js'
import { ensureSchema } from '../lib/store/db.js'

test('actual v2 tables upgrade with foreign keys and a usable job schema', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const old = DDL.replace("'global','project','unbound'", "'global','project'")
      .replace(/CREATE TABLE IF NOT EXISTS jobs \([\s\S]*?\);/, 'CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT,state TEXT,attempts INTEGER,lease_until INTEGER,created_revision INTEGER,created_epoch INTEGER);')
      .replace(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_jobs[^;]+;/g, '')
    db.exec(old)
    db.exec("INSERT INTO meta VALUES('schema_version','2'),('revision','0'); INSERT INTO scopes VALUES('g','global',NULL,'global',0)")
    ensureSchema(db)
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION))
    assert.ok(db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'lease_token'))
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.ok(db.prepare('PRAGMA foreign_key_list(memory_versions)').all().some(r => r.on_delete === 'CASCADE'))
  } finally { db.close() }
})
