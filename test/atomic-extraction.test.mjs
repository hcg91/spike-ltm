import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { openMemoryStore } from '../lib/store/factory.js'

const candidate = text => ({ text, decision: 'save', kind: 'fact', scope: 'global', importance: 'medium', confidence: 'high' })

test('an auto update cannot reintroduce exact forgotten text through another active item',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forgotten-update-')),store=openMemoryStore({dir})
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
 const {core,jobs}=store
 await core.save('用户住在北京')
 await core.forget('北京')
 await core.save('用户偏好茶')
 const target=core.inspect().items[0]
 jobs.enqueue({sessionId:'s',eventSeq:1,scopeId:core.scopeIdFor('global'),payload:{epoch:core.captureEpoch()}})
 const job=jobs.claim()
 const result=await core.commitExtraction({jobs,job,targets:[target],candidates:[{...candidate('用户住在北京'),decision:'update',targetId:target.id}]})
 assert.equal(result.updated,0)
 assert.deepEqual(core.inspect().items.map(i=>i.text),['用户偏好茶'])
})
test('failing second candidate rolls back first candidate and job completion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-atomic-')), store = openMemoryStore({ dir })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const { core, jobs, db } = store
  jobs.enqueue({ sessionId: 's', eventSeq: 1, scopeId: core.scopeIdFor('global'), payload: { epoch: core.captureEpoch() } })
  const job = jobs.claim()
  db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON memories WHEN new.text='second' BEGIN SELECT RAISE(ABORT,'injected'); END")
  await assert.rejects(core.commitExtraction({ jobs, job, targets: [], candidates: [candidate('first'), candidate('second')] }), /injected/)
  assert.equal(core.inspect().items.length, 0)
  assert.equal(jobs.get(job.id).state, 'running')
  db.exec('DROP TRIGGER inject_failure')
  await core.commitExtraction({ jobs, job, targets: [], candidates: [candidate('first'), candidate('second')] })
  assert.equal(core.inspect().items.length, 2)
  assert.equal(jobs.get(job.id).state, 'completed')
  await assert.rejects(core.commitExtraction({ jobs, job, targets: [], candidates: [candidate('first')] }), /LEASE_LOST/)
})

for (const point of ['queued', 'claimed', 'generated', 'committed']) test(`abrupt child exit after ${point} recovers without duplicate facts`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-crash-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const moduleUrl = new URL('../lib/store/factory.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openMemoryStore } from ${JSON.stringify(moduleUrl)};
    const {core,jobs}=openMemoryStore({dir:${JSON.stringify(dir)}});
    jobs.enqueue({sessionId:'s',eventSeq:1,scopeId:core.scopeIdFor('global'),payload:{epoch:core.captureEpoch()}});
    if (${JSON.stringify(point)}==='queued') process.exit(17);
    const job=jobs.claim({leaseMs:2000});
    if (${JSON.stringify(point)}==='claimed') process.exit(17);
    const result={targets:[],candidates:[${JSON.stringify(candidate('durable fact'))}]};
    jobs.stage(job.id,job.leaseToken,result);
    if (${JSON.stringify(point)}==='generated') process.exit(17);
    await core.commitExtraction({jobs,job,...result});
    process.exit(17);
  `], { encoding: 'utf8' })
  assert.equal(child.status, 17, child.stderr)
  await new Promise(r => setTimeout(r, 2200))
  const store = openMemoryStore({ dir })
  try {
    const job = store.jobs.claim()
    if (point === 'committed') assert.equal(job, null)
    else {
      assert.ok(job)
      const result = job.result ?? { targets: [], candidates: [candidate('durable fact')] }
      await store.core.commitExtraction({ jobs: store.jobs, job, ...result })
    }
    assert.deepEqual(store.core.inspect().items.map(i => i.text), ['durable fact'])
    assert.equal(store.jobs.status().counts.completed, 1)
  } finally { store.close() }
})
