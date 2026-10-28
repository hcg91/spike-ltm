// Bounded lexical candidate selection for extraction prompts. This does not
// decide what to remember and never bypasses semantic injection thresholds.
function terms(text) {
  const out = new Set()
  for (const part of String(text).toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[a-z0-9_]+$/.test(part)) out.add(part)
    else for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2))
  }
  return out
}
export function extractionTargets(items, query, { limit = 60, chars = 16000 } = {}) {
  const q = terms(query)
  const ranked = items.filter(i => i.status === 'active').map((item, index) => {
    const words = terms(item.text)
    let score = 0
    for (const word of words) if (q.has(word)) score += 1
    return { item, index, score: score / Math.sqrt(words.size || 1) }
  }).sort((a, b) => b.score - a.score || b.index - a.index)
  const result = []
  let used = 0
  for (const { item } of ranked) {
    const value = { id: item.id, text: item.text, scope: item.scope, version: item.version ?? 1, status: item.status }
    const cost = JSON.stringify(value).length
    if (result.length >= limit) break
    if (used + cost > chars) continue
    used += cost; result.push(value)
  }
  return result
}
