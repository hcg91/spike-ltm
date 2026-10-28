/* 注册记忆工具、召回上下文、后台任务和页面。 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { closeDatabase, getEpoch, getMeta, integrityCheck, openDatabase, transaction } from './store/db.js'
import { MemoryService } from './store/service.js'
import { JobStore } from './store/jobs.js'
import { createSqliteCore } from './store/core.js'
import { discardTempDatabase, migrateJsonToSqlite } from './store/migrate.js'
import { openMemoryStore } from './store/factory.js'
import { resolveMemoryContext } from './memory-context.js'
import { installMemoryJobs } from './auto.js'
import { installMemoryUi } from './memory-ui-host.js'
import { embed, cosine, semanticStatus, abandonPending, disposeSemantic } from './semantic.js'
import { filterRecall } from './recall-filter.js'
import { forgetTopic } from './forget-topic.js'

export const name = 'spike-ltm'
export const inject = ['tools', 'systemPrompt']

const CONTEXT_NAME = 'ltm:memory'
const CONTEXT_ORDER = 500

/** 数据库不可用时的降级内核：读取为空，写入明确报错，宿主不崩。 */
function createUnavailableCore() {
  const fail = async () => { throw new Error('STORAGE_UNAVAILABLE') }
  return {
    setThresholds: () => ({}),
    inspect: () => ({ revision: 0, epoch: 0, items: [], profile: null }),
    providerText: () => '',
    profileText: () => '',
    embeddingTargets: () => ({ items: [], bullets: [] }),
    refreshSnapshot: () => ({ revision: 0, epoch: 0, text: '', ids: [] }),
    captureEpoch: () => 0,
    save: fail, saveIfEpoch: fail, updateItem: fail, forget: fail, forgetItem: fail,
    forgetItems: fail, updateSummarySection: fail, updateSummarySections: fail,
    refreshSummary: fail, setProfile: fail, itemVersions: () => { throw new Error('STORAGE_UNAVAILABLE') },
  }
}


function resolveDir(ctx) {
  try {
    const homePath = ctx.get('dshHomePath')
    if (typeof homePath === 'function') return homePath('spike-ltm')
  } catch {
    // 服务不存在时走下面的兜底
  }
  if (process.env.DSH_HOME) return `${process.env.DSH_HOME}\\spike-ltm`
  return `${process.cwd()}\\.spike-ltm`
}

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const kind = message?.source?.kind
    // 只认"真人输入"：runtime-context / plugin / skill 之类都不算
    if (kind !== undefined && kind !== 'user') continue
    const text = textOfMessage(message)
    if (text.trim() !== '') return text
  }
  return ''
}

function codeOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  const known = ['EMPTY_TEXT', 'TEXT_TOO_LONG', 'EMPTY_TOPIC', 'MEMORY_FULL', 'INVALID_PROFILE']
  return known.includes(message) ? message : `STORAGE_FAILED: ${message}`
}

/* 检查宿主是否支持 node:sqlite。 */
function probeSqlite() {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    if (typeof DatabaseSync !== 'function') return 'no-export'
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t(a INTEGER)')
    db.exec('PRAGMA journal_mode=WAL')
    db.close()
    return 'ok'
  } catch (error) {
    return `fail:${String(error?.message ?? error).slice(0, 80)}`
  }
}

/* 记录启动阶段，便于排查加载失败。 */
function bootBeacon(dir, phase) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), `${new Date().toISOString()} ${phase} pid=${process.pid}\n`, 'utf8')
  } catch {
    /* 日志失败不影响插件。 */
  }
}



/** 文本 → 向量缓存（进程内）。条目/结论各自按内容哈希索引。 */
const vectorCache = new Map()

/** 测试钩子：注入受控的语义打分，验证接线（生产环境为 null） */
let semanticScorerOverride = null
export function __setSemanticScorerForTest(fn) {
  semanticScorerOverride = fn
}

/** 最近一次召回的状态，供 ltm_status 查看。 */
let lastSemantic = { status: 'idle', at: null, ms: null }

const MAX_VECTOR_CACHE = 20000
let vectorModel = null

