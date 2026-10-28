// 记忆界面服务与路由测试（独立临时库）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeDatabase, openDatabase } from '../lib/store/db.js'
import { MemoryService } from '../lib/store/service.js'
import { resolveScope } from '../lib/store/scope.js'
import {
  listMemoryView, applyEdit, listVersions, restoreVersion,
} from '../lib/memory-ui-service.js'
import { createEditProposer, parseProposal, readTarget } from '../lib/memory-edit.js'
import { registerMemoryUiRoutes } from '../lib/memory-ui-routes.js'

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

const dir = mkdtempSync(join(tmpdir(), 'ltm-ui-'))
const { db } = openDatabase(join(dir, 'ui.db'))
const service = new MemoryService({ db, logger: console })

const globalScope = resolveScope(db, null).id
const projectScope = resolveScope(db, join(dir, 'project-a')).id

const globalItem = await service.saveExplicit({ text: '全局：回答先给结论', scopeId: globalScope, kind: 'rule' })
const projectItem = await service.saveExplicit({ text: '项目 A：Godot 三维仿真', scopeId: projectScope, kind: 'project' })
const otherItem = await service.saveExplicit({ text: '全局：使用 A6700 相机', scopeId: globalScope, kind: 'fact' })


await check('视图按 kind 分段，并按作用域过滤', () => {
  const globalView = listMemoryView({ db, scopeIds: [globalScope] })
  const projectView = listMemoryView({ db, scopeIds: [globalScope, projectScope] })
  assert(globalView.sections.length >= 2, '全局应有至少两个分类')
  assertEqual(globalView.total, 2, '全局视图只含 2 条')
  assertEqual(projectView.total, 3, '项目视图含全局 + 项目条目')
  const kinds = projectView.sections.map((s) => s.kind)
  assert(kinds.includes('project') && kinds.includes('rule'), '分类应包含 project 与 rule')
  const all = projectView.sections.flatMap((s) => s.items)
  assert(all.some((i) => i.id === projectItem.id), '项目条目应出现')
  assert(!all.some((i) => i.id === 'nothing'), '不应有幽灵条目')
  return `${globalView.total}/${projectView.total}`
})


await check('编辑只改选中项，版本递增，另一条不变', async () => {
  const before = service.get({ id: otherItem.id, scopeIds: [globalScope] })
  const result = await applyEdit({
    service, id: globalItem.id, scopeId: globalScope, expectedVersion: 1, text: '全局：先给结论，再解释',
  })
  assertEqual(result.version, 2, '版本应 +1')
  const edited = service.get({ id: globalItem.id, scopeIds: [globalScope] })
  const untouched = service.get({ id: otherItem.id, scopeIds: [globalScope] })
  assertEqual(edited.text, '全局：先给结论，再解释', '内容应更新')
  assertEqual(untouched.text, before.text, '另一条不得改变')
  return `v${result.version}`
})

await check('空文本、错误作用域、过期版本都被拒绝', async () => {
  let empty = false
  try { await applyEdit({ service, id: otherItem.id, scopeId: globalScope, expectedVersion: 1, text: '   ' }) } catch (e) { empty = e.message === 'EMPTY_TEXT' }
  assert(empty, '空文本应拒绝')

  let scope = false
  try { await applyEdit({ service, id: otherItem.id, scopeId: projectScope, expectedVersion: 1, text: '越权' }) } catch (e) { scope = e.message === 'NOT_FOUND' }
  assert(scope, '错误作用域应拒绝')

  let stale = false
  try { await applyEdit({ service, id: projectItem.id, scopeId: projectScope, expectedVersion: 99, text: '过期写入' }) } catch (e) { stale = e.message === 'VERSION_CONFLICT' }
  assert(stale, '过期版本应拒绝')
  return 'guarded'
})

await check('编辑使旧画像在同一事务失效', async () => {
  db.prepare(`INSERT OR REPLACE INTO profiles(scope_id, version, built_at_revision, sections, updated_at)
    VALUES(?,?,?,?,?)`).run(globalScope, 1, service.revision(), JSON.stringify([{ title: '摄影', bullets: [{ text: otherItem.text, refs: [otherItem.id] }] }]), Date.now())
  assert(db.prepare('SELECT 1 FROM profiles WHERE scope_id = ?').get(globalScope) !== undefined, '前置：画像存在')
  await applyEdit({ service, id: otherItem.id, scopeId: globalScope, expectedVersion: 1, text: '全局：使用 A6700 相机（APS-C）' })
  assertEqual(db.prepare('SELECT 1 FROM profiles WHERE scope_id = ?').get(globalScope), undefined, '画像应被删除')
  return 'profile stale'
})


