/**
 * 仅用于没有数据库的测试环境的内存队列。
 * 正式运行必须使用 store/jobs.js 的 SQLite JobStore。
 */
export function createMemoryJobQueue() {
  const rows = []
  let seq = 0
  return {
    enqueue(input) {
      const same = input.eventSeq == null ? undefined : rows.find((row) => row.kind === input.kind
        && row.sessionId === input.sessionId && row.eventSeq === input.eventSeq)
      if (same !== undefined) return { id: same.id, inserted: false }
      const id = `mem-${++seq}`
      rows.push({
        id, kind: input.kind ?? 'extract', sessionId: input.sessionId ?? null,
        eventSeq: input.eventSeq ?? null, state: 'pending', attempts: 0,
        payload: input.payload ?? null, provider: input.provider ?? null, model: input.model ?? null,
      })
      return { id, inserted: true }
    },
    claim() {
      const row = rows.find((entry) => entry.state === 'pending' || entry.state === 'retry')
      if (row === undefined) return null
      row.state = 'running'
      row.attempts += 1
      return { ...row }
    },
    complete(id) { const row = rows.find((entry) => entry.id === id); if (row) row.state = 'completed' },
    fail(id) { const row = rows.find((entry) => entry.id === id); if (row) row.state = 'dead' },
    recover() { return 0 },
    status() { return { counts: {}, lastError: null } },
    setCursor() {},
  }
}
