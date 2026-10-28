/* 按可信作用域读取记忆；编辑和恢复均校验版本。 */
export const VIEW_KINDS = [
  ['fact', '个人背景与事实'],
  ['preference', '偏好'],
  ['goal', '长期目标'],
  ['project', '项目'],
  ['constraint', '约束'],
  ['rule', '交流与行为规则'],
]

const MAX_TEXT = 2000

export function listMemoryView({ db, scopeIds }) {
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) throw new Error('SCOPE_REQUIRED')
  const placeholders = scopeIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT id, text, kind, version, source, protected, scope_id, updated_at
    FROM memories
    WHERE status = 'active' AND scope_id IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(...scopeIds)
  const revisionRow = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()
  const revision = Number.parseInt(String(revisionRow?.value ?? '0'), 10) || 0

  const sections = []
  for (const [kind, title] of VIEW_KINDS) {
    const items = rows
      .filter((row) => String(row.kind) === kind)
      .map((row) => ({
        id: String(row.id),
        text: String(row.text),
        kind,
        version: Number(row.version),
        source: String(row.source),
        protected: Number(row.protected) === 1,
        scopeId: String(row.scope_id),
      }))
    if (items.length > 0) sections.push({ kind, title, items })
  }
  return { revision, total: rows.length, sections }
}

export function applyEdit({ service, id, scopeId, expectedVersion, text }) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('EMPTY_TEXT')
  if (text.trim().length > MAX_TEXT) throw new Error('TEXT_TOO_LONG')
  return service.updateText({ id, text: text.trim(), expectedVersion, scopeId, reason: 'ui-edit' })
}

export function listVersions({ db, id, scopeIds }) {
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) throw new Error('SCOPE_REQUIRED')
  const memory = db.prepare('SELECT id, scope_id FROM memories WHERE id = ?').get(id)
  if (memory === undefined) throw new Error('NOT_FOUND')
  if (!scopeIds.includes(String(memory.scope_id))) throw new Error('SCOPE_DENIED')

  const rows = db.prepare(`
    SELECT version, snapshot, reason, created_at
    FROM memory_versions WHERE memory_id = ? ORDER BY version DESC
  `).all(id)

  return rows.map((row) => {
    let text = ''
    try {
      text = String(JSON.parse(String(row.snapshot)).text ?? '')
    } catch {
      text = ''
    }
    return {
      version: Number(row.version),
      text,
      reason: row.reason === null ? '' : String(row.reason),
      createdAt: Number(row.created_at),
    }
  })
}

/** 恢复 = 读历史文本后做一次新的 CAS 写入，版本号继续递增，不回退。 */
export function restoreVersion({ service, db, id, scopeId, expectedVersion, targetVersion }) {
  const memory = db.prepare('SELECT id, scope_id FROM memories WHERE id = ?').get(id)
  if (memory === undefined) throw new Error('NOT_FOUND')
  if (String(memory.scope_id) !== String(scopeId)) throw new Error('SCOPE_DENIED')

  const row = db.prepare('SELECT snapshot FROM memory_versions WHERE memory_id = ? AND version = ?')
    .get(id, targetVersion)
  if (row === undefined) throw new Error('VERSION_NOT_FOUND')

  let text = ''
  try {
    text = String(JSON.parse(String(row.snapshot)).text ?? '')
  } catch {
    throw new Error('VERSION_SNAPSHOT_INVALID')
  }
  if (text.trim() === '') throw new Error('VERSION_SNAPSHOT_INVALID')

  return service.updateText({
    id,
    text,
    expectedVersion,
    scopeId,
    reason: `restore:v${targetVersion}`,
  })
}
