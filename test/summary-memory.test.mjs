import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { createSummaryService } from '../lib/memory-summary.js'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-summary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const core = createCore({ dir })
  const a = core.save('用户做 C# 开发', { kind: 'project' }).item
  const b = core.save('用户维护 WPF 项目', { kind: 'project' }).item
  const c = core.save('用户喜欢摄影', { kind: 'preference' }).item
  core.setProfile({ sections: [
    { title: '工作与项目', bullets: [{ text: '用户从事 C# 和 WPF 开发。', refs: [a.id, b.id] }] },
    { title: '兴趣', bullets: [{ text: '用户喜欢摄影。', refs: [c.id] }] },
  ] })
  return { dir, core, a, b, c }
}

test('点击整段后的多条来源更新是一次事务，其他段落保持不变', t => {
  const { core, a, b, c } = setup(t)
  const before = core.inspect()
  core.updateSummarySection({ expectedRevision: before.revision, profileIndex: 0,
    sourceIds: [a.id, b.id], changes: [{ id: b.id, text: '用户改为维护 Avalonia 项目' }],
    title: '工作与项目', text: '用户从事 C# 开发，改为维护 Avalonia 项目。' })
  const after = core.inspect()
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.items.find(x => x.id === b.id).version, 2)
  assert.deepEqual(after.items.find(x => x.id === c.id), before.items.find(x => x.id === c.id))
  assert.deepEqual(after.profile.sections[1], before.profile.sections[1])
  assert.match(core.profileText(), /Avalonia/)
  assert(!core.profileText().includes('WPF'))
})

test('段落跨目标写入和过期提交均拒绝，文件保持原样', t => {
  const { core, dir, a, b, c } = setup(t)
  const before = readFileSync(join(dir, 'memory.json'), 'utf8')
  const args = { expectedRevision: core.inspect().revision, profileIndex: 0, sourceIds: [a.id, b.id], title: '工作与项目', text: '更正后' }
  assert.throws(() => core.updateSummarySection({ ...args, changes: [{ id: c.id, text: '错误目标' }] }), /SCOPE_DENIED/)
  assert.throws(() => core.updateSummarySection({ ...args, expectedRevision: 0, changes: [] }), /VERSION_CONFLICT/)
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before)
})

test('删除选中段落只删除其来源，未选中段落保留', t => {
  const { core, a, b, c } = setup(t)
  core.forgetItems({ ids: [a.id, b.id], expectedRevision: core.inspect().revision })
  assert.deepEqual(core.inspect().items.map(x => x.id), [c.id])
  assert(!core.profileText().includes('WPF'))
  assert(core.profileText().includes('摄影'))
})

test('整段模型建议只收到本段来源，多轮带上一版草稿，点击更新才落盘', async t => {
  const { core, dir, b, c } = setup(t), prompts = []
  const service = createSummaryService({ core, callModel: async prompt => {
    prompts.push(prompt)
    return JSON.stringify({ reply: '可以这样修改', text: '用户从事 C# 和 Avalonia 开发。', changes: [{ id: b.id, text: '用户维护 Avalonia 项目' }] })
  } })
  const view = service.snapshot(), section = view.sections[0]
  const before = readFileSync(join(dir, 'memory.json'), 'utf8')
  const request = { sessionId: 's', sectionId: section.id, expectedRevision: view.revision, messages: [{ role: 'user', content: 'WPF 改成 Avalonia' }] }
  const first = await service.propose(request)
  assert(!prompts[0].includes('摄影'))
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before)
  const second = await service.propose({ ...request, previousToken: first.proposal.token, messages: [{ role: 'user', content: '用更简短的话' }] })
  assert(prompts[1].includes('用户从事 C# 和 Avalonia 开发。'))
  await assert.rejects(() => service.apply({ token: second.proposal.token, sessionId: 'other' }), /PROPOSAL_EXPIRED/)
  await service.apply({ token: second.proposal.token, sessionId: 's' })
  assert.equal(core.inspect().items.find(x => x.id === c.id).text, '用户喜欢摄影')
  await assert.rejects(() => service.apply({ token: first.proposal.token, sessionId: 's' }), /VERSION_CONFLICT/)
})

