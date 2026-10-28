import { SCHEMA_VERSION } from '../lib/store/schema.js'
// P1 存储层测试：文件型 WAL、事务、CAS、幂等、作用域、遗忘、迁移、请求生命周期
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, ensureGlobalScope, ensureSchema, getEpoch, getMeta, integrityCheck, loadSqlite, openDatabase, transaction } from '../lib/store/db.js'
import { MemoryService } from '../lib/store/service.js'
import { RequestRegistry } from '../lib/store/request.js'
import { migrateJsonToSqlite, discardTempDatabase } from '../lib/store/migrate.js'
import { resolveScope, readableScopes } from '../lib/store/scope.js'

let pass = 0
let fail = 0
const lines = []

async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    lines.push(`PASS ${name}${detail ? `（${detail}）` : ''}`)
  } catch (error) {
    fail += 1
    lines.push(`FAIL ${name}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`)
}

const dir = mkdtempSync(join(tmpdir(), 'ltm-p1-'))
const dbPath = join(dir, 'memory.db')


await check('文件库启用 WAL（返回值必须是 wal）', () => {
  const { db, journalMode } = openDatabase(dbPath)
  try {
    assertEqual(journalMode, 'wal', 'journal_mode 返回值')
    const row = db.prepare('PRAGMA journal_mode').get()
    assertEqual(String(row.journal_mode).toLowerCase(), 'wal', '再次读取 journal_mode')
    return journalMode
  } finally {
    closeDatabase(db)
  }
})

await check('关闭重开后数据仍在，完整性检查通过', () => {
  const first = openDatabase(dbPath)
  first.db.prepare("INSERT INTO meta(key, value) VALUES('p1_probe', 'v1')").run()
  closeDatabase(first.db)

  const second = openDatabase(dbPath)
  try {
    const row = second.db.prepare("SELECT value FROM meta WHERE key = 'p1_probe'").get()
    assertEqual(String(row.value), 'v1', '重开后应读到数据')
    assertEqual(integrityCheck(second.db), 'ok', 'integrity_check')
    return 'ok'
  } finally {
    closeDatabase(second.db)
  }
})


