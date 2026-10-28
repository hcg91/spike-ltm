/* 迁移旧 JSON，保留状态、版本和历史。无法绑定的项目单独隔离。 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import {
  bumpRevision,
  ensureUnboundScope,
  closeDatabase,
  getMeta,
  integrityCheck,
  openDatabase,
  setEpoch,
  setMeta,
  transaction,
} from './db.js'
import { getGlobalScopeId } from './scope.js'

const EXCERPT_MAX = 200
const KINDS = new Set(['fact', 'preference', 'goal', 'constraint', 'rule', 'project'])
const STATUSES = new Set(['active', 'superseded', 'review'])
const LEVELS = new Set(['high', 'medium', 'low'])

function hashContent(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export function migrateJsonToSqlite({ jsonPath, dbPath, logger = console, backup = false } = {}) {
  if (!existsSync(jsonPath)) return { ok: false, error: 'JSON_NOT_FOUND', jsonPath }
  if (existsSync(dbPath)) return { ok: false, error: 'TARGET_EXISTS', dbPath }

  let legacy
  let sourceHash
  try {
    const bytes = readFileSync(jsonPath)
    sourceHash = hashContent(bytes)
    legacy = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return { ok: false, error: 'JSON_INVALID' }
  }
  const items = Array.isArray(legacy?.items) ? legacy.items : null
  if (items === null) return { ok: false, error: 'JSON_SHAPE_INVALID' }

  const backupPath = backup ? `${jsonPath}.bak.${Date.now()}` : null
  if (backup) copyFileSync(jsonPath, backupPath)
  let created = false

  let opened = null
  try {
    writeFileSync(dbPath, '', { flag: 'wx' })
    created = true
    opened = openDatabase(dbPath)
    const { db, journalMode } = opened
    if (journalMode !== 'wal') throw new Error(`WAL_NOT_ENABLED: ${journalMode}`)
    const globalId = getGlobalScopeId(db)
    const unboundId = ensureUnboundScope(db)

    const legacyRevision = Number.isInteger(legacy?.revision) ? legacy.revision : null
    const legacyEpoch = Number.isInteger(legacy?.epoch) ? legacy.epoch : null
    if (legacyRevision !== null) setMeta(db, 'revision', String(legacyRevision))
    if (legacyEpoch !== null) setEpoch(db, globalId, legacyEpoch)

    const report = {
      imported: 0,
      skippedExisting: 0,
      unboundImported: 0,
      resurrectSkipped: 0,
      invalidSkipped: 0,
      statusCounts: { active: 0, superseded: 0, review: 0 },
      profileImported: false,
      historicalVersions: 0,
      profileDeferred: false,
    }

    transaction(db, () => {
      for (const item of items) {
        const legacyId = typeof item?.id === 'string' ? item.id : null
        const text = typeof item?.text === 'string' ? item.text.trim() : ''
        if (legacyId === null || text === '') {
          report.invalidSkipped += 1
          continue
        }

        // 旧 project 条目没有目录信息：进入未绑定作用域，绝不落到 global
        const targetScope = item.scope === 'project' ? unboundId : globalId
        if (item.scope === 'project') report.unboundImported += 1

        const id = `legacy:${legacyId}`
        if (db.prepare('SELECT id FROM memories WHERE id = ?').get(id) !== undefined) {
          report.skippedExisting += 1
          continue
        }

        // 目标库已有该内容的遗忘指纹 -> 拒绝复活
        if (db.prepare('SELECT id FROM forgotten WHERE scope_id = ? AND content_hash = ?')
          .get(targetScope, hashContent(text)) !== undefined) {
          report.resurrectSkipped += 1
          continue
        }

        const at = Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Date.now()
        const revision = Number.isInteger(item.revision) ? item.revision : (legacyRevision ?? bumpRevision(db))
        const status = STATUSES.has(item.status) ? item.status : 'active'
        const version = Number.isInteger(item.version) && item.version > 0 ? item.version : 1
        report.statusCounts[status] += 1

        db.prepare(`
          INSERT INTO memories(id, scope_id, kind, subject, predicate, value, text, source,
            importance, confidence, status, protected, version, revision, reason, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          id, targetScope,
          KINDS.has(item.kind) ? item.kind : 'fact',
          item.subject ?? null, item.predicate ?? null, item.value ?? null,
          text,
          item.source === 'auto' ? 'auto' : 'explicit',
          LEVELS.has(item.importance) ? item.importance : 'medium',
          LEVELS.has(item.confidence) ? item.confidence : 'medium',
          status,
          item.protected === true ? 1 : 0,
          version, revision, typeof item.reason === 'string' ? item.reason : null, at, at,
        )
        db.prepare('INSERT INTO memory_versions(memory_id, version, snapshot, reason, created_at) VALUES(?,?,?,?,?)')
          .run(id, version, JSON.stringify({ text, kind: item.kind ?? 'fact', status }), 'migrated', at)
        for (const entry of item.history ?? []) {
          if (!Number.isSafeInteger(entry.version) || entry.version < 1 || entry.version >= version || typeof entry.text !== 'string') throw new Error('HISTORY_INVALID')
          db.prepare('INSERT INTO memory_versions(memory_id,version,snapshot,reason,created_at) VALUES(?,?,?,?,?)')
            .run(id, entry.version, JSON.stringify({ text: entry.text, kind: item.kind ?? 'fact', status }), entry.reason ?? 'legacy-history', Number.isFinite(Date.parse(entry.createdAt)) ? Date.parse(entry.createdAt) : at)
          report.historicalVersions++
        }
        db.prepare('INSERT INTO memory_sources(memory_id, session_id, event_seq, excerpt, created_at) VALUES(?,?,?,?,?)')
          .run(id, null, null, String(item.evidence ?? item.reason ?? text).slice(0, EXCERPT_MAX), at)
        report.imported += 1
      }

      // 画像仅在引用和版本完整时保留；过期画像不进入召回。
      const validIds = new Set(items.filter(i => i.scope !== 'project' && (!i.status || i.status === 'active')).map(i => i.id))
      const usableProfile = legacy.profile?.builtAtRevision === legacyRevision && legacy.profile?.sections?.every(s => s.bullets?.every(b => b.refs?.length && b.refs.every(id => validIds.has(id))))
      report.profileDeferred = !!legacy.profile && !usableProfile
      if (report.profileDeferred) setMeta(db, `profile_stale:${globalId}`, '1')
      if (usableProfile) {
        const profileSections = legacy.profile.sections
          .filter((section) => section && Array.isArray(section.bullets))
          .map((section) => ({
            title: String(section.title ?? '').trim() || '未命名',
            bullets: section.bullets
              .filter((bullet) => bullet && Array.isArray(bullet.refs) && bullet.refs.length > 0 && typeof bullet.text === 'string')
              .map((bullet) => ({ text: String(bullet.text).trim(), refs: bullet.refs.map((ref) => `legacy:${String(ref)}`) })),
          }))
          .filter((section) => section.bullets.length > 0)
        db.prepare('INSERT INTO profiles(scope_id, version, built_at_revision, sections, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_id) DO UPDATE SET version=excluded.version, built_at_revision=excluded.built_at_revision, sections=excluded.sections, updated_at=excluded.updated_at')
          .run(globalId, Number(legacy.profile.version) || 1, legacyRevision, JSON.stringify(profileSections), Date.now())
        report.profileImported = true
      }
    })

    const stored = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
    const expected = items.filter((it) => typeof it?.text === 'string' && it.text.trim() !== ''
      && typeof it?.id === 'string').length
    const revisionNow = Number.parseInt(getMeta(db, 'revision') ?? '0', 10) || 0
    const epochNow = Number.parseInt(getMeta(db, `epoch:${globalId}`) ?? '0', 10) || 0
    const integrity = integrityCheck(db)
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length ? 'failed' : 'ok'
    if (hashContent(readFileSync(jsonPath)) !== sourceHash) throw new Error('SOURCE_CHANGED')

    const statusTotal = Object.values(report.statusCounts).reduce((a, b) => a + b, 0)
    const ok = integrity === 'ok' && foreignKeys === 'ok'
      && stored === expected
      && statusTotal === report.imported
      && journalMode === 'wal'
      && report.resurrectSkipped === 0
      && report.invalidSkipped === 0
      && (legacyRevision === null || revisionNow === legacyRevision)
      && (legacyEpoch === null || epochNow === legacyEpoch)

    if (!ok) throw new Error('MIGRATION_VERIFICATION_FAILED')
    return {
      ok,
      dbPath,
      sourceHash, foreignKeys,
      backupPath,
      journalMode,
      ...report,
      stored,
      expected,
      revision: revisionNow,
      legacyRevision,
      epoch: epochNow,
      legacyEpoch,
      integrity,
      profileStale: report.profileDeferred,
      checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (opened !== null) {
      try {
        closeDatabase(opened.db)
      } catch {
        // 已关闭
      }
    }
    if (created) discardTempDatabase(dbPath)
    return { ok: false, error: String(error?.message ?? error), dbPath, backupPath }
  } finally {
    if (opened !== null) closeDatabase(opened.db)
    logger?.info?.('spike-ltm: 迁移检查结束，请以报告 ok 字段为准')
  }
}

/** 迁移失败或放弃时清理临时库（含 WAL 旁文件）。 */
export function discardTempDatabase(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`
    if (existsSync(target)) rmSync(target, { force: true })
  }
}
