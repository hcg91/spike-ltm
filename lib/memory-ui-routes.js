/* 记忆页面路由。客户端提交作用域标签，服务端解析真实权限范围。 */
export const ROUTE_PREFIX = '/api/spike-ltm/ui'

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

const ok = (value) => json({ ok: true, value })
const fail = (code, message, status = 400) => json({ ok: false, error: { code, message } }, status)

function resolveLabel(allowlist, label) {
  const hit = allowlist.find((entry) => entry.label === label)
  return hit === undefined ? null : hit
}

function itemScope(db, scope, id) {
  const row = db.prepare('SELECT id, scope_id FROM memories WHERE id = ?').get(id)
  if (row === undefined) throw new Error('NOT_FOUND')
  if (!scope.scopeIds.includes(String(row.scope_id))) throw new Error('SCOPE_DENIED')
  return String(row.scope_id)
}
function errorResponse(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = String(message).split(':')[0]
  const known = new Set([
    'SCOPE_REQUIRED', 'SCOPE_DENIED', 'NOT_FOUND', 'NOT_ACTIVE', 'EMPTY_TEXT',
    'TEXT_TOO_LONG', 'VERSION_CONFLICT', 'VERSION_NOT_FOUND',
    'VERSION_SNAPSHOT_INVALID', 'FORGOTTEN_BLOCKED',
    'MODEL_UNAVAILABLE', 'MODEL_ROUTE_UNAVAILABLE', 'MODEL_FAILED', 'MODEL_EMPTY',
    'MODEL_TIMEOUT', 'MODEL_CANCELLED', 'REQUEST_BUSY', 'STORAGE_CHANGED', 'STORAGE_UNREADABLE',
  ])
  if (known.has(code)) return fail(code, message, code === 'NOT_FOUND' ? 404 : 409)
  return fail('INTERNAL', message, 500)
}

async function readBody(request) {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function registerMemoryUiRoutes({ ctx, db, service, allowlist, propose, adapter = null, logger = console, beaconPath = null }) {
  const { connection } = ctx
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    throw new Error('connection service unavailable')
  }

  const routes = []
  const pending = new Map()
  const targetScope = (scope, id) => adapter ? adapter.read({ id, scopeIds: scope.scopeIds }).scopeId : itemScope(db, scope, id)

  routes.push({
    path: `${ROUTE_PREFIX}/status`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => ok({
      enabled: true,
      source: adapter?.source ?? 'test',
      notice: adapter ? '旧记忆没有会话来源；项目旧记录未绑定具体目录，不能按会话编号筛选。' : '独立测试数据，不是你的真实项目。',
      scopes: allowlist.map((entry) => ({ label: entry.label, kind: entry.kind })),
      revision: adapter ? adapter.revision() : service.revision(),
    }),
  })

  routes.push({
    path: `${ROUTE_PREFIX}/beacon`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (beaconPath === null) return ok({ logged: false })
        const body = await readBody(request)
        mkdirSync(dirname(beaconPath), { recursive: true })
        appendFileSync(beaconPath, `${JSON.stringify({ t: new Date().toISOString(), ...body })}\n`, 'utf8')
        return ok({ logged: true })
      } catch {
        return ok({ logged: false })
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/list`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        const { listMemoryView } = await import('./memory-ui-service.js')
        return ok(adapter ? adapter.list(scope.scopeIds) : listMemoryView({ db, scopeIds: scope.scopeIds }))
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/edit`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        const { applyEdit } = await import('./memory-ui-service.js')
        const targetScopeId = targetScope(scope, String(body.id ?? ''))
        return ok(await (adapter?.edit ?? applyEdit)({
          service, id: String(body.id ?? ''), scopeId: targetScopeId,
          expectedVersion: Number(body.expectedVersion), text: String(body.text ?? ''),
        }))
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/versions`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        const { listVersions } = await import('./memory-ui-service.js')
        return ok((adapter?.versions ?? listVersions)({ db, id: String(body.id ?? ''), scopeIds: scope.scopeIds }))
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/restore`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        const { restoreVersion } = await import('./memory-ui-service.js')
        const targetScopeId = targetScope(scope, String(body.id ?? ''))
        return ok(await (adapter?.restore ?? restoreVersion)({
          service, db, id: String(body.id ?? ''), scopeId: targetScopeId,
          expectedVersion: Number(body.expectedVersion), targetVersion: Number(body.targetVersion),
        }))
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/forget`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        const targetScopeId = targetScope(scope, String(body.id ?? ''))
        const args = { id: String(body.id ?? ''), scopeId: targetScopeId, expectedVersion: Number(body.expectedVersion) }
        const result = adapter ? adapter.forget(args) : await service.forget(args)
        return ok(result)
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/cancel`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      const key = `${String(body.sessionId ?? '')}:${String(body.requestId ?? '')}`
      pending.get(key)?.abort(new Error('MODEL_CANCELLED'))
      return ok({ cancelled: pending.has(key) })
    },
  })

  routes.push({
    path: `${ROUTE_PREFIX}/propose`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readBody(request)
        const scope = resolveLabel(allowlist, body.label)
        if (scope === null) return fail('SCOPE_REQUIRED', '未知的作用域标签')
        if (typeof propose !== 'function') return fail('MODEL_UNAVAILABLE', '宿主模型不可用', 503)
        const key = `${String(body.sessionId ?? '')}:${String(body.requestId ?? '')}`
        if (pending.has(key)) return fail('REQUEST_BUSY', '请求正在生成，请先取消')
        const abort = new AbortController()
        pending.set(key, abort)
        let result
        try { result = await propose({
          id: String(body.id ?? ''),
          scopeIds: scope.scopeIds,
          expectedVersion: Number(body.expectedVersion),
          messages: Array.isArray(body.messages) ? body.messages : [],
          requestId: String(body.requestId ?? ''),
          sessionId: String(body.sessionId ?? ''),
          draft: typeof body.draft === 'string' ? body.draft.slice(0, 2000) : null,
          signal: AbortSignal.any([request.signal, abort.signal]),
        }) } finally { pending.delete(key) }
        return ok(result)
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  const disposers = routes.map((route) => connection.fetch.register(route))
  logger?.info?.(`spike-ltm: 记忆界面路由已注册 ${routes.length} 条`)
  return () => {
    for (const abort of pending.values()) abort.abort(new Error('MODEL_CANCELLED'))
    pending.clear()
    disposers.forEach((dispose) => { try { dispose() } catch { /* 已释放 */ } })
  }
}
