// 无浏览器/桌面控制：执行实际 bundle 的 React 事件处理器；不声称验证了像素布局。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../lib/core.js'
import { createSummaryService, registerSummaryRoutes } from '../lib/memory-summary.js'

const source = readFileSync(new URL('../lib/client/index.js', import.meta.url), 'utf8')
test('记忆入口仅接入头像原菜单，不再添加侧栏按钮或会话标题入口', () => {
  let plugin
  const slots = []
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})) } } }, fetch: async () => ({}), location: { href: 'http://test/' } })
  plugin.apply({ locale: { register() {}, bind: () => x => x }, slots: {
    entriesOfSlot: () => [{ component: () => null, options: { priority: 0 } }],
    inject: (_, fn) => fn(), register: (config, render) => { slots.push({ config, render }); return () => {} },
  }, effect() {} })
  assert(slots.some(s => s.config.name === 'settings.launcher'))
  assert(!slots.some(s => s.config.name === 'sidebar.footer.action'))
  assert(!slots.some(s => s.config.name === 'conversation.session.header.actions'))
  assert(!slots.some(s => s.config.name === 'sidebar'))
  assert(!slots.some(s => s.config.name === 'conversation.view'))
})

test('头像原菜单稍后注册时仍接入一次，卸载后移除适配并释放订阅', () => {
  let plugin, listener, cleanup, releases = 0, unsubscribed = 0
  const entries = [], registered = [], nativeInject = () => ({ marker: 'original-account-actions' })
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})) } } } })
  plugin.apply({ slots: {
    inject: (_, fn) => fn(), entriesOfSlot: () => entries,
    subscribe: (_, fn) => { listener = fn; return () => { unsubscribed++ } },
    register(config, component) {
      registered.push(config)
      entries.push({ options: config, component })
      listener?.()
      return () => { releases++ }
    },
  }, effect(fn) { cleanup = fn() } })
  assert.equal(registered.length, 0)
  entries.push({ component: () => null, options: { priority: 9 }, locale: 'settings.account', inject: nativeInject })
  listener(); listener()
  assert.equal(registered.length, 1)
  assert(registered[0].priority < 9, '宿主优先选较小的数值')
  assert.equal(registered[0].inject, nativeInject)
  assert.equal(registered[0].locale, 'settings.account')
  cleanup()
  assert.equal(releases, 1)
  assert.equal(unsubscribed, 1)
})

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(x => nodes(x, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate), ...nodes(tree.props?.anchor, predicate)]
}
async function setup(t, intercept, nativeFactory) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-dialog-'))
  const core = createCore({ dir }), routes = [], requests = [], prompts = []
  const a = core.save('合成 A').item, b = core.save('合成 B').item
  core.setProfile({ sections: [
    { title: '工作与项目', bullets: [{ text: '合成 A 的总结', refs: [a.id] }] },
    { title: '兴趣', bullets: [{ text: '合成 B 的总结', refs: [b.id] }] },
  ] })
  const service = createSummaryService({ core, callModel: async prompt => {
    prompts.push(prompt)
    if (prompt.startsWith('请把下面')) return JSON.stringify({ sections: [{ title: '新摘要', bullets: [{ text: '刷新后的完整总结', refs: [a.id, b.id] }] }] })
    if (prompt.startsWith('你在和用户讨论整份')) {
      const context = JSON.parse(prompt.split('上下文：')[1])
      return JSON.stringify({ reply: '已在整份记忆中定位修改', sections: [{ id: context.sections[0].id, text: '全局修改后的 A' }], changes: [{ id: a.id, text: '全局修改后的 A' }] })
    }
    return JSON.stringify({ reply: '整理好了，等待你确认', text: '模型草稿 A', changes: [{ id: a.id, text: '模型草稿 A' }] })
  } })
  const dispose = registerSummaryRoutes({ ctx: { connection: { fetch: { register: r => { routes.push(r); return () => {} } } } }, service })
  const normalFetch = async (url, init = {}) => {
    const path = new URL(url, 'http://test/').pathname
    if (init.body) requests.push({ path, body: JSON.parse(init.body) })
    return routes.find(r => r.path === path).fetch(new Request('http://test' + path, init))
  }
  let active, slotRender, plugin
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children }, children }),
    isValidElement: value => !!value && typeof value === 'object' && 'type' in value,
    cloneElement: (element, props, ...children) => React.createElement(element.type, { ...element.props, ...props }, ...(children.length ? children : element.children)),
    Children: { map: (children, fn) => children == null ? children : (Array.isArray(children) ? children : [children]).map(fn) },
    useState(initial) { const r = active, i = r.cursor++; if (!(i in r.hooks)) r.hooks[i] = initial; return [r.hooks[i], value => { r.hooks[i] = typeof value === 'function' ? value(r.hooks[i]) : value }] },
    useRef(initial) { const r = active, i = r.cursor++; return r.hooks[i] ??= { current: initial } },
    useEffect(fn, deps) { const r = active, i = r.cursor++; const old = r.effects[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) { old?.cleanup?.(); r.effects[i] = { deps }; r.pending.push(() => { r.effects[i].cleanup = fn() }) } },
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React) } } },
    fetch: (url, init) => intercept ? intercept(url, init, normalFetch) : normalFetch(url, init), AbortController, setTimeout, clearTimeout })
  const nativeActions = { settings: 0, contact: 0, signout: 0 }
  const nativeProps = { wide: true, settingsOpen: false, useAccount: fn => fn({ view: { status: 'credential-stored' }, details: { profile: { status: 'ready', value: { name: '合成测试账号' } } } }),
    useTheme: fn => fn({ active: { colorScheme: 'light' } }), t: key => ({ menu: '账号菜单', settings: '设置', contactUs: '意见反馈', signOut: '退出登录' }[key] ?? key),
    openSettings() { nativeActions.settings++ }, contactUs() { nativeActions.contact++ }, async hasRunningAccountTasks() { nativeActions.signout++; return false }, refreshAccount() {},
  }
  const native = nativeFactory ? nativeFactory(React) : () => React.createElement('native-menu', {
    items: [{ id: 'settings', label: '设置' }, { id: 'contact', label: '意见反馈' }, { id: 'signout', label: '退出登录' }],
    onClose() {}, onSelect: id => { nativeActions[id]++ },
  })
  plugin.apply({ slots: { entriesOfSlot: () => [{ component: native, options: { priority: 0 }, locale: 'settings.account', inject: () => nativeProps }],
    inject: (_, fn) => fn(), register: (config, render) => { slotRender = props => React.createElement(render, { ...props, ...config.inject?.() }); return () => {} } }, effect() {} })
  function renderer(component, props) {
    const r = { hooks: [], effects: [], pending: [], cursor: 0, tree: null }
    r.render = () => { active = r; r.cursor = 0; r.tree = component(props); for (const n of nodes(r.tree, n => n.type === 'dialog')) n.props.ref.current ??= { showModal() {}, close() {} }; r.pending.splice(0).forEach(fn => fn()); return r.tree }
    r.button = text => { const n = nodes(r.render(), n => n.type === 'button' && (n.children.includes(text) || n.props['aria-label'] === text))[0]; assert(n, text); return n }
    r.click = text => { const n = r.button(text); assert(!n.props.disabled, `disabled: ${text}`); return n.props.onClick({ stopPropagation() {}, preventDefault() {} }) }
    r.input = (label, value) => { const n = nodes(r.render(), n => n.type === 'textarea' && n.props['aria-label'] === label)[0]; assert(n, label); n.props.onChange({ target: { value } }) }
    r.state = () => r.hooks[0]
    r.unmount = () => r.effects.forEach(e => e?.cleanup?.())
    return r
  }
  const entry = slotRender({ wide: true })
  const launcher = renderer(entry.type, entry.props)
  let menu = nodes(launcher.render(), n => Array.isArray(n.props.items))[0]
  if (menu?.props.anchor) { launcher.click('账号菜单'); menu = nodes(launcher.render(), n => Array.isArray(n.props.items))[0] }
  const memoryItem = menu?.props.items.find(item => item.label === '长期记忆')
  assert(memoryItem, '头像菜单中必须存在长期记忆')
  menu.props.onSelect(memoryItem.id)
  const element = nodes(launcher.render(), n => typeof n.type === 'function')[0]
  assert(element)
  const ui = renderer(element.type, element.props)
  ui.render()
  await new Promise(setImmediate)
  ui.render()
  t.after(() => { ui.unmount(); launcher.unmount(); dispose(); rmSync(dir, { recursive: true, force: true }) })
  return { ui, launcher, nativeActions, core, a, b, requests, prompts, dir }
}