test('恶意跨段来源、过期模型响应均不得保存', async t => {
  const { core, c } = setup(t)
  const bad = createSummaryService({ core, callModel: async () => JSON.stringify({ text: '错误', changes: [{ id: c.id, text: '改别的' }] }) })
  const view = bad.snapshot()
  await assert.rejects(bad.propose({ sectionId: view.sections[0].id, expectedRevision: view.revision }), /SCOPE_DENIED/)
  const late = createSummaryService({ core, callModel: async () => { core.save('并发新条目'); return '{"text":"过期","changes":[]}' } })
  await assert.rejects(late.propose({ sectionId: view.sections[0].id, expectedRevision: view.revision }), /VERSION_CONFLICT/)
})

test('更新摘要只归纳现有内容，遗漏来源时不覆盖，取消后不落盘', async t => {
  const { core, dir, a, b, c } = setup(t)
  const beforeItems = core.inspect().items
  const service = createSummaryService({ core, callModel: async () => JSON.stringify({ sections: [{ title: '新摘要', bullets: [{ text: '完整合成总结', refs: [a.id, b.id, c.id] }] }] }) })
  await service.refresh({ expectedRevision: core.inspect().revision })
  assert.deepEqual(core.inspect().items, beforeItems)
  assert.match(core.profileText(), /完整合成总结/)
  const contents = readFileSync(join(dir, 'memory.json'), 'utf8')
  const bad = createSummaryService({ core, callModel: async () => JSON.stringify({ sections: [{ title: '遗漏', bullets: [{ text: '只剩一条', refs: [a.id] }] }] }) })
  await assert.rejects(bad.refresh({ expectedRevision: core.inspect().revision }), /MODEL_INVALID/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(service.refresh({ expectedRevision: core.inspect().revision, signal: cancelled.signal }), /abort/i)
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), contents)
})

test('同名且引用相同的两段仍拥有不同的选中标识', t => {
  const { core, a } = setup(t)
  core.setProfile({ sections: [
    { title: '工作', bullets: [{ text: '第一段', refs: [a.id] }] },
    { title: '工作', bullets: [{ text: '第二段', refs: [a.id] }] },
  ] })
  const service = createSummaryService({ core, callModel: async () => '' })
  const sections = service.snapshot().sections
  assert.notEqual(sections[0].id, sections[1].id)
})

test('不选段落可全局对话，跨段修改一次保存，多轮保留整份建议', async t => {
  const { core, dir, b, c } = setup(t)
  const prompts = []
  let view
  const service = createSummaryService({ core, callModel: async prompt => {
    prompts.push(prompt)
    return JSON.stringify({ reply: '已整理两处修改，等待确认', sections: [
      { id: view.sections[0].id, text: '用户用 C# 和 Avalonia 开发。' },
      { id: view.sections[1].id, text: '用户喜欢徒步。' },
    ], changes: [{ id: b.id, text: '用户维护 Avalonia 项目' }, { id: c.id, text: '用户喜欢徒步' }] })
  } })
  view = service.snapshot()
  const before = readFileSync(join(dir, 'memory.json'), 'utf8')
  const args = { sessionId: 's', expectedRevision: view.revision, messages: [{ role: 'user', content: '工作改用 Avalonia，兴趣改成徒步' }] }
  const first = await service.propose(args)
  assert.equal(first.proposal.sections.length, 2)
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before)
  const second = await service.propose({ ...args, previousToken: first.proposal.token, messages: [{ role: 'user', content: '再简短一点' }] })
  assert(prompts[1].includes('用户喜欢徒步。'))
  assert(prompts[0].includes('工作与项目') && prompts[0].includes('兴趣'))
  await service.apply({ token: second.proposal.token, sessionId: 's' })
  assert.equal(core.inspect().revision, view.revision + 1)
  assert(core.profileText().includes('Avalonia'))
  assert(core.profileText().includes('徒步'))
})

test('全局聊天只回答问题不落盘，并拒绝伪造段落', async t => {
  const { core, dir } = setup(t)
  let mode = 'chat'
  const service = createSummaryService({ core, callModel: async () => mode === 'chat'
    ? '{"reply":"可以直接问我记住了什么。","sections":[],"changes":[]}'
    : '{"reply":"错","sections":[{"id":"foreign","text":"越界"}],"changes":[]}' })
  const args = { sessionId: 's', expectedRevision: core.inspect().revision, messages: [] }
  const before = readFileSync(join(dir, 'memory.json'), 'utf8')
  const response = await service.propose(args)
  assert.equal(response.proposal, null)
  assert.match(response.reply, /直接问/)
  mode = 'bad'
  await assert.rejects(service.propose(args), /SCOPE_DENIED/)
  assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before)
})
