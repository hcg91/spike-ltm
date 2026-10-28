import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as host from '../lib/memory-ui-host.js'
import { buildPrompt, createEditProposer } from '../lib/memory-edit.js'

test('多轮提示包含上一版完整建议，而不只是助手简短回复', () => {
  assert.match(buildPrompt({ currentText: '原文', messages: [{ role: 'user', content: '缩短上一版' }], draft: '上轮完整修改方案' }), /上轮完整修改方案/)
})

test('模型调用从指定活跃会话解析 provider/model，不接受请求自带的模型配置', async () => {
  let received
  const ctx = { sessions: { get: id => id === 'session-test' ? { requestHeader: () => ({ config: { provider: 'verified-provider', model: 'verified-model' } }) } : undefined },
    llm: { async *stream(options) { received = options; yield { type: 'text-delta', text: '{"reply":"好","text":"新文本"}' }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
  const call = host.makeModelCaller(ctx)
  await call('prompt', { sessionId: 'session-test' })
  assert.equal(received.provider, 'verified-provider')
  assert.equal(received.model, 'verified-model')
  assert(received.signal instanceof AbortSignal)
  await assert.rejects(call('prompt', { sessionId: 'unknown' }), /MODEL_ROUTE_UNAVAILABLE/)
})

test('没有会话也能对话修改：从宿主实时默认配置读取账号通道，不接受客户端通道覆盖', async () => {
  const calls = []
  let selected = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const ctx = { get: name => name === 'agentDefaultModel' ? { currentSelection: () => selected } : undefined,
    sessions: { get() { throw new Error('全局记忆不能依赖某个会话') } },
    llm: { async *stream(options) { calls.push(options); yield { type: 'text-delta', text: '{"reply":"可以修改"}' }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
  const call = host.makeModelCaller(ctx)
  await call('全局修改', { provider: 'deepseek-official', model: 'forged' })
  assert.equal(calls[0].provider, 'deepseek-account')
  assert.equal(calls[0].model, 'deepseek-flash')
  selected = { provider: 'deepseek-account', model: 'next-account-model' }
  await call('下一轮修改')
  assert.equal(calls[1].model, 'next-account-model', '每次读取实时默认值')
})

test('默认模型缺失时明确失败；错误会话不能退回默认值或官方 API', async () => {
  let called = false
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }, sessions: { get() {} }, llm: { async *stream() { called = true } } }
  const call = host.makeModelCaller(ctx)
  await assert.rejects(call('修改', { sessionId: 'unknown' }), /MODEL_ROUTE_UNAVAILABLE/)
  delete ctx.agentDefaultModel
  await assert.rejects(call('修改'), /MODEL_ROUTE_UNAVAILABLE/)
  assert.equal(called, false)
})

test('即使模型挂起，超时与主动取消仍结束等待，并传递中止信号', async () => {
  let signal
  const ctx = { sessions: { get: () => ({ requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }) },
    llm: { async *stream(options) { signal = options.signal; await new Promise(() => {}) } } }
  const call = host.makeModelCaller(ctx, { timeoutMs: 15 })
  await assert.rejects(call('prompt', { sessionId: 's' }), /MODEL_TIMEOUT/)
  assert.equal(signal.aborted, true)
  const abort = new AbortController()
  const pending = call('prompt', { sessionId: 's', signal: abort.signal })
  abort.abort()
  await assert.rejects(pending, /MODEL_CANCELLED/)
})

test('提案返回前再次校验版本，拒绝模型运行期间的并发更新', async () => {
  let version = 1
  const propose = createEditProposer({ read: () => ({ id: 'a', text: 'old', version }), callModel: async () => { version++; return '{"reply":"好","text":"草稿"}' } })
  await assert.rejects(propose({ id: 'a', scopeIds: ['g'], expectedVersion: 1, messages: [] }), /VERSION_CONFLICT/)
})
