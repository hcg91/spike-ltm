/* 管理向量子进程和请求队列。旧进程事件丢弃，退出时结算等待请求。 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const MODEL_ID = process.env.LTM_EMBEDDING_MODEL ?? 'Xenova/bge-small-zh-v1.5'
const RETRY_AFTER_MS = 60000
const DEFAULT_INFER_TIMEOUT_MS = 30000
const WORKER = fileURLToPath(new URL('./embed-worker.mjs', import.meta.url))

export const SEMANTIC_STATE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  FAILED: 'failed',
})

let state = SEMANTIC_STATE.IDLE
let child = null
let nodeAttempt = 0
let nextId = 1
let pending = new Map()
let failedAt = null
let lastError = null
let lastErrorKind = null
let readyAt = null
let loadStartedAt = null
let lastInferenceMs = null
/** 进程代次：每次 spawn / stop 都 +1，旧进程的事件一律丢弃 */
let generation = 0
/** 队列计数：真实反映等待+执行中的请求数 */
let queueSize = 0
let chain = Promise.resolve()

export function semanticStatus() {
  return {
    state,
    model: MODEL_ID,
    isolated: true,
    pid: child?.pid ?? null,
    generation,
    loadStartedAt,
    readyAt,
    failedAt,
    lastError,
    lastErrorKind,
    lastInferenceMs,
    queued: queueSize,
  }
}

export function textHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
}

/** 结算所有等待请求：每个只结算一次。 */
function settleAll(reason) {
  const entries = [...pending.values()]
  pending = new Map()
  for (const entry of entries) {
    clearTimeout(entry.timer)
    if (entry.settled) continue
    entry.settled = true
    entry.reject(new Error(reason))
  }
}

/** 停止子进程：提升代次 → 旧事件失效 → 结算等待 → 杀进程。 */
function stopChild(reason) {
  generation += 1
  const handle = child
  child = null
  settleAll(reason)
  if (handle === null) return
  try {
    handle.stdin?.removeAllListeners()
    handle.stdout?.removeAllListeners()
    handle.stderr?.removeAllListeners()
    handle.removeAllListeners('exit')
    handle.removeAllListeners('error')
    handle.stdin?.destroy()
    handle.kill()
  } catch {
    // 进程可能已退出
  }
}

function markFailed(kind, reason, logger) {
  state = SEMANTIC_STATE.FAILED
  failedAt = Date.now()
  lastError = String(reason).slice(0, 300)
  lastErrorKind = kind
  stopChild(`semantic failed: ${kind}`)
  logger?.warn?.(`spike-ltm: 语义不可用（${kind}，${RETRY_AFTER_MS / 1000}s 后重试）：${lastError}`)
}

/** 测试与卸载用：彻底重置，旧请求立即结束，旧事件不再影响状态。 */
export function resetSemanticForTest() {
  generation += 1
  stopChild('semantic reset')
  state = SEMANTIC_STATE.IDLE
  failedAt = null
  lastError = null
  lastErrorKind = null
  readyAt = null
  loadStartedAt = null
  lastInferenceMs = null
  queueSize = 0
  chain = Promise.resolve()
  nodeAttempt = 0
  nextId = 1
}

/** 插件卸载 / 热重载时调用：释放子进程与监听器。 */
export function disposeSemantic() {
  resetSemanticForTest()
}

/* 超时结束等待。预热可继续；已就绪但卡住的推理进程会退出。 */
export function abandonPending(reason, logger) {
  const entries = [...pending.entries()]
  if (entries.length === 0) return false
  if (state === SEMANTIC_STATE.READY) {
    // 已就绪但推理卡住：终止子进程，避免不可取消的推理继续占用 CPU
    stopChild('abandoned inference')
    state = SEMANTIC_STATE.IDLE
    logger?.warn?.(`spike-ltm: 推理超时，已终止子进程（${reason}）`)
    return true
  }
  // 预热中：立即让宿主拿到失败，但保留条目的"回执通道"，
  // 等 worker 真正加载完成后把状态置为 ready（后台预热）
  for (const [id, entry] of entries) {
    clearTimeout(entry.timer)
    if (entry.settled) continue
    entry.settled = true
    entry.abandoned = true
    entry.reject(new Error(reason))
  }
  logger?.warn?.(`spike-ltm: 宿主等待超时，保留后台预热（${reason}）`)
  return true
}

function nodeCandidates() {
  const list = []
  if (process.env.LTM_NODE_BIN) list.push(process.env.LTM_NODE_BIN)
  list.push('node')
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) list.push(process.env.DSH_DESKTOP_NODE_EXECUTABLE)
  return [...new Set(list)]
}

