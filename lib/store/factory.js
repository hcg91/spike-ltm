import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createCore } from '../core.js'
import { openDatabase, closeDatabase, getMeta, setMeta, transaction } from './db.js'
import { MemoryService } from './service.js'
import { createSqliteCore } from './core.js'
import { JobStore } from './jobs.js'
import { randomUUID } from 'node:crypto'

const owners = new Map()
function acquireWriter(db) {
  const id = getMeta(db, 'db_id')
  return transaction(db, () => {
    const raw = getMeta(db, 'writer_owner')
    const prior = raw ? JSON.parse(raw) : null
    if (prior && prior.pid !== process.pid) {
      let alive = true
      try { process.kill(prior.pid, 0) } catch (e) { if (e.code === 'ESRCH') alive = false }
      if (alive) throw new Error('STORAGE_IN_USE')
    }
    const owner = owners.get(id) ?? { token: randomUUID(), count: 0 }
    owner.count++; owners.set(id, owner)
    setMeta(db, 'writer_owner', JSON.stringify({ pid: process.pid, token: owner.token }))
    return () => {
      owner.count--
      if (owner.count === 0) {
        transaction(db, () => db.prepare("DELETE FROM meta WHERE key='writer_owner' AND value=?").run(JSON.stringify({ pid: process.pid, token: owner.token })))
        owners.delete(id)
      }
    }
  })
}

export function openMemoryStore({ dir, backend, logger = console }) {
  const jsonExists = existsSync(join(dir, 'memory.json'))
  const selected = backend ?? (jsonExists ? 'json' : 'sqlite')
  if (selected === 'json') return { core: createCore({ dir, logger, allowedScopes: ['global'] }), jobs: null, backend: 'json', close() {} }
  if (selected !== 'sqlite') throw new Error('STORAGE_BACKEND_INVALID')
  const path = join(dir, 'memory.db')
  if (jsonExists && !existsSync(path)) throw new Error('MIGRATION_REQUIRED')
  const { db } = openDatabase(path)
  let release
  try { release = acquireWriter(db) } catch (error) { closeDatabase(db); throw error }
  const service = new MemoryService({ db, logger })
  let closed = false
  return { db, core: createSqliteCore({ db, service, logger }), jobs: new JobStore({ db, logger }), backend: 'sqlite', close() {
    if (closed) return
    closed = true
    try { release() } finally { closeDatabase(db) }
  } }
}
