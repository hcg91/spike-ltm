/* 记忆页面接入：live 复用当前存储，uiTestDb 使用独立测试库。 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, openDatabase } from './store/db.js'
import { MemoryService } from './store/service.js'
import { resolveScope } from './store/scope.js'
import { registerMemoryUiRoutes } from './memory-ui-routes.js'
import { createEditProposer } from './memory-edit.js'
import { resolveMemoryContext } from './memory-context.js'
import { createLiveAdapter, LIVE_SCOPES } from './memory-live-adapter.js'
import { createSummaryService, registerSummaryRoutes } from './memory-summary.js'

const SEED = [
  { kind: 'rule', scope: 'global', text: '回答时先给结论，再解释必要原因。', opId: 'seed-rule-1' },
  { kind: 'fact', scope: 'global', text: '用户使用索尼 A6700 相机拍摄城市夜景。', opId: 'seed-fact-1' },
  { kind: 'project', scope: 'a', text: '工业设备三维仿真项目：Godot 4 + Blender，模型来自 SolidWorks。', opId: 'seed-project-a' },
  { kind: 'goal', scope: 'a', text: '项目目标：完整展示装配、吊装与安装流程。', opId: 'seed-goal-a' },
  { kind: 'preference', scope: 'b', text: '偏好自然真实的光照，不喜欢过度磨皮。', opId: 'seed-pref-b' },
  { kind: 'constraint', scope: 'b', text: '当前只有周末能投入连续四小时做项目。', opId: 'seed-constraint-b' },
]

export function makeModelCaller(ctx, { timeoutMs = 60000 } = {}) {
  return async function callModel(prompt, { sessionId, signal, maxTokens = 1200 } = {}) {
    const llm = ctx.get?.('llm') ?? ctx.llm
    let route
    if (sessionId === undefined || sessionId === null) {
      const defaults = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
      route = defaults?.currentSelection()
    } else {
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      route = sessions?.get(sessionId)?.requestHeader()?.config
    }
    if (!route?.provider || !route?.model) throw new Error('MODEL_ROUTE_UNAVAILABLE: 默认模型或指定会话的模型配置不可用，请检查账号通道配置')
    if (typeof llm?.stream !== 'function') throw new Error('MODEL_UNAVAILABLE: 当前宿主模型服务不可用')
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('MODEL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new Error('MODEL_TIMEOUT: 模型响应超时，请重试')), timeoutMs)
    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const generate = async () => {
      controller.signal.throwIfAborted()
      let output = ''
      let finish
      for await (const chunk of llm.stream({
        provider: route.provider, model: route.model,
        signal: controller.signal, purpose: 'spike-ltm-ui', maxTokens: Math.min(3000, maxTokens),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'spike-ltm-ui' }, id: `ui-${Date.now()}` }],
      })) {
        controller.signal.throwIfAborted()
        if (chunk?.type === 'text-delta') output += chunk.text ?? ''
        else if (chunk?.type === 'finish') finish = chunk.reason
      }
      if (finish?.kind !== 'stop') throw new Error('MODEL_FAILED: 模型没有正常完成，本次未保存')
      if (!output.trim()) throw new Error('MODEL_EMPTY')
      return output
    }
    try { return await Promise.race([generate(), cancelled]) }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }
}

export function installMemoryUi({ ctx, config, dir, core, logger = ctx.logger }) {
  if (config.uiSource === 'live') {
    if (!core) throw new Error('Live memory core is required')
    const adapter = createLiveAdapter(core)
    const propose = createEditProposer({ read: adapter.read, callModel: makeModelCaller(ctx) })
    const summary = createSummaryService({ core, callModel: makeModelCaller(ctx), scopeIds: [...new Set(LIVE_SCOPES.flatMap(s => s.scopeIds))] })
    const boundServices = new Map()
    const getService = sessionId => {
      if (!core.forContext) return summary
      const context = resolveMemoryContext(ctx, { sessionId })
      const key = JSON.stringify(context)
      if (!boundServices.has(key)) {
        while (boundServices.size >= 64) { const oldest = boundServices.keys().next().value; boundServices.get(oldest).dispose(); boundServices.delete(oldest) }
        const call = makeModelCaller(ctx)
        boundServices.set(key, createSummaryService({ core: core.forContext(context), scopeIds: ['global','project'],
          callModel: async (prompt, options) => {
            if (JSON.stringify(resolveMemoryContext(ctx, { sessionId })) !== key) throw new Error('CONTEXT_CHANGED')
            const result = await call(prompt, options)
            if (JSON.stringify(resolveMemoryContext(ctx, { sessionId })) !== key) throw new Error('CONTEXT_CHANGED')
            return result
          },
        }))
      }
      return boundServices.get(key)
    }
    let release = null
    const uninject = ctx.inject(['connection'], scoped => {
      const releaseLegacy = registerMemoryUiRoutes({ ctx: scoped, adapter, allowlist: LIVE_SCOPES, propose, logger })
      const releaseSummary = registerSummaryRoutes({ ctx: scoped, service: summary, getService })
      release = () => { releaseLegacy(); releaseSummary() }
      return () => { release?.(); release = null }
    })
    return () => { release?.(); uninject?.(); boundServices.forEach(s => s.dispose()); boundServices.clear() }
  }
  const dbPath = String(config.uiTestDb)
  mkdirSync(join(dirnameOf(dbPath)), { recursive: true })
  const tracePath = join(dirnameOf(dbPath), 'host-ui.log')
  const trace = (message) => { try { appendFileSync(tracePath, `${new Date().toISOString()} ${message}\n`, 'utf8') } catch { /* 忽略 */ } }
  trace(`install-start db=${dbPath}`)
  const { db } = openDatabase(dbPath)
  trace('db-open')
  const service = new MemoryService({ db, logger })

  const globalScope = resolveScope(db, null).id
  const projectA = resolveScope(db, join(dir, 'ui-projects', 'project-a')).id
  const projectB = resolveScope(db, join(dir, 'ui-projects', 'project-b')).id

  const allowlist = [
    { label: '全局', kind: 'global', scopeIds: [globalScope] },
    { label: '项目 A', kind: 'project', scopeIds: [globalScope, projectA] },
    { label: '项目 B', kind: 'project', scopeIds: [globalScope, projectB] },
  ]

  // 合成数据：只在空库时写入，重复启动不会重复
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
  if (count === 0) {
    const byScope = { global: globalScope, a: projectA, b: projectB }
    for (const seed of SEED) {
      try {
        service.saveExplicit({
          text: seed.text, kind: seed.kind, scopeId: byScope[seed.scope],
          importance: 'medium', confidence: 'high', opId: seed.opId,
          evidence: '界面测试合成数据',
        })
      } catch (error) {
        logger?.warn?.(`spike-ltm: 界面种子写入失败：${String(error)}`)
      }
    }
  }

  trace(`seeded count=${Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)}`)
  const callModel = makeModelCaller(ctx)
  trace(`llm=${callModel === null ? 'none' : 'ok'} inject=${typeof ctx.inject} connection=${typeof ctx.get?.('connection')}`)
  const propose = callModel === null
    ? null
    : createEditProposer({ db, callModel })

  let disposeRoutes = null
  let injectDisposer = null
  if (typeof ctx.inject !== 'function') {
    trace('inject-unavailable')
  } else {
    try {
      injectDisposer = ctx.inject(['connection'], (scoped) => {
        trace('inject-callback')
        try {
          disposeRoutes = registerMemoryUiRoutes({
            ctx: scoped, db, service, allowlist, propose, logger,
            beaconPath: join(dirnameOf(dbPath), 'client-beacon.log'),
          })
          trace('routes-registered')
        } catch (error) {
          trace(`routes-failed ${String(error?.message ?? error)}`)
        }
      })
      trace('inject-called')
    } catch (error) {
      trace(`inject-threw ${String(error?.message ?? error)}`)
    }
  }

  const dispose = () => {
    try { disposeRoutes?.() } catch { /* 已释放 */ }
    try { injectDisposer?.() } catch { /* 已释放 */ }
    closeDatabase(db)
  }

  logger?.info?.(`spike-ltm: 记忆界面已启用，测试库 ${dbPath}`)
  return dispose
}

function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '.' : path.slice(0, index)
}
