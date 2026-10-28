/* SQLite 记忆内核。数据读写走数据库，注入只读带版本的内存快照。 */
import { createHash } from 'node:crypto'

import { cancelScopeJobs, invalidateProfiles, bumpEpoch, bumpRevision, cachedRevision, getEpoch, transaction } from './db.js'
import { resolveScope } from './scope.js'
import { commitExtraction } from './extraction.js'

const MAX_TEXT = 2000
const MAX_ITEMS = Infinity
const MAX_INJECT_ITEMS = 4
const MAX_PROFILE_CHARS = 1600
const MAX_ENTRY_CHARS = 600
const MAX_SOURCE_ITEMS = 400

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

const KIND_SCOPE_LABEL = { global: 'global', unbound: 'project', project: 'project' }

export function createSqliteCore({ db, service, logger = console, context = {} }) {
  const snapshots = new WeakMap()
  const defaultAgent = {}
  let thresholdEntry = 0.46
  let thresholdBullet = 0.46

  const globalId = () => db.prepare("SELECT id FROM scopes WHERE kind='global' LIMIT 1").get().id
  const projectId = context.workspacePath ? resolveScope(db, context.workspacePath).id : null
  const boundIds = [globalId(), ...(projectId ? [projectId] : [])]
  const profileId = projectId ?? globalId()

  function scopeName(scopeId) {
    const row = db.prepare('SELECT kind FROM scopes WHERE id = ?').get(scopeId)
    return row === undefined ? 'global' : (KIND_SCOPE_LABEL[String(row.kind)] ?? 'global')
  }

  function allowedScopes() { return [...boundIds] }
  function agentCwd() { return context.workspacePath ?? null }

  function rowToItem(row) {
    return {
      id: String(row.id), text: String(row.text), kind: String(row.kind),
      scopeId: String(row.scope_id), scope: scopeName(String(row.scope_id)), source: String(row.source),
      importance: String(row.importance), confidence: String(row.confidence),
      status: String(row.status), version: Number(row.version), revision: Number(row.revision),
      protected: Number(row.protected) === 1,
      reason: row.reason === null || row.reason === undefined ? undefined : String(row.reason),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    }
  }

  function items(scopeIds = boundIds) {
    return service.listActive({ scopeIds }).map(rowToItem)
  }

  function activeItems(agent) {
    return items(allowedScopes(agent))
  }

  function profileOf(scopeId = profileId) {
    return service.profile(scopeId)
  }

  function revision() { return service.revision() }

  function epoch() { return boundIds.reduce((sum, id) => sum + getEpoch(db, id), 0) }


  function renderProfile(agent) {
    const profile = profileOf()
    if (profile === null) return ''
    const alive = new Set(activeItems(agent).map((it) => it.id))
    const lines = []
    let used = 0
    for (const section of profile.sections) {
      const visible = (section.bullets ?? []).filter((b) => Array.isArray(b.refs) && b.refs.length > 0 && b.refs.every((ref) => alive.has(ref)))
      if (visible.length === 0) continue
      const block = [`### ${section.title}`, ...visible.map((b) => `- ${b.text}`)].join('\n')
      if (used + block.length > MAX_PROFILE_CHARS) break
      used += block.length
      lines.push(block)
    }
    return lines.length === 0 ? '' : `<ltm-profile>\n${lines.join('\n')}\n</ltm-profile>`
  }

  function renderBriefing(query, semantic, agent) {
    const profile = profileOf()
    if (profile === null) return ''
    const alive = activeItems(agent)
    const kindById = new Map(alive.map((it) => [it.id, it.kind]))
    const bulletScores = semantic?.bullets instanceof Map ? semantic.bullets : null
    const rules = []
    const background = []
    for (const section of profile.sections) {
      for (const bullet of section.bullets ?? []) {
        const refs = (bullet.refs ?? []).filter((ref) => kindById.has(ref))
        if (!bullet.refs?.length || refs.length !== bullet.refs.length) continue
        if (refs.some((ref) => kindById.get(ref) === 'rule')) {
          if (rules.length < 5) rules.push(bullet.text)
          continue
        }
        if (bulletScores === null) continue
        if ((bulletScores.get(hashText(bullet.text)) ?? -1) >= thresholdBullet && background.length < 6) background.push(bullet.text)
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
    if (rules.length > 0) lines.push('', '可长期遵守的交互规则：', ...rules.map((text) => `- ${text}`))
    if (background.length > 0) lines.push('', '背景（按需参考，不要当成当前任务）：', ...background.map((text) => `- ${text}`))
    lines.push('</ltm-memory-briefing>')
    return lines.join('\n')
  }

  function relevant(semantic, agent) {
    const entryScores = semantic?.entries instanceof Map ? semantic.entries : null
    if (entryScores === null) return []
    return activeItems(agent)
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
    return `<ltm-memory rev="${revision()}" epoch="${epoch()}" count="${lines.length}">\n${lines.join('\n')}\n</ltm-memory>`
  }

  function refreshSnapshot(query, agent = defaultAgent, semantic) {
    const q = String(query ?? '').trim()
    const previous = snapshots.get(agent) ?? null
    const effective = q === '' && previous !== null ? previous.query : q
    const text = [renderBriefing(effective, semantic, agent), renderEntries(relevant(semantic, agent))].filter(Boolean).join('\n\n')
    const next = { revision: revision(), epoch: epoch(), text, ids: relevant(semantic, agent).map((h) => h.id), query: effective, agent }
    snapshots.set(agent, next)
    return { revision: next.revision, epoch: next.epoch, text: next.text, ids: next.ids, query: next.query }
  }

  function providerText(agent = defaultAgent) {
    const current = snapshots.get(agent)
    if (current === undefined) return ''
    if (current.revision !== cachedRevision(db)) return ''
    return current.text
  }

  function embeddingTargets() {
    const all = items()
    const targets = all.map((it) => {
      const text = it.source === 'auto' && it.kind === 'fact' ? it.text.replace(/^用户/, '我') : it.text
      return { id: it.id, text, hash: hashText(text) }
    })
    const bullets = []
    const profile = profileOf()
    if (profile !== null) {
      const alive = new Set(all.map((it) => it.id))
      for (const section of profile.sections) {
        for (const bullet of section.bullets ?? []) {
          if (!bullet.refs?.length || !bullet.refs.every((ref) => alive.has(ref))) continue
          bullets.push({ hash: hashText(bullet.text), text: bullet.text })
        }
      }
    }
    return { items: targets, bullets }
  }


  function scopeIdFor(scope) {
    if (scope === 'project') {
      if (!projectId) throw new Error('PROJECT_UNBOUND')
      return projectId
    }
    if (scope !== undefined && scope !== 'global') throw new Error('SCOPE_DENIED')
    return globalId()
  }

  function target(id, scope) {
    const row = service.get({ id, scopeIds: boundIds })
    if (!row || row.status !== 'active') throw new Error('NOT_FOUND')
    if (scope !== undefined && row.scope_id !== scopeIdFor(scope)) throw new Error('SCOPE_DENIED')
    return row
  }

  async function save(text, meta = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_TEXT')
    if (text.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
    const input = { ...meta, text, scopeId: scopeIdFor(meta.scope), sessionId: context.sessionId ?? null }
    return meta.source === 'auto' ? service.saveCandidate(input) : service.saveExplicit(input)
  }

  async function saveIfEpoch(text, expectedEpoch, meta = {}) {
    // Scope-combined guard and the actual write run in the same serialized queue turn.
    if (epoch() !== expectedEpoch) throw new Error('FORGET_EPOCH_CHANGED')
    const scopeId = scopeIdFor(meta.scope)
    return service.saveIfEpoch({ ...meta, text, scopeId, sessionId: context.sessionId ?? null }, getEpoch(db, scopeId), () => epoch() === expectedEpoch)
  }

  async function forget(topic, selection) {
    const needle = String(topic ?? '').trim()
    if (!needle) throw new Error('EMPTY_TOPIC')
    return service.enqueue(() => transaction(db, () => {
      if (selection && selection.expectedRevision !== revision()) throw new Error('VERSION_CONFLICT')
      const removed = selection ? [...new Set(selection.ids)].map(id => rowToItem(target(id))) : items().filter(it => it.text.includes(needle))
      deleteRows(removed, boundIds)
      // Even an empty match must fence candidates that have not arrived yet.
      for (const id of boundIds) bumpEpoch(db, id)
      const rev = bumpRevision(db)
      return { removed, revision: rev, epoch: epoch() }
    }))
  }

  function deleteRows(rows, affectedScopes = rows.map(r => r.scopeId)) {
    for (const row of rows) {
      const texts = [row.text, ...service.itemVersions({ id: row.id, scopeIds: boundIds }).map(v => v.text)]
      for (const text of new Set(texts)) db.prepare('INSERT OR REPLACE INTO forgotten(id, scope_id, content_hash, forgotten_at) VALUES(?,?,?,?)')
        .run(row.id + ':' + hashText(text), row.scopeId, createHash('sha256').update(text).digest('hex'), Date.now())
      db.prepare('DELETE FROM memories WHERE id=?').run(row.id)
    }
    invalidateProfiles(db, rows.map(r => r.id))
    // Pending payloads may themselves contain forgotten source text; cancel and scrub.
    cancelScopeJobs(db, affectedScopes)
  }

  async function updateItem({ id, scope, expectedVersion, text, reason = 'ui-edit' }) {
    const row = target(id, scope)
    return service.updateText({ id, scopeId: row.scope_id, expectedVersion, text, reason })
  }

  async function forgetItem({ id, scope, expectedVersion }) {
    return service.enqueue(() => transaction(db, () => {
      const row = target(id, scope)
      if (row.version !== expectedVersion) throw new Error('VERSION_CONFLICT')
      deleteRows([rowToItem(row)])
      bumpEpoch(db, row.scope_id)
      return { id, revision: bumpRevision(db) }
    }))
  }

  async function forgetItems({ ids, expectedRevision }) {
    return service.enqueue(() => transaction(db, () => {
      if (expectedRevision !== revision()) throw new Error('VERSION_CONFLICT')
      const rows = [...new Set(ids)].map(id => rowToItem(target(id)))
      deleteRows(rows)
      for (const id of new Set(rows.map(r => r.scopeId))) bumpEpoch(db, id)
      return { removed: rows.length, revision: bumpRevision(db) }
    }))
  }

  function itemVersions(id) {
    target(id)
    return service.itemVersions({ id, scopeIds: boundIds }).map(v => ({ ...v, createdAt: new Date(v.createdAt).toISOString() }))
  }

  async function setProfile(next, expectedRevision) {
    return service.setProfile({ scopeId: profileId, scopeIds: boundIds, sections: next?.sections, expectedRevision })
  }

  async function refreshSummary(next, expectedRevision) { return setProfile(next, expectedRevision) }

  async function updateSummarySections({ expectedRevision, sections: edits, changes = [] }) {
    return service.enqueue(() => transaction(db, () => {
      if (expectedRevision !== revision()) throw new Error('VERSION_CONFLICT')
      if (!Array.isArray(edits) || !edits.length) throw new Error('NOT_FOUND')
      const allowed = new Set(), changed = new Set()
      for (const edit of edits) {
        if (!Array.isArray(edit.sourceIds) || !edit.sourceIds.length) throw new Error('NOT_FOUND')
        if (typeof edit.title !== 'string' || !edit.title.trim() || typeof edit.text !== 'string' || !edit.text.trim()) throw new Error('EMPTY_TEXT')
        if (edit.text.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
        for (const id of edit.sourceIds) { target(id); allowed.add(id) }
      }
      for (const change of changes) {
        if (!allowed.has(change.id) || changed.has(change.id)) throw new Error('SCOPE_DENIED')
        if (typeof change.text !== 'string' || !change.text.trim()) throw new Error('EMPTY_TEXT')
        if (change.text.length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
        changed.add(change.id)
      }
      const rev = bumpRevision(db), at = Date.now(), old = profileOf()
      for (const change of changes) {
        const row = target(change.id), version = row.version + 1
        db.prepare('UPDATE memories SET text=?, version=?, revision=?, updated_at=? WHERE id=?').run(change.text.trim(), version, rev, at, change.id)
        db.prepare('INSERT INTO memory_versions(memory_id,version,snapshot,reason,created_at) VALUES(?,?,?,?,?)').run(change.id, version, JSON.stringify({ ...row, version, text: change.text.trim() }), 'summary-edit', at)
        db.prepare('DELETE FROM vectors WHERE memory_id=?').run(change.id)
      }
      const sections = (old?.sections ?? []).flatMap((section, index) => {
        const edit = edits.find(e => e.profileIndex === index)
        if (edit) return [{ title: edit.title, bullets: [{ text: edit.text.trim(), refs: edit.sourceIds }] }]
        const bullets = section.bullets.filter(b => !b.refs.some(id => changed.has(id)))
        return bullets.length ? [{ ...section, bullets }] : []
      })
      for (const edit of edits) if (edit.profileIndex < 0) sections.push({ title: edit.title, bullets: [{ text: edit.text.trim(), refs: edit.sourceIds }] })
      invalidateProfiles(db, [...changed])
      db.prepare('DELETE FROM profiles WHERE scope_id=?').run(profileId)
      db.prepare('INSERT INTO profiles(scope_id,version,built_at_revision,sections,updated_at) VALUES(?,?,?,?,?)').run(profileId, (old?.version ?? 0) + 1, rev, JSON.stringify(sections), at)
      for (const id of boundIds) bumpEpoch(db, id)
      return { revision: rev, committedAt: at }
    }))
  }

  async function updateSummarySection(args) { return updateSummarySections({ expectedRevision: args.expectedRevision, sections: [args], changes: args.changes }) }

  function inspect() { return { revision: revision(), epoch: epoch(), items: items(), profile: profileOf() } }

  function setThresholds(next = {}) {
    if (Number.isFinite(next.entry)) thresholdEntry = next.entry
    if (Number.isFinite(next.bullet)) thresholdBullet = next.bullet
    return { entry: thresholdEntry, bullet: thresholdBullet }
  }

  const api = {
    readVectors(model) {
      const placeholders = boundIds.map(() => '?').join(',')
      const rows = db.prepare(`SELECT v.hash,v.vec,v.dim FROM vectors v JOIN memories m ON m.id=v.memory_id WHERE v.model=? AND m.status='active' AND m.scope_id IN (${placeholders})`).all(model, ...boundIds)
      return new Map(rows.filter(r => r.vec.byteLength === r.dim * 4).map(r => {
        const bytes = Uint8Array.from(r.vec)
        return [r.hash, Array.from(new Float32Array(bytes.buffer))]
      }))
    },
    rememberVectors(targets, vectors, model, expectedRevision) {
      transaction(db, () => {
        if (expectedRevision !== revision()) throw new Error('VERSION_CONFLICT')
        const insert = db.prepare('INSERT INTO vectors(memory_id,hash,model,dim,vec,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET hash=excluded.hash,model=excluded.model,dim=excluded.dim,vec=excluded.vec,updated_at=excluded.updated_at')
        targets.forEach((item, i) => {
          if (!item.id) return // Summary vectors are inexpensive derived, in-memory data.
          target(item.id)
          const vector = Float32Array.from(vectors[i])
          insert.run(item.id, item.hash, model, vector.length, Buffer.from(vector.buffer), Date.now())
        })
      })
    },
    commitExtraction: (args) => commitExtraction({ db, core: api, service, ...args }),
    backend: 'sqlite',
    forContext: (context) => createSqliteCore({ db, service, logger, context }),
    save, saveIfEpoch, forget, updateItem, forgetItem, forgetItems, itemVersions,
    updateSummarySection, updateSummarySections, refreshSummary, setProfile,
    refreshSnapshot, embeddingTargets, providerText,
    profileText: (agent) => renderProfile(agent),
    captureEpoch: epoch,
    inspect,
    setThresholds,
    revision,
    scopeIdFor,
    allowedScopes,
    agentCwd,
  }
  return api
}
