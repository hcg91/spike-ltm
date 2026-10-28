/** Durable outbox. A lease token fences every mutation, including final commit. */
import { createHash, randomUUID } from 'node:crypto'
import { transaction } from './db.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class JobStore {
  constructor({ db, logger = console, now = Date.now }) { this.db = db; this.logger = logger; this.now = now }
  enqueue({ kind = 'extract', sessionId = null, eventSeq = null, eventId = null, scopeId = null, payload = null, provider = null, model = null }) {
    const key = hash([kind, sessionId, eventId ?? eventSeq ?? randomUUID()])
    const payloadHash = hash([scopeId, payload, provider, model])
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT id,payload_hash FROM jobs WHERE dedupe_key=?').get(key)
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new Error('JOB_CONFLICT')
        return { id: prior.id, inserted: false }
      }
      const id = randomUUID(), at = this.now()
      this.db.prepare("INSERT INTO jobs(id,kind,session_id,event_seq,event_id,scope_id,dedupe_key,payload_hash,state,stage,payload,provider,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending','queued',?,?,?,?,?)")
        .run(id, kind, sessionId, eventSeq, eventId, scopeId, key, payloadHash, JSON.stringify(payload), provider, model, at, at)
      if (sessionId && Number.isSafeInteger(eventSeq)) this.setCursor(sessionId, eventSeq)
      return { id, inserted: true }
    })
  }
  claim({ leaseMs = 90000 } = {}) {
    this.recover()
    return transaction(this.db, () => {
      const at = this.now()
      const row = this.db.prepare("SELECT * FROM jobs WHERE state IN ('pending','retry') AND next_attempt_at<=? ORDER BY created_at,id LIMIT 1").get(at)
      if (!row) return null
      const token = randomUUID()
      this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?").run(token, at + leaseMs, at, row.id)
      return this.get(row.id)
    })
  }
  get(id) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    if (!r) return null
    return { id: r.id, kind: r.kind, sessionId: r.session_id, eventSeq: r.event_seq, scopeId: r.scope_id,
      state: r.state, attempts: r.attempts, modelAttempts: r.model_attempts, leaseToken: r.lease_token,
      payload: r.payload ? JSON.parse(r.payload) : null, result: r.result ? JSON.parse(r.result) : null,
      provider: r.provider, model: r.model }
  }
  assertLease(id, token) {
    if (!token || !this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND state='running' AND lease_until>?").get(id, token, this.now())) throw new Error('LEASE_LOST')
  }
  guarded(sql, params, id, token) {
    const result = this.db.prepare(sql + " AND lease_token=? AND state='running' AND lease_until>?").run(...params, token, this.now())
    if (result.changes !== 1) throw new Error('LEASE_LOST')
  }
  renew(id, token, leaseMs = 90000) {
    this.assertLease(id, token)
    this.guarded('UPDATE jobs SET lease_until=? WHERE id=?', [this.now() + leaseMs, id], id, token)
  }
  beginModelAttempt(id, token) {
    this.assertLease(id, token)
    if (this.db.prepare("UPDATE jobs SET model_attempts=model_attempts+1 WHERE id=? AND model_attempts<3 AND lease_token=? AND state='running' AND lease_until>?").run(id, token, this.now()).changes !== 1) throw new Error('MODEL_ATTEMPTS_EXHAUSTED')
  }
  stage(id, token, result) {
    this.assertLease(id, token)
    this.guarded("UPDATE jobs SET stage='generated',result=?,updated_at=? WHERE id=?", [JSON.stringify(result), this.now(), id], id, token)
  }
  complete(id, token) {
    this.assertLease(id, token)
    this.guarded("UPDATE jobs SET state='completed',stage='done',lease_token=NULL,lease_until=NULL,payload=NULL,result=NULL,error=NULL,updated_at=? WHERE id=?", [this.now(), id], id, token)
  }
  fail(id, token, error, { backoffMs = 5000 } = {}) {
    this.assertLease(id, token)
    const row = this.get(id), dead = row.modelAttempts >= 3 || row.attempts >= 6
    // Raw provider errors may contain request text or credentials; only record a code.
    const code = /^[A-Z_]{3,60}$/.test(String(error?.message ?? error)) ? String(error?.message ?? error) : 'MODEL_FAILED'
    this.guarded("UPDATE jobs SET state=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,error=?,payload=CASE WHEN ? THEN NULL ELSE payload END,result=CASE WHEN ? THEN NULL ELSE result END,updated_at=? WHERE id=?", [dead ? 'dead' : 'retry', this.now() + backoffMs * row.attempts, code, +dead, +dead, this.now(), id], id, token)
    return { state: dead ? 'dead' : 'retry' }
  }
  cancel(id) { this.db.prepare("UPDATE jobs SET state='cancelled',payload=NULL,result=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('pending','running','retry')").run(this.now(), id) }
  recover() {
    const at = this.now()
    const dead = this.db.prepare("UPDATE jobs SET state='dead',error='ATTEMPTS_EXHAUSTED',payload=NULL,result=NULL,lease_token=NULL,lease_until=NULL WHERE state IN ('pending','retry','running') AND (model_attempts>=3 OR attempts>=6) AND result IS NULL AND (state!='running' OR lease_until<=?)").run(at).changes
    const retry = this.db.prepare("UPDATE jobs SET state='retry',lease_token=NULL,lease_until=NULL,next_attempt_at=0 WHERE state='running' AND lease_until<=?").run(at).changes
    return Number(dead + retry)
  }
  status() {
    const counts = Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) AS n FROM jobs GROUP BY state').all().map(r => [r.state, r.n]))
    return { counts, lastError: this.db.prepare('SELECT error FROM jobs WHERE error IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get()?.error ?? null }
  }
  pendingCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('pending','running','retry')").get().n }
  cursor(sessionId) { return this.db.prepare('SELECT last_seq FROM session_cursors WHERE session_id=?').get(sessionId)?.last_seq ?? 0 }
  setCursor(sessionId, seq) {
    this.db.prepare('INSERT INTO session_cursors(session_id,last_seq,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at').run(sessionId, seq, this.now())
  }
}
