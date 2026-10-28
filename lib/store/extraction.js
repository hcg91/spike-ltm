import { createHash, randomUUID } from 'node:crypto'
import { invalidateProfiles, bumpEpoch, bumpRevision, transaction } from './db.js'

/** Facts, versions, provenance, invalidation, and job acknowledgement commit together. */
export function commitExtraction({ db, core, service, jobs, job, candidates, targets }) {
  return service.enqueue(() => transaction(db, () => {
    jobs.assertLease(job.id, job.leaseToken)
    if (core.captureEpoch() !== job.payload.epoch) {
      jobs.cancel(job.id)
      return { saved: 0, updated: 0, stale: true }
    }
    let saved = 0, updated = 0
    const targetMap = new Map(targets.map(t => [t.id, t])), touched = new Set()
    for (const c of candidates) {
      if (saved + updated >= 12) break
      if (!['save','update'].includes(c.decision) || c.importance === 'low' || c.confidence === 'low') continue
      if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 200) continue
      let scopeId
      try { scopeId = core.scopeIdFor(c.scope) } catch { continue }
      const at = Date.now(), text = c.text.trim()
      if (service.isForgotten({ scopeId, text })) continue
      if (c.decision === 'update') {
        const prior = targetMap.get(c.targetId)
        if (!prior || prior.scope !== c.scope || c.confidence !== 'high' || touched.has(prior.id)) continue
        const row = service.get({ id: prior.id, scopeIds: core.allowedScopes() })
        if (!row || row.scope_id !== scopeId || row.version !== prior.version || row.text === text) continue
        const revision = bumpRevision(db), version = row.version + 1
        db.prepare('UPDATE memories SET text=?,version=?,revision=?,updated_at=? WHERE id=?').run(text, version, revision, at, row.id)
        db.prepare('INSERT INTO memory_versions(memory_id,version,snapshot,reason,created_at) VALUES(?,?,?,?,?)').run(row.id, version, JSON.stringify({ ...row, text, version }), 'auto-update', at)
        db.prepare('DELETE FROM vectors WHERE memory_id=?').run(row.id)
        invalidateProfiles(db, [row.id])
        db.prepare('INSERT INTO memory_sources(memory_id,session_id,event_seq,excerpt,created_at) VALUES(?,?,?,?,?)').run(row.id, job.sessionId, job.eventSeq, c.evidence?.slice(0, 200) ?? '', at)
        touched.add(row.id)
        bumpEpoch(db, scopeId)
        updated++
      } else {
        if (db.prepare("SELECT 1 FROM memories WHERE scope_id=? AND text=? AND status='active'").get(scopeId, text)) continue
        const id = randomUUID(), revision = bumpRevision(db)
        db.prepare("INSERT INTO memories(id,scope_id,kind,text,source,importance,confidence,status,protected,version,revision,reason,created_at,updated_at) VALUES(?,?,?,?,'auto',?,?,'active',0,1,?,?,?,?)")
          .run(id, scopeId, c.kind, text, c.importance, c.confidence, revision, c.reason ?? '', at, at)
        db.prepare('INSERT INTO memory_versions(memory_id,version,snapshot,reason,created_at) VALUES(?,1,?,?,?)').run(id, JSON.stringify({ text, kind: c.kind }), 'auto-created', at)
        db.prepare('INSERT INTO memory_sources(memory_id,session_id,event_seq,excerpt,created_at) VALUES(?,?,?,?,?)').run(id, job.sessionId, job.eventSeq, c.evidence?.slice(0, 200) ?? '', at)
        saved++
      }
    }
    jobs.complete(job.id, job.leaseToken)
    return { saved, updated }
  }))
}
