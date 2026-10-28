import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryStore } from '../lib/store/factory.js'
import { transaction } from '../lib/store/db.js'
import { extractionTargets } from '../lib/retrieval.js'

test('10000 synthetic facts survive reopen; warm storage and prompt budgets stay bounded', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-scale-'))
  let store = openMemoryStore({ dir })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  // Use actual service writes; an outer batch is deliberately not used to hide per-write failures.
  for (let i = 0; i < 10000; i++) await store.core.save(`合成设备型号 E${i} 用于场景 ${i}`, { kind: 'fact' })
  store.close(); store = openMemoryStore({ dir })
  assert.equal(store.core.inspect().items.length, 10000)
  const targets = store.core.embeddingTargets().items
  store.core.rememberVectors(targets.slice(0, 65), targets.slice(0, 65).map(() => [.1,.2,.3]), 'fixture', store.core.inspect().revision)
  store.close(); store = openMemoryStore({ dir })
  assert.equal(store.core.readVectors('fixture').size, 65)
  assert.equal(store.core.readVectors('wrong-model').size, 0)
  const timings = []
  for (let run = 0; run < 20; run++) {
    const started = performance.now()
    const state = store.core.inspect()
    const subset = extractionTargets(state.items, '设备 E9900 型号改了')
    assert.ok(subset.length <= 60)
    assert.ok(subset.some(i => i.text.includes('E9900')))
    assert.ok(JSON.stringify(subset).length < 17000)
    timings.push(performance.now() - started)
  }
  const p95 = timings.sort((a,b) => a-b)[18]
  t.diagnostic(`10k storage read + extraction shortlist p95=${p95.toFixed(1)}ms (no model calls)`)
  assert.ok(p95 < 2000)
  const snapshot = store.core.refreshSnapshot('test', {}, { entries: new Map(targets.map(t => [t.id, .9])) })
  assert.ok(snapshot.ids.length <= 4)
  assert.ok(snapshot.text.length < 1000)
  const id = targets[0].id
  await store.core.forgetItem({ id, scope: 'global', expectedVersion: 1 })
  assert.equal(store.core.readVectors('fixture').size, 64)
})