test('实际宿主头像菜单：插入长期记忆后原设置、反馈、退出处理与账号状态仍保留', { skip: !process.env.DSH_HOST_ASAR }, async t => {
  const archive = readFileSync(process.env.DSH_HOST_ASAR)
  const tree = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString('utf8'))
  const entry = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'.split('/').reduce((node, part) => node.files[part], tree)
  const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset)
  const account = archive.subarray(offset, offset + entry.size).toString('utf8')
  const start = account.indexOf('function AccountMenu('), end = account.indexOf('//#endregion', start)
  assert(start >= 0 && end > start, '必须找到实际原组件，不能用自造菜单冒充')
  const { ui, launcher, nativeActions } = await setup(t, undefined, React => vm.runInNewContext(`(${account.slice(start, end).trim()})`, {
    react: React,
    react_jsx_runtime: { jsx: (type, props) => React.createElement(type, props, ...(Array.isArray(props.children) ? props.children : props.children === undefined ? [] : [props.children])),
      jsxs: (type, props) => React.createElement(type, props, ...(Array.isArray(props.children) ? props.children : props.children === undefined ? [] : [props.children])) },
    _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, { get: (_, name) => name === 'Menu' ? 'native-menu' : `native-${name}` }),
    AccountMenu_module_css_default: new Proxy({}, { get: (_, name) => String(name) }), AccountAvatar: 'native-avatar', LogoutIcon: 'native-logout',
    AccountNoticeStack: 'native-notice', SignInDialog: 'native-signin', SignOutDialog: 'native-signout',
  }))
  let menu = nodes(launcher.render(), n => Array.isArray(n.props.items))[0]
  assert.equal(menu.props.open, false, '打开记忆时原头像菜单应关闭')
  assert.deepEqual(Array.from(menu.props.items, item => item.id), ['settings', 'spike-ltm-memory', 'contact', 'signout'])
  assert.deepEqual(nativeActions, { settings: 0, contact: 0, signout: 0 }, '新选项不得误触退出登录')
  assert.equal(ui.state().view.sections.length, 2)
  ui.click('关闭记忆摘要')
  assert.equal(nodes(launcher.render(), n => typeof n.type === 'function').length, 0)
  for (const id of ['settings', 'contact', 'signout']) {
    launcher.click('账号菜单')
    menu = nodes(launcher.render(), n => Array.isArray(n.props.items))[0]
    menu.props.onSelect(id)
    await new Promise(setImmediate)
  }
  assert.deepEqual(nativeActions, { settings: 1, contact: 1, signout: 1 })
})

