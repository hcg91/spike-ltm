import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cwd = fileURLToPath(new URL('..', import.meta.url))
const standalone = ['spike.test.mjs', 'p1-store.test.mjs', 'memory-ui.test.mjs']
const files = readdirSync(new URL('../test/', import.meta.url)).filter(f => f.endsWith('.test.mjs') && !standalone.includes(f)).sort()
for (const args of [...standalone.map(f => ['test/' + f]), ['--test', '--test-concurrency=2', ...files.map(f => 'test/' + f)]]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
