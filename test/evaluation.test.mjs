import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { runSuite } from '../eval/run.js'

const scenarios = [{id:'fixture',steps:[{op:'ingest',text:'input only'},{op:'ask',text:'question',expected:['answer'],forbidden:['wrong']}]}]
test('evaluation isolates data and expected answers, scores failures and cleans the adapter', async () => {
  let path, closed = false
  const result = await runSuite({scenarios,createAdapter:({dir}) => {
    path = dir
    return {ingest:input => assert.deepEqual(Object.keys(input).sort(),['project','signal','text']),
      ask:() => ({text:'wrong',finish:'stop'}),close:() => {closed = true}}
  }})
  assert.equal(result.completed,true); assert.equal(result.failed,1); assert.equal(result.passed,0)
  assert.equal(closed,true); assert.equal(existsSync(path),false)
})
test('evaluation never calls unfinished, aborted or malformed answers successful', async () => {
  const result = await runSuite({scenarios,createAdapter:() => ({ingest(){},ask:() => ({text:'answer',finish:'max-tokens'})})})
  assert.equal(result.completed,false); assert.equal(result.errors,1); assert.equal(result.unanswered,1)
  const timed = await runSuite({scenarios,timeoutMs:5,createAdapter:() => ({ingest:() => new Promise(() => {})})})
  assert.equal(timed.cases[0].error,'EVAL_TIMEOUT'); assert.equal(timed.passed,0)
  await assert.rejects(runSuite({scenarios:[{id:'x',steps:[{op:'ask',text:'x',expected:[]}]}]}), /MISSING_EXPECTATION/)
})