await check('事务失败整体回滚，不留半成品', () => {
  const { db } = openDatabase(dbPath)
  try {
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
    const revisionBefore = Number(getMeta(db, 'revision'))
    let threw = false
    try {
      transaction(db, () => {
        db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
          VALUES('rollback-test', (SELECT id FROM scopes WHERE kind='global'), 'fact', '临时', 'explicit', 1, 1, 1)`).run()
        throw new Error('boom')
      })
    } catch {
      threw = true
    }
    assert(threw, '应抛出错误')
    assertEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), before, '条数不变')
    assertEqual(Number(getMeta(db, 'revision')), revisionBefore, 'revision 不变')
    return 'rollback ok'
  } finally {
    closeDatabase(db)
  }
})


await check('CHECK/外键约束真的生效', () => {
  const { db } = openDatabase(dbPath)
  try {
    let badKind = false
    try {
      db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
        VALUES('bad-kind', (SELECT id FROM scopes WHERE kind='global'), 'nonsense', 'x', 'explicit', 1, 1, 1)`).run()
    } catch {
      badKind = true
    }
    assert(badKind, '非法 kind 应被拒绝')

    let badScope = false
    try {
      db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
        VALUES('bad-scope', 'no-such-scope', 'fact', 'x', 'explicit', 1, 1, 1)`).run()
    } catch {
      badScope = true
    }
    assert(badScope, '外键应拒绝不存在的 scope')
    return 'constraints ok'
  } finally {
    closeDatabase(db)
  }
})


const opened = openDatabase(dbPath)
const service = new MemoryService({ db: opened.db, logger: console })
const globalScope = resolveScope(opened.db, null).id

await check('显式保存返回真实回执并落库', async () => {
  const receipt = await service.saveExplicit({
    text: '用户喜欢喝咖啡', scopeId: globalScope, opId: 'op-1', sessionId: 's-1',
  })
  assertEqual(receipt.ok, true, '回执 ok')
  assert(receipt.id, '应有 id')
  assertEqual(receipt.replayed, false, '首次不应是重放')
  const row = service.get({ id: receipt.id, scopeIds: [globalScope] })
  assert(row !== null, '应能读回')
  return `rev=${receipt.revision}`
})

await check('同一 opId 重放不产生重复条目', async () => {
  const first = await service.saveExplicit({ text: '用户喜欢喝咖啡', scopeId: globalScope, opId: 'op-1' })
  assertEqual(first.replayed, true, '第二次应为重放')
  const count = Number(opened.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE text = '用户喜欢喝咖啡'").get().n)
  assertEqual(count, 1, '只应有一条')
  return 'idempotent'
})

await check('CAS：版本不符拒绝覆盖，版本正确才更新', async () => {
  const receipt = await service.saveExplicit({ text: '读书会每周六', scopeId: globalScope, opId: 'op-2' })
  let conflict = false
  try {
    await service.updateText({ id: receipt.id, text: '读书会每周日', expectedVersion: 99, scopeId: globalScope })
  } catch (error) {
    conflict = error.message === 'VERSION_CONFLICT'
  }
  assert(conflict, '错误版本应冲突')

  const updated = await service.updateText({ id: receipt.id, text: '读书会每周日', expectedVersion: 1, scopeId: globalScope })
  assertEqual(updated.version, 2, '版本应递增')
  const versions = opened.db.prepare('SELECT version FROM memory_versions WHERE memory_id = ? ORDER BY version').all(receipt.id)
  assertEqual(versions.length, 2, '历史版本应保留两条')
  return 'v2'
})

await check('并发写入串行化，revision 单调递增', async () => {
  const before = service.revision()
  await Promise.all(Array.from({ length: 20 }, (_, i) => service.saveExplicit({
    text: `并发条目 ${i}`, scopeId: globalScope, opId: `concurrent-${i}`,
  })))
  const after = service.revision()
  assertEqual(after - before, 20, '20 次写入应 +20 revision')
  return `${before}→${after}`
})


await check('项目作用域隔离：A 看不见 B，global 都看得见', () => {
  const scopeA = resolveScope(opened.db, 'D:\\work\\projectA').id
  const scopeB = resolveScope(opened.db, 'D:\\work\\projectB').id
  const globalId = resolveScope(opened.db, null).id

  opened.db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
    VALUES('mem-a', ?, 'fact', 'A 项目的事', 'explicit', 1, 1, 1)`).run(scopeA)
  opened.db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
    VALUES('mem-b', ?, 'fact', 'B 项目的事', 'explicit', 1, 1, 1)`).run(scopeB)
  opened.db.prepare(`INSERT INTO memories(id, scope_id, kind, text, source, revision, created_at, updated_at)
    VALUES('mem-g', ?, 'fact', '全局的事', 'explicit', 1, 1, 1)`).run(globalId)

  const readA = readableScopes(opened.db, 'D:\\work\\projectA')
  const readB = readableScopes(opened.db, 'D:\\work\\projectB')
  const idsA = service.list({ scopeIds: readA }).map((r) => r.id)
  const idsB = service.list({ scopeIds: readB }).map((r) => r.id)

  assert(idsA.includes('mem-a') && idsA.includes('mem-g'), 'A 应看到 A + global')
  assert(!idsA.includes('mem-b'), 'A 不得看到 B')
  assert(idsB.includes('mem-b') && !idsB.includes('mem-a'), 'B 不得看到 A')
  assertEqual(service.get({ id: 'mem-b', scopeIds: readA }), null, '按 id 读取也要校验作用域')
  return 'isolated'
})

await check('同一路径大小写不同解析到同一项目', () => {
  const upper = resolveScope(opened.db, 'D:\\WORK\\ProjectA').id
  const lower = resolveScope(opened.db, 'd:\\work\\projecta').id
  if (process.platform === 'win32') {
    assertEqual(upper, lower, 'Windows 路径应大小写不敏感')
  } else {
    // 非 Windows 文件系统大小写敏感：不同大小写就是不同项目，不能被合并
    assert(upper !== lower, '非 Windows 平台不应强行折叠大小写')
  }
  return 'case-insensitive'
})


await check('遗忘：删除内容/版本/来源/向量，留指纹不留原文', async () => {
  const receipt = await service.saveExplicit({
    text: '用户喜欢城市夜景摄影', scopeId: globalScope, opId: 'op-forget', evidence: '我最近在拍城市夜景',
  })
  opened.db.prepare('INSERT INTO vectors(memory_id, hash, model, dim, vec, updated_at) VALUES(?,?,?,?,?,?)')
    .run(receipt.id, 'h', 'm', 3, new Uint8Array([1, 2, 3]), Date.now())
  const epochBefore = service.epoch(globalScope)

  const result = await service.forget({ id: receipt.id, scopeId: globalScope })
  assertEqual(result.ok, true, '遗忘应成功')
  assertEqual(service.epoch(globalScope), epochBefore + 1, 'epoch 应递增')
  assertEqual(service.get({ id: receipt.id, scopeIds: [globalScope] }), null, '条目应消失')
  assertEqual(Number(opened.db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(receipt.id).n), 0, '版本应清空')
  assertEqual(Number(opened.db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE memory_id = ?').get(receipt.id).n), 0, '来源应清空')
  assertEqual(Number(opened.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE memory_id = ?').get(receipt.id).n), 0, '向量应清空')

  const tomb = opened.db.prepare('SELECT * FROM forgotten WHERE id = ?').get(receipt.id)
  assert(tomb !== undefined, '应有指纹记录')
  assert(!JSON.stringify(tomb).includes('夜景'), '指纹不得包含原文')
  assertEqual(service.isForgotten({ scopeId: globalScope, text: '用户喜欢城市夜景摄影' }), true, '指纹应能识别复活')
  return `epoch=${result.epoch}`
})


await check('请求生命周期：取消只影响自己，过期结果不可用', async () => {
  const registry = new RequestRegistry({ generation: 1 })
  const a = registry.create({ sessionId: 's-a', revision: 5, epoch: 0, deadlineMs: 1000 })
  const b = registry.create({ sessionId: 's-b', revision: 5, epoch: 0, deadlineMs: 1000 })

  assertEqual(registry.cancel(a.id, 'test-cancel'), true, '取消 A 应成功')
  assertEqual(registry.isStale(a.id, { revision: 5, epoch: 0 }), true, 'A 已取消应判定过期')
  assertEqual(registry.isStale(b.id, { revision: 5, epoch: 0 }), false, 'B 不应受影响')
  assertEqual(registry.isStale(b.id, { revision: 6, epoch: 0 }), true, 'revision 变化应判定过期')
  assertEqual(registry.isStale(b.id, { revision: 5, epoch: 1 }), true, 'epoch 变化应判定过期')
  registry.bumpGeneration()
  assertEqual(registry.isStale(b.id, { revision: 5, epoch: 0 }), true, '代次变化应判定过期')
  registry.dispose()
  return 'lifecycle ok'
})

await check('请求超时触发回调且只结算一次', async () => {
  const registry = new RequestRegistry()
  let expired = 0
  const request = registry.create({ deadlineMs: 20, onExpire: () => { expired += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assertEqual(expired, 1, '超时回调应触发一次')
  assertEqual(registry.cancel(request.id), false, '已过期请求不应再次取消')
  registry.dispose()
  return 'deadline ok'
})


const legacyPath = join(dir, 'memory.json')
writeFileSync(legacyPath, JSON.stringify({
  version: 2,
  revision: 7,
  epoch: 1,
  items: [
    { id: 'm1', text: '用户喜欢喝咖啡', kind: 'preference', source: 'explicit', status: 'active' },
    { id: 'm2', text: '读书会每月第二个星期日', kind: 'fact', source: 'explicit', status: 'active' },
  ],
}), 'utf8')

await check('JSON 迁移：临时库、WAL、校验通过、原文件不动', () => {
  const target = join(dir, 'migrated.db')
  const before = readFileSync(legacyPath, 'utf8')
  const report = migrateJsonToSqlite({ jsonPath: legacyPath, dbPath: target, logger: console })
  assertEqual(report.ok, true, `迁移应成功：${report.error ?? ''}`)
  assertEqual(report.imported, 2, '应导入 2 条')
  assertEqual(report.journalMode, 'wal', 'WAL 应启用')
  assertEqual(report.integrity, 'ok', 'Integrity 检查')
  const after = readFileSync(legacyPath, 'utf8')
  assertEqual(after, before, '原 JSON 不得被改动')
  assertEqual(report.backupPath, null, '默认不得擅自生成备份文件')
  return `imported=${report.imported}`
})

await check('迁移重复执行不产生重复条目', () => {
  const target = join(dir, 'migrated.db')
  const again = migrateJsonToSqlite({ jsonPath: legacyPath, dbPath: target, logger: console })
  assertEqual(again.ok, false, '目标已存在时应拒绝重复迁移')
  assertEqual(again.error, 'TARGET_EXISTS', '应返回 TARGET_EXISTS')
  return 'idempotent guard'
})

await check('迁移失败可安全丢弃临时库', () => {
  const target = join(dir, 'broken.db')
  writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8')
  const report = migrateJsonToSqlite({ jsonPath: join(dir, 'broken.json'), dbPath: target, logger: console })
  assertEqual(report.ok, false, '坏 JSON 应失败')
  discardTempDatabase(target)
  return report.error.slice(0, 24)
})

await check('迁移后的旧条目可被服务读取', async () => {
  const target = join(dir, 'migrated.db')
  const reopened = openDatabase(target)
  try {
    const svc = new MemoryService({ db: reopened.db, logger: console })
    const global = resolveScope(reopened.db, null).id
    const rows = svc.list({ scopeIds: [global] })
    assertEqual(rows.length, 2, '应读到 2 条')
    assert(rows.every((r) => r.id.startsWith('legacy:')), 'ID 应带 legacy: 前缀')
    return 'readable'
  } finally {
    closeDatabase(reopened.db)
  }
})




console.log('\n—— 审查回归 ——')

await check('迁移保留 status/revision/epoch，project 条目隔离迁移并计数', () => {
  const legacyPath2 = join(dir, 'legacy-semantics.json')
  const target2 = join(dir, 'legacy-semantics.db')
  writeFileSync(legacyPath2, JSON.stringify({
    version: 2, revision: 99, epoch: 7,
    profile: { version: 3, sections: [{ title: '旧画像', bullets: [{ text: '旧结论', refs: ['g1'] }] }] },
    items: [
      { id: 'g1', text: '全局偏好', kind: 'preference', source: 'explicit', status: 'superseded', revision: 42 },
      { id: 'p1', text: '某个项目的事', kind: 'fact', scope: 'project', source: 'explicit', status: 'active' },
    ],
  }), 'utf8')

  const report = migrateJsonToSqlite({ jsonPath: legacyPath2, dbPath: target2, logger: console })
  assertEqual(report.imported, 2, 'global 与 project 条目都应迁移')
  assertEqual(report.unboundImported, 1, 'project 条目应进入未绑定作用域')
  assertEqual(report.statusCounts.superseded, 1, 'superseded 状态应保留')
  assertEqual(report.revision, 99, 'revision 应保留 99')
  assertEqual(report.epoch, 7, 'epoch 应保留 7')
  assertEqual(report.profileStale, true, '画像应标记为待重新综合')
  assertEqual(report.ok, true, '全部条目已迁移且过期画像已标记重建')

  const reopened = openDatabase(target2)
  try {
    const row = reopened.db.prepare("SELECT status, revision FROM memories WHERE id = 'legacy:g1'").get()
    assertEqual(String(row.status), 'superseded', '库内状态应为 superseded')
    assertEqual(Number(row.revision), 42, '条目 revision 应保留')
    const globalId = ensureGlobalScope(reopened.db)
    const stale = reopened.db.prepare('SELECT value FROM meta WHERE key = ?').get(`profile_stale:${globalId}`)
    assert(stale !== undefined && String(stale.value) === '1', '应写入画像待重建标记')
    const epochRow = reopened.db.prepare('SELECT value FROM meta WHERE key = ?').get(`epoch:${globalId}`)
    assertEqual(Number(epochRow.value), 7, '库内 epoch 应为 7')
  } finally {
    closeDatabase(reopened.db)
  }
  return 'semantics preserved'
})

await check('全部可迁移时 ok=true 且字段一致', () => {
  const p = join(dir, 'legacy-clean.json')
  const target = join(dir, 'legacy-clean.db')
  writeFileSync(p, JSON.stringify({
    revision: 5, epoch: 2,
    items: [{ id: 'a', text: '甲', kind: 'fact', status: 'active' }, { id: 'b', text: '乙', kind: 'rule', status: 'review' }],
  }), 'utf8')
  const report = migrateJsonToSqlite({ jsonPath: p, dbPath: target, logger: console })
  assertEqual(report.ok, true, `应完全成功：${report.error ?? ''}`)
  assertEqual(report.imported, 2, '应迁移 2 条')
  assertEqual(report.statusCounts.review, 1, 'review 状态应保留')
  return 'ok=true'
})

await check('get() 不传作用域默认拒绝', () => {
  let threw = false
  try {
    service.get({ id: 'any-id' })
  } catch (error) {
    threw = error.message === 'SCOPE_REQUIRED'
  }
  assert(threw, '不传 scopeIds 必须抛 SCOPE_REQUIRED')
  return 'deny by default'
})

await check('遗忘后自动提炼被拦截，显式保存可恢复', async () => {
  const receipt = await service.saveExplicit({ text: '用户喜欢夜景摄影', scopeId: globalScope, opId: 'resurrect-1' })
  await service.forget({ id: receipt.id, scopeId: globalScope })

  let blocked = false
  try {
    await service.saveCandidate({ text: '用户喜欢夜景摄影', scopeId: globalScope })
  } catch (error) {
    blocked = error.message === 'FORGOTTEN_BLOCKED'
  }
  assert(blocked, '自动提炼不得复活已遗忘内容')

  const again = await service.saveExplicit({ text: '用户喜欢夜景摄影', scopeId: globalScope })
  assertEqual(again.ok, true, '用户明确保存应允许恢复')
  return 'guarded'
})

await check('请求结算后从注册表释放：30 个完成后 active=0', () => {
  const registry = new RequestRegistry()
  const ids = []
  for (let i = 0; i < 30; i++) ids.push(registry.create({ deadlineMs: 5000 }).id)
  assertEqual(registry.activeCount(), 30, '创建后应在途')
  for (const id of ids) registry.finish(id)
  assertEqual(registry.activeCount(), 0, '完成后必须释放')
  assertEqual(registry.stats().settled, 30, '结算计数应准确')

  const cancelIds = []
  for (let i = 0; i < 5; i++) cancelIds.push(registry.create({ deadlineMs: 5000 }).id)
  for (const id of cancelIds) registry.cancel(id)
  assertEqual(registry.activeCount(), 0, '取消后必须释放')
  registry.dispose()
  return 'no leak'
})

await check('相同 opId 不同内容返回 OP_CONFLICT', async () => {
  await service.saveExplicit({ text: '第一条内容', scopeId: globalScope, opId: 'dup-op' })
  let conflicted = false
  try {
    await service.saveExplicit({ text: '第二条内容', scopeId: globalScope, opId: 'dup-op' })
  } catch (error) {
    conflicted = error.message === 'OP_CONFLICT'
  }
  assert(conflicted, '同 opId 不同内容必须冲突')

  const other = resolveScope(opened.db, 'D:\\work\\opScope')
  let scopeConflict = false
  try {
    await service.saveExplicit({ text: '第一条内容', scopeId: other.id, opId: 'dup-op' })
  } catch (error) {
    scopeConflict = error.message === 'OP_CONFLICT'
  }
  assert(scopeConflict, '同 opId 不同作用域必须冲突')
  return 'bound to content'
})

await check('global 作用域唯一（部分唯一索引）', () => {
  let threw = false
  try {
    opened.db.prepare('INSERT INTO scopes(id, kind, path_key, label, created_at) VALUES(?,?,?,?,?)')
      .run('another-global', 'global', null, 'global2', Date.now())
  } catch {
    threw = true
  }
  assert(threw, '第二个 global 必须被拒绝')
  const count = Number(opened.db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE kind = 'global'").get().n)
  assertEqual(count, 1, 'global 只能有一行')
  assertEqual(ensureGlobalScope(opened.db), ensureGlobalScope(opened.db), '应返回同一个 global')
  return 'unique'
})

await check('外键完整性：孤儿版本被拒绝，删除记忆级联清理', () => {
  let orphanRejected = false
  try {
    opened.db.prepare('INSERT INTO memory_versions(memory_id, version, snapshot, created_at) VALUES(?,?,?,?)')
      .run('no-such-memory', 1, '{}', Date.now())
  } catch {
    orphanRejected = true
  }
  assert(orphanRejected, '孤儿版本必须被外键拒绝')

  const receipt = opened.db.prepare("SELECT id FROM memories WHERE scope_id = ? LIMIT 1").get(globalScope)
  if (receipt !== undefined) {
    opened.db.prepare('INSERT INTO vectors(memory_id, hash, model, dim, vec, updated_at) VALUES(?,?,?,?,?,?)')
      .run(String(receipt.id), 'h', 'm', 1, new Uint8Array([1]), Date.now())
    opened.db.prepare('DELETE FROM memories WHERE id = ?').run(String(receipt.id))
    const vectorsLeft = Number(opened.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE memory_id = ?').get(String(receipt.id)).n)
    const versionsLeft = Number(opened.db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(String(receipt.id)).n)
    assertEqual(vectorsLeft, 0, '删除记忆应级联删除向量')
    assertEqual(versionsLeft, 0, '删除记忆应级联删除版本')
  }
  return 'fk + cascade ok'
})
await check('自动候选默认不受保护，重要度不取最高', async () => {
  const receipt = await service.saveCandidate({
    text: '自动候选：用户在学习摄影', scopeId: globalScope, evidence: '我在学摄影',
  })
  const row = service.get({ id: receipt.id, scopeIds: [globalScope] })
  assertEqual(Number(row.protected), 0, '自动候选不得默认受保护')
  assertEqual(String(row.source), 'auto', '来源应为 auto')
  assertEqual(String(row.importance), 'medium', '重要度默认应为 medium')

  const explicit = await service.saveExplicit({ text: '显式保存：偏好结论先行', scopeId: globalScope })
  const erow = service.get({ id: explicit.id, scopeIds: [globalScope] })
  assertEqual(Number(erow.protected), 0, '显式保存不等于用户置顶')
  assertEqual(String(erow.importance), 'high', '显式保存重要度应为 high')

  const low = await service.saveCandidate({ text: '自动候选：低重要度', scopeId: globalScope, importance: 'low' })
  assertEqual(String(service.get({ id: low.id, scopeIds: [globalScope] }).importance), 'low', '提炼结果应覆盖默认值')
  return 'explicit≠candidate'
})

await check('用户置顶与自动提炼隔离，来源由保存入口决定', async () => {
  const pinned = await service.saveExplicit({
    text: '用户明确置顶', scopeId: globalScope, protected: true, source: 'auto',
  })
  const pinnedRow = service.get({ id: pinned.id, scopeIds: [globalScope] })
  assertEqual(Number(pinnedRow.protected), 1, '用户明确置顶才受保护')
  assertEqual(pinnedRow.source, 'explicit', '显式入口的来源不得被输入覆盖')

  for (const importance of ['low', 'medium', 'high', 'invalid']) {
    const receipt = await service.saveCandidate({
      text: `提炼候选 ${importance}`, scopeId: globalScope,
      importance, protected: true, source: 'explicit',
    })
    const row = service.get({ id: receipt.id, scopeIds: [globalScope] })
    assertEqual(Number(row.protected), 0, '提炼结果不能替用户置顶')
    assertEqual(row.source, 'auto', '自动入口始终标记 auto')
    assertEqual(row.importance, importance === 'invalid' ? 'medium' : importance, '采用合法提炼重要度，否则使用 medium')
  }
})

await check('损坏的 schema_version 被拒绝，不重新初始化', () => {
  const target = join(dir, 'corrupt-version.db')
  const first = openDatabase(target)
  first.db.prepare("UPDATE meta SET value = 'not-an-integer' WHERE key = 'schema_version'").run()
  const before = first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  closeDatabase(first.db)

  let message = ''
  try {
    openDatabase(target)
  } catch (error) {
    message = String(error.message)
  }
  assert(message.startsWith('SCHEMA_CORRUPT'), `应拒绝损坏版本号，实际：${message}`)

  const { DatabaseSync } = loadSqlite()
  const raw = new DatabaseSync(target)
  const after = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  const version = raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
  raw.close()
  assertEqual(JSON.stringify(after), JSON.stringify(before), '结构不得被重建')
  assertEqual(String(version.value), 'not-an-integer', '版本号不得被改写')
  return 'corrupt rejected'
})

await check('v1 库被拒绝并要求重建（不再伪造升级）', () => {
  const target = join(dir, 'v1.db')
  const { DatabaseSync } = loadSqlite()
  const first = new DatabaseSync(target)
  // 独立构造旧表，不能仅把一个完整 v2 库的版本号改成 1。
  first.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL);
    INSERT INTO memories VALUES ('old', '旧库原始内容');
    CREATE TABLE memory_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
      version INTEGER NOT NULL, snapshot TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL,
      UNIQUE (memory_id, version)
    );
    CREATE TABLE memory_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
      session_id TEXT, event_seq INTEGER, excerpt TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO memory_versions(memory_id, version, snapshot, created_at) VALUES ('old', 1, '{}', 1);
    INSERT INTO memory_sources(memory_id, excerpt, created_at) VALUES ('old', '旧来源', 1);
    CREATE TABLE oplog (op_id TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL);
  `)
  assertEqual(first.prepare('PRAGMA foreign_key_list(memory_versions)').all().length, 0, '旧版本表确实无外键')
  assertEqual(first.prepare('PRAGMA foreign_key_list(memory_sources)').all().length, 0, '旧来源表确实无外键')
  first.close()
  const before = readFileSync(target)

  let message = ''
  try {
    closeDatabase(openDatabase(target).db)
  } catch (error) {
    message = String(error.message)
  }
  assert(message.startsWith('SCHEMA_V1_REQUIRES_REBUILD'), `应拒绝 v1 库，实际：${message}`)

  assert(readFileSync(target).equals(before), '拒绝 v1 时不得写入任何字节或更改 journal_mode')

  const rebuiltPath = join(dir, 'v2-rebuilt.db')
  const jsonBefore = readFileSync(legacyPath)
  const report = migrateJsonToSqlite({ jsonPath: legacyPath, dbPath: rebuiltPath, logger: console })
  assertEqual(report.ok, true, '从原 JSON 迁移到独立 v2 库应成功')
  assert(readFileSync(legacyPath).equals(jsonBefore), '迁移不得修改原 JSON')
  assert(readFileSync(target).equals(before), '迁移不得覆盖被拒绝的 v1 库')
  const rebuilt = openDatabase(rebuiltPath).db
  try {
    assertEqual(getMeta(rebuilt, 'schema_version'), String(SCHEMA_VERSION), '新库应为当前 schema')
    for (const table of ['memory_versions', 'memory_sources']) {
      const fk = rebuilt.prepare(`PRAGMA foreign_key_list(${table})`).all()
      assert(fk.some((r) => r.table === 'memories' && r.from === 'memory_id' && r.to === 'id' && r.on_delete === 'CASCADE'), `${table} 必须有级联外键`)
      assertEqual(Number(rebuilt.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id = 'legacy:m1'`).get().n), 1, '删除前必须有子记录')
    }
    for (const sql of [
      "INSERT INTO memory_versions(memory_id, version, snapshot, created_at) VALUES ('orphan', 1, '{}', 1)",
      "INSERT INTO memory_sources(memory_id, created_at) VALUES ('orphan', 1)",
    ]) {
      let rejected = false
      try { rebuilt.exec(sql) } catch (error) { rejected = /FOREIGN KEY/.test(error.message) }
      assert(rejected, '新库应拒绝孤儿子记录')
    }
    rebuilt.exec("DELETE FROM memories WHERE id = 'legacy:m1'")
    for (const table of ['memory_versions', 'memory_sources']) {
      assertEqual(Number(rebuilt.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id = 'legacy:m1'`).get().n), 0, '直接删除父记录应级联清理')
    }
    assertEqual(rebuilt.prepare('PRAGMA foreign_key_check').all().length, 0, '不得存在孤儿记录')
  } finally {
    closeDatabase(rebuilt)
  }
  return 'rebuild required'
})

