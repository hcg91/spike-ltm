// Real local embeddings, fresh synthetic JSON store, no model-generated scores.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { embed, cosine, disposeSemantic } from '../lib/semantic.js'

test('自动记忆的第三人称表述可回答第一人称短问题，且不混入第三方与无关问题', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-auto-recall-'))
  t.after(() => { disposeSemantic(); rmSync(dir, { recursive: true, force: true }) })
  const core = createCore({ dir })
  const facts = ['用户叫周岚。', '用户从事工业展馆的交互设计。', '用户长期住在宁波。',
    '用户喜欢城市夜景和街头纪实摄影', '用户当前使用索尼 A6700 相机', '用户计划明年学习日语',
    '用户喜欢爵士乐', '用户组织夜航读书会，每月第二个星期日在松果茶室聚会']
  const kinds = ['fact', 'fact', 'fact', 'preference', 'fact', 'goal', 'preference', 'fact']
  facts.forEach((text, i) => core.save(text, { source: 'auto', kind: kinds[i] }))
  core.save(facts[0], { source: 'explicit' })
  const targets = core.embeddingTargets()
  const documents = await embed(targets.items.map(it => it.text))
  assert(documents.ok, documents.reason)
  // Host caches by target hash: explicit text must not overwrite an auto fact's
  // vector when their displayed text matches but embedding perspectives differ.
  const cache = new Map(targets.items.map((it, i) => [it.hash, documents.vectors[i]]))
  const cases = [
    ['我叫什么名字？', '周岚'], ['我从事什么工作？', '交互设计'], ['我住在哪里？', '宁波'],
    ['这个故事的主角叫什么名字？', null], ['你能做什么工作？', null],
    ['帮我推荐几道家常菜', null], ['为什么飞机能够飞起来', null],
    ['我明年想养一只猫，需要什么准备', null], ['基金定投怎么止盈', null], ['我想开始力量训练，怎么安排', null],
    ['我今天准备出去拍照，有什么建议', '摄影'], ['想买一个长焦镜头，有什么推荐', 'A6700'],
    ['我以前说过自己喜欢哪种音乐', '爵士乐'], ['读书会这个月哪天聚', '松果茶室'],
  ]
  const failures = []
  for (const [question, expected] of cases) {
    // Same separation as the host: cached documents and a separately embedded query.
    const query = await embed([question])
    assert(query.ok, query.reason)
    const entries = new Map(targets.items.map(it => [it.id, cosine(cache.get(it.hash), query.vectors[0])]))
    const result = core.refreshSnapshot(question, {}, { entries, bullets: new Map() }).text
    if (expected ? !result.includes(expected) : result !== '') failures.push({ question, expected, result })
  }
  assert.deepEqual(failures, [])
  assert.deepEqual(createCore({ dir }).inspect().items.map(it => it.text), [...facts, facts[0]], '检索不能改写原始事实')
})
