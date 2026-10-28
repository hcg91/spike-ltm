import {filterRecall} from './recall-filter.js'

export async function forgetTopic(core, topic, {llm,route,timeoutMs=15000} = {}) {
  const query=String(topic??'').trim()
  if(!query)throw new Error('EMPTY_TOPIC')
  const snapshot=core.inspect(), candidates=snapshot.items.filter(i=>i.status==='active')
  const ids=candidates.filter(i=>i.text.includes(query)).map(i=>i.id)
  if(candidates.length && (!llm?.stream || !route?.provider || !route?.model))throw new Error('MODEL_ROUTE_UNAVAILABLE')
  const deadline=Date.now()+timeoutMs
  // Resolve every batch before writing, so a timeout cannot leave a partial deletion.
  for(let start=0;start<candidates.length;start+=20){
    const remaining=deadline-Date.now()
    if(remaining<=0)throw new Error('FORGET_TIMEOUT')
    const selected=await filterRecall({llm,route,query,candidates:candidates.slice(start,start+20).map(({id,text})=>({id,text})),intent:'forget',timeoutMs:remaining})
    ids.push(...selected)
  }
  return core.forget(query,{ids,expectedRevision:snapshot.revision})
}
