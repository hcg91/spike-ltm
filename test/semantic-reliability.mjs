// 真实子进程可靠性测试：不模拟，真的起进程、真的杀
import { embed, semanticStatus, resetSemanticForTest, abandonPending } from '../lib/semantic.js'

const results = []
let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    results.push(`PASS ${name}${detail ? `（${detail}）` : ''}`)
  } catch (error) {
    fail += 1
    results.push(`FAIL ${name}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. 正常推理
await check('正常推理可用', async () => {
  resetSemanticForTest()
  const result = await embed(['用户喜欢城市夜景摄影', '我今天出去拍照'], console, 60000)
  assert(result.ok, `应成功，实际：${result.reason}`)
  assert(result.vectors.length === 2, '应返回 2 个向量')
  const status = semanticStatus()
  assert(status.state === 'ready', `状态应为 ready，实际 ${status.state}`)
  return `pid=${status.pid}`
})

// 2. 子进程被外部杀掉：后续请求必须失败但不崩进程
await check('子进程被杀后主进程存活且返回失败', async () => {
  resetSemanticForTest()
  const first = await embed(['预热'], console, 60000)
  assert(first.ok, '预热应成功')
  const pid = semanticStatus().pid
  assert(Number.isInteger(pid), '应有子进程 pid')
  process.kill(pid) // 真实 kill
  await sleep(300)
  const second = await embed(['再次请求'], console, 5000)
  assert(!second.ok, '子进程死亡后应返回失败而不是挂起')
  assert(typeof second.reason === 'string' && second.reason !== '', '应给出失败原因')
  return `reason=${second.reason.slice(0, 40)}`
})

// 3. 连续超时：每次都要在限定时间内返回失败，不能堆积
await check('连续超时都返回失败且不挂起', async () => {
  resetSemanticForTest()
  const started = Date.now()
  for (let i = 0; i < 3; i++) {
    const result = await embed(['超时测试'], console, 1)
    assert(!result.ok, `第 ${i + 1} 次应超时`)
  }
  const elapsed = Date.now() - started
  assert(elapsed < 30000, `三次都应及时返回，实际 ${elapsed}ms`)
  return `${elapsed}ms`
})

// 4. 并发请求串行化，不互相踩
await check('并发请求都被处理', async () => {
  resetSemanticForTest()
  const [a, b] = await Promise.all([
    embed(['并发一：摄影'], console, 60000),
    embed(['并发二：读书会'], console, 60000),
  ])
  assert(a.ok && b.ok, `并发应都成功：${a.reason ?? 'ok'} / ${b.reason ?? 'ok'}`)
  return `pid=${semanticStatus().pid}`
})

// 5. 模型不可用：必须进入 failed，且带可诊断原因
await check('模型加载失败进入 failed 而不是 loading', async () => {
  resetSemanticForTest()
  const previous = process.env.LTM_EMBEDDING_MODEL
  process.env.LTM_EMBEDDING_MODEL = 'Xenova/definitely-not-a-real-model-xyz'
  try {
    const result = await embed(['失败测试'], console, 60000)
    assert(!result.ok, '应失败')
    const status = semanticStatus()
    assert(status.state === 'failed', `状态应为 failed，实际 ${status.state}`)
    assert(status.lastError !== null, '应记录失败原因')
    return `kind=${status.lastErrorKind}`
  } finally {
    if (previous === undefined) delete process.env.LTM_EMBEDDING_MODEL
    else process.env.LTM_EMBEDDING_MODEL = previous
    resetSemanticForTest()
  }
})

// 6. 不存在的解释器：回退候选，不应抛未处理异常
await check('解释器不存在时回退而不崩溃', async () => {
  resetSemanticForTest()
  const previous = process.env.LTM_NODE_BIN
  process.env.LTM_NODE_BIN = 'definitely-not-a-node-binary'
  try {
    const result = await embed(['回退测试'], console, 60000)
    assert(result.ok, `应回退到真实 node 并成功，实际：${result.reason}`)
    return 'fallback ok'
  } finally {
    if (previous === undefined) delete process.env.LTM_NODE_BIN
    else process.env.LTM_NODE_BIN = previous
    resetSemanticForTest()
  }
})


// 7. 推理中重置：等待请求必须立即结束，旧事件不能把 idle 改回 failed
await check('推理中重置会立即结束请求且状态不被污染', async () => {
  resetSemanticForTest()
  const pendingRequest = embed(['重置测试文本'], console, 60000)
  await sleep(30)
  const started = Date.now()
  resetSemanticForTest()
  const result = await pendingRequest
  assert(!result.ok, '重置后旧请求应返回失败')
  const elapsed = Date.now() - started
  assert(elapsed < 1000, `应立即结束，实际 ${elapsed}ms`)
  await sleep(500)
  assertEqual(semanticStatus().state, 'idle', '旧事件不得把状态改回 failed')
  assertEqual(semanticStatus().queued, 0, '队列计数应归零')
  return `${elapsed}ms`
})

// 8. 队列计数：成功 / 失败 / 并发后都必须归零
await check('队列计数在成功、失败和并发后都归零', async () => {
  resetSemanticForTest()
  const ok = await embed(['队列成功'], console, 60000)
  assert(ok.ok, '应成功')
  assertEqual(semanticStatus().queued, 0, '成功后应为 0')

  resetSemanticForTest()
  const timeouts = await Promise.all([
    embed(['超时一'], console, 1),
    embed(['超时二'], console, 1),
  ])
  assert(timeouts.every((r) => !r.ok), '应都失败')
  assertEqual(semanticStatus().queued, 0, '失败后应为 0')

  resetSemanticForTest()
  const both = await Promise.all([embed(['并发甲'], console, 60000), embed(['并发乙'], console, 60000)])
  assert(both.every((r) => r.ok), '并发应都成功')
  assertEqual(semanticStatus().queued, 0, '并发后应为 0')
  return 'ok'
})

// 9. 空队列放弃：不应误判
await check('没有等待请求时放弃是无操作', async () => {
  resetSemanticForTest()
  assertEqual(abandonPending('noop', console), false, '空队列应返回 false')
  return 'noop'
})

// 10. 预热期放弃：立即返回失败，但后台继续预热并最终 ready
await check('预热期放弃后后台完成加载，状态变为 ready', async () => {
  resetSemanticForTest()
  const pendingRequest = embed(['预热期放弃'], console, 60000)
  await sleep(5)
  const had = abandonPending('test-loading', console)
  assert(had, '应有等待中的请求')
  const result = await pendingRequest
  assert(!result.ok, '宿主应立刻拿到失败')
  await sleep(4000)
  assertEqual(semanticStatus().state, 'ready', `后台预热应完成，实际 ${semanticStatus().state}`)
  return semanticStatus().state
})

console.log(results.join('\n'))
console.log(`\n真实子进程测试：通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
