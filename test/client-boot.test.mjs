// 客户端启动契约回归；不启动窗口、不接触记忆数据。
// 可选：DSH_CLIENT_MODULES_BUNDLE 指向本机宿主实际 client-modules bundle，
// 用真实加载器验证批量加载、缓存和失效重载，而不是只检查 JS 语法。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../lib/client/index.js', import.meta.url), 'utf8')

test('客户端以宿主清单使用的包名注册，可按包名解析工厂', () => {
  const factories = new Map()
  vm.runInNewContext(client, { window: { __ModuleLoader__: { load({ id, factory }) {
    assert(!factories.has(id), '不得重复注册')
    factories.set(id, factory)
  } } } })
  const factory = factories.get(pkg.name)
  assert.equal(typeof factory, 'function', `宿主请求 ${pkg.name} 时必须能找到对应模块，实际注册 ${[...factories.keys()]}`)
  const plugin = factory((name) => {
    assert.equal(name, 'react')
    return {}
  })
  assert.equal(typeof plugin.apply, 'function')
})

const hostBundlePath = process.env.DSH_CLIENT_MODULES_BUNDLE
test('实际安装宿主的头像菜单可复用，插件依赖原账号菜单而不依赖会话', { skip: !process.env.DSH_HOST_ASAR }, () => {
  const asar = readFileSync(process.env.DSH_HOST_ASAR)
  const tree = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString('utf8'))
  const file = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'.split('/').reduce((node, part) => node.files[part], tree)
  const start = 8 + asar.readUInt32LE(4) + Number(file.offset)
  const account = asar.subarray(start, start + file.size).toString('utf8')
  assert.match(account, /name: "settings\.launcher"/)
  assert.match(account, /function AccountMenu\(/)
  assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-account'))
  assert(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})

test('实际宿主 SlotCore 选中记忆菜单适配，卸载后恢复原账号菜单', { skip: !process.env.DSH_HOST_ASAR }, () => {
  const asar = readFileSync(process.env.DSH_HOST_ASAR)
  const tree = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString('utf8'))
  const assets = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'.split('/').reduce((node, part) => node.files[part], tree)
  const [, file] = Object.entries(assets.files).find(([name]) => /^index-.*\.js$/.test(name))
  const start = 8 + asar.readUInt32LE(4) + Number(file.offset)
  const frontend = asar.subarray(start, start + file.size).toString('utf8')
  const anchor = frontend.indexOf('entriesOfSlot(e)')
  assert(anchor >= 0, '需要实际注册器的选择实现')
  const classStart = frontend.lastIndexOf('=class', anchor) + 1
  let implementation
  for (let end = frontend.indexOf('}', anchor); end >= 0 && end < anchor + 18000; end = frontend.indexOf('}', end + 1)) {
    try { implementation = new vm.Script(`(${frontend.slice(classStart, end + 1)})`); break } catch { /* 继续到实际类结束，不执行整个前端 */ }
  }
  assert(implementation, '实际 SlotCore 必须可独立解析，不能退回模拟注册器')
  const Core = implementation.runInNewContext({ queueMicrotask, console, i1: Object.freeze([]) })
  const core = new Core()
  core.register({ name: 'root', children: { 'settings.launcher': { kind: 'single', scope: 'root' } } }, () => null)
  const original = () => null
  core.register({ name: 'settings.launcher', locale: 'settings.account', priority: 0 }, original)
  let plugin, cleanup
  vm.runInNewContext(client, { window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } } })
  plugin.apply({ slots: { inject: (_, fn) => fn(), entriesOfSlot: key => core.entriesOfSlot(key),
    register: (config, component) => core.register(config, component), subscribe: (key, fn) => core.subscribe(key, fn) },
    effect(fn) { cleanup = fn() },
  })
  const winner = core.entriesOfSlot('settings.launcher')[0]
  assert.equal(winner.component.spikeLtmAvatarAdapter, true, '真正渲染的必须是记忆适配，不能只是注册了却被原菜单遮住')
  assert.equal(winner.locale, 'settings.account')
  cleanup()
  assert.equal(core.entriesOfSlot('settings.launcher')[0].component, original)
})

test('实际宿主加载器：首次导入、缓存命中、失效重载均成功', { skip: !hostBundlePath }, async () => {
  let bootstrap
  vm.runInNewContext(readFileSync(hostBundlePath, 'utf8'), {
    window: { __ModuleLoader__: { load(registration) { bootstrap = registration } } },
  })
  const host = bootstrap.factory(() => { throw new Error('未预期的宿主外部依赖') })
  const target = { mode: 'queue', pendingQueue: [] }
  const scriptContext = vm.createContext({ window: { __ModuleLoader__: target } })
  let loads = 0
  const loader = host.createClientModuleSystem(target, { id: bootstrap.id, exports: host }, {
    boot: {
      rev: 'test-1',
      entries: [{ id: pkg.name, url: `/plugins/??${pkg.name}/client.js&rev=test-1`, rev: 'test-1' }],
      batches: [{ phase: 'application', url: '/plugins/batch.js?rev=test-1', rev: 'test-1', entries: [pkg.name] }],
    },
    staticModules: { react: {} },
    loadBundle: async () => { loads += 1; vm.runInContext(client, scriptContext) },
  })
  const first = await loader.import(pkg.name)
  assert.equal(typeof first.apply, 'function')
  assert.equal(loads, 1, '首次加载不应因注册错名而进入重复加载回退')
  assert.equal(await loader.import(pkg.name), first)
  assert.equal(loads, 1, '再次导入应复用缓存')
  loader.invalidate(pkg.name, 'test-2')
  const reloaded = await loader.import(pkg.name)
  assert.equal(typeof reloaded.apply, 'function')
  assert.notEqual(reloaded, first)
  assert.equal(loads, 2, '失效重载只能加载一次')
})
