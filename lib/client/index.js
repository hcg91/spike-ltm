/** 头像原菜单内打开记忆摘要，无需进入会话。 */
window.__ModuleLoader__.load({
  id: 'spike-ltm',
  factory: (require) => {
    const React = require('react')
    const { useState, useRef, useEffect } = React
    const h = React.createElement, API = 'api/spike-ltm/ui/summary'
    async function api(path, body, signal) {
      const response = await fetch(`${API}/${path}`, { method: body === undefined ? 'GET' : 'POST', signal,
        headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const payload = await response.json()
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? `请求失败（${response.status}）`)
        error.code = payload?.error?.code
        throw error
      }
      return payload.value
    }
    const css = `
      .ltm-dialog{--paper:var(--dsw-alias-background-primary,#fff);--ink:var(--dsw-alias-label-primary,#252525);--muted:rgba(128,128,128,.13);background:var(--paper);color:var(--ink);border:0;border-radius:18px;padding:0;width:min(760px,calc(100vw - 40px));height:min(780px,calc(100dvh - 64px));max-width:none;max-height:none;box-shadow:0 22px 85px #0003;font:15px/1.65 system-ui,sans-serif;overflow:hidden}
      .ltm-dialog::backdrop{background:#16191c55;backdrop-filter:blur(2px)}.ltm-dialog *{box-sizing:border-box}.ltm-shell{height:100%;display:flex;flex-direction:column}.ltm-dialog button,.ltm-dialog textarea{font:inherit;color:inherit}.ltm-dialog button{cursor:pointer}.ltm-dialog button:disabled{opacity:.4;cursor:default}.ltm-dialog button:focus-visible,.ltm-dialog textarea:focus-visible{outline:2px solid #668abd;outline-offset:3px}.ltm-head{padding:21px 30px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}.ltm-head h2{margin:0;font-size:18px;font-weight:600}.ltm-time{font-size:12px;opacity:.55}.ltm-head-actions{display:flex;gap:9px;align-items:center;margin-left:auto;position:relative}.ltm-icon{border:0;background:transparent;border-radius:8px;min-width:30px;height:30px;padding:0 6px;font-size:20px!important}.ltm-icon:hover{background:var(--muted)}.ltm-menu{position:absolute;right:36px;top:38px;min-width:170px;background:var(--paper);border:1px solid var(--muted);box-shadow:0 10px 30px #0002;border-radius:12px;padding:6px;z-index:2}.ltm-menu button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:10px 12px;border-radius:7px;white-space:nowrap;font-size:13px}.ltm-menu button:hover{background:var(--muted)}
      .ltm-document{flex:1;min-height:0;overflow-y:auto;padding:12px 30px 24px;scrollbar-width:thin}.ltm-section{margin:0 0 26px;cursor:pointer}.ltm-section h3{margin:0 0 6px;font-size:18px;line-height:1.5}.ltm-heading{padding:0;background:transparent;border:0;font-weight:650!important;text-align:left;line-height:inherit}.ltm-heading:hover{text-decoration:underline;text-underline-offset:4px}.ltm-section[aria-current=true] .ltm-heading{color:#668abd}.ltm-paragraph{margin:0;white-space:pre-line;overflow-wrap:anywhere}.ltm-caption{font-size:12px;opacity:.55}.ltm-empty{opacity:.55;padding:35px 0}
      .ltm-bottom{padding:0 26px 20px;flex-shrink:0}.ltm-thread{max-height:130px;overflow-y:auto;scrollbar-width:thin;padding:0 6px;font-size:13px}.ltm-message{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.ltm-message.user{opacity:.6}.ltm-compose{border-radius:18px;background:var(--muted);padding:10px 13px}.ltm-selection{display:flex;align-items:center;gap:8px;font-size:13px;padding:2px 5px 8px;opacity:.75}.ltm-selection .ltm-icon{margin-left:auto;font-size:17px!important;height:24px}.ltm-input-row{display:flex;align-items:flex-end;gap:8px}.ltm-input-row textarea{flex:1;min-width:0;width:100%;min-height:48px;max-height:120px;resize:vertical;border:0;background:transparent;outline:none;padding:8px 5px;line-height:1.5}.ltm-send{border:0;border-radius:50%;background:var(--ink);color:var(--paper)!important;width:32px;height:32px;flex-shrink:0;margin-bottom:6px;font-size:20px!important}.ltm-note{font-size:12px;padding:5px 6px}.ltm-error{color:#ba443c}.ltm-apply{display:flex;align-items:center;gap:12px;padding:8px 6px;font-size:12px}.ltm-action{border:0;border-radius:8px;padding:6px 12px;background:var(--ink);color:var(--paper)!important;font-size:12px!important}.ltm-text-button{border:0;background:transparent;padding:4px;font-size:12px!important;text-decoration:underline;text-underline-offset:3px}.ltm-confirm{font-size:13px;padding:10px 6px}.ltm-confirm p{margin:0 0 10px}.ltm-confirm button{margin-right:12px}
      @media(prefers-color-scheme:dark){.ltm-dialog{--paper:var(--dsw-alias-background-primary,#2b2c2c);--ink:var(--dsw-alias-label-primary,#ececec)}}
      @media(max-width:600px){.ltm-dialog{width:calc(100vw - 20px);height:calc(100dvh - 30px);border-radius:15px}.ltm-head{padding:18px 20px 12px;gap:8px}.ltm-time{font-size:11px}.ltm-document{padding:12px 20px 20px}.ltm-bottom{padding:0 16px 16px}.ltm-section h3{font-size:17px}}
    `
    function MemoryDialog({ sessionId, onClose }) {
      const [state, setState] = useState({ view: null, selectedId: null, input: '', chat: [], proposal: null, busy: null, menu: false, confirmDelete: false, error: null, notice: null })
      const patch = next => setState(previous => ({ ...previous, ...next }))
      const dialog = useRef(null), generation = useRef(0), request = useRef(null), reading = useRef(null), writing = useRef(false), input = useRef(null)
      const selected = state.view?.sections.find(s => s.id === state.selectedId) ?? null
      function cancelWork() {
        generation.current++
        reading.current?.abort()
        if (request.current) {
          const { id, controller } = request.current
          void api('cancel', { sessionId, requestId: id }).catch(() => {})
          controller.abort(); request.current = null
        }
      }
      useEffect(() => {
        const element = dialog.current; element?.showModal()
        const controller = new AbortController(); reading.current = controller
        api(`view${sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''}`, undefined, controller.signal).then(view => { if (!controller.signal.aborted) patch({ view }) })
          .catch(error => { if (!controller.signal.aborted) patch({ error: error.message }) })
        return () => { cancelWork(); element?.close() }
      }, [sessionId])
      function choose(section) {
        if (writing.current) return
        if (section?.id === state.selectedId) { input.current?.focus(); return }
        cancelWork()
        patch({ selectedId: section?.id ?? null, input: '', chat: [], proposal: null, busy: null, error: null, notice: null, menu: false, confirmDelete: false })
        input.current?.focus()
      }
      function cancel() { cancelWork(); patch({ busy: null, notice: '已停止。' }) }
      async function showError(error, current) {
        if (current !== generation.current) return
        if (error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND' || error.code === 'PROPOSAL_EXPIRED') {
          patch({ proposal: null, chat: [], selectedId: null, error: '记忆已有变化，旧建议已作废，请基于最新记忆重新提出修改。' })
          try { const view = await api(`view${sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''}`); if (current === generation.current) patch({ view }) }
          catch (reloadError) { if (current === generation.current) patch({ error: reloadError.message }) }
        } else patch({ error: error.message })
      }
      async function generate(action) {
        if (!state.view || state.busy || request.current || writing.current) return
        if (action === 'propose' && !state.input.trim()) return
        const current = ++generation.current
        const id = `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`, controller = new AbortController()
        request.current = { id, controller }
        const chat = action === 'propose' ? [...state.chat, { role: 'user', content: state.input.trim() }] : []
        patch({ chat, input: '', busy: action, menu: false, error: null, notice: null })
        try {
          const value = await api(action, { sessionId, requestId: id, sectionId: selected?.id, expectedRevision: state.view.revision,
            messages: chat, previousToken: state.proposal?.token }, controller.signal)
          if (current !== generation.current) return
          if (action === 'refresh') patch({ view: value, selectedId: null, chat: [], proposal: null, notice: '摘要已更新。' })
          else patch({ chat: [...chat, { role: 'assistant', content: value.reply }], proposal: value.proposal ?? state.proposal })
        } catch (error) { if (!controller.signal.aborted) await showError(error, current) }
        finally { if (current === generation.current) { request.current = null; patch({ busy: null }) } }
      }
      async function save(action) {
        if (!state.view || state.busy || writing.current || (action === 'apply' && !state.proposal)) return
        const current = generation.current
        writing.current = true
        patch({ busy: action, error: null, notice: null, menu: false, confirmDelete: false })
        try {
          const view = await api(action, action === 'apply' ? { sessionId, token: state.proposal.token }
            : { sessionId, sectionId: selected?.id, expectedRevision: state.view.revision })
          if (current === generation.current) patch({ view, proposal: null, chat: [], selectedId: action === 'delete' ? null : state.selectedId, notice: action === 'delete' ? '已删除。' : selected ? '这段记忆已更新。' : '记忆已更新。' })
        } catch (error) { await showError(error, current) }
        finally { writing.current = false; if (current === generation.current) patch({ busy: null }) }
      }
      const active = !!state.busy
      const previewText = section => state.proposal?.sections?.find(edit => edit.id === section.id)?.text
        ?? (section.id === state.selectedId ? state.proposal?.text : undefined)
      const timestamp = state.view?.updatedAt ? new Date(state.view.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
      return h('dialog', { ref: dialog, className: 'ltm-dialog', 'aria-labelledby': 'ltm-title', onCancel: event => { event.preventDefault(); if (!writing.current) onClose() }, onKeyDown: event => event.stopPropagation(), onKeyUp: event => event.stopPropagation() }, h('style', null, css), h('div', { className: 'ltm-shell' },
        h('header', { className: 'ltm-head' }, h('h2', { id: 'ltm-title' }, '记忆摘要'), timestamp ? h('span', { className: 'ltm-time' }, `更新于 ${timestamp}`) : null,
          h('div', { className: 'ltm-head-actions' }, h('button', { className: 'ltm-icon', 'aria-label': '摘要操作', 'aria-expanded': state.menu, disabled: active, onClick: () => patch({ menu: !state.menu }) }, '···'),
            state.menu ? h('div', { className: 'ltm-menu' }, h('button', { disabled: !state.view?.sections.length, onClick: () => generate('refresh') }, '更新摘要'), h('button', { disabled: !state.view?.sections.length, onClick: () => patch({ menu: false, confirmDelete: true }) }, selected ? '删除选中段落' : '删除全部记忆')) : null,
            h('button', { className: 'ltm-icon', 'aria-label': '关闭记忆摘要', disabled: state.busy === 'apply' || state.busy === 'delete', onClick: onClose }, '×'))),
        h('main', { className: 'ltm-document', 'aria-label': '记忆摘要正文' },
          (state.view?.sections ?? []).map(section => h('section', { className: 'ltm-section', key: section.id, 'aria-current': section.id === state.selectedId, onClick: () => choose(section) },
            h('h3', null, h('button', { className: 'ltm-heading', disabled: state.busy === 'apply' || state.busy === 'delete', onClick: event => { event.stopPropagation(); choose(section) } }, section.title)),
            previewText(section) !== undefined ? h('div', { className: 'ltm-caption' }, '修改建议 · 尚未保存') : null,
            h('p', { className: 'ltm-paragraph' }, previewText(section) ?? section.text))),
          !state.view?.sections.length ? h('p', { className: 'ltm-empty' }, state.view ? '暂无已保存的记忆。' : state.error ? '读取失败，关闭后重新打开可重试。' : '正在读取摘要…') : null),
        h('footer', { className: 'ltm-bottom' },
          state.error ? h('div', { className: 'ltm-note ltm-error', role: 'alert' }, state.error) : null,
          state.notice ? h('div', { className: 'ltm-note', role: 'status' }, state.notice) : null,
          state.confirmDelete ? h('div', { className: 'ltm-confirm', role: 'alert' }, h('p', null, selected ? `删除“${selected.title}”及对应记忆？相关摘要也会移除，此操作无法撤销。` : '删除全部已保存的记忆？此操作无法撤销。'),
            h('button', { className: 'ltm-action', onClick: () => save('delete') }, '确认删除'), h('button', { className: 'ltm-text-button', onClick: () => patch({ confirmDelete: false }) }, '取消')) : null,
          state.chat.length ? h('div', { className: 'ltm-thread', 'aria-live': 'polite' }, state.chat.map((message, index) => h('p', { className: `ltm-message ${message.role}`, key: index }, message.content))) : null,
          state.proposal ? h('div', { className: 'ltm-apply' }, h('button', { className: 'ltm-action', disabled: active, onClick: () => save('apply') }, selected ? '更新这段记忆' : '更新记忆'), h('button', { className: 'ltm-text-button', disabled: active, onClick: () => patch({ proposal: null }) }, '放弃修改')) : null,
          h('div', { className: 'ltm-compose' }, selected ? h('div', { className: 'ltm-selection' }, h('span', { 'aria-hidden': true }, '↳'), h('span', null, selected.title), h('button', { className: 'ltm-icon', 'aria-label': '取消选中段落', disabled: state.busy === 'apply' || state.busy === 'delete', onClick: () => choose(null) }, '×')) : null,
            h('div', { className: 'ltm-input-row' }, h('textarea', { ref: input, 'aria-label': '摘要修改要求', placeholder: selected ? `更正“${selected.title}”…` : '直接提问或更新记忆…', value: state.input, disabled: !state.view || active || state.confirmDelete, maxLength: 2000,
              onChange: event => patch({ input: event.target.value }), onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing) { event.preventDefault(); void generate('propose') } } }),
              h('button', { className: 'ltm-send', 'aria-label': state.busy === 'propose' || state.busy === 'refresh' ? '停止生成' : '发送修改要求', disabled: writing.current || !state.view || (!active && (!state.input.trim() || state.confirmDelete)), onClick: state.busy === 'propose' || state.busy === 'refresh' ? cancel : () => generate('propose') }, state.busy === 'propose' || state.busy === 'refresh' ? '■' : '↑'))))))
    }
    function withMemoryMenu(nativeRender, ctx) {
      // 宿主当前没有菜单子项插槽。固定复用原函数的 hook 顺序与原菜单，
      // 只适配 items/onSelect；账号资料、登录、反馈、退出仍由原组件处理。
      function AccountMenuWithMemory(props) {
        const [open, setOpen] = useState(false)
        const source = ctx.uiSession?.current
        const [sessionId, setSessionId] = useState(() => source?.getSnapshot?.()?.key)
        useEffect(() => source?.subscribe?.(() => setSessionId(source.getSnapshot()?.key)), [source])
        const nativeTree = nativeRender(props)
        function decorate(node) {
          if (Array.isArray(node)) return node.map(decorate)
          if (!React.isValidElement(node)) return node
          const items = node.props.items
          if (Array.isArray(items) && items.some(item => item.id === 'settings') && items.some(item => item.id === 'contact')) {
            const next = items.filter(item => item.id !== 'spike-ltm-memory')
            next.splice(next.findIndex(item => item.id === 'settings') + 1, 0, {
              id: 'spike-ltm-memory', label: '长期记忆',
              icon: h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
                h('path', { d: 'M5 3.5h12a2 2 0 0 1 2 2v15H7a3 3 0 0 1-3-3v-13a1 1 0 0 1 1-1ZM4 17.5a2.5 2.5 0 0 1 2.5-2.5H19M8 7h7M8 10h5' })),
            })
            return React.cloneElement(node, { items: next, onSelect: id => {
              if (id === 'spike-ltm-memory') { node.props.onClose?.(); setOpen(true) }
              else node.props.onSelect?.(id)
            } })
          }
          return node.props.children === undefined ? node : React.cloneElement(node, undefined, React.Children.map(node.props.children, decorate))
        }
        return h(React.Fragment, null, decorate(nativeTree), open ? h(MemoryDialog, { sessionId, onClose: () => setOpen(false) }) : null)
      }
      AccountMenuWithMemory.spikeLtmAvatarAdapter = true
      return AccountMenuWithMemory
    }
    function apply(ctx) {
      const dispose = ctx.slots.inject('settings.launcher', () => {
        let release = null, binding = false
        function bind() {
          if (release || binding) return
          const native = ctx.slots.entriesOfSlot('settings.launcher').find(entry => typeof entry.component === 'function' && !entry.component.spikeLtmAvatarAdapter)
          if (!native) return
          binding = true
          try {
            // 宿主按数值升序选择入口：更小的 priority 才能接管原菜单。
            release = ctx.slots.register({ name: 'settings.launcher', priority: (native.options?.priority ?? 0) - 1,
              inject: native.inject, locale: native.locale, children: native.children, store: native.store, select: native.select,
            }, withMemoryMenu(native.component, ctx))
          } finally { binding = false }
        }
        bind()
        const unsubscribe = ctx.slots.subscribe?.('settings.launcher', bind)
        return () => { unsubscribe?.(); release?.() }
      })
      ctx.effect(() => () => dispose?.(), 'spike-ltm-ui: cleanup')
    }
    return { name: 'spike-ltm-ui', inject: ['slots'], apply }
  },
})