test('默认是一篇连续摘要，无侧栏/分类按钮/卡片；点标题只绑定底部输入框', async t => {
  const { ui } = await setup(t)
  assert.equal(nodes(ui.render(), n => n.type === 'aside').length, 0)
  assert.equal(nodes(ui.render(), n => n.type === 'nav').length, 0)
  assert(!source.includes('grid-template-columns'))
  assert(!source.includes('直接编辑'))
  assert(!source.includes('历史版本'))
  assert.equal(ui.state().selectedId, null)
  assert.equal(nodes(ui.render(), n => n.type === 'textarea')[0].props.disabled, false, '未选段落也必须能直接对话')
  ui.click('工作与项目')
  assert.equal(ui.state().selectedId, ui.state().view.sections[0].id)
  assert.equal(nodes(ui.render(), n => n.props.className === 'ltm-selection').length, 1)
  assert.equal(nodes(ui.render(), n => n.props.className === 'ltm-section').length, 2, '选中后整篇正文仍在')
})

test('段落对话→多轮含草稿→更新，只改变选中段落', async t => {
  const { ui, core, a, b, prompts, requests } = await setup(t)
  ui.click('工作与项目'); ui.input('摘要修改要求', '修改一下')
  await ui.click('发送修改要求')
  assert.equal(core.inspect().items[0].text, '合成 A')
  assert.equal(ui.state().proposal.text, '模型草稿 A')
  ui.input('摘要修改要求', '再缩短上一版')
  await ui.click('发送修改要求')
  assert.match(prompts[1], /模型草稿 A/)
  assert.equal(requests.find(r => r.path.endsWith('/propose')).body.sessionId, undefined, '侧栏修改无需关联某个聊天')
  await ui.click('更新这段记忆')
  assert.equal(core.inspect().items.find(x => x.id === a.id).text, '模型草稿 A')
  assert.equal(core.inspect().items.find(x => x.id === b.id).text, '合成 B')
  assert.equal(ui.state().error, null)
  assert.match(ui.state().notice, /已更新/)
})

