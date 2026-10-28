import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { installMemoryJobs } from '../lib/auto.js'
import { apply } from '../lib/index.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-maintenance-'))
  const cleanup = []
  t.after(() => { cleanup.forEach(fn => fn?.()); rmSync(dir, { recursive: true, force: true }) })
  return { dir, cleanup, core: createCore({ dir, logger }) }
}
const candidate = (id, text, extras = {}) => ({ decision: 'update', targetId: id, text, kind: 'fact', scope: 'global', importance: 'medium', confidence: 'high', ...extras })

function auto(core, reply, gate) {
  let handler, prompt, settled = false
  const forbidden = () => { throw new Error('后台记忆不能请求用户确认') }
  const ctx = { logger, on(name, fn) { if (name === 'session/event') handler = fn },
    question: forbidden, askUser: forbidden,
    llm: { async *stream(request) {
      prompt = request.messages[0].content[0].text
      if (gate) await gate
      yield { type: 'text-delta', text: JSON.stringify(typeof reply === 'function' ? reply(prompt) : reply) }
      yield { type: 'finish', reason: { kind: 'stop' } }
      settled = true
    } },
  }
  const jobs = installMemoryJobs({ ctx, core, config: { autoSynthesize: false } })
  return { jobs, prompt: () => prompt,
    start() { handler({ requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }), snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '相机已换为富士 X-S20，读书会改为每月第三个星期日在白榆书店。' }] } }] }, { type: 'turn/end' }) },
    async finish() { for (let i = 0; i < 20; i++) { await new Promise(r => setImmediate(r)); if (settled) return } throw new Error('模型调用未完成') },
  }
}

test('普通聊天两项明确纠正自动保存，不再等待确认，历史和旧画像同步失效', async t => {
  const { core, dir } = fixture(t)
  const a = core.save('用户使用索尼 A6700 相机').item
  const b = core.save('用户的读书会每月第二个星期日在松果茶室聚会').item
  core.setProfile({ sections: [{ title: '旧画像', bullets: [{ text: a.text, refs: [a.id] }, { text: b.text, refs: [b.id] }] }] })
  const runner = auto(core, [candidate(a.id, '用户目前使用富士 X-S20 相机'), candidate(b.id, '用户的读书会每月第三个星期日在白榆书店聚会')])
  runner.start(); await runner.finish()
  const state = createCore({ dir, logger }).inspect()
  assert.equal(state.items[0].text, '用户目前使用富士 X-S20 相机')
  assert.equal(state.items[1].text, '用户的读书会每月第三个星期日在白榆书店聚会')
  assert.equal(state.items.length, 2)
  assert.equal(state.items[0].version, 2)
  assert.equal(state.items[0].history[0].text, a.text)
  assert.equal(core.profileText(), '')
  assert.equal(runner.jobs.stats().updated, 2)
  assert(runner.prompt().includes(a.id) && runner.prompt().includes(a.text))
  assert(runner.prompt().includes('不要向用户发起确认'))
})

test('不确定、未知目标与跨作用域纠正静默跳过，后面的正常新增仍能保存', async t => {
  const { core } = fixture(t)
  const a = core.save('项目约束 A', { scope: 'project' }).item
  for (const update of [candidate(a.id, '不确定的新状态', { scope: 'project', confidence: 'low' }), candidate('m999', '未知目标'), candidate(a.id, '跨作用域的新状态')]) {
    const runner = auto(core, [update, { ...candidate(undefined, '用户喜欢自然光摄影'), decision: 'save' }])
    runner.start(); await runner.finish()
    assert.equal(core.inspect().items.find(it => it.id === a.id).text, a.text)
  }
  assert(core.inspect().items.some(it => it.text === '用户喜欢自然光摄影'))
})

test('模型提炼期间人工编辑或遗忘后，迟到的纠正不得覆盖或复活旧条目', async t => {
  for (const mode of ['edit', 'forget']) {
    const { core } = fixture(t)
    const a = core.save('旧相机').item
    let release
    const gate = new Promise(r => { release = r })
    const runner = auto(core, [candidate(a.id, '迟到的新相机')], gate)
    runner.start()
    if (mode === 'edit') core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '用户刚刚手改的相机' })
    else core.forget('旧相机')
    release(); await runner.finish()
    assert(!core.inspect().items.some(it => it.text === '迟到的新相机'))
    assert.equal(core.inspect().items.length, mode === 'edit' ? 1 : 0)
  }
})

test('主模型可按版本直接更新旧事实，维护指引不要求冲突确认，失败如实回执', async t => {
  const { dir, cleanup } = fixture(t), tools = new Map(), contexts = new Map()
  const ctx = { logger, get() {}, on() {}, effect(fn) { cleanup.push(fn()) }, tools: { register(tool) { tools.set(tool.name, tool) } }, systemPrompt: { context(entry) { contexts.set(entry.name, entry) } } }
  apply(ctx, { dir, semantic: false, autoExtract: false })
  const save = tools.get('ltm_save')
  const a = await save.execute({ text: '用户使用索尼 A6700 相机' })
  const updated = await save.execute({ id: a.id, expectedVersion: 1, text: '用户目前使用富士 X-S20 相机' })
  assert.equal(updated.ok, true)
  assert.equal(updated.id, a.id)
  assert.equal(updated.count, 1)
  assert.match((await tools.get('ltm_list').execute({})).text, /用户目前使用富士 X-S20 相机/)
  const stale = await save.execute({ id: a.id, expectedVersion: 1, text: '过期覆盖' })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /VERSION_CONFLICT/)
  assert.match((await tools.get('ltm_list').execute({})).text, /version=2/)
  const policy = contexts.get('ltm:maintenance')?.text({})
  assert.match(policy ?? '', /不要.*ask_user_question/)
  assert.match(save.description, /无需.*确认/)
})
