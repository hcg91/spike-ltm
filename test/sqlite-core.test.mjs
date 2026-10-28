import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../lib/store/db.js'
import { MemoryService } from '../lib/store/service.js'
import { createSqliteCore } from '../lib/store/core.js'
import { createSummaryService } from '../lib/memory-summary.js'

export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-core-'))
  const { db } = openDatabase(join(dir, 'test.db'))
  const service = new MemoryService({ db })
  const core = createSqliteCore({ db, service })
  t.after(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })
  return { db, service, core, dir }
}

test('forget even with zero stored matches fences an in-flight extraction', async t => {
  const { core } = fixture(t)
  const epoch = core.captureEpoch()
  await core.forget('secret')
  await assert.rejects(core.saveIfEpoch('secret', epoch), /FORGET_EPOCH_CHANGED/)
  assert.equal(core.inspect().items.length, 0)
})

test('forget invalidates stored profile and all its derived targets immediately', async t => {
  const { core } = fixture(t)
  const saved = await core.save('camera')
  await core.setProfile({ sections: [{ title: 'Equipment', bullets: [{ text: 'camera', refs: [saved.id] }] }] })
  const agent = {}
  core.refreshSnapshot('camera', agent, { entries: new Map([[saved.id, .9]]) })
  await core.forget('camera')
  assert.equal(core.providerText(agent), '')
  assert.equal(core.inspect().profile, null)
  assert.deepEqual(core.embeddingTargets(), { items: [], bullets: [] })
})

test('project writes require binding and cannot update another project by known id', async t => {
  const { core, dir } = fixture(t)
  await assert.rejects(core.save('unbound', { scope: 'project' }), /PROJECT_UNBOUND/)
  const a = core.forContext({ workspacePath: join(dir, 'a') })
  const b = core.forContext({ workspacePath: join(dir, 'b') })
  const saved = await a.save('project A', { scope: 'project' })
  assert.equal(b.inspect().items.length, 0)
  await assert.rejects(b.updateItem({ id: saved.id, scope: 'project', expectedVersion: 1, text: 'stolen' }), /NOT_FOUND|SCOPE_DENIED/)
  assert.throws(() => b.itemVersions(saved.id), /NOT_FOUND|SCOPE_DENIED/)
})

test('profile write advances revision, rejects invalid refs, and injection performs no SQL', async t => {
  const { core, db } = fixture(t)
  const saved = await core.save('camera')
  const before = core.inspect().revision
  await core.setProfile({ sections: [{ title: 'Gear', bullets: [{ text: 'camera', refs: [saved.id] }] }] }, before)
  assert.ok(core.inspect().revision > before)
  await assert.rejects(core.setProfile({ sections: [{ title: 'bad', bullets: [{ text: 'invented', refs: ['missing'] }] }] }), /SCOPE_DENIED|INVALID_PROFILE/)
  const agent = {}
  core.refreshSnapshot('camera', agent, { entries: new Map([[saved.id, .9]]) })
  const prepare = db.prepare
  db.prepare = () => { throw new Error('provider must not query SQL') }
  try { assert.match(core.providerText(agent), /camera/) } finally { db.prepare = prepare }
})

test('summary apply waits for committed writes and failed CAS cannot reuse preview', async t => {
  const { core } = fixture(t)
  const saved = await core.save('old')
  const summary = createSummaryService({ core, callModel: async () => JSON.stringify({ reply: 'edit', text: 'new', changes: [{ id: saved.id, text: 'new' }] }) })
  const view = summary.snapshot()
  const draft = await summary.propose({ sectionId: view.sections[0].id, expectedRevision: view.revision })
  const result = await summary.apply({ token: draft.proposal.token })
  assert.ok(result.sections.some(s => s.text.includes('new')))
  assert.equal(core.inspect().items[0].text, 'new')
  await assert.rejects(Promise.resolve().then(() => summary.apply({ token: draft.proposal.token })), /PROPOSAL_EXPIRED/)
})
