import assert from 'node:assert/strict'
import { computeLayout, emptyState } from '../lib/core.js'

function graph(count, topology = 'chain', uniform = false) {
  const state = emptyState()
  for (let i = 0; i < count; i += 1) {
    const id = `node-${i}`
    state.nodes[id] = { id, title: `记忆 ${i}`, importance: uniform ? 100 : (i * 17) % 101,
      hits: 1 + (i % 10) * 3, sessions: ['s1'] }
    if (i && topology !== 'none') state.edges[`e${i}`] = { id: `e${i}`, from: topology === 'star' ? 'node-0' : `node-${i - 1}`, to: id }
  }
  return state
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
function length(layout, edges) {
  const nodes = new Map(layout.nodes.map((node) => [node.id, node]))
  return edges.reduce((sum, edge) => sum + distance(nodes.get(edge.from), nodes.get(edge.to)), 0)
}

const state = graph(32)
const snapshot = structuredClone(state)
const layout = computeLayout(state)
assert.deepEqual(state, snapshot, '布局不改写记忆数据')
assert.deepEqual(computeLayout(state), layout, '刷新时位置稳定')
const reordered = { ...state, nodes: Object.fromEntries(Object.entries(state.nodes).reverse()), edges: Object.fromEntries(Object.entries(state.edges).reverse()) }
const canonical = (result) => result.nodes.map(({ id, x, y, r }) => ({ id, x, y, r })).sort((a, b) => a.id.localeCompare(b.id))
assert.deepEqual(canonical(computeLayout(reordered)), canonical(layout), '输入顺序不影响布局')
console.log('PASS 布局稳定、不依赖输入顺序、不修改数据')

const unlinked = computeLayout({ ...state, edges: {} })
const ratio = length(layout, Object.values(state.edges)) / length(unlinked, Object.values(state.edges))
assert.ok(ratio < 0.9, `连线总长度应下降，实际比例 ${ratio}`)
console.log(`PASS 连线总长度减少 ${Math.round((1 - ratio) * 100)}%`)

const center = { x: layout.width / 2, y: layout.height / 2 }
const ranked = [...layout.nodes].sort((a, b) => b.freq - a.freq)
const meanRadius = (nodes) => nodes.reduce((sum, node) => sum + distance(node, center), 0) / nodes.length
assert.ok(meanRadius(ranked.slice(0, 8)) < meanRadius(ranked.slice(-8)) * 0.65, '高频记忆应更靠近中心')
for (const node of layout.nodes) assert.equal(node.r, Math.round(16 + node.importance * 0.3))
assert.equal(layout.nodes.find((node) => node.importance === 0).r, 16)
console.log('PASS 高频靠中心，重要程度独立决定气泡大小')

for (const topology of ['star', 'chain', 'none']) {
  const dense = computeLayout(graph(300, topology, true))
  for (let i = 0; i < dense.nodes.length; i += 1) {
    const a = dense.nodes[i]
    assert.equal(a.collisionR, a.r + 6)
    assert.ok(a.x - a.r >= 0 && a.x + a.r <= dense.width)
    assert.ok(a.y - a.r >= 0 && a.y + a.r <= dense.height)
    for (let j = 0; j < i; j += 1) {
      const b = dense.nodes[j]
      assert.ok(distance(a, b) + 1e-7 >= a.collisionR + b.collisionR, `${topology}: ${a.id} 与 ${b.id} 碰撞区重叠`)
    }
  }
  const byId = new Map(dense.nodes.map((node) => [node.id, node]))
  for (const edge of dense.edges) {
    assert.equal(edge.x1, byId.get(edge.from).x)
    assert.equal(edge.y2, byId.get(edge.to).y)
  }
  console.log(`PASS 300 个最大气泡 ${topology} 布局无重叠、无越界、连线端点正确`)
}

assert.equal(computeLayout(emptyState()).nodes.length, 0)
const solo = computeLayout(graph(1))
assert.equal(solo.nodes[0].x, solo.width / 2)
assert.equal(solo.nodes[0].y, solo.height / 2)
const dangling = graph(2)
dangling.edges.missing = { id: 'missing', from: 'node-0', to: 'deleted' }
assert.equal(computeLayout(dangling).edges.length, 1)
console.log('PASS 空图、单气泡、失效连线兼容')

state.nodes['node-0'].importance = 100
const resized = computeLayout(state)
const moved = new Map(resized.nodes.map((node) => [node.id, node]))
for (const edge of resized.edges) {
  assert.deepEqual([edge.x1, edge.y1, edge.x2, edge.y2],
    [moved.get(edge.from).x, moved.get(edge.from).y, moved.get(edge.to).x, moved.get(edge.to).y])
}
console.log('PASS 气泡大小及位置更新后，连线端点同步更新')
