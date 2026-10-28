import { join } from 'node:path'
import { openMemoryStore } from '../lib/store/factory.js'
import { installMemoryJobs } from '../lib/auto.js'
import { semanticScores } from '../lib/index.js'
import { forgetTopic } from '../lib/forget-topic.js'

// Call only in a dedicated evaluation process. The runner supplies a fresh dir;
// this adapter never discovers a user's memory path, model route or credentials.
export function createAdapter({ dir, llm, route }) {
  if (!dir || !route?.provider || !route?.model || !llm?.stream) throw new Error('EVAL_CONFIG_REQUIRED')
  const store = openMemoryStore({ dir, backend:'sqlite', logger:{} })
  let handler, seq = 0
  const projects = new Set()
  const contextFor = project => ({ workspacePath: project === null ? null : join(dir, 'projects', encodeURIComponent(project)) })
  const bound = project => store.core.forContext(contextFor(project))
  const runner = installMemoryJobs({ core:store.core, jobs:store.jobs, config:{autoSynthesize:false}, ctx:{
    llm, logger:{}, on(name, fn) { if (name === 'session/event') handler = fn },
  } })
  return {
    async ingest({ text, project = null, signal }) {
      if (project !== null) projects.add(project)
      const eventSeq = ++seq
      const session = { id:'eval-' + (project ?? 'global'), header:{cwd:contextFor(project).workspacePath}, requestHeader:() => ({config:route}),
        snapshotEvents:() => [{seq:eventSeq,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}}] }
      handler(session, {seq:++seq,type:'turn/end'})
      while (store.jobs.pendingCount()) {
        signal?.throwIfAborted()
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (store.jobs.status().counts.dead) throw new Error('DEAD_JOB')
    },
    async ask({ text, project = null, signal }) {
      const core = bound(project), agent = {}
      const semantic = await semanticScores(core, text, {}, {llm,route})
      signal?.throwIfAborted()
      if (semantic?.degraded) throw new Error('SEMANTIC_UNAVAILABLE')
      core.refreshSnapshot(text, agent, semantic)
      const recalled = core.providerText(agent)
      let output = '', finish = null
      for await (const chunk of llm.stream({ ...route, signal, maxTokens:1600, purpose:'spike-ltm-evaluation',
        messages:[{id:'eval-' + ++seq,role:'user',source:{kind:'memory-evaluation'},content:[{type:'text',text:
          `根据以下记忆简短回答问题。没有依据时说“没有记录”，不要猜测。\n记忆：${recalled || '无'}\n问题：${text}`}]}] })) {
        if (chunk.type === 'text-delta') output += chunk.text ?? ''
        if (chunk.type === 'finish') finish = chunk.reason?.kind
      }
      signal?.throwIfAborted()
      return { text:output, finish, recalled, recallMs:semantic?.ms ?? 0 }
    },
    forget: ({ text, project = null }) => forgetTopic(bound(project),text,{llm,route}),
    diagnostics: () => ({global:store.core.inspect().items,projects:Object.fromEntries([...projects].map(p=>[p,bound(p).inspect().items])),jobs:store.jobs.status()}),
    close() { runner.stop(); store.close() },
  }
}
