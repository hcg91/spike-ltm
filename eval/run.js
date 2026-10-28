import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Answers belong only to this scorer. Adapters receive input/question/context,
// never the scenario object or its expected/forbidden assertions.
export async function runSuite({ scenarios, createAdapter, timeoutMs = 240000 }) {
  if (!Array.isArray(scenarios) || !scenarios.length) throw new Error('EMPTY_SUITE')
  for (const scenario of scenarios) {
    if (!scenario.id || !Array.isArray(scenario.steps) || !scenario.steps.some(s => s.op === 'ask')) throw new Error('INVALID_SCENARIO')
    for (const step of scenario.steps) {
      if (!['ingest', 'ask', 'forget'].includes(step.op) || typeof step.text !== 'string') throw new Error('INVALID_STEP')
      if (step.op === 'ask' && (!Array.isArray(step.expected) || !step.expected.length || step.expected.some(s => typeof s !== 'string' || !s))) throw new Error('MISSING_EXPECTATION')
    }
  }
  const report = { startedAt: new Date().toISOString(), cases: [], total: 0, passed: 0, failed: 0, errors: 0, completed: true }
  for (const scenario of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), 'ltm-eval-'))
    let adapter
    const result = { id: scenario.id, checks: [], writes: [], completed: false }
    report.cases.push(result)
    try {
      adapter = await createAdapter({ dir })
      for (const step of scenario.steps) {
        const controller = new AbortController()
        let timer
        const input = { text: step.text, project: step.project ?? null, signal: controller.signal }
        const start = performance.now()
        try {
          const value = await Promise.race([
            Promise.resolve().then(() => adapter[step.op](input)),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('EVAL_TIMEOUT')) }, timeoutMs) }),
          ])
          if (step.op === 'ask') {
            if (typeof value?.text !== 'string' || value.finish !== 'stop') throw new Error('ANSWER_INCOMPLETE')
            const answer = value.text.normalize('NFKC').toLowerCase()
            const includes = term => answer.includes(term.normalize('NFKC').toLowerCase())
            const passed = step.expected.some(includes) && (step.forbidden ?? []).every(term => !includes(term))
            result.checks.push({ question: step.text, answer: value.text, recalled: value.recalled ?? null, passed, recallMs:value.recallMs ?? null, ms: performance.now() - start })
            report.total++; report[passed ? 'passed' : 'failed']++
          }
          if (step.op !== 'ask' && adapter.diagnostics) result.writes.push({operation:step.op,diagnostics:adapter.diagnostics()})
        } finally { clearTimeout(timer) }
      }
      result.completed = true
    } catch (e) {
      // Do not leak provider response bodies or credentials through an error.
      result.error = /^[A-Z_]+$/.test(e?.message ?? '') ? e.message : 'ADAPTER_ERROR'
      report.errors++; report.completed = false
    } finally {
      try { await adapter?.close?.() } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
  report.expectedTotal = scenarios.reduce((n, s) => n + s.steps.filter(x => x.op === 'ask').length, 0)
  report.unanswered = report.expectedTotal - report.total
  report.endedAt = new Date().toISOString()
  return report
}
