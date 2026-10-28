import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './run.js'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node eval/cli.mjs --adapter ./adapter.mjs --cases ./cases.json --out ./NEW-report.json')
} else {
  try {
    const options = {}
    for (let i=0; i<args.length; i+=2) {
      if (!['--adapter','--cases','--out'].includes(args[i]) || !args[i+1] || options[args[i]]) throw new Error('INVALID_ARGUMENTS')
      options[args[i]] = args[i+1]
    }
    if (!options['--adapter'] || !options['--out']) throw new Error('ADAPTER_AND_OUTPUT_REQUIRED')
    const { createAdapter } = await import(pathToFileURL(resolve(options['--adapter'])))
    const scenarios = JSON.parse(readFileSync(options['--cases'] ?? new URL('./smoke.json', import.meta.url),'utf8'))
    const report = await runSuite({scenarios,createAdapter})
    writeFileSync(resolve(options['--out']),JSON.stringify(report,null,2),{flag:'wx'})
    console.log(JSON.stringify({completed:report.completed,passed:report.passed,total:report.total,unanswered:report.unanswered,errors:report.errors}))
    process.exitCode = report.completed && report.failed === 0 ? 0 : 1
  } catch (e) {
    console.error(/^[A-Z_]+$/.test(e?.message ?? '') ? e.message : 'EVALUATION_FAILED')
    process.exitCode = 1
  }
}