/* 返回相关性结果；degraded 表示本轮不注入背景，null 表示没有候选。 */
export async function semanticScores(core, query, logger, options = {}) {
  const started = Date.now()
  const q = String(query ?? '').trim()
  if (q === '') return null
  const targets = core.embeddingTargets()
  const model = semanticStatus().model
  if (vectorModel !== model) { vectorCache.clear(); vectorModel = model }
  if (core.readVectors) for (const [hash, vector] of core.readVectors(model)) vectorCache.set(hash, vector)
  if (targets.items.length === 0 && targets.bullets.length === 0) return null

  // 只保留当前仍然有效的目标：遗忘/更新后旧向量立即失效
  const validHashes = new Set([...targets.items, ...targets.bullets].map((t) => t.hash))
  for (const hash of [...vectorCache.keys()]) {
    if (!validHashes.has(hash)) vectorCache.delete(hash)
  }
  while (vectorCache.size > MAX_VECTOR_CACHE) {
    const oldest = vectorCache.keys().next().value
    vectorCache.delete(oldest)
  }

  // 推理开始时的版本：期间发生写入/遗忘，这批结果就作废，不得进入缓存
  const baseState = core.inspect()
  const baseRevision = baseState.revision
  const baseEpoch = baseState.epoch

  const missing = []
  for (const target of [...targets.items, ...targets.bullets]) {
    if (!vectorCache.has(target.hash)) missing.push(target)
  }
  for (let start = 0; start < missing.length; start += 64) {
    const batch = missing.slice(start, start + 64)
    const result = await embed(batch.map(t => t.text), logger)
    if (!result.ok) return { degraded: true, reason: result.reason, ms: Date.now() - started }
    if (core.inspect().revision !== baseRevision) return { degraded: true, reason: 'stale-revision' }
    core.rememberVectors?.(batch, result.vectors, model, baseRevision)
    batch.forEach((target, i) => vectorCache.set(target.hash, result.vectors[i]))
  }
  const queryResult = await embed([q], logger)
  if (!queryResult.ok) return { degraded: true, reason: queryResult.reason, ms: Date.now() - started }

  const afterState = core.inspect()
  if (afterState.revision !== baseRevision || afterState.epoch !== baseEpoch) {
    return { degraded: true, reason: 'stale-revision', ms: Date.now() - started }
  }
  const qv = queryResult.vectors[0]

  const entries = new Map()
  for (const target of targets.items) {
    const vector = vectorCache.get(target.hash)
    if (vector !== undefined) entries.set(target.id, cosine(qv, vector))
  }
  const bullets = new Map()
  for (const target of targets.bullets) {
    const vector = vectorCache.get(target.hash)
    if (vector !== undefined) bullets.set(target.hash, cosine(qv, vector))
  }
  if (options.llm?.stream && options.route?.provider && options.route?.model) {
    const original = new Map(baseState.items.map(it => [it.id, it.text]))
    const candidates = [
      ...targets.items.map(t => ({ id: `item:${t.id}`, key: t.id, type: 'item', text: original.get(t.id) ?? t.text, score: entries.get(t.id) ?? 0 })),
      ...targets.bullets.map(t => ({ id: `bullet:${t.hash}`, key: t.hash, type: 'bullet', text: t.text, score: bullets.get(t.hash) ?? 0 })),
    ].filter(t => t.score >= 0.30).sort((a,b) => b.score - a.score).slice(0, 8)
    let selected = new Set()
    try {
      if (candidates.length) selected = await filterRecall({ ...options, query:q, candidates:candidates.map(({id,text}) => ({id,text})) })
    } catch (error) {
      return { degraded:true, reason:error.message, ms:Date.now()-started }
    }
    const current = core.inspect()
    if (current.revision !== baseRevision || current.epoch !== baseEpoch) return { degraded:true, reason:'stale-revision', ms:Date.now()-started }
    // After model review, these are inclusion flags rather than cosine scores.
    for (const id of entries.keys()) entries.set(id, 0)
    for (const hash of bullets.keys()) bullets.set(hash, 0)
    for (const c of candidates) if (selected.has(c.id)) (c.type === 'item' ? entries : bullets).set(c.key, 1)
  }
  return { ok: true, entries, bullets, ms: Date.now() - started }
}