function spawnWorker(logger) {
  if (child !== null) return child
  const candidates = nodeCandidates()
  if (nodeAttempt >= candidates.length) {
    markFailed('runtime', 'no usable node runtime for semantic worker', logger)
    return null
  }
  const bin = candidates[nodeAttempt]
  const myGeneration = generation + 1
  generation = myGeneration
  loadStartedAt = Date.now()
  state = SEMANTIC_STATE.LOADING

  let handle
  try {
    handle = spawn(bin, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  } catch (error) {
    nodeAttempt += 1
    state = SEMANTIC_STATE.IDLE
    lastError = String(error?.message ?? error)
    return null
  }
  child = handle

  const isStale = () => myGeneration !== generation

  handle.on('error', (error) => {
    if (isStale()) return
    if (error?.code === 'ENOENT') {
      stopChild('node-runtime-not-found')
      nodeAttempt += 1
      state = SEMANTIC_STATE.IDLE
      lastError = `spawn ENOENT: ${bin}`
      return
    }
    markFailed('spawn', String(error?.message ?? error), logger)
  })

  handle.on('exit', (code, signal) => {
    if (isStale()) return
    markFailed('exited', `worker exited (code=${code}, signal=${signal})`, logger)
  })

  // EPIPE 根因：对已退出进程写 stdin 会异步触发 'error'，没有监听器就会杀主进程
  handle.stdin?.on('error', (error) => {
    if (isStale()) return
    markFailed('stdin', `stdin ${error?.code ?? 'error'}: ${error?.message ?? error}`, logger)
  })

  if (handle.stderr) {
    const errLines = createInterface({ input: handle.stderr })
    errLines.on('line', (line) => {
      if (isStale()) return
      if (line.trim() !== '') {
        lastError = line.trim().slice(0, 300)
        lastErrorKind = 'worker-stderr'
      }
    })
    handle.stderr.on('error', () => {})
  }

  const lines = createInterface({ input: handle.stdout })
  lines.on('line', (line) => {
    if (isStale()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    // 先更新模型状态：即使请求已被放弃，加载成功也要让下一轮直接复用
    if (message.ok === true) {
      state = SEMANTIC_STATE.READY
      readyAt = Date.now()
    }
    if (entry.settled) return
    entry.settled = true
    if (message.ok === true) {
      entry.resolve(message.vectors)
    } else {
      entry.reject(new Error(String(message.error ?? 'unknown error')))
      markFailed('worker-rejected', String(message.error ?? 'unknown error'), logger)
    }
  })
  handle.stdout?.on('error', () => {})

  return handle
}

function requestVectors(texts, timeoutMs, logger) {
  const handle = spawnWorker(logger)
  if (handle === null) {
    return Promise.resolve({
      ok: false,
      reason: state === SEMANTIC_STATE.IDLE ? 'node-runtime-not-found' : `failed:${lastErrorKind ?? 'unknown'}`,
    })
  }

  const id = nextId++
  const started = Date.now()
  return new Promise((resolve) => {
    const entry = {
      settled: false,
      timer: null,
      resolve: (vectors) => resolve({ ok: true, vectors, ms: Date.now() - started }),
      reject: (error) => resolve({ ok: false, reason: error.message }),
    }
    entry.timer = setTimeout(() => {
      pending.delete(id)
      if (entry.settled) return
      entry.settled = true
      resolve({ ok: false, reason: `inference-timeout(${timeoutMs}ms)` })
      markFailed('timeout', `inference timeout after ${timeoutMs}ms`, logger)
    }, timeoutMs)
    pending.set(id, entry)

    try {
      if (handle.stdin?.destroyed || handle.stdin?.writable === false) throw new Error('stdin not writable')
      handle.stdin.write(`${JSON.stringify({ id, texts })}\n`)
    } catch (error) {
      pending.delete(id)
      clearTimeout(entry.timer)
      if (!entry.settled) {
        entry.settled = true
        resolve({ ok: false, reason: `write-failed: ${String(error?.message ?? error)}` })
      }
      markFailed('write', String(error?.message ?? error), logger)
    }
  })
}

/**
 * 批量取向量（串行队列）。
 * @returns {Promise<{ok:true, vectors:number[][], ms:number} | {ok:false, reason:string}>}
 */
export async function embed(texts, logger, timeoutMs = DEFAULT_INFER_TIMEOUT_MS) {
  if (!Array.isArray(texts) || texts.length === 0) return { ok: true, vectors: [], ms: 0 }
  if (state === SEMANTIC_STATE.FAILED && failedAt !== null && Date.now() - failedAt < RETRY_AFTER_MS) {
    return { ok: false, reason: `cooldown:${lastErrorKind ?? 'failed'}` }
  }

  queueSize += 1
  // 用同一条链串行化；queueSize 是真实计数，不靠比较 Promise 对象
  const run = chain.then(() => requestVectors(texts, timeoutMs, logger))
  chain = run.then(() => undefined, () => undefined)
  try {
    const first = await run
    if (!first.ok && String(first.reason).includes('node-runtime-not-found') && state !== SEMANTIC_STATE.FAILED) {
      // 解释器不存在：换下一个候选重试一次（不无限重试）
      return await requestVectors(texts, timeoutMs, logger)
    }
    if (first.ok) lastInferenceMs = first.ms
    return first
  } finally {
    queueSize = Math.max(0, queueSize - 1)
  }
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
