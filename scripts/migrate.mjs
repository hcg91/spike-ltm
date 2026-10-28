#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { migrateJsonToSqlite } from '../lib/store/migrate.js'
const args = process.argv.slice(2)
if (args.includes('--help') || !args.length) {
  console.log('Usage: node scripts/migrate.mjs --source <memory.json> --target <NEW memory.db>\nRead-only source; refuses existing target. Does not change Harness configuration or create backups. Stop the source writer before migrating.')
  process.exit(0)
}
const source = args[args.indexOf('--source') + 1], target = args[args.indexOf('--target') + 1]
if (!args.includes('--source') || !args.includes('--target') || !source || !target || source.startsWith('--') || target.startsWith('--')) throw new Error('SOURCE_AND_TARGET_REQUIRED')
if (resolve(source) === resolve(target)) throw new Error('SOURCE_TARGET_SAME')
mkdirSync(dirname(resolve(target)), { recursive: true })
const result = migrateJsonToSqlite({ jsonPath: resolve(source), dbPath: resolve(target), logger: {} })
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
