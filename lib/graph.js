/**
 * 图记忆：实体 + 带时效的边。
 *
 * 研究里有个反直觉的结论：图谱检索在基础事实回忆上会输给关键词，
 * 必须做多跳扩展（PPR / 更深整合）才追平。所以这里不做纯图检索，
 * 只做「关键词命中实体 → 往外走一两跳」的补充通道。
 * 边跟事实层一样有 validFrom / validTo，改口不是删边，是让旧边过期。
 */
import { tokenize, ulid } from './store.js'

const MAX_NODES = 500
const MAX_EDGES = 1200

export function ensureNode(store, name, type = 'concept') {
  const clean = String(name || '').trim().slice(0, 40)
  if (!clean) return null
  const existing = store.of('graph').find((record) => record.kind === 'node' && record.name === clean)
  if (existing) return existing
  const node = { id: ulid(), kind: 'node', name: clean, type, ts: Date.now() }
  store.put('graph', node)

  const nodes = store.of('graph').filter((record) => record.kind === 'node')
  if (nodes.length > MAX_NODES) {
    for (const old of nodes.slice(0, nodes.length - MAX_NODES)) {
      store.put('graph', { ...old, status: 'invalid', invalidatedAt: Date.now(), invalidReason: 'node-cap' })
    }
  }
  return node
}

export function applyTriple(store, triple, { sourceEvent = null } = {}) {
  if (!triple) return null
  const from = ensureNode(store, triple.from, triple.fromType)
  const to = ensureNode(store, triple.to, triple.toType)
  const relation = String(triple.relation || '').trim().slice(0, 24)
  if (!from || !to || !relation) return null

  const edges = store.of('graph').filter((record) => record.kind === 'edge')
  const same = edges.find((edge) => edge.from === from.id && edge.to === to.id && edge.relation === relation)
  if (same) return same

  // 同一个主语、同一个关系、对象变了：旧边过期，新边生效
  const now = Date.now()
  for (const edge of edges) {
    if (edge.from !== from.id || edge.relation !== relation) continue
    if (edge.to === to.id) continue
    store.put('graph', { ...edge, validTo: now, status: 'invalid', invalidatedAt: now, invalidReason: 'relation-changed' })
  }

  const edge = {
    id: ulid(),
    kind: 'edge',
    from: from.id,
    to: to.id,
    relation,
    validFrom: now,
    conf: Number(triple.conf ?? 0.7),
    sourceEvent,
    ts: now,
  }
  store.put('graph', edge)

  const live = store.of('graph').filter((record) => record.kind === 'edge')
  if (live.length > MAX_EDGES) {
    for (const old of live.slice(0, live.length - MAX_EDGES)) {
      store.put('graph', { ...old, status: 'invalid', invalidatedAt: now, invalidReason: 'edge-cap' })
    }
  }
  return edge
}

/** 从一句话里找实体，往外走一两跳，返回可注入的几行关系。 */
export function graphRecall(store, query, { hops = 2, limit = 6 } = {}) {
  const terms = tokenize(query)
  if (terms.size === 0) return ''
  const records = store.of('graph')
  const nodes = records.filter((record) => record.kind === 'node')
  const edges = records.filter((record) => record.kind === 'edge')
  if (nodes.length === 0 || edges.length === 0) return ''

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seeds = nodes.filter((node) => {
    const nodeTerms = tokenize(node.name)
    for (const term of nodeTerms) if (terms.has(term)) return true
    return false
  })
  if (seeds.length === 0) return ''

  const seenEdges = new Set()
  const lines = []
  let frontier = seeds.map((node) => ({ node, hop: 0 }))
  const visited = new Set(seeds.map((node) => node.id))

  for (let hop = 1; hop <= hops; hop += 1) {
    const next = []
    for (const { node } of frontier) {
      for (const edge of edges) {
        if (edge.from !== node.id && edge.to !== node.id) continue
        if (seenEdges.has(edge.id)) continue
        seenEdges.add(edge.id)
        const other = byId.get(edge.from === node.id ? edge.to : edge.from)
        if (!other) continue
        lines.push({
          hop,
          text: `${byId.get(edge.from)?.name ?? '?'} → ${edge.relation} → ${byId.get(edge.to)?.name ?? '?'}`,
        })
        if (!visited.has(other.id)) {
          visited.add(other.id)
          next.push({ node: other, hop })
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  if (lines.length === 0) return ''
  const picked = lines
    .sort((a, b) => a.hop - b.hop)
    .slice(0, limit)
    .map((item) => `- ${item.text}`)
  return `[关系]\n${picked.join('\n')}`
}

export function graphStats(store) {
  const records = store.of('graph')
  return {
    nodes: records.filter((record) => record.kind === 'node').length,
    edges: records.filter((record) => record.kind === 'edge').length,
  }
}
