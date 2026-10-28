import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createCore} from '../lib/core.js'
import {openMemoryStore} from '../lib/store/factory.js'
import {forgetTopic} from '../lib/forget-topic.js'
import {apply} from '../lib/index.js'
const route={provider:'deepseek-account',model:'fixture'}
for(const backend of ['json','sqlite'])test(`${backend}: topic deletion resolves synonyms, keeps unrelated facts, and rejects a stale decision`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-topic-'))
 const store=backend==='sqlite'?openMemoryStore({dir}):null
 const core=store?.core??createCore({dir})
 t.after(()=>{store?.close();rmSync(dir,{recursive:true,force:true})})
 const saved=await core.save('用户养了一只名叫松糕的柯基。'), id=saved.item?.id??saved.id
 await core.save('用户住在台州。')
 await core.setProfile({sections:[{title:'生活',bullets:[{text:'松糕是用户的柯基。',refs:[id]}]}]},core.inspect().revision)
 let mutate=false
 const llm={async *stream(request){
   assert.equal(request.provider,'deepseek-account')
   assert.match(request.messages[0].content[0].text,/删除/)
   if(mutate)await core.save('并发新事实')
   yield {type:'text-delta',text:JSON.stringify({ids:[id]})};yield {type:'finish',reason:{kind:'stop'}}
 }}
 mutate=true
 await assert.rejects(forgetTopic(core,'狗',{llm,route}),/VERSION_CONFLICT/)
 assert(core.inspect().items.some(i=>i.id===id))
 mutate=false
 const result=await forgetTopic(core,'狗',{llm,route})
 assert.equal(result.removed.length,1);assert.equal(result.removed[0].id,id)
 assert(!core.inspect().items.some(i=>i.id===id));assert(core.inspect().items.some(i=>i.text.includes('台州')))
 assert(!JSON.stringify(core.inspect().profile).includes('松糕'))
 if(backend==='json')assert(!readFileSync(join(dir,'memory.json'),'utf8').includes('松糕'))
})

test('a failed semantic deletion does not claim a literal-only partial success',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-failure-')),core=createCore({dir})
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 core.save('用户养狗，也照顾一只柯基。')
 const llm={async *stream(){yield{type:'text-delta',text:'{"ids":["outside"]}'};yield{type:'finish',reason:{kind:'stop'}}}}
 await assert.rejects(forgetTopic(core,'狗',{llm,route}),/RECALL_FILTER_INVALID/)
 assert.equal(core.inspect().items.length,1)
})

test('the host forget tool uses the session account and returns the actual deleted identifier',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-host-')), tools=new Map(), cleanup=[]
 let savedId,request
 const llm={async *stream(input){request=input;yield {type:'text-delta',text:JSON.stringify({ids:[savedId]})};yield {type:'finish',reason:{kind:'stop'}}}}
 const ctx={logger:{},get(name){if(name==='llm')return llm},on(){},effect(fn){cleanup.push(fn())},systemPrompt:{context(){}},tools:{register(tool){tools.set(tool.name,tool)}}}
 t.after(()=>{cleanup.forEach(fn=>fn?.());rmSync(dir,{recursive:true,force:true})})
 apply(ctx,{dir,autoExtract:false,autoSynthesize:false,semantic:false})
 const exec={agent:{session:{id:'fixture',header:{},requestHeader:()=>({config:route})}}}
 const saved=await tools.get('ltm_save').execute({text:'用户养了一只柯基。'},exec)
 assert.equal(saved.ok,true);savedId=saved.id
 const result=await tools.get('ltm_forget').execute({topic:'狗'},exec)
 assert.equal(result.ok,true);assert.equal(result.removed,1);assert.equal(result.removedIds,savedId)
 assert.equal(request.provider,'deepseek-account');assert.equal(request.purpose,'spike-ltm-forget')
})

test('missing model configuration cannot silently turn semantic deletion into a keyword deletion',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-no-route-')),core=createCore({dir})
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 core.save('用户养了一只柯基。')
 await assert.rejects(forgetTopic(core,'狗'),/MODEL_ROUTE_UNAVAILABLE/)
 assert.equal(core.inspect().items.length,1)
})

test('an empty semantic selection cannot preserve an explicitly matching topic',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-literal-')),core=createCore({dir})
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 core.save('用户的主力相机是尼康 Z6III。')
 core.save('用户喜欢阴天柔光。')
 const llm={async *stream(){yield {type:'text-delta',text:'{"ids":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}
 const result=await forgetTopic(core,'相机',{llm,route})
 assert.equal(result.removed.length,1)
 assert.deepEqual(core.inspect().items.map(i=>i.text),['用户喜欢阴天柔光。'])
})

test('failure in a later deletion batch leaves every earlier selection untouched',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ltm-forget-batches-')),core=createCore({dir})
 t.after(()=>rmSync(dir,{recursive:true,force:true}))
 for(let i=0;i<21;i++)core.save(`合成事实 ${i}`)
 const before=core.inspect(),firstId=before.items[0].id
 let calls=0
 const llm={async *stream(){if(++calls===2)throw new Error('PROVIDER_UNAVAILABLE');yield {type:'text-delta',text:JSON.stringify({ids:[firstId]})};yield{type:'finish',reason:{kind:'stop'}}}}
 await assert.rejects(forgetTopic(core,'合成事实',{llm,route}),/PROVIDER_UNAVAILABLE/)
 assert.equal(core.inspect().items.length,21);assert.equal(core.inspect().revision,before.revision)
})
