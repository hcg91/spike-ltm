import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

test('host tool and UI summary use trusted session workspace, including context switch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-project-host-')), tools = new Map(), routes = [], dispose = []
  const sessions = new Map([['a', { id: 'a', header: { cwd: join(dir, 'first', 'same') } }], ['b', { id: 'b', header: { cwd: join(dir, 'second', 'same') } }]])
  let synthesisPrompt = ''
  for (const session of sessions.values()) session.requestHeader = () => ({ config: { provider:'deepseek-account', model:'fixture' } })
  const ctx = { logger: {}, get: name => ctx[name], sessions: { get: id => sessions.get(id) }, on() {},
    llm: { async *stream(request) {
      assert.equal(request.provider, 'deepseek-account')
      synthesisPrompt = JSON.stringify(request.messages)
      const id = synthesisPrompt.match(/\[([a-f0-9-]{36})\]/)[1]
      yield { type:'text-delta', text:JSON.stringify({sections:[{title:'A summary',bullets:[{text:'A-only summary',refs:[id]}]}]}) }
      yield { type:'finish', reason:{kind:'stop'} }
    } },
    effect(fn) { dispose.push(fn()) }, inject: (_, fn) => fn(ctx),
    tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { context() {} },
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
  }
  t.after(() => { dispose.forEach(fn => fn?.()); rmSync(dir, { recursive: true, force: true }) })
  apply(ctx, { dir, autoSynthesize: false, semantic: false, uiSource: 'live' })
  const a = { agent: { session: sessions.get('a') } }, b = { agent: { session: sessions.get('b') } }
  const saved = await tools.get('ltm_save').execute({ text: 'A-only fact', scope: 'project' }, a)
  assert.equal(saved.ok, true)
  await tools.get('ltm_save').execute({ text:'B-only fact', scope:'project' }, b)
  const rebuilt = await tools.get('ltm_profile').execute({ rebuild:true }, a)
  assert.equal(rebuilt.ok, true)
  assert.match(rebuilt.profile, /A-only summary/)
  assert.doesNotMatch(synthesisPrompt, /B-only fact/)
  assert.equal((await tools.get('ltm_list').execute({}, b)).count, 1)
  const stolen = await tools.get('ltm_save').execute({ id: saved.id, scope: 'project', expectedVersion: 1, text: 'steal' }, b)
  assert.equal(stolen.ok, false)
  const view = routes.find(r => r.path.endsWith('/summary/view'))
  const get = async id => (await (await view.fetch(new Request('http://test/api/spike-ltm/ui/summary/view' + (id ? '?sessionId=' + id : '')))).json())
  assert.match(JSON.stringify(await get('a')), /A-only/)
  assert.doesNotMatch(JSON.stringify(await get('b')), /A-only/)
  assert.doesNotMatch(JSON.stringify(await get()), /A-only/)
  assert.equal((await get('fake')).ok, false)
  sessions.get('a').header.cwd = sessions.get('b').header.cwd
  assert.doesNotMatch(JSON.stringify(await get('a')), /A-only/)
})
