/* 用受控模型验证工具、保存、召回和后台任务；不调用账号模型。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, formatSemanticProbe, __setSemanticScorerForTest } from '../lib/index.js'
import { createCore } from '../lib/core.js'
import { semanticStatus, textHash } from '../lib/semantic.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

function makeCtx(dir) {
  const tools = new Map()
  const contexts = new Map()
  const handlers = new Map()
  return {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get(service) {
      if (service === 'dshHomePath') return (...parts) => join(dir, ...parts)
      return undefined
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      (globalThis.__ltmEffects ??= []).push(fn)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      context(entry) {
        contexts.set(entry.name, entry)
        return () => contexts.delete(entry.name)
      },
      getContextOrder() {
        return 0
      },
    },
    // 测试辅助
    _tools: tools,
    _contexts: contexts,
    _handlers: handlers,
  }
}

function userMessage(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

async function runPreStep(ctx, text) {
  const handlers = ctx._handlers.get('agent/pre-step') ?? []
  const payload = { messages: [userMessage(text)], step: 1 }
  let result
  const next = async () => ({ kind: 'enter', messages: payload.messages })
  for (const handler of handlers) {
    result = await handler(payload, next)
  }
  return result
}

function providerText(ctx) {
  const entry = ctx._contexts.get('ltm:memory')
  assert(entry !== undefined, '没有注册 ltm:memory 上下文')
  assert(typeof entry.text === 'function', '上下文 text 必须是函数')
  const value = entry.text({})
  assert(typeof value === 'string', '同步通道必须返回字符串，不能是 Promise')
  return value
}

import { openDatabase, closeDatabase } from '../lib/store/db.js'
function readItems(dir) {
  const opened = openDatabase(join(dir, 'memory.db'))
  try {
    return opened.db.prepare('SELECT * FROM memories ORDER BY created_at').all().map((row) => ({
      id: String(row.id), text: String(row.text), source: String(row.source),
      importance: String(row.importance), confidence: String(row.confidence),
      reason: row.reason === null ? '' : String(row.reason), status: String(row.status),
      version: Number(row.version), scope: String(row.scope_id),
    }))
  } finally { closeDatabase(opened.db) }
}
const workDir = mkdtempSync(join(tmpdir(), 'spike-ltm-'))
console.log(`临时目录：${workDir}\n`)


console.log('A. 工具与上下文注册')
const ctx = makeCtx(workDir)
apply(ctx, { dir: join(workDir, 'memory') })

await check('注册了 ltm_save / ltm_forget / ltm_profile / ltm_list / ltm_status', () => {
  assert(ctx._tools.has('ltm_save'), '缺少 ltm_save')
  assert(ctx._tools.has('ltm_forget'), '缺少 ltm_forget')
  assert(ctx._tools.has('ltm_profile'), '缺少 ltm_profile')
  assert(ctx._tools.has('ltm_list'), '缺少 ltm_list')
  assert(ctx._tools.has('ltm_status'), '缺少 ltm_status')
})

await check('工具参数是宿主支持的 JSON Schema 子集', () => {
  for (const [name, tool] of ctx._tools) {
    assertEqual(tool.parameters.type, 'object', `${name}.parameters.type`)
    assert(typeof tool.parameters.properties === 'object', `${name}.parameters.properties`)
    assert(typeof tool.output?.render === 'function', `${name} 缺少 output.render`)
    assertEqual(tool.output.schema.type, 'object', `${name}.output.schema.type`)
  }
})

await check('注册了注入上下文，且关闭插值', () => {
  const entry = ctx._contexts.get('ltm:memory')
  assertEqual(entry.interpolate, false, 'interpolate 必须为 false')
  assert(typeof entry.order === 'number', 'order 必须是数字')
})


console.log('\nB. 保存与回执')
let saveReceipt

await check('保存返回真实回执', async () => {
  const tool = ctx._tools.get('ltm_save')
  saveReceipt = await tool.execute({ text: '用户喜欢喝咖啡' })
  assertEqual(saveReceipt.ok, true, '保存应成功')
  assert(typeof saveReceipt.id === 'string' && saveReceipt.id !== '', '回执必须带 id')
  assert(saveReceipt.revision >= 1, '回执必须带版本号')
  assertEqual(saveReceipt.count, 1, '回执应报告当前条数')
})

await check('落盘失败时不返回成功', async () => {
  // 让记忆库目录变成"一个文件"，mkdir 必然失败
  const blocked = join(workDir, 'blocked')
  writeFileSync(blocked, 'not a directory', 'utf8')
  const ctx2 = makeCtx(workDir)
  apply(ctx2, { dir: blocked })
  const receipt = await ctx2._tools.get('ltm_save').execute({ text: '这条不该存进去' })
  assertEqual(receipt.ok, false, '写入失败必须返回 ok:false')
  assert(typeof receipt.error === 'string' && receipt.error !== '', '失败必须带错误码')
})


console.log('\nC. 注入、遗忘与失效')

await check('相关问题会注入记忆（语义分数驱动）', () => {
  const dir = join(workDir, 'inject-sem')
  const c = createCore({ dir, logger: console })
  const saved = c.save('用户喜欢喝咖啡', { kind: 'preference', source: 'explicit' })
  const semantic = { entries: new Map([[saved.item.id, 0.7]]), bullets: new Map() }
  const text = c.refreshSnapshot('我喜欢喝什么来着', undefined, semantic).text
  assert(text.includes('咖啡'), `注入文本应包含记忆，实际：${JSON.stringify(text)}`)
  assert(text.includes('<ltm-memory'), '注入文本应带标记')
})

await check('关闭语义时不做字面召回，不注入历史背景', () => {
  const dir = join(workDir, 'no-semantic')
  const c = createCore({ dir, logger: console })
  c.save('用户喜欢喝咖啡', { kind: 'preference', source: 'explicit' })
  const text = c.refreshSnapshot('我喜欢喝什么来着', undefined, null).text
  assertEqual(text, '', '没有语义分数时不应靠字面重合注入')
})

await check('无关问题不注入（避免过度个性化）', () => {
  const dir = join(workDir, 'irrelevant')
  const c = createCore({ dir, logger: console })
  const saved = c.save('用户喜欢喝咖啡', { kind: 'preference', source: 'explicit' })
  const semantic = { entries: new Map([[saved.item.id, 0.12]]), bullets: new Map() }
  const text = c.refreshSnapshot('帮我算一下 17 乘 23 等于多少', undefined, semantic).text
  assertEqual(text, '', '低相似不注入')
})

await check('遗忘后旧快照立即失效', () => {
  const dir = join(workDir, 'forget-snapshot')
  const c = createCore({ dir, logger: console })
  const saved = c.save('用户喜欢喝咖啡', { kind: 'preference', source: 'explicit' })
  const agent = { id: 'snapshot-agent' }
  const semantic = { entries: new Map([[saved.item.id, 0.7]]), bullets: new Map() }
  c.refreshSnapshot('我喜欢喝什么来着', agent, semantic)
  assert(c.providerText(agent).includes('咖啡'), '前置条件：应先注入')
  c.forget('咖啡')
  assertEqual(c.providerText(agent), '', '遗忘后旧快照必须立刻失效')
})


console.log('\nD. 后台任务与遗忘的竞争')
const coreDir = join(workDir, 'core')
const core = createCore({ dir: coreDir, logger: console })
core.save('用户在学英语')

await check('遗忘前入队的任务，遗忘后不能写回', async () => {
  const queued = core.enqueueExtraction('用户的英语学习目标是雅思 7 分')
  core.forget('英语')
  const result = await queued.run()
  assertEqual(result.ok, false, '过期任务必须被拒绝')
  assertEqual(result.error, 'FORGET_EPOCH_CHANGED', '错误码应为 FORGET_EPOCH_CHANGED')
  assertEqual(core.inspect().items.length, 0, '库里不得出现被拒绝的写入')
})

await check('遗忘之后的新任务可以正常写', async () => {
  const fresh = core.enqueueExtraction('用户喜欢喝美式咖啡')
  const result = await fresh.run()
  assertEqual(result.ok, true, '新任务应成功')
})


console.log('\nE. 重启后数据仍在')
await check('重新打开内核，条目和版本都还在', () => {
  const reopened = createCore({ dir: coreDir, logger: console })
  const state = reopened.inspect()
  assertEqual(state.items.length, 1, '应读到 1 条')
  assert(state.items[0].text.includes('美式'), '内容应一致')
  assert(state.revision >= 3, `版本号应延续（实际 ${state.revision}）`)
})


console.log('\nF. 自动提炼（用假模型，不联网）')

function makeAutoCtx(dir, { reply, gate } = {}) {
  const ctx = makeCtx(dir)
  const fakeLlm = {
    async *stream(options) {
      if (gate !== undefined) await gate.promise
      const prompt = options?.messages?.[0]?.content?.[0]?.text ?? ''
      if (options.purpose === 'spike-ltm-forget') {
        const topic = JSON.parse(prompt.match(/^问题：(.*)$/m)[1])
        const candidates = JSON.parse(prompt.split('\n候选：')[1])
        yield { type:'text-delta', text:JSON.stringify({ids:candidates.filter(c=>c.text.includes(topic)).map(c=>c.id)}) }
        yield { type:'finish', reason:{kind:'stop'} }
        return
      }
      const text = typeof reply === 'function' ? reply(prompt) : reply
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (service) => (service === 'llm' ? fakeLlm : baseGet(service))
  return ctx
}

function makeSession(text) {
  return {
    snapshotEvents: () => [{
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }],
    requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function emitTurnEnd(ctx, session) {
  for (const handler of ctx._handlers.get('session/event') ?? []) {
    handler(session, { type: 'turn/end' })
  }
}

function candidateJson(overrides = {}) {
  const base = {
    decision: 'save',
    kind: 'fact',
    text: '用户喜欢周末去爬山',
    importance: 'medium',
    confidence: 'high',
    reason: '长期爱好，影响活动建议',
    evidence: '我周末一般都去爬山',
    scope: 'global',
  }
  return JSON.stringify([{ ...base, ...overrides }])
}

await check('structured 候选：save 且重要度达标才入库', async () => {
  const dir = join(workDir, 'auto-ok')
  const ctx = makeAutoCtx(dir, { reply: candidateJson() })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我周末一般都去爬山，已经坚持两年了'))
  const ok = await waitFor(() => readItems(dir).length > 0)
  assert(ok, '两秒内没有自动写入')
  const stored = readItems(dir)[0]
  assertEqual(stored.source, 'auto', '来源应标记为 auto')
  assertEqual(stored.importance, 'medium', '重要度应被保存')
  assertEqual(stored.confidence, 'high', '置信度应被保存')
  assert(stored.reason.includes('长期'), '应保存判断理由')
  assert(stored.text.includes('爬山'), '内容应来自模型输出的候选')
})

await check('decision=ignore 时不入库', async () => {
  const dir = join(workDir, 'auto-skip')
  const ctx = makeAutoCtx(dir, { reply: candidateJson({ decision: 'ignore', text: '用户问怎么学爬山' }) })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我应该怎么开始学爬山？'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assertEqual(readItems(dir).length, 0, 'ignore 不应入库')
})

await check('importance=low 时不入库', async () => {
  const dir = join(workDir, 'auto-low')
  const ctx = makeAutoCtx(dir, { reply: candidateJson({ importance: 'low', text: '用户明天想吃面' }) })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我明天中午想吃面'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assertEqual(readItems(dir).length, 0, '低重要度不应入库')
})

await check('decision=update 未指定已有目标时静默跳过', async () => {
  const dir = join(workDir, 'auto-update')
  const ctx = makeAutoCtx(dir, { reply: candidateJson({ decision: 'update', text: '用户把读书会改到了星期六' }) })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('读书会改成星期六了'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assertEqual(readItems(dir).length, 0, '没有目标的 update 不得伪造条目')
})

await check('提炼途中发生遗忘，候选不得写回', async () => {
  const dir = join(workDir, 'auto-epoch')
  let release
  const gate = { promise: new Promise((resolve) => { release = resolve }) }
  const ctx = makeAutoCtx(dir, { reply: candidateJson(), gate })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我周末一般都去爬山，已经坚持两年了'))
  // 模型还没返回，此时用户说"忘掉"——必须走插件自己的遗忘工具，才能推进同一个内核的 epoch
  const receipt = await ctx._tools.get('ltm_forget').execute({ topic: '爬山' })
  assertEqual(receipt.ok, true, '遗忘应成功')
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assertEqual(readItems(dir).length, 0, '遗忘后不得写入候选')
})


console.log('\nG. 画像综合与删除穿透')

await check('画像从条目综合出来，并能读取', async () => {
  const dir = join(workDir, 'profile-ok')
  const ctx = makeAutoCtx(dir, {
    reply: (prompt) => (prompt.includes('长期画像')
      ? JSON.stringify({ sections: [{ title: '身份与背景', bullets: [{ text: '用户是核电上位机开发者', refs: [prompt.match(/\[([^\]]+)\] \(/)[1]] }] }] })
      : candidateJson({ text: '用户从事核电设备上位机开发' })),
  })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我在成都做核电设备的上位机开发，主要用 C# 和 WPF'))
  const saved = await waitFor(() => readItems(dir).length > 0)
  assert(saved, '条目没有写进去')

  const receipt = await ctx._tools.get('ltm_profile').execute({ rebuild: true }, { agent: { session: makeSession('') } })
  assertEqual(receipt.ok, true, '画像工具应成功')
  assert(receipt.profile.includes('核电上位机'), `画像应包含综合内容，实际：${receipt.profile}`)
  assert(receipt.profile.includes('<ltm-profile>'), '画像应带标记')
})

await check('条目被遗忘后，画像里对应内容立刻消失', async () => {
  const dir = join(workDir, 'profile-forget')
  const ctx = makeAutoCtx(dir, {
    reply: (prompt) => (prompt.includes('长期画像')
      ? JSON.stringify({ sections: [{ title: '身份与背景', bullets: [{ text: '用户是核电上位机开发者', refs: [prompt.match(/\[([^\]]+)\] \(/)[1]] }] }] })
      : candidateJson({ text: '用户从事核电设备上位机开发' })),
  })
  apply(ctx, { dir, semantic: false })
  emitTurnEnd(ctx, makeSession('我在成都做核电设备的上位机开发，主要用 C# 和 WPF'))
  await waitFor(() => readItems(dir).length > 0)
  const before = await ctx._tools.get('ltm_profile').execute({ rebuild: true }, { agent: { session: makeSession('') } })
  assert(before.profile.includes('核电上位机'), '前置条件：画像应有内容')

  const forgotten = await ctx._tools.get('ltm_forget').execute({ topic: '核电' }, { agent:{session:makeSession('')} })
  assertEqual(forgotten.ok,true,'遗忘必须返回真实成功回执')
  const after = await ctx._tools.get('ltm_profile').execute({})
  assertEqual(after.profile, '', `遗忘后画像必须为空，实际：${after.profile}`)
})

await check('显式保存只写一条，不做关键词补录', async () => {
  const dir = join(workDir, 'detail-guard')
  const ctx = makeAutoCtx(dir, { reply: '[]' })
  apply(ctx, { dir, semantic: false })
  const utterance = '我们读书会叫「夜航读书会」，固定在每个月第二个星期日在「松果茶室」聚会。'
  for (const handler of ctx._handlers.get('session/event') ?? []) {
    handler({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: utterance }] } })
  }
  const receipt = await ctx._tools.get('ltm_save').execute({
    text: '用户组织一个读书会，每个月第二个星期日聚会',
  })
  assertEqual(receipt.ok, true, '保存应成功')
  assertEqual(receipt.recovered, undefined, '不应再有"补录"字段')
  const items = readItems(dir)
  assertEqual(items.length, 1, '只允许一条：模型给什么就存什么，代码不擅自补录')
  assertEqual(items[0].source, 'explicit', '显式来源')
  assertEqual(items[0].importance, 'high', '显式保存应为高重要度')
})

await check('ltm_list 能列出全部条目', async () => {
  const dir = join(workDir, 'list-ok')
  const ctx = makeAutoCtx(dir, { reply: '[]' })
  apply(ctx, { dir, semantic: false })
  await ctx._tools.get('ltm_save').execute({ text: '用户喜欢喝岩茶' })
  const receipt = await ctx._tools.get('ltm_list').execute({})
  assertEqual(receipt.ok, true, '列取应成功')
  assertEqual(receipt.count, 1, '应有 1 条')
  assert(receipt.text.includes('岩茶'), '列表应包含条目内容')
})


console.log('\nH. 容量策略')

await check('库满时只淘汰自动条目，显式记忆不丢', () => {
  const dir = join(workDir, 'capacity')
  const c = createCore({ dir, logger: console })
  c.save('用户明确保存的偏好：结论先行', { source: 'explicit', importance: 'high' })
  for (let i = 0; i < 59; i++) c.save(`自动条目 ${i}`, { source: 'auto', importance: 'medium' })
  assertEqual(c.inspect().items.length, 60, '应先填满到 60 条')
  c.save('又一条自动条目', { source: 'auto', importance: 'medium' })
  const items = c.inspect().items
  assertEqual(items.length, 60, '容量仍为 60')
  assert(items.some((it) => it.text.includes('明确保存')), '显式记忆不得被淘汰')
  assert(!items.some((it) => it.text === '自动条目 0'), '最旧的自动条目应被淘汰')
})

await check('全是显式记忆时，库满拒绝写入而不是删旧的', () => {
  const dir = join(workDir, 'capacity-full')
  const c = createCore({ dir, logger: console })
  for (let i = 0; i < 60; i++) c.save(`显式记忆 ${i}`, { source: 'explicit', importance: 'high' })
  let threw = false
  try {
    c.save('第 61 条显式记忆', { source: 'explicit', importance: 'high' })
  } catch (error) {
    threw = error instanceof Error && error.message === 'MEMORY_FULL'
  }
  assert(threw, '库满时应抛 MEMORY_FULL')
  assertEqual(c.inspect().items.length, 60, '不得因为写入失败而丢掉旧记忆')
})


console.log('\nI. 记忆使用策略（注入内容，不调用模型）')

await check('无关问题只带规则，不带背景', () => {
  const dir = join(workDir, 'usage-unrelated')
  const c = createCore({ dir, logger: console })
  const rule = c.save('回答要简洁，先给结论', { kind: 'rule', source: 'explicit' })
  const pref = c.save('用户喜欢摄影，尤其城市夜景', { kind: 'preference', source: 'explicit' })
  c.setProfile({
    sections: [
      { title: '交互偏好', bullets: [{ text: '回答简洁，结论先行', refs: [rule.item.id] }] },
      { title: '兴趣', bullets: [{ text: '用户喜欢摄影', refs: [pref.item.id] }] },
    ],
  })
  const text = c.refreshSnapshot('为什么飞机能够飞起来').text
  assert(text.includes('不是本轮指令'), '必须声明是历史背景')
  assert(text.includes('本轮用户的明确说法优先'), '必须声明当前表达优先')
  assert(text.includes('回答简洁'), '交互规则应常驻')
  assert(!text.includes('摄影'), `无关问题不应注入兴趣背景，实际：${text}`)
})

await check('相关问题会带上背景', () => {
  const dir = join(workDir, 'usage-related')
  const c = createCore({ dir, logger: console })
  const pref = c.save('用户喜欢摄影，尤其城市夜景', { kind: 'preference', source: 'explicit' })
  c.setProfile({
    sections: [{ title: '兴趣', bullets: [{ text: '用户喜欢摄影', refs: [pref.item.id] }] }],
  })
  const semantic = { entries: new Map(), bullets: new Map([[textHash('用户喜欢摄影'), 0.8]]) }
  const text = c.refreshSnapshot('我想学摄影，有什么建议', undefined, semantic).text
  assert(text.includes('摄影'), `相关问题应注入背景，实际：${text}`)
  assert(text.includes('不得据此排除其他合理方案'), '应带使用边界')
})

await check('画像全文不再无条件注入', () => {
  const dir = join(workDir, 'usage-no-profile-tag')
  const c = createCore({ dir, logger: console })
  const rule = c.save('回答要简洁', { kind: 'rule', source: 'explicit' })
  c.setProfile({ sections: [{ title: '交互偏好', bullets: [{ text: '回答简洁', refs: [rule.item.id] }] }] })
  const text = c.refreshSnapshot('为什么飞机会飞').text
  assert(!text.includes('<ltm-profile>'), '注入的应是简报，不是画像全文')
  assert(text.includes('<ltm-memory-briefing>'), '应有简报标记')
})

await check('注入阶段不产生额外模型调用', async () => {
  const dir = join(workDir, 'no-extra-calls')
  let calls = 0
  const ctx = makeCtx(dir)
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (service) => (service === 'llm'
    ? {
        async *stream() {
          calls += 1
          yield { type: 'text-delta', text: '[]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    : baseGet(service))
  apply(ctx, { dir, semantic: false })
  await runPreStep(ctx, '随便问一个问题')
  assertEqual(calls, 0, '注入阶段不应调用模型')
  emitTurnEnd(ctx, makeSession('我平时喜欢在周末拍城市夜景'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assertEqual(calls, 1, '每轮只应有 1 次提炼调用')
})

await check('两个会话的快照互不覆盖', () => {
  const dir = join(workDir, 'per-agent')
  const c = createCore({ dir, logger: console })
  c.save('用户喜欢摄影，尤其城市夜景', { kind: 'preference', source: 'explicit' })
  const a = { id: 'session-a' }
  const b = { id: 'session-b' }
  const savedId = c.inspect().items[0].id
  const hitA = { entries: new Map([[savedId, 0.8]]), bullets: new Map() }
  const hitB = { entries: new Map([[savedId, 0.1]]), bullets: new Map() }
  c.refreshSnapshot('我想学摄影，有什么建议', a, hitA)
  c.refreshSnapshot('为什么飞机能够飞起来', b, hitB)
  assert(c.providerText(a).includes('摄影'), '会话 A 应保留自己的召回')
  assert(!c.providerText(b).includes('摄影'), '会话 B 不应拿到 A 的内容')
  // 同一轮后续 step 没有新消息时，沿用本会话上一问，不能把上下文清空
  c.refreshSnapshot('', a, hitA)
  assert(c.providerText(a).includes('摄影'), '空查询时应沿用本会话上一问')
})


console.log('\nJ. P1.5 回归（误召回 / 漏召回 / 画像残留 / 身份）')

await check('语义门控：低相似不注入（字面碰巧相同也不算）', () => {
  const dir = join(workDir, 'reg-false-positive')
  const c = createCore({ dir, logger: console })
  const saved = c.save('用户最近喜欢吃火锅', { kind: 'preference', source: 'explicit' })
  // 不依赖真实模型：直接给一个"语义不相似"的分数，验证门控生效
  const semantic = { entries: new Map([[saved.item.id, 0.2]]), bullets: new Map() }
  const text = c.refreshSnapshot('我最近想了解光学原理', undefined, semantic).text
  assert(!text.includes('火锅'), `低相似记忆被注入：${text}`)
})

await check('语义召回：高相似正常注入', () => {
  const dir = join(workDir, 'reg-true-positive')
  const c = createCore({ dir, logger: console })
  const saved = c.save('用户喜欢城市夜景摄影', { kind: 'preference', source: 'explicit' })
  const semantic = { entries: new Map([[saved.item.id, 0.82]]), bullets: new Map() }
  const text = c.refreshSnapshot('我今天准备出去拍照，有什么建议', undefined, semantic).text
  assert(text.includes('摄影'), `高相似记忆应注入：${text}`)
})

await check('画像版本竞争：生成期间记忆变了就拒绝提交', () => {
  const dir = join(workDir, 'reg-profile-race')
  const c = createCore({ dir, logger: console })
  const item = c.save('用户喜欢摄影', { kind: 'preference', source: 'explicit' })
  const baseRevision = c.inspect().revision
  const profile = { sections: [{ title: '兴趣', bullets: [{ text: '用户喜欢摄影', refs: [item.item.id] }] }] }
  // 生成期间又来一条写入
  c.save('用户喜欢登山', { kind: 'preference', source: 'explicit' })
  let rejected = false
  try {
    c.setProfile(profile, baseRevision)
  } catch (error) {
    rejected = error instanceof Error && error.message === 'PROFILE_STALE'
  }
  assert(rejected, '过期画像必须被拒绝提交')
  assertEqual(c.inspect().profile, null, '被拒绝的画像不得落盘')
})

await check('字面兜底模式：语义不可用时近义表达召回不到（已知降级行为）', () => {
  const dir = join(workDir, 'reg-known-limit')
  const c = createCore({ dir, logger: console })
  c.save('用户喜欢城市夜景摄影', { kind: 'preference', source: 'explicit' })
  c.save('用户目前使用索尼 A6700 相机', { kind: 'fact', source: 'explicit' })
  // 这条只在"语义模型不可用、退回字面匹配"时成立；
  // 语义可用时的真实效果由 test/semantic.integration.mjs 验证（5/5）。
  assertEqual(c.refreshSnapshot('我今天出去拍照，给点建议').text, '', '当前字面匹配召回不到近义词')
  assertEqual(c.refreshSnapshot('我想买个长焦镜头').text, '', '当前字面匹配召回不到近义词')
})

await check('画像残留：部分引用失效时整条不再注入', () => {
  const dir = join(workDir, 'reg-residue')
  const c = createCore({ dir, logger: console })
  const photo = c.save('用户喜欢摄影', { kind: 'preference', source: 'explicit' })
  const cam = c.save('用户有一台索尼相机', { kind: 'fact', source: 'explicit' })
  c.setProfile({
    sections: [{
      title: '摄影',
      bullets: [{ text: '用户喜欢摄影，并且拥有一台索尼相机', refs: [photo.item.id, cam.item.id] }],
    }],
  })
  const bulletScore = { entries: new Map(), bullets: new Map([[textHash('用户喜欢摄影，并且拥有一台索尼相机'), 0.9]]) }
  assert(c.refreshSnapshot('摄影', undefined, bulletScore).text.includes('索尼相机'), '前置条件：应能看到该结论')
  c.forget('喜欢摄影')
  const after = c.refreshSnapshot('摄影').text
  assert(!after.includes('喜欢摄影'), `删除后仍注入了被删内容：${after}`)
  assert(!after.includes('并且拥有'), '部分引用失效的结论不得继续注入')
})

await check('画像残留：无引用的结论不注入', () => {
  const dir = join(workDir, 'reg-empty-refs')
  const c = createCore({ dir, logger: console })
  const base = c.save('用户喜欢摄影', { kind: 'preference', source: 'explicit' })
  c.setProfile({
    sections: [{
      title: '摄影',
      bullets: [
        { text: '用户经常在周末外出拍摄', refs: [] },
        { text: '用户喜欢摄影', refs: [base.item.id] },
      ],
    }],
  })
  const semantic = {
    entries: new Map(),
    bullets: new Map([
      [textHash('用户经常在周末外出拍摄'), 0.9],
      [textHash('用户喜欢摄影'), 0.9],
    ]),
  }
  const text = c.refreshSnapshot('摄影', undefined, semantic).text
  assert(!text.includes('周末外出拍摄'), '无引用结论无法随删除失效，不得注入')
  assert(text.includes('用户喜欢摄影'), '有引用的结论应保留')
})

await check('删除后画像被标记过期', () => {
  const dir = join(workDir, 'reg-stale')
  const c = createCore({ dir, logger: console })
  const item = c.save('用户喜欢摄影', { kind: 'preference', source: 'explicit' })
  c.setProfile({ sections: [{ title: '兴趣', bullets: [{ text: '用户喜欢摄影', refs: [item.item.id] }] }] })
  const built = c.inspect().profile.builtAtRevision
  assert(Number.isInteger(built), '画像应记录生成时的版本')
  assertEqual(c.inspect().revision, built, '生成后版本应一致')
  c.forget('摄影')
  assert(c.inspect().revision > built, '删除后 revision 应超过生成版本，从而触发重算')
})

await check('宿主时序：pre-step 与注入使用同一个 agent 身份', async () => {
  const dir = join(workDir, 'reg-agent-identity')
  const ctx = makeAutoCtx(dir, { reply: '[]' })
  apply(ctx, { dir, semantic: false })
  await ctx._tools.get('ltm_save').execute({ text: '用户喜欢城市夜景摄影' })
  const agent = { id: 'agent-1' }
  for (const handler of ctx._handlers.get('agent/pre-step') ?? []) {
    await handler(
      { agent, messages: [userMessage('我想学摄影')], step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }
  const entry = ctx._contexts.get('ltm:memory')
  // 关闭语义时不得靠字面注入；这里只验证接线不抛错、不注入
  assertEqual(entry.text({ agent }), '', '语义关闭时不应注入历史背景')
})


console.log('\nK. P1.6 可靠性（降级 / 遗忘残留 / 隐私 / 状态）')

await check('语义不可用时只保留规则，不注入历史背景', () => {
  const dir = join(workDir, 'p16-degraded')
  const c = createCore({ dir, logger: console })
  const rule = c.save('回答要简洁', { kind: 'rule', source: 'explicit' })
  const pref = c.save('用户计划明年学习日语', { kind: 'goal', source: 'explicit' })
  c.setProfile({
    sections: [
      { title: '交互', bullets: [{ text: '回答简洁', refs: [rule.item.id] }] },
      { title: '计划', bullets: [{ text: '用户计划明年学习日语', refs: [pref.item.id] }] },
    ],
  })
  const text = c.refreshSnapshot('我明年想养一只猫', undefined, { degraded: true }).text
  assert(text.includes('回答简洁'), '规则应保留')
  assert(!text.includes('日语'), `降级时不得注入历史背景：${text}`)
})

await check('遗忘后语义目标集合不再包含失效内容', () => {
  const dir = join(workDir, 'p16-targets')
  const c = createCore({ dir, logger: console })
  const item = c.save('用户喜欢摄影', { kind: 'preference', source: 'explicit' })
  c.setProfile({ sections: [{ title: '兴趣', bullets: [{ text: '用户喜欢摄影', refs: [item.item.id] }] }] })
  assertEqual(c.embeddingTargets().items.length, 1, '前置：应有 1 个条目目标')
  assertEqual(c.embeddingTargets().bullets.length, 1, '前置：应有 1 个结论目标')
  c.forget('摄影')
  const targets = c.embeddingTargets()
  assertEqual(targets.items.length, 0, '条目目标应清空')
  assertEqual(targets.bullets.length, 0, '画像结论目标应清空（否则仍会被嵌入）')
})

await check('诊断行不包含用户原话', () => {
  const line = formatSemanticProbe({
    status: 'ok',
    entries: 3,
    bullets: 2,
    top: 0.61,
    ms: 12,
    model: 'Xenova/bge-small-zh-v1.5',
  })
  assert(!line.includes('用户'), '不得包含用户文本')
  assert(!line.includes('q='), '不得包含查询片段')
  const parsed = JSON.parse(line)
  assertEqual(parsed.status, 'ok', '应保留状态')
  assertEqual(parsed.entries, 3, '应保留条数')
  assertEqual(parsed.top, 0.61, '应保留分数')
})

await check('语义状态可查询，初始为 idle', () => {
  const status = semanticStatus()
  assert(['idle', 'loading', 'ready', 'failed'].includes(status.state), `未知状态：${status.state}`)
  assert(typeof status.model === 'string' && status.model !== '', '应报告模型名')
})

await check('ltm_status 能读出运行状态', async () => {
  const dir = join(workDir, 'p16-status')
  const ctx = makeAutoCtx(dir, { reply: '[]' })
  apply(ctx, { dir, semantic: false })
  await ctx._tools.get('ltm_save').execute({ text: '用户喜欢喝茶' })
  const receipt = await ctx._tools.get('ltm_status').execute({})
  assertEqual(receipt.ok, true, '状态查询应成功')
  assert(receipt.text.includes('记忆：1 条'), `应报告条数：${receipt.text}`)
  assert(receipt.text.includes('语义模型：'), '应报告模型状态')
})



console.log('\nL. 注入接线与会话隔离（受控语义分数）')

await check('同一会话的召回进入其 context，另一会话拿不到', async () => {
  const dir = join(workDir, 'wiring-isolation')
  const ctx = makeAutoCtx(dir, { reply: '[]' })
  __setSemanticScorerForTest(async (core) => {
    const items = core.inspect().items.filter((it) => it.status === 'active')
    const entries = new Map(items.map((it) => [it.id, 0.9]))
    return { ok: true, entries, bullets: new Map(), ms: 1 }
  })
  try {
    apply(ctx, { dir })
    await ctx._tools.get('ltm_save').execute({ text: '用户使用索尼 A6700 相机' })

    const agentA = { id: 'session-A' }
    const agentB = { id: 'session-B' }
    for (const handler of ctx._handlers.get('agent/pre-step') ?? []) {
      await handler(
        { agent: agentA, messages: [userMessage('我的相机是什么型号')], step: 1 },
        async () => ({ kind: 'enter', messages: [] }),
      )
    }
    const entry = ctx._contexts.get('ltm:memory')
    const textA = entry.text({ agent: agentA })
    assert(textA.includes('A6700'), `会话 A 应拿到召回，实际：${textA}`)
    assertEqual(entry.text({ agent: agentB }), '', '会话 B 不得拿到 A 的快照')

    // 本轮之后 agentB 自己问一次，也只拿到自己的结果
    for (const handler of ctx._handlers.get('agent/pre-step') ?? []) {
      await handler(
        { agent: agentB, messages: [userMessage('我的相机是什么型号')], step: 1 },
        async () => ({ kind: 'enter', messages: [] }),
      )
    }
    assert(entry.text({ agent: agentB }).includes('A6700'), '会话 B 自己问时应有自己的召回')
    assert(entry.text({ agent: agentA }).includes('A6700'), 'A 的快照不应被 B 覆盖')
  } finally {
    __setSemanticScorerForTest(null)
  }
})

for (const dispose of globalThis.__ltmEffects ?? []) { try { dispose()?.() } catch { /* 忽略 */ } }
try { rmSync(workDir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟释放 */ }

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
