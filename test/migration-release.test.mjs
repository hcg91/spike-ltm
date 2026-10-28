import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateJsonToSqlite } from '../lib/store/migrate.js'
import { openMemoryStore } from '../lib/store/factory.js'
import { openDatabase, closeDatabase } from '../lib/store/db.js'
test('migration preserves historical versions, isolates legacy projects, and does not back up or alter source', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'memory.json'), target = join(dir, 'memory.db')
  writeFileSync(source, JSON.stringify({ revision: 9, epoch: 3, items: [
    { id: 'm1', text: 'new', scope: 'global', version: 3, history: [{ version: 1, text: 'first' }, { version: 2, text: 'second' }] },
    { id: 'm2', text: 'private project', scope: 'project' },
  ] }))
  const before = readFileSync(source)
  const report = migrateJsonToSqlite({ jsonPath: source, dbPath: target, logger: {} })
  assert.equal(report.ok, true)
  assert.deepEqual(readFileSync(source), before)
  assert.equal(readdirSync(dir).some(n => n.includes('.bak')), false)
  const store = openMemoryStore({ dir, backend: 'sqlite' })
  try {
    assert.deepEqual(store.core.itemVersions('legacy:m1').map(v => v.text), ['new','second','first'])
    assert.deepEqual(store.core.inspect().items.map(v => v.text), ['new'])
    assert.equal(report.unboundImported, 1)
    assert.equal(report.foreignKeys, 'ok')
  } finally { store.close() }
})
test('existing JSON never migrates just because plugin starts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-legacy-start-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'memory.json'), '{"items":[],"revision":0}')
  const store = openMemoryStore({ dir })
  try { assert.equal(store.backend, 'json'); assert.equal(existsSync(join(dir,'memory.db')), false) } finally { store.close() }
  assert.throws(() => openMemoryStore({ dir, backend: 'sqlite' }), /MIGRATION_REQUIRED/)
})
