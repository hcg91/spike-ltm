import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { installMemoryJobs } from '../lib/auto.js'

const candidate = (text, extra = {}) => ({ decision: 'save', text, kind: 'fact', scope: 'global', importance: 'medium', confidence: 'high', ...extra })
function fixture(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-reliability-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const warnings = [], requests = [], logger = { info() {}, warn(value) { warnings.push(value) } }
  const core = createCore({ dir, logger })
  let handler
  const jobs = installMemoryJobs({ core, config: { autoSynthesize: false }, ctx: { logger,
    on(name, fn) { if (name === 'session/event') handler = fn },
    llm: { async *stream(request) {
      requests.push(request)
      const result = await respond(request, requests.length, core)
      if (result.error) throw result.error
      yield { type: 'text-delta', text: typeof result.text === 'string' ? result.text : JSON.stringify(result.text) }
      yield { type: 'finish', reason: { kind: result.finish ?? 'stop' } }
    } },
  } })
  return { core, jobs, requests, warnings, dir, async turn(text) {
    handler({ requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
      snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }] }, { type: 'turn/end' })
    // Only the external model is controlled; drain real async tasks and inspect real disk writes.
    for (let i = 0; i < 30; i++) await new Promise(setImmediate)
  } }
}

test('提炼为真实样本中超过600 token的完整JSON留足预算', async t => {
  const f = fixture(t, request => request.maxTokens < 1000
    ? { text: '[{"text":', finish: 'max-tokens' }
    : { text: [candidate('用户叫周岚')] })
  await f.turn('我叫周岚。')
  assert.equal(createCore({ dir: f.dir }).inspect().items[0]?.text, '用户叫周岚')
  assert(f.requests.every(r => r.provider === 'deepseek-account'))
})

test('长度截断重试一次且不提交部分候选，重试后只写一次', async t => {
  const f = fixture(t, (request, n) => n === 1
    ? { text: [candidate('不能保存的半成品')], finish: 'max-tokens' }
    : { text: [candidate('用户叫周岚')] })
  await f.turn('我叫周岚。')
  assert.deepEqual(f.core.inspect().items.map(x => x.text), ['用户叫周岚'])
  assert.equal(f.requests.length, 2)
  assert(f.requests[1].maxTokens > f.requests[0].maxTokens)
})

test('连续截断有界停止，不把半成品保存为成功', async t => {
  const f = fixture(t, () => ({ text: [candidate('截断内容')], finish: 'max-tokens' }))
  await f.turn('稳定事实')
  assert.equal(f.requests.length, 2)
  assert.equal(f.core.inspect().items.length, 0)
  assert(f.warnings.length > 0)
})

test('鉴权失败不做长度重试，不改变账号通道', async t => {
  const f = fixture(t, () => ({ error: new Error('AUTH') }))
  await f.turn('稳定事实')
  assert.equal(f.requests.length, 1)
  assert.equal(f.core.inspect().items.length, 0)
})

test('超过4000字符仍完整提供首部、中部和尾部上下文', async t => {
  const source = '姓名在首部。' + '这是临时讨论。'.repeat(360) + '中间是朋友的经历。' + '过程记录。'.repeat(360) + '结尾仍属朋友。'
  const f = fixture(t, request => ({ text: request.messages[0].content[0].text.includes(source) ? [candidate('用户叫周岚')] : [] }))
  await f.turn(source)
  assert.equal(f.core.inspect().items.length, 1)
})

test('一段含九项稳定信息时不再静默丢掉第三项以后的事实', async t => {
  const f = fixture(t, () => ({ text: Array.from({ length: 9 }, (_, i) => candidate(`用户稳定事实${i + 1}`)) }))
  await f.turn('九项相互独立的稳定事实')
  assert.equal(f.core.inspect().items.length, 9)
})

test('过滤和去重在写入限额前执行，低置信度不写入', async t => {
  const f = fixture(t, () => ({ text: [
    ...Array.from({ length: 12 }, () => candidate('临时安排', { decision: 'ignore' })),
    candidate('不可靠猜测', { confidence: 'low' }), candidate('用户喜欢自然光'), candidate('用户喜欢自然光'),
  ] }))
  await f.turn('我喜欢自然光。')
  await f.turn('我仍喜欢自然光。')
  assert.deepEqual(f.core.inspect().items.map(x => x.text), ['用户喜欢自然光'])
})

test('重试期间人工修改导致候选过期，不得覆盖或复活', async t => {
  const f = fixture(t, (request, n, core) => {
    if (n === 1) return { text: '[]', finish: 'max-tokens' }
    core.forget('旧相机')
    return { text: [candidate('用户使用新相机', { decision: 'update', targetId: 'm1' }), candidate('迟到的新增')] }
  })
  f.core.save('旧相机')
  await f.turn('换相机了')
  assert.equal(f.core.inspect().items.length, 0)
})

test('画像也有完整输出预算并可在截断后重试，不发布部分画像', async t => {
  const f = fixture(t, (request, n) => n === 1
    ? { text: '{"sections":', finish: 'max-tokens' }
    : { text: { sections: [{ title: '背景', bullets: [{ text: '用户叫周岚', refs: ['m1'] }] }] } })
  f.core.save('用户叫周岚')
  const result = await f.jobs.synthesizeNow({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert(result)
  assert.equal(f.core.inspect().profile.sections[0].bullets[0].text, '用户叫周岚')
  assert(f.requests[0].maxTokens >= 1000)
})