await check('版本列表按版本倒序，跨作用域拒绝', () => {
  const versions = listVersions({ db, id: globalItem.id, scopeIds: [globalScope] })
  assert(versions.length >= 2, '应有至少两个版本')
  assert(versions[0].version > versions[1].version, '应倒序')
  let denied = false
  try { listVersions({ db, id: globalItem.id, scopeIds: [projectScope] }) } catch (e) { denied = e.message === 'SCOPE_DENIED' }
  assert(denied, '跨作用域应拒绝')
  return `${versions.length} versions`
})

await check('恢复 = 新的 CAS 写入，版本继续递增', async () => {
  const current = service.get({ id: globalItem.id, scopeIds: [globalScope] })
  const versions = listVersions({ db, id: globalItem.id, scopeIds: [globalScope] })
  const oldest = versions[versions.length - 1]
  const result = await restoreVersion({
    service, db, id: globalItem.id, scopeId: globalScope,
    expectedVersion: current.version, targetVersion: oldest.version,
  })
  assertEqual(result.version, Number(current.version) + 1, '恢复应产生新版本')
  const restored = service.get({ id: globalItem.id, scopeIds: [globalScope] })
  assertEqual(restored.text, oldest.text, '内容应为历史版本文本')

  let stale = false
  try {
    await restoreVersion({ service, db, id: globalItem.id, scopeId: globalScope, expectedVersion: current.version, targetVersion: oldest.version })
  } catch (e) { stale = e.message === 'VERSION_CONFLICT' }
  assert(stale, '过期恢复应拒绝')
  return `v${result.version}`
})

await check('已遗忘的条目不能查看版本或恢复', async () => {
  const receipt = await service.saveExplicit({ text: '临时：会被遗忘', scopeId: globalScope, kind: 'fact' })
  await service.forget({ id: receipt.id, scopeId: globalScope })
  let listGone = false
  let restoreGone = false
  try { listVersions({ db, id: receipt.id, scopeIds: [globalScope] }) } catch (e) { listGone = e.message === 'NOT_FOUND' }
  try {
    await restoreVersion({ service, db, id: receipt.id, scopeId: globalScope, expectedVersion: 1, targetVersion: 1 })
  } catch (e) { restoreGone = e.message === 'NOT_FOUND' }
  assert(listGone && restoreGone, '遗忘后应查不到、恢复不了')
  return 'forgotten'
})


await check('对话只生成预览，不写库', async () => {
  const target = service.get({ id: projectItem.id, scopeIds: [globalScope, projectScope] })
  let called = 0
  const proposer = createEditProposer({
    db,
    callModel: async () => {
      called += 1
      return JSON.stringify({ reply: '把时间改成周日', text: '项目 A：每周日推进 Godot 三维仿真' })
    },
  })
  const result = await proposer({
    id: target.id, scopeIds: [globalScope, projectScope],
    expectedVersion: target.version, messages: [{ role: 'user', content: '改成周日' }],
  })
  assertEqual(called, 1, '应调用一次模型')
  assertEqual(result.proposedText, '项目 A：每周日推进 Godot 三维仿真', '应返回建议文本')
  const after = service.get({ id: target.id, scopeIds: [globalScope, projectScope] })
  assertEqual(after.text, target.text, '预览不得写库')
  assertEqual(after.version, target.version, '版本不得变化')
  return 'preview only'
})

await check('模型伪造 id/作用域也不影响目标', async () => {
  const target = service.get({ id: projectItem.id, scopeIds: [projectScope] })
  const proposer = createEditProposer({
    db,
    callModel: async () => JSON.stringify({ reply: 'ok', text: '新文本', id: 'evil', scopeId: 'evil' }),
  })
  const result = await proposer({
    id: target.id, scopeIds: [globalScope, projectScope],
    expectedVersion: target.version, messages: [],
  })
  assertEqual(result.id, target.id, '目标 id 必须来自服务端')
  assertEqual(result.baseVersion, target.version, '版本来自服务端')
  return 'target bound'
})

await check('预览失败/非法输出不产生写入', async () => {
  const target = service.get({ id: projectItem.id, scopeIds: [projectScope] })
  const proposer = createEditProposer({ db, callModel: async () => { throw new Error('MODEL_FAILED') } })
  let failed = false
  try {
    await proposer({ id: target.id, scopeIds: [globalScope, projectScope], expectedVersion: target.version, messages: [] })
  } catch (e) { failed = e.message === 'MODEL_FAILED' }
  assert(failed, '模型失败应抛错')
  const after = service.get({ id: target.id, scopeIds: [projectScope] })
  assertEqual(after.text, target.text, '失败不得写库')

  const parsed = parseProposal('不是 JSON 的回复')
  assert(parsed.proposedText === null, '非法输出不应给建议文本')
  assert(parsed.reply.length > 0, '应有兜底回复')
  return 'no write'
})