test('工作→兴趣→工作后迟到回复不可进入新对话', async t => {
  let release
  const { ui } = await setup(t, (url, init, normal) => url.endsWith('/propose') ? new Promise(resolve => { release = async () => resolve(await normal(url, { ...init, signal: undefined })) }) : normal(url, init))
  ui.click('工作与项目'); ui.input('摘要修改要求', '旧请求')
  const pending = ui.click('发送修改要求')
  ui.click('兴趣'); ui.click('工作与项目')
  await release(); await pending
  assert.equal(ui.state().proposal, null)
  assert.equal(ui.state().chat.length, 0)
})

test('停止按钮发送取消，网络迟到不改变正文或数据库', async t => {
  let release, cancelled = false
  const { ui, core } = await setup(t, (url, init, normal) => {
    if (url.endsWith('/cancel')) cancelled = true
    if (url.endsWith('/propose')) return new Promise(resolve => { release = async () => resolve(await normal(url, { ...init, signal: undefined })) })
    return normal(url, init)
  })
  ui.click('工作与项目'); ui.input('摘要修改要求', '暂时不要')
  const pending = ui.click('发送修改要求')
  ui.click('停止生成'); await release(); await pending
  assert.equal(cancelled, true)
  assert.equal(ui.state().proposal, null)
  assert.equal(ui.state().busy, null)
  assert.equal(core.inspect().items[0].text, '合成 A')
})

test('更新冲突后作废旧提案并重读摘要', async t => {
  const { ui, core, a } = await setup(t)
  ui.click('工作与项目'); ui.input('摘要修改要求', '修改')
  await ui.click('发送修改要求')
  core.updateItem({ id: a.id, scope: 'global', expectedVersion: 1, text: '其他地方的新内容' })
  await ui.click('更新这段记忆')
  assert.equal(ui.state().proposal, null)
  assert.equal(ui.state().selectedId, null)
  assert.equal(core.inspect().items[0].text, '其他地方的新内容')
  assert.equal(ui.state().view.revision, core.inspect().revision)
})

test('顶部更新摘要调用真实服务路径；不改原子记忆', async t => {
  const { ui, core } = await setup(t)
  const before = core.inspect().items
  ui.click('摘要操作'); await ui.click('更新摘要')
  assert.equal(ui.state().view.sections[0].text, '刷新后的完整总结')
  assert.deepEqual(core.inspect().items, before)
})

test('删除菜单须确认，选中段落和全部记忆的删除范围明确', async t => {
  const { ui, core, b } = await setup(t)
  ui.click('工作与项目'); ui.click('摘要操作'); ui.click('删除选中段落')
  assert.equal(core.inspect().items.length, 2, '打开确认不能删除')
  assert.equal(ui.state().confirmDelete, true)
  await ui.click('确认删除')
  assert.deepEqual(core.inspect().items.map(x => x.id), [b.id])
  ui.click('摘要操作'); ui.click('删除全部记忆')
  assert.equal(core.inspect().items.length, 1)
  await ui.click('确认删除')
  assert.equal(core.inspect().items.length, 0)
})

test('打开后直接发送全局修改，正文预览并确认更新，无需点击标题', async t => {
  const { ui, core, requests } = await setup(t)
  ui.input('摘要修改要求', '帮我更正工作信息')
  await ui.click('发送修改要求')
  assert.equal(requests.find(r => r.path.endsWith('/propose')).body.sectionId, undefined)
  assert.equal(ui.state().proposal.sections.length, 1)
  assert(nodes(ui.render(), n => n.props.className === 'ltm-paragraph' && n.children.includes('全局修改后的 A')).length)
  assert.equal(core.inspect().items[0].text, '合成 A')
  await ui.click('更新记忆')
  assert.equal(core.inspect().items[0].text, '全局修改后的 A')
  assert.equal(core.inspect().items[1].text, '合成 B')
})

test('全局和单段之间切换会清除旧建议，取消选中后恢复直接对话', async t => {
  const { ui, requests } = await setup(t)
  ui.input('摘要修改要求', '全局修改')
  await ui.click('发送修改要求')
  ui.click('工作与项目')
  assert.equal(ui.state().proposal, null)
  ui.input('摘要修改要求', '仅修改这段')
  await ui.click('发送修改要求')
  const localRequest = requests.filter(r => r.path.endsWith('/propose')).at(-1).body
  assert(localRequest.sectionId)
  assert.equal(localRequest.previousToken, undefined)
  ui.click('取消选中段落')
  assert.equal(ui.state().selectedId, null)
  assert.equal(ui.state().proposal, null)
  assert.equal(nodes(ui.render(), n => n.type === 'textarea')[0].props.disabled, false)
})
