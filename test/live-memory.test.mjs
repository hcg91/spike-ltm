import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { createLiveAdapter, LIVE_SCOPES } from '../lib/memory-live-adapter.js'
import { registerMemoryUiRoutes } from '../lib/memory-ui-routes.js'
import { createEditProposer } from '../lib/memory-edit.js'
import { apply } from '../lib/index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-live-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const core = createCore({ dir })
  const a = core.save('合成记忆 A', { kind: 'rule' }).item
  const b = core.save('合成记忆 B', { kind: 'project', scope: 'project' }).item
  return { dir, core, a, b }
}

test('真实存储适配基础：单项 CAS、历史持久化、其他条目不变', t => {
  const { dir, core, a, b } = fixture(t)
  const old = core.inspect().items.find(x => x.id === b.id)
  const result = core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '修改后的 A' })
  assert.equal(result.version, 2)
  assert.deepEqual(core.inspect().items.find(x => x.id === b.id), old)
  assert.throws(() => core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '过期' }), /VERSION_CONFLICT/)
  const disk = createCore({ dir })
  assert.equal(disk.inspect().items.find(x => x.id === a.id).text, '修改后的 A')
  assert.deepEqual(disk.itemVersions(a.id).map(x => x.text), ['修改后的 A', '合成记忆 A'])
})

test('修改原子失效相关总结、旧注入与后台任务，不删除无关总结', t => {
  const { core, a, b } = fixture(t)
  core.setProfile({ sections: [{ title: '总结', bullets: [{ text: '旧 A 总结', refs: [a.id] }, { text: 'B 总结', refs: [b.id] }] }] })
  const epoch = core.captureEpoch()
  core.refreshSnapshot('', null, { entries: new Map([[a.id, 1]]) })
  core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '新 A' })
  assert(!core.profileText().includes('旧 A'))
  assert(core.profileText().includes('B 总结'))
  assert.equal(core.providerText(), '')
  assert.throws(() => core.saveIfEpoch('迟到任务', epoch), /EPOCH/)
})

test('读历史不写盘，错误作用域/空文本不落盘，按 id 遗忘不误删相似条目', t => {
  const { dir, core, a, b } = fixture(t)
  const path = join(dir, 'memory.json')
  const before = readFileSync(path, 'utf8')
  core.itemVersions(a.id)
  assert.throws(() => core.updateItem({ id: b.id, scope: 'global', expectedVersion: 1, text: '禁止' }), /SCOPE_DENIED/)
  assert.throws(() => core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '' }), /EMPTY_TEXT/)
  assert.equal(readFileSync(path, 'utf8'), before)
  core.forgetItem({ id: a.id, scope: 'global', expectedVersion: 1 })
  assert.deepEqual(core.inspect().items.map(x => x.id), [b.id])
})

test('live HTTP 链路：真实 core 读写，预览不落盘，项目隔离，恢复产生新版本', async t => {
  const { dir, core, a, b } = fixture(t)
  const adapter = createLiveAdapter(core), routes = []
  const dispose = registerMemoryUiRoutes({ ctx: { connection: { fetch: { register: r => { routes.push(r); return () => {} } } } },
    adapter, allowlist: LIVE_SCOPES, logger: {}, propose: createEditProposer({ read: adapter.read, callModel: async () => '{"reply":"建议","text":"修改后 A"}' }) })
  t.after(dispose)
  async function call(path, body) {
    const r = routes.find(r => r.path.endsWith('/' + path))
    return (await r.fetch(new Request('http://test/' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}))).json()
  }
  const before = readFileSync(join(dir, 'memory.json'), 'utf8')
  assert.equal((await call('status')).value.source, 'live')
  assert.equal((await call('list', { label: '全局' })).value.total, 1)
  assert.equal((await call('propose', { label: '全局', id: a.id, expectedVersion: 1 })).value.proposedText, '修改后 A')
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before)
  assert.equal((await call('edit', { label: '全局', id: b.id, expectedVersion: 1, text: '误写项目' })).error.code, 'SCOPE_DENIED')
  assert.equal((await call('edit', { label: '全局', id: a.id, expectedVersion: 1, text: '修改后 A' })).value.version, 2)
  assert.equal((await call('restore', { label: '全局', id: a.id, expectedVersion: 2, targetVersion: 1 })).value.version, 3)
  assert.equal(core.inspect().items.find(x => x.id === a.id).text, '合成记忆 A')
})

test('外部改动不能被界面覆盖或产生虚假成功', t => {
  const { dir, core, a } = fixture(t)
  const path = join(dir, 'memory.json'), original = readFileSync(path, 'utf8')
  writeFileSync(path, original + '\n')
  assert.throws(() => core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '覆盖' }), /STORAGE_CHANGED/)
  assert.equal(readFileSync(path, 'utf8'), original + '\n')
})

test('总结按范围过滤，编辑后可看到最新条目而非旧归纳', t => {
  const { core, a, b } = fixture(t)
  core.setProfile({ sections: [{ title: '测试总结', bullets: [{ text: 'A 的旧归纳', refs: [a.id] }, { text: 'B 的私有归纳', refs: [b.id] }] }] })
  const adapter = createLiveAdapter(core)
  assert(!JSON.stringify(adapter.list(['global']).summary).includes('B 的私有归纳'))
  core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '最新已保存内容' })
  const summary = JSON.stringify(adapter.list(['global']).summary)
  assert(!summary.includes('A 的旧归纳'))
  assert(summary.includes('最新已保存内容'))
})

test('插件入口接线：工具保存与弹窗编辑共享同一个在线 core，未启用 SQLite 演示数据', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-host-wiring-'))
  const routes = [], tools = new Map(), cleanups = []
  const ctx = { logger: {}, get: name => ctx[name], on: () => () => {},
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    inject: (_, fn) => fn(ctx),
    tools: { register: d => { tools.set(d.name, d); return () => {} } },
    systemPrompt: { context() {} },
    connection: { fetch: { register: r => { routes.push(r); return () => {} } } },
  }
  t.after(() => { cleanups.forEach(fn => fn()); rmSync(dir, { recursive: true, force: true }) })
  apply(ctx, { dir, uiSource: 'live', semantic: false, autoExtract: false })
  const saved = await tools.get('ltm_save').execute({ text: '插件工具保存的合成记录' })
  assert.equal(saved.ok, true)
  const route = routes.find(r => r.path.endsWith('/edit'))
  assert(route, '入口必须注册线上路由')
  const response = await route.fetch(new Request('http://test/api/spike-ltm/ui/edit', { method: 'POST', body: JSON.stringify({ label: '全局', id: saved.id, expectedVersion: 1, text: '由弹窗修改后的合成记录' }) }))
  assert.equal((await response.json()).ok, true)
  const list = await tools.get('ltm_list').execute({})
  assert.match(list.text, /由弹窗修改后的合成记录/)
  assert.equal(list.count, 1)
})
