// 线上界面复用同一个 JSON core，不迁移到测试 SQLite，也不另开文件写入者。
import { VIEW_KINDS } from './memory-ui-service.js'

export const LIVE_SCOPES = [
  { label: '全局', kind: 'global', scopeIds: ['global'] },
  { label: '项目旧记录（未绑定）', kind: 'project', scopeIds: ['project'] },
]

export function createLiveAdapter(core) {
  function read({ id, scopeIds }) {
    const item = core.inspect().items.find(x => x.id === id && x.status === 'active')
    if (!item) throw new Error('NOT_FOUND')
    if (!scopeIds?.includes(item.scope)) throw new Error('SCOPE_DENIED')
    return { ...item, version: item.version ?? 1, scopeId: item.scope }
  }
  return {
    source: 'live',
    revision: () => core.inspect().revision,
    read,
    list(scopeIds) {
      const state = core.inspect()
      const items = state.items.filter(x => x.status === 'active' && scopeIds.includes(x.scope))
        .map(x => ({ ...x, history: undefined, version: x.version ?? 1, scopeId: x.scope }))
      const allowed = new Set(items.map(x => x.id))
      const summary = (state.profile?.sections ?? []).map(s => ({ title: s.title,
        bullets: s.bullets.filter(b => b.refs.length && b.refs.every(id => allowed.has(id))) })).filter(s => s.bullets.length)
      const covered = new Set(summary.flatMap(s => s.bullets.flatMap(b => b.refs)))
      // 修改后的条目立刻可见；没有重新综合前，显示准确原文而非旧推断。
      for (const [kind, title] of VIEW_KINDS) {
        const remaining = items.filter(x => x.kind === kind && !covered.has(x.id))
        if (remaining.length) summary.push({ title: `${title} · 已保存条目`, bullets: remaining.map(x => ({ text: x.text, refs: [x.id] })) })
      }
      return { revision: state.revision, total: items.length, summary,
        sections: VIEW_KINDS.map(([kind, title]) => ({ kind, title, items: items.filter(x => x.kind === kind) })).filter(s => s.items.length) }
    },
    edit: ({ scopeId, ...args }) => core.updateItem({ ...args, scope: scopeId }),
    versions: ({ id, scopeIds }) => { read({ id, scopeIds }); return core.itemVersions(id) },
    restore({ id, scopeId, expectedVersion, targetVersion }) {
      read({ id, scopeIds: [scopeId] })
      const version = core.itemVersions(id).find(v => v.version === targetVersion)
      if (!version) throw new Error('VERSION_NOT_FOUND')
      return core.updateItem({ id, scope: scopeId, expectedVersion, text: version.text, reason: `restore:v${targetVersion}` })
    },
    forget: ({ scopeId, ...args }) => core.forgetItem({ ...args, scope: scopeId }),
  }
}
