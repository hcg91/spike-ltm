/* 按规范化路径绑定持久项目 ID；不使用目录名推断身份。 */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureGlobalScope } from './db.js'

export function normalizeWorkspacePath(input) {
  if (typeof input !== 'string' || input.trim() === '') return null
  let absolute = resolve(input)
  try {
    absolute = realpathSync.native ? realpathSync.native(absolute) : realpathSync(absolute)
  } catch {
    // 路径可能尚未创建：保留 resolve 结果
  }
  if (process.platform === 'win32') absolute = absolute.toLowerCase()
  absolute = absolute.replace(/[\\/]+$/, '')
  return absolute === '' ? null : absolute
}

export function pathKeyToLabel(pathKey) {
  if (typeof pathKey !== 'string') return null
  const parts = pathKey.split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? pathKey : parts[parts.length - 1]
}

export function hashWorkspace(pathKey) {
  return createHash('sha256').update(String(pathKey)).digest('hex').slice(0, 16)
}

/**
 * @returns {{id:string, kind:'global'|'project', pathKey:string|null, unbound:boolean}}
 */
export function resolveScope(db, workspacePath) {
  const pathKey = normalizeWorkspacePath(workspacePath)
  if (pathKey === null) {
    // 没有工作区：只有 global 可用；unbound 标记用于阻止项目记忆混入
    const globalId = ensureGlobalScope(db)
    return { id: globalId, kind: 'global', pathKey: null, unbound: true }
  }

  const row = db.prepare("SELECT id FROM scopes WHERE kind = 'project' AND path_key = ?").get(pathKey)
  if (row !== undefined) {
    return { id: String(row.id), kind: 'project', pathKey, unbound: false }
  }

  const id = randomUUID()
  db.prepare('INSERT INTO scopes(id, kind, path_key, label, created_at) VALUES(?,?,?,?,?)')
    .run(id, 'project', pathKey, pathKeyToLabel(pathKey), Date.now())
  return { id, kind: 'project', pathKey, unbound: false }
}

export function getGlobalScopeId(db) {
  return ensureGlobalScope(db)
}

/** 列出某作用域可读的记忆作用域：global + 当前 project（未绑定时只有 global）。 */
export function readableScopes(db, workspacePath) {
  const globalId = ensureGlobalScope(db)
  const pathKey = normalizeWorkspacePath(workspacePath)
  if (pathKey === null) return [globalId]
  const row = db.prepare("SELECT id FROM scopes WHERE kind = 'project' AND path_key = ?").get(pathKey)
  return row === undefined ? [globalId] : [globalId, String(row.id)]
}
