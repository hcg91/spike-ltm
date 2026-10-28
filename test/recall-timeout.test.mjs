import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __setSemanticScorerForTest } from '../lib/index.js'

test('a completed recall cannot fire its timeout during the following request', async t => {
  const dir=mkdtempSync(join(tmpdir(),'ltm-recall-timer-')), cleanup=[]
  let preStep, timeoutCalls=0
  const ctx={logger:{},get(){},on(name,fn){if(name==='agent/pre-step')preStep=fn},
    tools:{register(){}},systemPrompt:{context(){}},effect(fn){cleanup.push(fn())}}
  t.after(()=>{__setSemanticScorerForTest(null);cleanup.forEach(fn=>fn?.());rmSync(dir,{recursive:true,force:true})})
  apply(ctx,{dir,autoExtract:false,semanticInitTimeoutMs:10,semanticTimeoutMs:10})
  __setSemanticScorerForTest(async()=>({ok:true,entries:new Map(),bullets:new Map(),ms:1}))
  const realTimeout=globalThis.setTimeout
  const mocked=t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>realTimeout(()=>{if(ms===10)timeoutCalls++;fn(...args)},ms))
  await preStep({agent:{},messages:[{source:{kind:'user'},content:[{type:'text',text:'test'}]}]},async()=>({kind:'enter'}))
  mocked.mock.restore()
  await new Promise(resolve=>realTimeout(resolve,25))
  assert.equal(timeoutCalls,0,'已完成召回的超时回调仍然触发，会中断后续嵌入请求')
})
