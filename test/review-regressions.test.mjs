import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCore } from '../lib/core.js'
import { openMemoryStore } from '../lib/store/factory.js'
function temp(t) { t.cleanupStores = []; const dir = mkdtempSync(join(tmpdir(), 'ltm-review-')); t.after(() => { t.cleanupStores.forEach(s => s.close()); rmSync(dir, { recursive: true, force: true }) }); return dir }
test('legacy project records stay quarantined without writing or migrating JSON', async t => {
  const dir = temp(t), file = join(dir, 'memory.json')
  const bytes = JSON.stringify({ items: [{ id:'p',text:'project secret',scope:'project' },{id:'g',text:'public',scope:'global'}] })
  writeFileSync(file, bytes)
  const store = openMemoryStore({ dir }); t.cleanupStores.push(store)
  assert.deepEqual(store.core.inspect().items.map(i => i.id), ['g'])
  await assert.rejects(Promise.resolve().then(() => store.core.save('new project', { scope:'project' })), /PROJECT_UNBOUND/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
})
test('all ordinary JSON writes reject corrupted or externally changed source bytes', t => {
  const dir = temp(t), file = join(dir,'memory.json')
  writeFileSync(file, '{"items":["recoverable"')
  const core = createCore({ dir, logger:{} })
  assert.throws(() => core.save('overwrite'), /STORAGE_UNREADABLE/)
  assert.equal(readFileSync(file,'utf8'), '{"items":["recoverable"')
  writeFileSync(file, '{"items":[]}')
  const other = createCore({ dir, logger:{} })
  writeFileSync(file, '{"items":[],"revision":100}')
  assert.throws(() => other.forget('anything'), /STORAGE_CHANGED/)
  writeFileSync(file, '{"unrecognized":"preserve"}')
  const invalidShape = createCore({ dir, logger:{} })
  assert.throws(() => invalidShape.save('overwrite'), /STORAGE_UNREADABLE/)
  assert.equal(readFileSync(file,'utf8'), '{"unrecognized":"preserve"}')
})
test('forget on another connection immediately fences an already prepared snapshot', async t => {
  const dir = temp(t), a = openMemoryStore({ dir }), b = openMemoryStore({ dir }); t.cleanupStores.push(a, b)
  t.after(() => { a.close(); b.close() })
  const receipt = await a.core.save('secret')
  const agent = {}
  a.core.refreshSnapshot('secret', agent, { entries: new Map([[receipt.id,.9]]) })
  await b.core.forget('secret')
  assert.equal(a.core.providerText(agent), '')
})
test('another host process cannot mutate a live writer database', t => {
  const dir = temp(t), a = openMemoryStore({ dir }); t.cleanupStores.push(a); t.after(() => a.close())
  const file = new URL('../lib/store/factory.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module','-e', `import {openMemoryStore} from ${JSON.stringify(file)}; try { const s=openMemoryStore({dir:${JSON.stringify(dir)}}); s.close(); process.exit(8) } catch(e) { process.exit(e.message==='STORAGE_IN_USE' ? 0 : 9) }`])
  assert.equal(child.status, 0)
})
test('a cancellation between lease check and mutation cannot resurrect or refill the job', t => {
  const dir = temp(t), a = openMemoryStore({ dir }), b = openMemoryStore({ dir }); t.cleanupStores.push(a, b); t.after(() => { a.close(); b.close() })
  a.jobs.enqueue({ sessionId:'s',eventSeq:1,payload:{utterance:'secret'} })
  const job = a.jobs.claim()
  const original = a.jobs.assertLease.bind(a.jobs)
  a.jobs.assertLease = (...args) => { original(...args); b.jobs.cancel(job.id) }
  assert.throws(() => a.jobs.fail(job.id,job.leaseToken,new Error('FAIL')), /LEASE_LOST/)
  assert.equal(a.jobs.get(job.id).state, 'cancelled')
  assert.equal(a.jobs.get(job.id).payload, null)
})
test('changing project A preserves independent user-edited project B summary', async t => {
  const dir = temp(t), store = openMemoryStore({ dir }); t.cleanupStores.push(store); t.after(() => store.close())
  const a = store.core.forContext({workspacePath:join(dir,'a')}), b = store.core.forContext({workspacePath:join(dir,'b')})
  const one = await a.save('A fact',{scope:'project'}), two = await b.save('B fact',{scope:'project'})
  await b.setProfile({sections:[{title:'B edited title',bullets:[{text:'B user phrasing',refs:[two.id]}]}]})
  await a.updateItem({id:one.id,scope:'project',expectedVersion:1,text:'A changed'})
  assert.equal(b.inspect().profile.sections[0].bullets[0].text, 'B user phrasing')
})

test('forgetting global facts immediately scrubs project jobs that could carry those facts', async t => {
  const dir = temp(t), store = openMemoryStore({dir}); t.cleanupStores.push(store)
  const b = store.core.forContext({workspacePath:join(dir,'b')})
  const saved = await store.core.save('global secret')
  const queued = store.jobs.enqueue({scopeId:b.scopeIdFor('project'),sessionId:'b',eventSeq:1,payload:{utterance:'global secret'}})
  await store.core.forgetItem({id:saved.id,scope:'global',expectedVersion:1})
  assert.equal(store.jobs.get(queued.id).state,'cancelled')
  assert.equal(store.jobs.get(queued.id).payload,null)
})
