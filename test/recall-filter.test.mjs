import test from 'node:test'
import assert from 'node:assert/strict'
import { filterRecall } from '../lib/recall-filter.js'
const route={provider:'deepseek-account',model:'fixture'}
const candidates=[{id:'i1',text:'用户练习中提琴。'},{id:'i2',text:'用户使用某相机。'}]
test('relevance filter uses the selected account and accepts only supplied identifiers', async()=>{
 let received
 const llm={async *stream(request){received=request;yield {type:'text-delta',text:'{"ids":["i1"]}'};yield {type:'finish',reason:{kind:'stop'}}}}
 const result=await filterRecall({llm,route,query:'我的乐器是什么？',candidates})
 assert.deepEqual([...result],['i1']);assert.equal(received.provider,'deepseek-account')
 assert.equal(received.reasoningEffort,'off')
 assert.match(received.messages[0].content[0].text,/中提琴/)
 const bad={async *stream(){yield {type:'text-delta',text:'{"ids":["stolen"]}'};yield {type:'finish',reason:{kind:'stop'}}}}
 await assert.rejects(filterRecall({llm:bad,route,query:'x',candidates}),/RECALL_FILTER_INVALID/)
})
test('a stuck or truncated relevance call fails without approving candidates',async()=>{
 let signal
 const stuck={async *stream(request){signal=request.signal;await new Promise(()=>{})}}
 await assert.rejects(filterRecall({llm:stuck,route,query:'x',candidates,timeoutMs:5}),/RECALL_FILTER_TIMEOUT/)
 assert.equal(signal.aborted,true)
 const short={async *stream(){yield {type:'text-delta',text:'{"ids":["i1"]}'};yield {type:'finish',reason:{kind:'max-tokens'}}}}
 await assert.rejects(filterRecall({llm:short,route,query:'x',candidates}),/RECALL_FILTER_INCOMPLETE/)
})
