/* 旧 JSON 存储兼容层。写入失败回滚；版本变化使旧快照失效。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const MAX_ITEMS = 60
const MAX_TEXT = 2000
const MAX_INJECT_ITEMS = 4
const MAX_PROFILE_CHARS = 1600
const MAX_ENTRY_CHARS = 600

const KINDS = new Set(['fact', 'preference', 'goal', 'constraint', 'rule', 'project'])

/* 仅向量召回时的默认阈值；可用 semanticMinScore / semanticMinBullet 调整。 */
const SEM_ENTRY_MIN = 0.46
const SEM_BULLET_MIN = 0.46

export function createCore({ dir, logger = console, allowedScopes = null } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createCore: dir is required')
  const file = join(dir, 'memory.json')
  const permitted = item => !allowedScopes || allowedScopes.includes(item.scope)

  function hashText(text) {
    return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
  }

  let items = []
  let seq = 0
  let revision = 0
  let epoch = 0
  let profile = null
  let loadFailure = null
  let diskContents = null
  // 阈值可覆盖：不同模型、不同语料的最优值不同，不写死成永久结论
  let thresholdEntry = SEM_ENTRY_MIN
  let thresholdBullet = SEM_BULLET_MIN

  // 每个会话（agent）一份注入快照：两个会话并行时不能互相覆盖
  let defaultSnapshot = null
  const agentSnapshots = new WeakMap()

  function snapshotFor(agent) {
    if (agent !== null && typeof agent === 'object') return agentSnapshots.get(agent) ?? null
    return defaultSnapshot
  }

  function storeSnapshot(agent, next) {
    if (agent !== null && typeof agent === 'object') agentSnapshots.set(agent, next)
    else defaultSnapshot = next
  }

  try {
    diskContents = readFileSync(file, 'utf8')
    const raw = JSON.parse(diskContents)
    if (!Array.isArray(raw?.items)) throw new Error('JSON_SHAPE_INVALID')
    if (Array.isArray(raw?.items)) {
      items = raw.items.slice(0, MAX_ITEMS).map(normalizeItem)
      for (const item of items) {
        const n = Number.parseInt(String(item.id).replace(/\D/g, ''), 10)
        if (Number.isFinite(n)) seq = Math.max(seq, n)
      }
    }
    revision = Number.isInteger(raw?.revision) ? raw.revision : 0
    epoch = Number.isInteger(raw?.epoch) ? raw.epoch : 0
    profile = normalizeProfile(raw?.profile)
  } catch (err) {
    if (err?.code !== 'ENOENT') loadFailure = err
    if (err?.code !== 'ENOENT') logger.warn?.(`spike-ltm: 读取记忆库失败，按空库启动：${String(err)}`)
  }

  function normalizeItem(item) {
    return {
      id: typeof item?.id === 'string' ? item.id : 'm0',
      text: String(item?.text ?? ''),
      kind: KINDS.has(item?.kind) ? item.kind : 'fact',
      scope: item?.scope === 'project' ? 'project' : 'global',
      source: item?.source === 'auto' ? 'auto' : 'explicit',
      status: item?.status === 'superseded' ? 'superseded' : 'active',
      importance: ['high', 'medium', 'low'].includes(item?.importance) ? item.importance : 'medium',
      confidence: ['high', 'medium', 'low'].includes(item?.confidence) ? item.confidence : 'medium',
      reason: typeof item?.reason === 'string' ? item.reason : '',
      evidence: typeof item?.evidence === 'string' ? item.evidence : '',
      createdAt: typeof item?.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      ...(Number.isSafeInteger(item?.version) && item.version > 0 ? { version: item.version } : {}),
      ...(Array.isArray(item?.history) ? { history: item.history.filter(v => Number.isSafeInteger(v.version) && typeof v.text === 'string').map(v => ({ ...v })) } : {}),
    }
  }

  function normalizeProfile(raw) {
    if (!raw || !Array.isArray(raw.sections)) return null
    const sections = []
    for (const section of raw.sections.slice(0, MAX_ITEMS + 8)) {
      const title = String(section?.title ?? '').trim()
      if (title === '') continue
      const bullets = []
      for (const bullet of Array.isArray(section.bullets) ? section.bullets.slice(0, 10) : []) {
        const text = String(bullet?.text ?? '').trim()
        if (text === '') continue
        const refs = Array.isArray(bullet?.refs)
          ? bullet.refs.filter((ref) => typeof ref === 'string').slice(0, MAX_ITEMS)
          : []
        bullets.push({ text, refs })
      }
      if (bullets.length > 0) sections.push({ title, bullets })
    }
    if (sections.length === 0) return null
    return {
      version: Number.isInteger(raw.version) ? raw.version : 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      builtAtRevision: Number.isInteger(raw.builtAtRevision) ? raw.builtAtRevision : undefined,
      sections,
    }
  }

  function persist() {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    const nextContents = JSON.stringify({ version: 2, seq, revision, epoch, items, profile }, null, 2)
    writeFileSync(tmp, nextContents, 'utf8')
    renameSync(tmp, file)
    diskContents = nextContents
  }

  function transaction(fn) {
    checkUiDisk()
    const before = {
      items: items.map((it) => ({ ...it })),
      seq,
      revision,
      epoch,
      profile: profile === null ? null : JSON.parse(JSON.stringify(profile)),
    }
    try {
      const result = fn()
      revision = before.revision + 1
      persist()
      return result
    } catch (err) {
      items = before.items
      seq = before.seq
      revision = before.revision
      epoch = before.epoch
      profile = before.profile
      throw err
    }
  }

  function save(text, meta = {}) {
    if (!permitted({ scope: meta.scope ?? 'global' })) throw new Error('PROJECT_UNBOUND')
    const clean = String(text ?? '').trim()
    if (clean === '') throw new Error('EMPTY_TEXT')
    if (clean.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')

    return transaction(() => {
      const active = items.filter((it) => it.status === 'active')
      if (active.length >= MAX_ITEMS) {
        // 容量上限只淘汰自动提炼的低优先级条目；
        // 用户明确保存的记忆永远不淘汰，库满就拒绝写入并如实报错。
        const victim = active.find((it) => it.source === 'auto' && it.importance !== 'high')
        if (victim === undefined) throw new Error('MEMORY_FULL')
        items = items.filter((it) => it !== victim)
      }
      seq += 1
      const item = {
        id: `m${seq}`,
        text: clean,
        kind: KINDS.has(meta.kind) ? meta.kind : 'fact',
        scope: meta.scope === 'project' ? 'project' : 'global',
        source: meta.source === 'auto' ? 'auto' : 'explicit',
        status: 'active',
        importance: ['high', 'medium', 'low'].includes(meta.importance) ? meta.importance : 'medium',
        confidence: ['high', 'medium', 'low'].includes(meta.confidence) ? meta.confidence : 'medium',
        reason: typeof meta.reason === 'string' ? meta.reason.slice(0, 300) : '',
        evidence: typeof meta.evidence === 'string' ? meta.evidence.slice(0, 300) : '',
        createdAt: new Date().toISOString(),
      }
      items.push(item)
      return { item, revision: revision + 1, epoch }
    })
  }

  function forget(topic, selection) {
    const needle = String(topic ?? '').trim()
    if (needle === '') throw new Error('EMPTY_TOPIC')

    return transaction(() => {
      if (selection && selection.expectedRevision !== revision) throw new Error('VERSION_CONFLICT')
      if (selection?.ids.some(id => !items.some(it => it.id === id && it.status === 'active' && permitted(it)))) throw new Error('NOT_FOUND')
      const removed = items.filter((it) => permitted(it) && (selection ? selection.ids.includes(it.id) : it.text.includes(needle)))
      const deleted = new Set(removed.map(it => it.id))
      items = items.filter((it) => !deleted.has(it.id))
      if (profile) profile = { ...profile, sections: profile.sections.map(s => ({ ...s, bullets:s.bullets.filter(b => !b.refs.some(id => deleted.has(id))) })).filter(s => s.bullets.length) }
      epoch += 1
      return { removed, revision: revision + 1, epoch }
    })
  }

  // UI 复用在线 core；读取不会迁移文件。旧条目从版本 1 开始。
  function checkUiRevision(expectedRevision) {
    if (expectedRevision !== revision) throw new Error('VERSION_CONFLICT')
    checkUiDisk()
  }

  function checkUiDisk() {
    if (loadFailure !== null) throw new Error('STORAGE_UNREADABLE')
    let current = null
    try { current = readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') throw err }
    if (current !== diskContents) throw new Error('STORAGE_CHANGED: 记忆文件已被其他进程修改，请重启应用后重试')
  }

  function uiTarget({ id, scope, expectedVersion }) {
    if (loadFailure !== null) throw new Error('STORAGE_UNREADABLE')
    const item = items.find(it => it.id === id && it.status === 'active' && permitted(it))
    if (!item) throw new Error('NOT_FOUND')
    if (item.scope !== scope) throw new Error('SCOPE_DENIED')
    if ((item.version ?? 1) !== expectedVersion) throw new Error('VERSION_CONFLICT')
    checkUiDisk()
    return item
  }

  function invalidateItem(id) {
    epoch += 1 // 已排队的提炼不能把编辑前的内容重新写回来。
    if (profile !== null) profile = { ...profile, sections: profile.sections
      .map(section => ({ ...section, bullets: section.bullets.filter(b => !b.refs.includes(id)) }))
      .filter(section => section.bullets.length > 0) }
  }

  function itemVersions(id) {
    const item = items.find(it => it.id === id && it.status === 'active' && permitted(it))
    if (!item) throw new Error('NOT_FOUND')
    const current = { version: item.version ?? 1, text: item.text, reason: 'current', createdAt: item.createdAt }
    return [current, ...(item.history ?? []).slice().reverse().map(v => ({ ...v }))]
  }

  function updateItem({ id, scope, expectedVersion, text, reason = 'ui-edit' }) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('EMPTY_TEXT')
    if (text.trim().length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
    const item = uiTarget({ id, scope, expectedVersion })
    return transaction(() => {
      const version = (item.version ?? 1) + 1
      const history = [...(item.history ?? []), { version: version - 1, text: item.text, reason, createdAt: new Date().toISOString() }]
      items = items.map(it => it.id === id ? { ...it, text: text.trim(), version, history } : it)
      invalidateItem(id)
      return { id, version, revision: revision + 1 }
    })
  }

  function forgetItem({ id, scope, expectedVersion }) {
    uiTarget({ id, scope, expectedVersion })
    return transaction(() => {
      items = items.filter(it => it.id !== id)
      invalidateItem(id)
      return { id, revision: revision + 1 }
    })
  }

  /** 一段摘要可能包含多个原子事实；必须一起校验、一次落盘。 */
  function updateSummarySection({ expectedRevision, profileIndex, sourceIds, title, text, changes }) {
    return updateSummarySections({ expectedRevision, sections: [{ profileIndex, sourceIds, title, text }], changes })
  }

  function updateSummarySections({ expectedRevision, sections: edits, changes }) {
    checkUiRevision(expectedRevision)
    if (!Array.isArray(edits) || !edits.length) throw new Error('NOT_FOUND')
    const allowed = new Set(), indexes = new Set()
    for (const { sourceIds, text, title, profileIndex } of edits) {
      if (!Array.isArray(sourceIds) || !sourceIds.length) throw new Error('NOT_FOUND')
      if (sourceIds.some(id => !items.some(it => it.id === id && it.status === 'active' && permitted(it)))) throw new Error('NOT_FOUND')
      sourceIds.forEach(id => allowed.add(id))
      if (typeof text !== 'string' || !text.trim() || typeof title !== 'string' || !title.trim()) throw new Error('EMPTY_TEXT')
      if (text.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
      if (profileIndex >= 0 && indexes.has(profileIndex)) throw new Error('SCOPE_DENIED')
      indexes.add(profileIndex)
    }
    const replacements = new Map()
    for (const change of changes) {
      if (!allowed.has(change.id) || replacements.has(change.id)) throw new Error('SCOPE_DENIED')
      if (typeof change.text !== 'string' || !change.text.trim()) throw new Error('EMPTY_TEXT')
      if (change.text.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
      replacements.set(change.id, change.text.trim())
    }
    return transaction(() => {
      const changed = new Set()
      items = items.map(it => {
        const nextText = replacements.get(it.id)
        if (nextText === undefined || nextText === it.text) return it
        changed.add(it.id)
        return { ...it, text: nextText, version: (it.version ?? 1) + 1,
          history: [...(it.history ?? []), { version: it.version ?? 1, text: it.text, reason: 'summary-edit', createdAt: new Date().toISOString() }] }
      })
      const replacement = edit => ({ title: edit.title, bullets: [{ text: edit.text.trim(), refs: [...new Set(edit.sourceIds)] }] })
      const sections = (profile?.sections ?? []).flatMap((section, index) => {
        const edit = edits.find(entry => entry.profileIndex === index)
        if (edit) return [replacement(edit)]
        const bullets = section.bullets.filter(b => !b.refs.some(id => changed.has(id)))
        return bullets.length ? [{ ...section, bullets }] : []
      })
      for (const edit of edits) if (edit.profileIndex < 0) sections.push(replacement(edit))
      profile = { version: (profile?.version ?? 0) + 1, updatedAt: new Date().toISOString(), builtAtRevision: revision + 1, sections }
      epoch += 1
      return { revision: revision + 1 }
    })
  }

  function forgetItems({ ids, expectedRevision }) {
    checkUiRevision(expectedRevision)
    const chosen = new Set(ids)
    if (!chosen.size || ids.some(id => !items.some(it => it.id === id && it.status === 'active' && permitted(it)))) throw new Error('NOT_FOUND')
    return transaction(() => {
      items = items.filter(it => !chosen.has(it.id))
      for (const id of chosen) invalidateItem(id)
      return { removed: chosen.size, revision: revision + 1 }
    })
  }

  function refreshSummary(next, expectedRevision) {
    checkUiRevision(expectedRevision)
    return setProfile(next, expectedRevision)
  }

  function setProfile(next, expectedRevision) {
    const normalized = normalizeProfile(next)
    if (normalized === null) throw new Error('INVALID_PROFILE')
    return transaction(() => {
      // 画像是在某个 revision 上生成的；提交时记忆已经变了就拒绝，
      // 否则会把过期结论标成最新，覆盖更新的结果。
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new Error('PROFILE_STALE')
      }
      const version = profile === null ? 1 : profile.version + 1
      profile = { ...normalized, version, updatedAt: new Date().toISOString(), builtAtRevision: revision + 1 }
      return { version: profile.version, sections: profile.sections.length }
    })
  }

  function enqueueExtraction(text, meta = {}) {
    const jobEpoch = epoch
    const job = async () => {
      if (jobEpoch !== epoch) return { ok: false, error: 'FORGET_EPOCH_CHANGED', jobEpoch, epoch }
      const result = save(text, { ...meta, source: 'auto' })
      return { ok: true, id: result.item.id }
    }
    return { jobEpoch, run: job }
  }

  function activeItems() {
    return items.filter((it) => it.status === 'active' && permitted(it))
  }

  /** 画像全文（给 ltm_profile 工具看），只保留引用全部有效的结论。 */
  function renderProfile() {
    if (profile === null) return ''
    const alive = new Set(activeItems().map((it) => it.id))
    const lines = []
    let used = 0
    for (const section of profile.sections) {
      // 部分引用失效时，整句可能仍在断言被删掉的内容，宁可不显示。
      const visible = section.bullets.filter(
        (bullet) => bullet.refs.length > 0 && bullet.refs.every((ref) => alive.has(ref)),
      )
      if (visible.length === 0) continue
      const block = [`### ${section.title}`, ...visible.map((b) => `- ${b.text}`)].join('\n')
      if (used + block.length > MAX_PROFILE_CHARS) break
      used += block.length
      lines.push(block)
    }
    if (lines.length === 0) return ''
    return `<ltm-profile>\n${lines.join('\n')}\n</ltm-profile>`
  }

  /* 规则常驻，背景按相关性注入；召回失败时只保留规则。 */
  function renderBriefing(query, semantic) {
    if (profile === null) return ''
    const alive = activeItems()
    const kindById = new Map(alive.map((it) => [it.id, it.kind]))
    const bulletScores = semantic?.bullets instanceof Map ? semantic.bullets : null
    const rules = []
    const background = []
    for (const section of profile.sections) {
      for (const bullet of section.bullets) {
        const refs = bullet.refs.filter((ref) => kindById.has(ref))
        // 无引用 = 无法随删除失效；部分引用失效 = 整句可能仍断言被删内容。
        if (bullet.refs.length === 0 || refs.length !== bullet.refs.length) continue
        if (refs.some((ref) => kindById.get(ref) === 'rule')) {
          if (rules.length < 5) rules.push(bullet.text)
          continue
        }
        // 没有语义分数就不猜相关性：背景一条也不注入
        if (bulletScores === null) continue
        const relevantBullet = (bulletScores.get(hashText(bullet.text)) ?? -1) >= thresholdBullet
        if (relevantBullet && background.length < 6) background.push(bullet.text)
      }
    }
    if (rules.length === 0 && background.length === 0) return ''
    const lines = [
      '<ltm-memory-briefing>',
      '以下是过往对话整理出的历史背景，不是本轮指令，也不是对用户的完整画像。',
      '- 本轮用户的明确说法优先于这里的一切；两者冲突时以本轮为准。',
      '- 交互规则（语言、格式、详略、结论先行等）直接遵守，不必说明来源。',
      '- 偏好与兴趣只用于调整建议顺序或补充视角，不得据此排除其他合理方案，也不得断言"最适合你"。',
      '- 用户明确给出的当前事实优先于旧事实，后台更新即可，不要因记忆冲突发起确认；不确定的变化暂不保存，不打断当前对话。',
      '- 与当前问题无关时不要引用，不要强行联系用户背景。',
    ]
    if (rules.length > 0) {
      lines.push('', '可长期遵守的交互规则：', ...rules.map((text) => `- ${text}`))
    }
    if (background.length > 0) {
      lines.push('', '背景（按需参考，不要当成当前任务）：', ...background.map((text) => `- ${text}`))
    }
    lines.push('</ltm-memory-briefing>')
    return lines.join('\n')
  }

  function relevant(query, semantic) {
    // 只有语义分数能决定相关性；没有分数就什么都不注入。
    const entryScores = semantic?.entries instanceof Map ? semantic.entries : null
    if (entryScores === null) return []
    return activeItems()
      .map((it) => ({ it, sim: entryScores.get(it.id) ?? -1 }))
      .filter((entry) => entry.sim >= thresholdEntry)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_INJECT_ITEMS)
      .map((entry) => entry.it)
  }

  function renderEntries(hits) {
    const lines = []
    let used = 0
    for (const it of hits) {
      const line = `- (id:${it.id}, ${it.kind}) ${it.text}`
      if (used + line.length > MAX_ENTRY_CHARS) break
      used += line.length
      lines.push(line)
    }
    if (lines.length === 0) return ''
    return `<ltm-memory rev="${revision}" epoch="${epoch}" count="${lines.length}">\n${lines.join('\n')}\n</ltm-memory>`
  }

  /** 语义层要嵌入的目标（条目 + 有效画像结论）。失效内容绝不进入。 */
  function embeddingTargets() {
    const itemsTargets = activeItems().map((it) => {
      // 自动事实约定用“用户”指本人，而用户提问用“我”。仅统一事实的向量视角，
      // 计划/偏好不替换，避免“我明年想……”句式相似盖过实际主题；原文不变。
      const text = it.source === 'auto' && it.kind === 'fact' ? it.text.replace(/^用户/, '我') : it.text
      return { id: it.id, text, hash: hashText(text) }
    })
    const bullets = []
    if (profile !== null) {
      const alive = new Set(itemsTargets.map((it) => it.id))
      for (const section of profile.sections) {
        for (const bullet of section.bullets) {
          // 只允许"全部引用仍有效"的结论进入语义索引，否则遗忘后还会被嵌入、被召回
          if (bullet.refs.length === 0 || !bullet.refs.every((ref) => alive.has(ref))) continue
          bullets.push({ hash: hashText(bullet.text), text: bullet.text })
        }
      }
    }
    return { items: itemsTargets, bullets }
  }

  function refreshSnapshot(query, agent, semantic) {
    const q = String(query ?? '').trim()
    const previous = snapshotFor(agent)
    // 同一轮里后续 step 可能没有新的用户消息，这时沿用本会话上一次的问题
    const effective = q === '' && previous !== null ? previous.query : q
    const briefing = renderBriefing(effective, semantic)
    const hits = relevant(effective, semantic)
    const entriesText = renderEntries(hits)
    const text = [briefing, entriesText].filter((part) => part !== '').join('\n\n')
    const next = { revision, epoch, text, ids: hits.map((h) => h.id), query: effective }
    storeSnapshot(agent, next)
    return next
  }

  /** 同步、无 IO；版本对不上就返回空，绝不注入可能过期的内容。 */
  function providerText(agent) {
    const current = snapshotFor(agent)
    if (current === null) return ''
    if (current.epoch !== epoch) return ''
    if (current.revision !== revision) return ''
    return current.text
  }

  return {
    save,
    forget,
    updateItem,
    forgetItem,
    itemVersions,
    updateSummarySection,
    updateSummarySections,
    forgetItems,
    refreshSummary,
    setProfile,
    enqueueExtraction,
    refreshSnapshot,
    embeddingTargets,
    providerText,
    profileText: renderProfile,
    captureEpoch: () => epoch,
    saveIfEpoch(text, expectedEpoch, meta = {}) {
      if (expectedEpoch !== epoch) throw new Error('FORGET_EPOCH_CHANGED')
      return save(text, meta)
    },
    setThresholds(next = {}) {
      if (Number.isFinite(next.entry)) thresholdEntry = next.entry
      if (Number.isFinite(next.bullet)) thresholdBullet = next.bullet
      return { entry: thresholdEntry, bullet: thresholdBullet }
    },
    inspect: () => ({
      revision,
      epoch,
      items: items.filter(permitted).map((it) => ({ ...it, ...(it.history ? { history: it.history.map(v => ({ ...v })) } : {}) })),
      profile: profile === null ? null : JSON.parse(JSON.stringify(profile)),
      snapshot: defaultSnapshot === null ? null : { ...defaultSnapshot },
    }),
  }
}
