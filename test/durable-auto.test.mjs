import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryStore } from '../lib/store/factory.js'
import { installMemoryJobs } from '../lib/auto.js'

const c = text => ({ text, kind: 'fact', scope: 'global', decision: 'save', importance: 'medium', confidence: 'high' })
const settle = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('TEST_DEADLINE')
}
function setup(t, respond, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-auto-durable-')), store = openMemoryStore({ dir })
  let handler, calls = 0, release
  const ctx = { logger: {}, on: (_, fn) => { handler = fn }, llm: { async *stream(request) {
    calls++
    const text = await respond(request, store.core, calls)
    yield { type: 'text-delta', text: typeof text === 'string' ? text : JSON.stringify(text) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const runner = installMemoryJobs({ ctx, core: store.core, jobs: store.jobs, config: { autoSynthesize: false, ...config } })
  t.after(() => { runner.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const emit = (text, n = 1) => handler({ id: 's', header: {}, requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'fixture' } }), snapshotEvents: () => [{ seq: n, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }] }, { type: 'turn/end', seq: n + 1 })
  return { ...store, dir, runner, emit, calls: () => calls }
}
test('durable extraction commits provenance and skips replayed source events', async t => {
  const f = setup(t, () => [c('durable')])
  f.emit('synthetic')
  await settle(() => f.jobs.status().counts.completed === 1)
  const source = f.db.prepare('SELECT session_id,event_seq FROM memory_sources').get()
  assert.equal(source.session_id, 's'); assert.equal(source.event_seq, 1)
  assert.equal(f.core.inspect().items[0].protected, false)
  f.emit('synthetic'); await new Promise(setImmediate)
  assert.equal(f.calls(), 1)
})
test('forget during a pending call cancels and scrubs the job, late model output stays out', async t => {
  let release
  const gate = new Promise(r => { release = r })
  const f = setup(t, async () => { await gate; return [c('private')] })
  f.emit('private'); await settle(() => f.calls() === 1)
  await f.core.forget('private')
  release(); await new Promise(r => setTimeout(r, 20))
  assert.equal(f.core.inspect().items.length, 0)
  const row = f.db.prepare('SELECT state,payload,result FROM jobs').get()
  assert.equal(row.state, 'cancelled'); assert.equal(row.payload, null); assert.equal(row.result, null)
})
test('timeout aborts the request and a provider ignoring abort still cannot save late text', async t => {
  let release, signal
  const gate = new Promise(r => { release = r })
  const f = setup(t, async request => { signal = request.signal; await gate; return [c('late')] }, { autoTimeoutMs: 10 })
  f.emit('late')
  await settle(() => signal?.aborted)
  release(); await new Promise(r => setTimeout(r, 20))
  assert.equal(f.core.inspect().items.length, 0)
  assert.equal(f.jobs.status().counts.retry, 1)
})
test('profile CAS conflict retries from fresh facts and awaits the actual commit', async t => {
  const f = setup(t, async (_request, core, n) => {
    if (n === 1) await core.save('arrived during synthesis')
    return { sections: [{ title: 'Summary', bullets: core.inspect().items.map(i => ({ text: i.text, refs: [i.id] })) }] }
  })
  await f.core.save('initial')
  const result = await f.runner.synthesizeNow({ provider: 'deepseek-account', model: 'fixture' })
  assert.equal(result.sections, 1)
  assert.equal(f.calls(), 2)
  assert.match(f.core.profileText(), /arrived during synthesis/)
})

test('extraction receives trusted scope availability and keeps personal activities global', async t => {
  const f = setup(t, request => {
    const prompt = request.messages[0].content[0].text
    return [{...c('用户组织杉林桌游社'),kind:'project',scope:prompt.includes('当前工作区：未绑定')?'global':'project'}]
  })
  f.emit('我长期组织杉林桌游社。')
  await settle(() => f.jobs.status().counts.completed === 1)
  assert.equal(f.core.inspect().items[0]?.text,'用户组织杉林桌游社')
  assert.equal(f.core.inspect().items[0]?.scope,'global')
})

test('profile retry stays in its original project when another session changes the next route', async t => {
  let a,b,routeA,routeB
  const f=setup(t,async(request,_core,n)=>{
    if(n===1){await a.save('A newer fact',{scope:'project'});await f.runner.synthesizeNow(routeB)}
    const prompt=request.messages[0].content[0].text
    const rows=[...a.inspect().items,...b.inspect().items].filter(i=>prompt.includes(`[${i.id}]`))
    return {sections:[{title:'Summary',bullets:rows.map(i=>({text:i.text,refs:[i.id]}))}]}
  })
  routeA={provider:'deepseek-account',model:'fixture',context:{workspacePath:join(f.dir,'a')}}
  routeB={provider:'deepseek-account',model:'fixture',context:{workspacePath:join(f.dir,'b')}}
  a=f.core.forContext(routeA.context);b=f.core.forContext(routeB.context)
  await a.save('A original fact',{scope:'project'});await b.save('B private fact',{scope:'project'})
  await f.runner.synthesizeNow(routeA)
  assert.match(a.profileText(),/A newer fact/)
  assert.equal(b.profileText(),'')
})
