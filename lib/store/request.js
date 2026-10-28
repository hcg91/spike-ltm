/* 管理请求取消、超时和结算；结束后移除记录并清理计时器。 */
import { randomUUID } from 'node:crypto'

export class RequestRegistry {
  constructor({ generation = 0 } = {}) {
    this.generation = generation
    this.requests = new Map()
    this.settled = 0
    this.cancelled = 0
    this.expired = 0
  }

  create({ sessionId = null, revision = 0, epoch = 0, deadlineMs = 30000, onExpire = null } = {}) {
    const id = randomUUID()
    const request = {
      id,
      sessionId,
      generation: this.generation,
      revision,
      epoch,
      state: 'pending',
      createdAt: Date.now(),
      deadlineAt: Date.now() + deadlineMs,
      timer: null,
      onExpire,
    }
    request.timer = setTimeout(() => {
      if (!this.requests.has(id)) return
      this.#settle(id, 'expired')
      this.expired += 1
      try {
        request.onExpire?.(request)
      } catch {
        // 回调失败不影响其他请求
      }
    }, deadlineMs)
    this.requests.set(id, request)
    return request
  }

  #settle(id, state) {
    const request = this.requests.get(id)
    if (request === undefined) return false
    request.state = state
    clearTimeout(request.timer)
    this.requests.delete(id)
    this.settled += 1
    return true
  }

  cancel(id, reason = 'cancelled') {
    const ok = this.#settle(id, reason)
    if (ok) this.cancelled += 1
    return ok
  }

  finish(id, outcome = 'done') {
    return this.#settle(id, outcome)
  }

  /** 结果是否还能用：请求已结算、代次/revision/epoch 变化都算过期。 */
  isStale(id, { revision, epoch } = {}) {
    const request = this.requests.get(id)
    if (request === undefined) return true
    if (request.state !== 'pending') return true
    if (request.generation !== this.generation) return true
    if (revision !== undefined && Number(revision) !== Number(request.revision)) return true
    if (epoch !== undefined && Number(epoch) !== Number(request.epoch)) return true
    return false
  }

  bumpGeneration() {
    this.generation += 1
    for (const [id] of this.requests) this.#settle(id, 'stale-generation')
    return this.generation
  }

  dispose() {
    for (const [id] of this.requests) this.#settle(id, 'disposed')
    this.requests.clear()
  }

  activeCount() {
    return this.requests.size
  }

  stats() {
    return {
      generation: this.generation,
      active: this.requests.size,
      settled: this.settled,
      cancelled: this.cancelled,
      expired: this.expired,
    }
  }
}