/** 诊断行：只写结构化指标，绝不写用户原话。 */
function formatSemanticProbe(info) {
  return JSON.stringify({
    t: new Date().toISOString(),
    status: info.status,
    entries: info.entries,
    bullets: info.bullets,
    top: Number.isFinite(info.top) ? Number(info.top.toFixed(3)) : null,
    ms: info.ms,
    model: info.model ?? null,
  })
}

export { formatSemanticProbe }

function pruneVectorCache(core) {
  const targets = core.embeddingTargets()
  const valid = new Set([...targets.items, ...targets.bullets].map((t) => t.hash))
  for (const hash of [...vectorCache.keys()]) {
    if (!valid.has(hash)) vectorCache.delete(hash)
  }
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

export function apply(ctx, config = {}) {
  // 语义模型的可选配置：镜像站与模型缓存目录（首次下载用）
  if (typeof config.semanticMirror === 'string' && config.semanticMirror !== '') {
    process.env.LTM_HF_MIRROR = config.semanticMirror
  }
  if (typeof config.semanticCacheDir === 'string' && config.semanticCacheDir !== '') {
    process.env.LTM_CACHE_DIR = config.semanticCacheDir
  }
  const dir = config.dir ?? resolveDir(ctx)
  bootBeacon(dir, 'apply-start')
  try {
    const dbPath = join(dir, 'memory.db')
    let opened = null
    let jobStore = null
    let core
    try {
      opened = openMemoryStore({ dir, backend: config.storeBackend, logger: ctx.logger ?? console })
      jobStore = opened.jobs
      core = opened.core
    } catch (error) {
      ctx.logger?.error?.(`spike-ltm: 记忆数据库不可用，记忆功能暂停（不回退 JSON）：${String(error)}`)
      core = createUnavailableCore()
    }
    const boundAgents = new WeakMap()
    const forAgent = (agent) => {
      if (!core.forContext || !agent) return core
      const context = resolveMemoryContext(ctx, { session: agent.session })
      const key = JSON.stringify(context)
      const prior = boundAgents.get(agent)
      if (prior?.key === key) return prior.core
      const bound = core.forContext(context)
      bound.setThresholds({ entry: config.semanticMinScore, bullet: config.semanticMinBullet })
      boundAgents.set(agent, { key, core: bound })
      return bound
    }
    core.setThresholds({ entry: config.semanticMinScore, bullet: config.semanticMinBullet })
    ctx.logger?.info?.(`spike-ltm: memory dir = ${dir}`)

  // 1) 注入通道：同步、无 IO，只读快照；版本不一致时返回空串。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    // 关闭模板插值：记忆文本是数据，不能被当成 {{变量}} 解释
    interpolate: false,
    text: (context) => (context?.agent ? boundAgents.get(context.agent)?.core ?? core : core).providerText(context?.agent),
  })

  ctx.systemPrompt.context({
    name: 'ltm:maintenance',
    order: CONTEXT_ORDER + 1,
    interpolate: false,
    text: () => '长期记忆维护：普通聊天中的记忆新增与更新应在后台完成。用户明确陈述或纠正的当前事实优先于旧记忆，无需再次确认。不要仅因旧记忆冲突而调用 ask_user_question、列出冲突选项或暂停回答；证据不足时暂不改记忆，也不要专门追问。需要立即修正已有条目时先用 ltm_list 取得 id、scope 和 version，再调用 ltm_save 的 id/expectedVersion 定点更新，保留未被纠正的信息；不要用宽泛遗忘删除其他条目。只有真实保存回执成功才能声称已更新。用户主动打开记忆页面进行修改时，仍按页面的更新按钮提交。',
  })

  // 2) 每个 step 开始前按当前问题重算快照（按 agent 区分，避免跨会话串档）
  ctx.on('agent/pre-step', async (payload, next) => {
    const core = forAgent(payload?.agent)
    const decision = await next()
    try {
      const messages = payload?.messages ?? decision?.messages ?? []
      const query = lastUserText(messages)
      const startedAt = Date.now()
      let semantic = null
      let status = 'disabled'

      if (config.semantic !== false) {
        const route = payload?.agent?.session?.requestHeader?.()?.config
        let llm = ctx.llm
        try { llm ??= ctx.get?.('llm') } catch { /* Optional model service. */ }
        // 首次加载（含首次下载）和正常推理是两件事，用不同预算：
        // 加载可能几十秒，但它只发生一次；推理通常 10ms 级。
        const ready = semanticStatus().state === 'ready'
        const timeoutMs = ready
          ? (config.semanticTimeoutMs ?? (llm?.stream && route?.provider && route?.model ? 8000 : 2000))
          : (config.semanticInitTimeoutMs ?? 8000)

        // 必须区分三件事：超时 / 没有可召回记忆 / 真正返回了分数。
        // 不能把 null（无记忆）当成超时，否则永远不会触发模型加载。
        let timedOut = false
        let timeoutHandle, outcome
        try { outcome = await Promise.race([
          (semanticScorerOverride ?? ((c, q) => semanticScores(c, q, ctx.logger, {llm,route})))(core, query).catch((error) => {
            ctx.logger?.warn?.(`spike-ltm: 语义召回异常：${String(error)}`)
            return { degraded: true, reason: 'exception', ms: Date.now() - startedAt }
          }),
          new Promise((resolve) => { timeoutHandle = setTimeout(() => {
            timedOut = true
            // 外层等待超时：立即结算底层请求，避免其无限挂起/污染状态
            abandonPending(`host-timeout(${timeoutMs}ms)`, ctx.logger)
            resolve(null)
          }, timeoutMs) }),
        ]) } finally { clearTimeout(timeoutHandle) }

        if (outcome === null) {
          if (timedOut) {
            status = 'degraded:timeout'
            semantic = { degraded: true }
          } else {
            status = 'no-memory' // 没有可召回的条目，不是失败
            semantic = null
          }
        } else if (outcome.degraded === true) {
          status = `degraded:${outcome.reason}`
          semantic = { degraded: true }
        } else {
          status = 'ok'
          semantic = { entries: outcome.entries, bullets: outcome.bullets }
        }
        lastSemantic = { status, at: Date.now(), ms: outcome?.ms ?? null }
      }

      // 诊断行：只有结构化指标，不含用户原话
      try {
        const top = Math.max(
          ...(semantic?.entries ? semantic.entries.values() : []),
          ...(semantic?.bullets ? semantic.bullets.values() : []),
          0,
        )
        appendFileSync(
          join(dir, 'semantic.log'),
          `${formatSemanticProbe({
            status,
            entries: semantic?.entries?.size ?? 0,
            bullets: semantic?.bullets?.size ?? 0,
            top,
            ms: lastSemantic?.ms ?? 0,
            model: semanticStatus().model,
          })}\n`,
          'utf8',
        )
      } catch {
        // 诊断落盘失败不影响召回
      }

      core.refreshSnapshot(query, payload?.agent, semantic)
    } catch (error) {
      ctx.logger?.warn?.(`spike-ltm: 召回失败（本轮不注入）：${String(error)}`)
    }
    return decision
  })

  // 3) 模型工具
  ctx.tools.register({
    name: 'ltm_save',
    description:
      '把一条需要跨会话记住的信息写入长期记忆。用户明确陈述的新事实或对旧事实的纠正无需再次确认。'
      + '更新旧条目时传入 ltm_list 返回的 id、scope、expectedVersion（version），原位替换并保留历史；不要另存重复条目或弹出冲突确认。'
      + '只有返回 ok:true 才代表真的写入了磁盘；ok:false 时必须如实告诉用户没存上，不得声称已记住。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的完整内容，用一句陈述句。' },
        scope: { type: 'string', description: 'global（跨项目）或 project（仅当前项目），默认 global。' },
        id: { type: 'string', description: '更新已有记忆时填其 id；新增时不填。' },
        expectedVersion: { type: 'integer', description: '更新时填写 ltm_list 返回的 version；版本过期时重新读取，不要覆盖新修改。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          revision: { type: 'integer' },
          count: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: value.ok
            ? `已保存（回执 id=${value.id}，版本 rev=${value.revision}，当前共 ${value.count} 条）`
            : `保存失败：${value.error}`,
        }]
      },
    },
    timeoutMs: 5000,
    async execute(args, exec) {
      const core = forAgent(exec?.agent)
      try {
        // 显式保存：用户要求的优先级最高，按原样写入，不做任何改写或"补录"。
        const result = args.id !== undefined ? await core.updateItem({
          id: args.id,
          scope: args.scope ?? 'global',
          expectedVersion: args.expectedVersion,
          text: args.text,
          reason: 'conversation-update',
        }) : await core.save(args.text, {
          scope: args.scope,
          source: 'explicit',
          importance: 'high',
          confidence: 'high',
          reason: '用户明确要求保存',
        })
        pruneVectorCache(core)
        return {
          ok: true,
          id: result.item?.id ?? result.id,
          revision: core.inspect().revision,
          count: core.inspect().items.filter((it) => it.status === 'active').length,
        }
      } catch (error) {
        return { ok: false, error: codeOf(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'ltm_forget',
    description:
      '遗忘匹配主题的长期记忆。删除成功后返回 ok:true 与被删除的条目；'
      + '该操作会让此前注入过的内容立即失效，且排队中的自动提炼不得再把它们写回来。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '要遗忘的主题，使用当前会话模型按含义选择条目；模型不可用时明确报错。' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'integer' },
          removedIds: { type: 'string' },
          epoch: { type: 'integer' },
          revision: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: value.ok
            ? `已遗忘 ${value.removed} 条（epoch=${value.epoch}，rev=${value.revision}）`
            : `遗忘失败：${value.error}`,
        }]
      },
    },
    timeoutMs: 20000,
    async execute(args, exec) {
      const core = forAgent(exec?.agent)
      try {
        const route = exec?.agent?.session?.requestHeader?.()?.config
        let llm = ctx.llm
        try { llm ??= ctx.get?.('llm') } catch { /* Missing service is reported by forgetTopic. */ }
        const result = await forgetTopic(core, args.topic, {llm,route})
        pruneVectorCache(core)
        return {
          ok: true,
          removed: result.removed.length,
          removedIds: result.removed.map((it) => it.id).join(','),
          epoch: result.epoch,
          revision: result.revision,
        }
      } catch (error) {
        return { ok: false, error: codeOf(error) }
      }
    },
  })

    // 4) 自动提炼 + 画像综合
    const jobs = installMemoryJobs({ ctx, core, config, jobs: jobStore })

    // 5) 让用户/模型能查看当前画像
    ctx.tools.register({
      name: 'ltm_profile',
      description: '查看当前的长期画像（从记忆条目综合而来）。传 rebuild:true 可立即重新综合。',
      parameters: {
        type: 'object',
        properties: {
          rebuild: { type: 'boolean', description: '是否立刻重新综合画像，默认 false。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            profile: { type: 'string' },
            entries: { type: 'integer' },
            error: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.profile === '' ? '画像还是空的。' : value.profile }]
        },
      },
      timeoutMs: 30000,
      async execute(args, exec) {
        const core = forAgent(exec?.agent)
        try {
          if (args?.rebuild === true) {
              const session = exec?.agent?.session
              const route = session?.requestHeader?.()?.config
                ?? (ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel)?.currentSelection?.()
              if (!route?.provider || !route?.model) throw new Error('MODEL_ROUTE_UNAVAILABLE')
              const result = await jobs.synthesizeNow?.({
                provider: route.provider, model: route.model,
                context: resolveMemoryContext(ctx, { session }),
              })
              if (!result && core.inspect().items.some(it => it.status === 'active')) throw new Error('PROFILE_REBUILD_FAILED')
          }
          const text = core.profileText()
          return { ok: true, profile: text, entries: core.inspect().items.filter((it) => it.status === 'active').length }
        } catch (error) {
          return { ok: false, error: codeOf(error) }
        }
      },
    })

    /* 读取原始记忆条目。 */
    ctx.tools.register({
      name: 'ltm_list',
      description: '列出长期记忆的全部条目（id、scope、version、类型、来源、内容），用来读取事实及定点更新版本。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'integer' },
            text: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text === '' ? '记忆库是空的。' : value.text }]
        },
      },
      timeoutMs: 5000,
      async execute(_args, exec) {
        const core = forAgent(exec?.agent)
        try {
          const items = core.inspect().items.filter((it) => it.status === 'active')
          const text = items
            .map((it) => `- [${it.id}] (scope=${it.scope}, version=${it.version ?? 1}, ${it.kind}, ${it.source}) ${it.text}`)
            .join('\n')
          return { ok: true, count: items.length, text }
        } catch (error) {
          return { ok: false, count: 0, text: `读取失败：${codeOf(error)}` }
        }
      },
    })

    // 7) 运行状态（语义模型 + 最近一次召回 + 记忆规模）
    ctx.tools.register({
      name: 'ltm_status',
      description: '查看长期记忆与语义检索的运行状态：模型是否就绪、最近一次召回是成功/降级/超时、记忆条数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      timeoutMs: 5000,
      async execute(_args, exec) {
        const core = forAgent(exec?.agent)
        try {
          const state = core.inspect()
          const items = state.items.filter((it) => it.status === 'active')
          const semantic = semanticStatus()
          const lines = [
            `记忆：${items.length} 条，revision=${state.revision}，epoch=${state.epoch}`,
            `画像：${state.profile === null ? '无' : `v${state.profile.version}（${state.profile.sections.length} 节，基于 revision ${state.profile.builtAtRevision}）`}`,
            `语义模型：${semantic.state}（${semantic.model}）`,
            semantic.readyAt === null ? '加载耗时：未加载' : `加载耗时：${semantic.readyAt - semantic.loadStartedAt}ms`,
            semantic.lastInferenceMs === null ? '推理耗时：无' : `推理耗时：${semantic.lastInferenceMs}ms`,
            `最近召回：${lastSemantic.status}${lastSemantic.ms === null ? '' : `（${lastSemantic.ms}ms）`}`,
            `推理进程：pid=${semantic.pid ?? '无'}，代次=${semantic.generation}，排队=${semantic.queued}`,
            semantic.lastError === null ? '最近错误：无' : `最近错误：${semantic.lastError}`,
          ]
          return { ok: true, text: lines.join('\n') }
        } catch (error) {
          return { ok: false, text: `读取状态失败：${codeOf(error)}` }
        }
      },
    })

    // 8) 内置长期记忆弹窗：live 复用在线 core；测试库保持独立。
    let uiDispose = null
    if (opened !== null && (config.uiSource === 'live' || (config.uiSource === undefined && (typeof config.uiTestDb !== 'string' || config.uiTestDb === '')) || (typeof config.uiTestDb === 'string' && config.uiTestDb !== ''))) {
      try {
        uiDispose = installMemoryUi({
          ctx, dir, core, logger: ctx.logger,
          config: config.uiSource === undefined && (typeof config.uiTestDb !== 'string' || config.uiTestDb === '')
            ? { ...config, uiSource: 'live' } : config,
        })
      } catch (error) {
        ctx.logger?.warn?.(`spike-ltm: 记忆界面启用失败：${String(error)}`)
        try {
          appendFileSync(`${dir}/ui-error.log`, `${new Date().toISOString()} ${String(error?.stack ?? error)}\n`, 'utf8')
        } catch { /* 忽略 */ }
      }
    }

    // 卸载/热重载时释放推理子进程与界面资源
    try {
      ctx.effect(() => () => {
        disposeSemantic()
        try { jobs.stop?.() } catch { /* 已停止 */ }
        try { uiDispose?.() } catch { /* 已释放 */ }
        if (opened !== null) opened.close()
      })
    } catch {
      // 宿主不支持 effect 时忽略
    }

    bootBeacon(dir, `ready db=${dbPath} tools=5 context=1 pre-step=1 jobs=${jobs.enabled ? 'on' : 'off'} sqlite=${probeSqlite()}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bootBeacon(dir, `FAILED ${message}`)
    ctx.logger?.error?.(`spike-ltm: 加载失败（插件已停用）：${message}`)
  }
}
