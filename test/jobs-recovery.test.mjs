import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../lib/store/db.js'
import { JobStore } from '../lib/store/jobs.js'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-jobs-'))
  const { db } = openDatabase(join(dir, 'jobs.db'))
  const scopeId = db.prepare("SELECT id FROM scopes WHERE kind='global'").get().id
  let now = 1000
  const jobs = new JobStore({ db, now: () => now })
  t.after(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })
  const enqueue = (seq = 1) => jobs.enqueue({ sessionId: 's', eventSeq: seq, scopeId, payload: { utterance: 'synthetic' } })
  return { db, jobs, enqueue, advance: ms => now += ms }
}
test('recovery never steals a live lease; expired lease gets a new fencing token', t => {
  const { jobs, enqueue, advance } = setup(t)
  enqueue()
  const a = jobs.claim({ leaseMs: 100 })
  assert.equal(jobs.recover(), 0)
  assert.equal(jobs.claim(), null)
  advance(101)
  const b = jobs.claim()
  assert.notEqual(a.leaseToken, b.leaseToken)
  assert.throws(() => jobs.complete(a.id, a.leaseToken), /LEASE_LOST/)
  jobs.complete(b.id, b.leaseToken)
  assert.equal(jobs.pendingCount(), 0)
})
test('queue identity is content bound and cursors are monotonic', t => {
  const { jobs, enqueue } = setup(t)
  assert.equal(enqueue().inserted, true)
  assert.equal(enqueue().inserted, false)
  assert.throws(() => jobs.enqueue({ sessionId: 's', eventSeq: 1, payload: { utterance: 'different' } }), /JOB_CONFLICT/)
  jobs.setCursor('s', 10); jobs.setCursor('s', 3)
  assert.equal(jobs.cursor('s'), 10)
})
test('model results survive lease expiry; completed payloads are scrubbed', t => {
  const { jobs, enqueue, advance, db } = setup(t)
  enqueue()
  const a = jobs.claim({ leaseMs: 10 })
  jobs.stage(a.id, a.leaseToken, { candidates: [], targets: [] })
  advance(11)
  const b = jobs.claim()
  assert.deepEqual(b.result, { candidates: [], targets: [] })
  jobs.complete(b.id, b.leaseToken)
  assert.equal(db.prepare('SELECT payload FROM jobs WHERE id=?').get(b.id).payload, null)
})
test('attempt budget survives crashes and reaches dead instead of looping forever', t => {
  const { jobs, enqueue, advance } = setup(t)
  enqueue()
  for (let i = 0; i < 3; i++) {
    const job = jobs.claim({ leaseMs: 10 })
    jobs.beginModelAttempt(job.id, job.leaseToken)
    advance(11)
  }
  jobs.recover()
  assert.equal(jobs.claim(), null)
  assert.equal(jobs.status().counts.dead, 1)
})
