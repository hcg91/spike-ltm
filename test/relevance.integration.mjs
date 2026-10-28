import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCore} from '../lib/core.js'
import {semanticScores} from '../lib/index.js'
import {disposeSemantic} from '../lib/semantic.js'

test('real embeddings shortlist an instrument; model decisions exclude unrelated exercise and stale writes', async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-relevance-'))
 t.after(()=>{disposeSemantic();rmSync(dir,{recursive:true,force:true})})
 const core=createCore({dir}), route={provider:'deepseek-account',model:'fixture'}
 const {item}=core.save('用户练习中提琴，每周三晚上上课。',{source:'auto',kind:'preference'})
 let requested=false, invalidate=false
 const llm={async *stream(request){
   requested=true
   const prompt=request.messages[0].content[0].text
   assert.match(prompt,/中提琴/)
   if(invalidate)core.forget('中提琴')
   const ids=prompt.includes('我练的乐器是什么')?[`item:${item.id}`]:[]
   yield {type:'text-delta',text:JSON.stringify({ids})};yield {type:'finish',reason:{kind:'stop'}}
 }}
 let scores=await semanticScores(core,'我练的乐器是什么？',{}, {llm,route})
 assert.equal(requested,true);assert.equal(scores.ok,true,JSON.stringify(scores));assert.equal(scores.entries.get(item.id),1)
 assert.match(core.refreshSnapshot('我练的乐器是什么？',{},scores).text,/中提琴/)
 scores=await semanticScores(core,'我想开始力量训练，怎么安排',{}, {llm,route})
 assert.equal(core.refreshSnapshot('我想开始力量训练，怎么安排',{},scores).text,'')
 assert.equal(core.inspect().items[0].text,'用户练习中提琴，每周三晚上上课。')
 invalidate=true
 scores=await semanticScores(core,'我练的乐器是什么？',{}, {llm,route})
 assert.equal(scores.degraded,true);assert.equal(scores.reason,'stale-revision')
})
