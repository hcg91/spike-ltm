// 真实语义召回测试：真实模型 + 真实分数，不用模拟值
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore } from '../lib/core.js'
import { embed, cosine, semanticStatus } from '../lib/semantic.js'

const dir = mkdtempSync(join(tmpdir(), 'ltm-sem-'))
const core = createCore({ dir, logger: console })

const saved = {
  photo: core.save('用户喜欢城市夜景和街头纪实摄影', { kind: 'preference' }).item,
  camera: core.save('用户当前使用索尼 A6700 相机', { kind: 'fact' }).item,
  japanese: core.save('用户计划明年学习日语', { kind: 'goal' }).item,
  music: core.save('用户喜欢爵士乐', { kind: 'preference' }).item,
  club: core.save('用户组织夜航读书会，每月第二个星期日在松果茶室聚会', { kind: 'fact' }).item,
}

const CASES = [
  { name: '同义表达', q: '我今天准备出去拍照，有什么建议', want: 'photo' },
  { name: '隐含依赖', q: '想买一个长焦镜头，有什么推荐', want: 'camera' },
  { name: '相机配件', q: '给这台机器配个备用电池', want: 'camera' },
  { name: '偏好查询', q: '我以前说过自己喜欢哪种音乐', want: 'music' },
  { name: '活动查询', q: '读书会这个月哪天聚', want: 'club' },
  { name: '表面相似无关', q: '我明年想养一只猫，需要什么准备', want: null },
  { name: '跨域无关', q: '为什么飞机能够飞起来', want: null },
  { name: '跨域无关2', q: '帮我推荐几道家常菜', want: null },
  { name: '跨域无关3', q: '基金定投怎么止盈', want: null },
  { name: '健身无关', q: '我想开始力量训练，怎么安排', want: null },
]

const started = Date.now()
const targets = core.embeddingTargets()
const all = await embed([...targets.items.map((t) => t.text), ...CASES.map((c) => c.q)], console)
if (!all.ok) {
  console.log('模型不可用：', all.reason)
  process.exit(2)
}
const loadMs = Date.now() - started

const byId = new Map()
targets.items.forEach((t, i) => byId.set(t.id, all.vectors[i]))
const queryVecs = all.vectors.slice(targets.items.length)

const idToKey = Object.fromEntries(Object.entries(saved).map(([k, v]) => [v.id, k]))
let pass = 0
const rows = []

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i]
  const qv = queryVecs[i]
  const scores = new Map()
  for (const [id, v] of byId) scores.set(idToKey[id] ?? id, cosine(qv, v))

  const t0 = Date.now()
  const entries = new Map()
  for (const [id, v] of byId) entries.set(id, cosine(qv, v))
  const text = core.refreshSnapshot(c.q, undefined, { entries, bullets: new Map() }).text
  const elapsed = Date.now() - t0

  const recalled = Object.entries(saved).filter(([, item]) => text.includes(item.text)).map(([k]) => k)
  const ok = c.want === null ? recalled.length === 0 : recalled.includes(c.want)
  if (ok) pass += 1

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  rows.push({
    case: c.name,
    query: c.q,
    want: c.want ?? '无',
    recalled: recalled.join(',') || '无',
    top: ranked[0][1].toFixed(3),
    topKey: ranked[0][0],
    second: ranked[1] ? ranked[1][1].toFixed(3) : '-',
    ok,
    ms: elapsed,
  })
}

console.log(`模型状态：${semanticStatus().state}；首次加载+嵌入总耗时：${loadMs}ms\n`)
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.case.padEnd(6)} 期望=${r.want.padEnd(6)} 召回=${r.recalled.padEnd(8)} top=${r.top}(${r.topKey}) second=${r.second} ${r.ms}ms`)
  console.log(`      q: ${r.query}`)
}
console.log(`\n真实语义召回：${pass}/${CASES.length}`)
rmSync(dir, { recursive: true, force: true })
process.exit(pass === CASES.length ? 0 : 1)
