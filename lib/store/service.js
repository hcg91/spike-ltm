/* 记忆写入服务。检查作用域、遗忘指纹和操作幂等性。 */
import { createHash, randomUUID } from 'node:crypto'

import { cancelScopeJobs, invalidateProfiles, bumpEpoch, bumpRevision, getEpoch, getMeta, transaction } from './db.js'

const EXCERPT_MAX = 200

function now() {
  return Date.now()
}

function hashContent(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

function opKey({ operation, scopeId, text, kind, subject, predicate, value }) {
  const payload = [operation, scopeId, text.trim(), kind, subject ?? '', predicate ?? '', value ?? ''].join('\u0001')
  return createHash('sha256').update(payload).digest('hex')
}

export class MemoryService {
  constructor({ db, logger = console } = {}) {
    if (!db) throw new Error('MemoryService: db is required')
    this.db = db
    this.logger = logger
    this.queue = Promise.resolve()
    this.stats = { writes: 0, errors: 0, lastMs: 0, totalMs: 0 }
  }

  async enqueue(fn) {
    const run = this.queue.then(() => {
      const started = performance.now()
      try {
        const result = fn()
        this.stats.writes += 1
        return result
      } catch (error) {
        this.stats.errors += 1
        throw error
      } finally {
        const ms = performance.now() - started
        this.stats.lastMs = ms
        this.stats.totalMs += ms
      }
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  revision() {
    const value = Number.parseInt(getMeta(this.db, 'revision') ?? '0', 10)
    return Number.isInteger(value) ? value : 0
  }

  epoch(scopeId) {
    return getEpoch(this.db, scopeId)
  }


  /** 显式保存标记用户来源；只有明确传 protected 才表示用户置顶。 */
  async saveExplicit(input) {
    return this.#save(input, {
      operation: 'explicit', defaultSource: 'explicit',
      defaultImportance: 'high', allowResurrect: true,
    })
  }

  /** 自动候选：禁止复活已遗忘内容。 */
  /** 自动候选：默认不受保护、重要度默认 medium（由提炼结果覆盖）。 */
  async saveCandidate(input) {
    return this.#save(input, {
      operation: 'candidate', defaultSource: 'auto',
      defaultImportance: 'medium', allowResurrect: false,
    })
  }

  #save(input, { operation, defaultSource, defaultImportance, allowResurrect, epochGuard = undefined, contextGuard = undefined }) {
    const {
      text, kind = 'fact', subject = null, predicate = null, value = null,
      importance, confidence = 'high', scopeId, reason = null,
      sessionId = null, eventSeq = null, evidence = null, opId = null,
      protected: protectedInput,
    } = input ?? {}
    if (typeof text !== 'string' || text.trim() === '') throw new Error('EMPTY_TEXT')
    if (typeof scopeId !== 'string' || scopeId === '') throw new Error('SCOPE_REQUIRED')
    // 来源由调用入口确定，提炼内容不能伪装成用户保存或授予置顶保护。
    const origin = defaultSource
    const cleanText = text.trim()
    const importanceValue = ['high', 'medium', 'low'].includes(importance) ? importance : defaultImportance
    const protectedValue = operation === 'explicit' && (protectedInput === true || protectedInput === 1) ? 1 : 0

    return this.enqueue(() => transaction(this.db, () => {
      const key = opKey({ operation, scopeId, text: cleanText, kind, subject, predicate, value })
      if (opId !== null) {
        const prior = this.db.prepare('SELECT op_key, result FROM oplog WHERE op_id = ?').get(opId)
        if (prior !== undefined) {
          if (String(prior.op_key) !== key) throw new Error('OP_CONFLICT')
          return { ...JSON.parse(String(prior.result)), replayed: true }
        }
      }

      if (contextGuard && !contextGuard()) throw new Error('FORGET_EPOCH_CHANGED')
      if (epochGuard !== undefined && getEpoch(this.db, scopeId) !== epochGuard) throw new Error('FORGET_EPOCH_CHANGED')

      // 防复活：自动写一律拦截；显式写视为用户明确操作，允许恢复
      if (!allowResurrect && this.isForgotten({ scopeId, text: cleanText })) {
        throw new Error('FORGOTTEN_BLOCKED')
      }

      const id = randomUUID()
      const at = now()
      const result = (() => {
        const revision = bumpRevision(this.db)
        this.db.prepare(`
          INSERT INTO memories(id, scope_id, kind, subject, predicate, value, text, source,
            importance, confidence, status, protected, version, revision, reason, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?, 'active', ?, 1, ?, ?, ?, ?)
        `).run(id, scopeId, kind, subject, predicate, value, cleanText, origin,
          importanceValue, confidence, protectedValue, revision, reason, at, at)
        this.db.prepare('INSERT INTO memory_versions(memory_id, version, snapshot, reason, created_at) VALUES(?,?,?,?,?)')
          .run(id, 1, JSON.stringify({ text: cleanText, kind, subject, predicate, value }), 'created', at)
        this.db.prepare('INSERT INTO memory_sources(memory_id, session_id, event_seq, excerpt, created_at) VALUES(?,?,?,?,?)')
          .run(id, sessionId, eventSeq, String(evidence ?? cleanText).slice(0, EXCERPT_MAX), at)
        const receipt = { ok: true, id, version: 1, revision, committedAt: at }
        if (opId !== null) {
          this.db.prepare('INSERT INTO oplog(op_id, op_key, result, created_at) VALUES(?,?,?,?)')
            .run(opId, key, JSON.stringify(receipt), at)
        }
        return receipt
      })()
      return { ...result, replayed: false }
    }))
  }

  async updateText({ id, text, expectedVersion, scopeId, reason = 'edit' }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_TEXT')
    if (text.length > 2000) throw new Error('TEXT_TOO_LONG')
    if (typeof id !== 'string' || id === '') throw new Error('ID_REQUIRED')
    if (typeof scopeId !== 'string' || scopeId === '') throw new Error('SCOPE_REQUIRED')

    return this.enqueue(() => transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND scope_id = ?').get(id, scopeId)
      if (row === undefined) throw new Error('NOT_FOUND')
      if (Number(row.version) !== Number(expectedVersion)) throw new Error('VERSION_CONFLICT')

      const at = now()
      const revision = bumpRevision(this.db)
      const nextVersion = Number(row.version) + 1
      const changed = this.db.prepare(`
        UPDATE memories SET text = ?, version = ?, revision = ?, updated_at = ?
        WHERE id = ? AND scope_id = ? AND version = ?
      `).run(text, nextVersion, revision, at, id, scopeId, expectedVersion)
      if (Number(changed.changes) !== 1) throw new Error('VERSION_CONFLICT')

      this.db.prepare('INSERT INTO memory_versions(memory_id, version, snapshot, reason, created_at) VALUES(?,?,?,?,?)')
        .run(id, nextVersion, JSON.stringify({ ...row, text }), reason, at)
      // 同一事务内让旧画像失效，并推进 epoch：迟到任务不得写回旧内容
      invalidateProfiles(this.db, [id])
      this.db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(id)
      bumpEpoch(this.db, scopeId)
      return { ok: true, id, version: nextVersion, revision }
    }))
  }

  async forget({ id, scopeId, reason = 'user-request' }) {
    if (typeof id !== 'string' || id === '') throw new Error('ID_REQUIRED')
    if (typeof scopeId !== 'string' || scopeId === '') throw new Error('SCOPE_REQUIRED')

    return this.enqueue(() => transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND scope_id = ?').get(id, scopeId)
      if (row === undefined) throw new Error('NOT_FOUND')
      const at = now()

      this.db.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(id)
      this.db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(id)
      this.db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(id)
      invalidateProfiles(this.db, [id])
      this.db.prepare('DELETE FROM memories WHERE id = ? AND scope_id = ?').run(id, scopeId)

      // 只留指纹，不留原文
      this.db.prepare('INSERT OR REPLACE INTO forgotten(id, scope_id, content_hash, forgotten_at) VALUES(?,?,?,?)')
        .run(id, scopeId, hashContent(row.text), at)

      const epoch = bumpEpoch(this.db, scopeId)
      const revision = bumpRevision(this.db)
      return { ok: true, id, scopeId, epoch, revision, reason }
    }))
  }


  /**
   * 按 id 读取：必须显式给出可信作用域集合。
   * 不传 -> 抛错；不在集合内 -> 返回 null（不泄露存在性）。
   */
  get({ id, scopeIds }) {
    if (!Array.isArray(scopeIds) || scopeIds.length === 0) throw new Error('SCOPE_REQUIRED')
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    if (row === undefined) return null
    if (!scopeIds.includes(String(row.scope_id))) return null
    return row
  }

  list({ scopeIds, status = 'active', limit = 100 }) {
    if (!Array.isArray(scopeIds) || scopeIds.length === 0) throw new Error('SCOPE_REQUIRED')
    const placeholders = scopeIds.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT * FROM memories WHERE status = ? AND scope_id IN (${placeholders})
      ORDER BY updated_at DESC LIMIT ?
    `).all(status, ...scopeIds, limit)
  }

  async saveItem(input) { return this.saveExplicit(input) }

  /** 自动写入的 epoch 守卫：忘记/修改后，旧任务不得复活或覆盖。 */
  async saveIfEpoch(input, expectedEpoch, contextGuard) {
    if (!Number.isInteger(expectedEpoch)) throw new Error('EPOCH_REQUIRED')
    return this.#save(input, {
      operation: 'candidate', defaultSource: 'auto',
      defaultImportance: 'medium', allowResurrect: false,
      epochGuard: expectedEpoch, contextGuard,
    })
  }

  async forgetItems({ ids, scopeId, expectedRevision }) {
    if (!Array.isArray(ids)) throw new Error('IDS_REQUIRED')
    if (typeof scopeId !== 'string' || scopeId === '') throw new Error('SCOPE_REQUIRED')
    return this.enqueue(() => transaction(this.db, () => {
      if (expectedRevision !== undefined && this.revision() !== expectedRevision) throw new Error('VERSION_CONFLICT')
      let removed = 0
      for (const id of ids) {
        const row = this.db.prepare('SELECT id, text FROM memories WHERE id = ? AND scope_id = ?').get(id, scopeId)
        if (row === undefined) throw new Error('NOT_FOUND')
        this.db.prepare('DELETE FROM memories WHERE id = ? AND scope_id = ?').run(id, scopeId)
        this.db.prepare('INSERT OR REPLACE INTO forgotten(id, scope_id, content_hash, forgotten_at) VALUES(?,?,?,?)')
          .run(id, scopeId, hashContent(row.text), now())
        removed += 1
      }
      invalidateProfiles(this.db, ids)
        cancelScopeJobs(this.db, [scopeId])
      const epoch = bumpEpoch(this.db, scopeId)
      const revision = bumpRevision(this.db)
      return { ok: true, removed, epoch, revision }
    }))
  }

  listActive({ scopeIds, status = 'active' } = {}) {
    if (Array.isArray(scopeIds) && scopeIds.length > 0) {
      const placeholders = scopeIds.map(() => '?').join(',')
      return this.db.prepare('SELECT * FROM memories WHERE status = ? AND scope_id IN (' + placeholders + ') ORDER BY created_at ASC')
        .all(status, ...scopeIds)
    }
    throw new Error('SCOPE_REQUIRED')
  }

  itemVersions({ id, scopeIds }) {
    const row = this.db.prepare('SELECT id, scope_id FROM memories WHERE id = ?').get(id)
    if (row === undefined) throw new Error('NOT_FOUND')
    if (!Array.isArray(scopeIds) || !scopeIds.includes(String(row.scope_id))) throw new Error('SCOPE_DENIED')
    const rows = this.db.prepare('SELECT version, snapshot, reason, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version DESC').all(id)
    return rows.map((entry) => {
      let text = ''
      try { text = String(JSON.parse(String(entry.snapshot)).text ?? '') } catch { text = '' }
      return { version: Number(entry.version), text, reason: entry.reason ?? 'edit', createdAt: Number(entry.created_at) }
    })
  }

  profile(scopeId) {
    const row = this.db.prepare('SELECT version, built_at_revision, sections, updated_at FROM profiles WHERE scope_id = ?').get(scopeId)
    if (row === undefined) return null
    let sections = []
    try { sections = JSON.parse(String(row.sections)) } catch { sections = [] }
    return {
      version: Number(row.version),
      builtAtRevision: Number(row.built_at_revision),
      sections: Array.isArray(sections) ? sections : [],
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    }
  }

  async setProfile({ scopeId, sections, expectedRevision, scopeIds = [scopeId] }) {
    if (!Array.isArray(sections)) throw new Error('INVALID_PROFILE')
    return this.enqueue(() => transaction(this.db, () => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision()) throw new Error('PROFILE_STALE')
      for (const section of sections) {
        if (typeof section.title !== 'string' || !section.title.trim() || !Array.isArray(section.bullets)) throw new Error('INVALID_PROFILE')
        for (const b of section.bullets) {
          if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000 || !Array.isArray(b.refs) || !b.refs.length) throw new Error('INVALID_PROFILE')
          for (const id of b.refs) {
            const ref = this.get({ id, scopeIds })
            if (!ref || ref.status !== 'active') throw new Error('SCOPE_DENIED')
          }
        }
      }
      const revision = bumpRevision(this.db)
      const current = this.profile(scopeId)
      const version = current === null ? 1 : current.version + 1
      const at = now()
      this.db.prepare('INSERT INTO profiles(scope_id, version, built_at_revision, sections, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_id) DO UPDATE SET version = excluded.version, built_at_revision = excluded.built_at_revision, sections = excluded.sections, updated_at = excluded.updated_at')
        .run(scopeId, version, revision, JSON.stringify(sections), at)
      return { version, sections: sections.length, revision }
    }))
  }

  profileInvalidate(scopeId) {
    this.db.prepare('DELETE FROM profiles WHERE scope_id = ?').run(scopeId)
  }

  counts() {
    const out = {}
    for (const table of ['memories', 'memory_versions', 'memory_sources', 'scopes', 'vectors', 'forgotten', 'jobs']) {
      out[table] = Number(this.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
    }
    return out
  }
  isForgotten({ scopeId, text }) {
    const row = this.db.prepare('SELECT id FROM forgotten WHERE scope_id = ? AND content_hash = ?')
      .get(scopeId, hashContent(text))
    return row !== undefined
  }

  diagnostics() {
    const counts = {}
    for (const table of ['memories', 'memory_versions', 'memory_sources', 'scopes', 'vectors', 'forgotten']) {
      counts[table] = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    }
    return { revision: this.revision(), counts, queue: { ...this.stats } }
  }
}