await check('迟到响应：遗忘后应用会被拒绝', async () => {
  const receipt = await service.saveExplicit({ text: '会先被遗忘的项目条目', scopeId: projectScope, kind: 'project' })
  const snapshot = readTarget({ db, id: receipt.id, scopeIds: [globalScope, projectScope] })
  await service.forget({ id: receipt.id, scopeId: projectScope })
  let gone = false
  try {
    await applyEdit({ service, id: snapshot.id, scopeId: projectScope, expectedVersion: snapshot.version, text: '迟到写入' })
  } catch (e) { gone = e.message === 'NOT_FOUND' }
  assert(gone, '遗忘后的迟到应用必须被拒绝')
  return 'late write rejected'
})


await check('HTTP 路由：列表/编辑/冲突/未知作用域', async () => {
  const registered = []
  const fakeCtx = {
    connection: { fetch: { register: (route) => { registered.push(route); return () => {} } } },
  }
  const allowlist = [
    { label: '全局', kind: 'global', scopeIds: [globalScope] },
    { label: '项目 A', kind: 'project', scopeIds: [globalScope, projectScope] },
  ]
  const dispose = registerMemoryUiRoutes({
    ctx: fakeCtx, db, service, allowlist,
    propose: async ({ id, scopeIds, expectedVersion }) => {
      const target = readTarget({ db, id, scopeIds })
      return { id, baseVersion: target.version, reply: '建议', proposedText: `${target.text}（改）` }
    },
    logger: { info() {}, warn() {} },
  })
  assertEqual(registered.length, 9, '应注册 9 条路由（包含显式取消生成）')

  const call = async (path, body) => {
    const route = registered.find((r) => r.path.endsWith(path))
    const response = await route.fetch(new Request(`http://local${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }

  const list = await call('/list', { label: '全局' })
  assertEqual(list.body.ok, true, '列表应成功')
  assert(list.body.value.total >= 2, '应返回条目')

  const target = list.body.value.sections[0].items[0]
  const edit = await call('/edit', { label: '全局', id: target.id, expectedVersion: target.version, text: '通过路由修改' })
  assertEqual(edit.body.ok, true, '编辑应成功')

  const conflict = await call('/edit', { label: '全局', id: target.id, expectedVersion: target.version, text: '旧版本写入' })
  assertEqual(conflict.status, 409, '过期版本应 409，实际 ' + JSON.stringify(conflict.body))
  assertEqual(conflict.body.error.code, 'VERSION_CONFLICT', '错误码')

  const badScope = await call('/list', { label: '不存在的项目' })
  assertEqual(badScope.status, 400, '未知作用域应 400')

  const propose = await call('/propose', { label: '全局', id: target.id, expectedVersion: target.version + 1, messages: [{ role: 'user', content: '改一下' }] })
  assertEqual(propose.body.ok, true, '预览应成功')
  assert(propose.body.value.proposedText.includes('改'), '应返回建议文本')

  dispose()
  return 'routes ok'
})


await check('混合视图：项目标签下编辑全局条目定位到正确作用域', async () => {
  const registered = []
  const fakeCtx = { connection: { fetch: { register: (route) => { registered.push(route); return () => {} } } } }
  const dispose = registerMemoryUiRoutes({
    ctx: fakeCtx, db, service,
    allowlist: [{ label: '项目 A', kind: 'project', scopeIds: [globalScope, projectScope] }],
    propose: null,
    logger: { info() {}, warn() {} },
  })
  const route = registered.find((r) => r.path.endsWith('/edit'))
  const response = await route.fetch(new Request('http://local/edit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '项目 A', id: otherItem.id, expectedVersion: service.get({ id: otherItem.id, scopeIds: [globalScope] }).version, text: '通过项目视图修改全局条目' }),
  }))
  const body = await response.json()
  assertEqual(response.status, 200, `应成功，实际 ${JSON.stringify(body)}`)
  assertEqual(body.value.version >= 2, true, '版本应递增')
  dispose()
  return 'mixed scope ok'
})

closeDatabase(db)
rmSync(dir, { recursive: true, force: true })

console.log(lines.join('\n'))
console.log(`\n记忆界面测试：通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