for (const [name, version, errorPrefix] of [
  ['损坏字符串', 'not-an-integer', 'SCHEMA_CORRUPT'],
  ['尾随字符', '2junk', 'SCHEMA_CORRUPT'],
  ['小数', '2.5', 'SCHEMA_CORRUPT'],
  ['指数表示', '2e0', 'SCHEMA_CORRUPT'],
  ['空版本号', '', 'SCHEMA_CORRUPT'],
  ['零版本号', '0', 'SCHEMA_CORRUPT'],
  ['负版本号', '-1', 'SCHEMA_CORRUPT'],
  ['缺失版本行', null, 'SCHEMA_CORRUPT'],
  ['缺失 meta 表', undefined, 'SCHEMA_CORRUPT'],
  ['不兼容高版本', '999', 'SCHEMA_TOO_NEW'],
]) {
  await check(`版本校验：${name} 在任何写入前拒绝`, () => {
    const target = join(dir, `invalid-${name}.db`)
    const { DatabaseSync } = loadSqlite()
    const raw = new DatabaseSync(target)
    try {
      raw.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('不得改动')")
      if (version !== undefined) {
        raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        if (version !== null) raw.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', version)
      }
    } finally {
      raw.close()
    }
    const before = readFileSync(target)
    // 分别验证 ensureSchema 的直接调用和完整打开入口。
    for (const direct of [true, false]) {
      let message = ''
      let db
      try {
        if (direct) {
          db = new DatabaseSync(target)
          ensureSchema(db)
        } else {
          db = openDatabase(target).db
        }
      } catch (error) {
        message = String(error.message)
      } finally {
        if (db) closeDatabase(db)
      }
      assert(message.startsWith(errorPrefix), `应拒绝 ${name}，实际：${message}`)
      assert(readFileSync(target).equals(before), '已有库必须逐字节保持不变')
      assert(!existsSync(`${target}-wal`) && !existsSync(`${target}-shm`), '拒绝时不应创建 WAL 旁文件')
    }
  })
}

await check('更高版本的数据库被拒绝且结构不被改动', () => {
  const target = join(dir, 'future.db')
  const first = openDatabase(target)
  first.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
  const before = first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  closeDatabase(first.db)

  let threw = false
  try {
    openDatabase(target)
  } catch (error) {
    threw = String(error.message).startsWith('SCHEMA_TOO_NEW')
  }
  assert(threw, '更高版本应抛 SCHEMA_TOO_NEW')

  const { DatabaseSync } = loadSqlite()
  const raw = new DatabaseSync(target)
  const after = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  const version = raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
  raw.close()

  assertEqual(JSON.stringify(after), JSON.stringify(before), '表结构不得变化')
  assertEqual(String(version.value), '999', '版本号不得被改写')
  return 'structure intact'
})


closeDatabase(opened.db)

console.log(lines.join('\n'))
console.log(`\nP1 存储层：通过 ${pass}，失败 ${fail}`)
console.log(`临时目录：${dir}`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
