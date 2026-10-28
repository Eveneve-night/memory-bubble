/**
 * 忆泡 · 纯逻辑自检（不需要 DSH）
 * 运行：node dev/test-core.mjs
 */
import assert from 'node:assert/strict'
import {
  emptyState, mergeExtraction, sessionState, computeLayout, buildDigest,
  refreshDigest, digestFor, rollbackBatch, exportGraph, importGraph,
  defaultConfig, sessionNodeCount, normalizeExtraction, buildBundle,
} from '../lib/core.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    console.error('FAIL ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

const extraction = (over) => Object.assign({
  memories: [
    { ref: 'a', title: '喜欢猫咖', summary: '喜欢去安静的猫咖，尤其橘猫。', evidence: '我周末常去猫咖', keywords: ['猫咖', '橘猫'], importance: 72, kind: 'preference' },
    { ref: 'b', title: '周报用要点', summary: '周报先给结论，再列要点。', evidence: '周报请先给结论', keywords: ['周报', '结论'], importance: 64, kind: 'preference' },
  ],
  relations: [{ from: 'a', to: 'b', summary: '都是表达偏好', relation: '相关' }],
}, over)

check('默认配置：自动生成关闭、每轮最多 3 条、总量 300', () => {
  const cfg = defaultConfig()
  assert.equal(cfg.auto, false)
  assert.equal(cfg.maxPerExtraction, 3)
  assert.equal(cfg.maxTotalNodes, 300)
  assert.equal(cfg.injection, 'digest')
})

check('新会话从零开始：空状态没有节点，sessionNodes 为 0', () => {
  const state = emptyState()
  assert.equal(Object.keys(state.nodes).length, 0)
  assert.equal(Object.keys(state.edges).length, 0)
  assert.equal(sessionNodeCount(state, 's1'), 0)
  assert.equal(buildDigest(state, 's1').text, '')
})

check('抽取后节点带创建时间，且自动抽取必须有用户原话依据', () => {
  const state = emptyState()
  const at = '2026-10-01T02:03:04.000Z'
  const withoutEvidence = extraction({ memories: [{ title: '没有依据', summary: 'x', evidence: '', importance: 50 }] })
  mergeExtraction(state, 's1', withoutEvidence, at)
  assert.equal(Object.keys(state.nodes).length, 0, '无 evidence 的自动记忆应被丢弃')
  mergeExtraction(state, 's1', extraction(), at)
  const node = Object.values(state.nodes)[0]
  assert.equal(node.created, at)
  assert.equal(node.sessions[0], 's1')
  assert.equal(Object.keys(state.edges).length, 1)
})

check('手动新增可指定记录时间（覆盖默认 now）', () => {
  const state = emptyState()
  const created = '2025-12-24T10:00:00.000Z'
  mergeExtraction(state, 's1', { memories: [{ title: '手记', summary: '手动记录', manual: true, created, importance: 40 }], relations: [] }, '2026-10-02T00:00:00.000Z')
  const node = Object.values(state.nodes)[0]
  assert.equal(node.created, created)
  assert.equal(node.updated, '2026-10-02T00:00:00.000Z')
})

check('每轮新建数量上限 maxPerExtraction 生效', () => {
  const state = emptyState()
  state.config.maxPerExtraction = 1
  const many = extraction({
    memories: [
      { title: '甲', summary: 'a', evidence: 'e1', importance: 60 },
      { title: '乙', summary: 'b', evidence: 'e2', importance: 60 },
      { title: '丙', summary: 'c', evidence: 'e3', importance: 60 },
    ],
    relations: [],
  })
  const batch = mergeExtraction(state, 's1', many)
  assert.equal(Object.keys(state.nodes).length, 1)
  assert.equal(batch.skipped, 2)
})

check('总量上限 maxTotalNodes 生效', () => {
  const state = emptyState()
  state.config.maxTotalNodes = 2
  for (let i = 0; i < 5; i += 1) {
    mergeExtraction(state, 's1', { memories: [{ title: `条目${i}`, summary: 'x', evidence: `e${i}`, importance: 50 }], relations: [] })
  }
  assert.equal(Object.keys(state.nodes).length, 2)
})

check('记忆按会话隔离：A 会话的节点不会出现在 B 会话简报里', () => {
  const state = emptyState()
  mergeExtraction(state, 'A', extraction())
  refreshDigest(state, 'A')
  refreshDigest(state, 'B')
  const digestA = digestFor(state, 'A')
  const digestB = digestFor(state, 'B')
  assert.ok(digestA.includes('喜欢猫咖'), 'A 应有自己的记忆')
  assert.equal(digestB, '', 'B 会话开始时没有任何记忆')
  assert.equal(sessionNodeCount(state, 'B'), 0)
  assert.equal(sessionState(state, 'B').extractCount, 0)
})

check('重复抽取合并而不重复建节点', () => {
  const state = emptyState()
  mergeExtraction(state, 's1', extraction())
  mergeExtraction(state, 's1', extraction())
  assert.equal(Object.keys(state.nodes).length, 2)
  const node = Object.values(state.nodes)[0]
  assert.ok(node.hits >= 2)
})

check('撤销上一批：节点/边回滚，简报也回滚', () => {
  const state = emptyState()
  mergeExtraction(state, 's1', { memories: [{ title: '临时', summary: 'x', evidence: 'e', importance: 50 }], relations: [] })
  refreshDigest(state, 's1')
  const batch = rollbackBatch(state, { sessionId: 's1' })
  assert.ok(batch && batch.id)
  assert.equal(Object.keys(state.nodes).length, 0)
  assert.equal(digestFor(state, 's1'), '')
})

check('布局：无节点时不炸；有节点时半径随重要性变化', () => {
  const empty = emptyState()
  const layout0 = computeLayout(empty, 's1')
  assert.equal(layout0.nodes.length, 0)
  const state = emptyState()
  mergeExtraction(state, 's1', {
    memories: [
      { title: '重要', summary: 'x', evidence: 'e', importance: 95 },
      { title: '次要', summary: 'y', evidence: 'e', importance: 10 },
    ],
    relations: [],
  })
  const layout = computeLayout(state, 's1')
  const big = layout.nodes.find((n) => n.title === '重要')
  const small = layout.nodes.find((n) => n.title === '次要')
  assert.ok(big.r > small.r)
  assert.ok(big.x >= 0 && big.y >= 0)
})

check('导出/导入往返：导入去重，图谱结构保持', () => {
  const state = emptyState()
  mergeExtraction(state, 's1', extraction())
  const bundle = exportGraph(state)
  const target = emptyState()
  const report1 = importGraph(target, bundle.graph)
  assert.equal(report1.nodes, 2)
  importGraph(target, bundle.graph)
  assert.equal(Object.keys(target.nodes).length, 2)
  assert.equal(Object.keys(target.edges).length, 1)
})

check('解析模型输出：容忍代码块包裹与结尾逗号', () => {
  const text = '```json\n{"memories":[{"title":"A","summary":"s","evidence":"e","keywords":["k"],"importance":60}],}\n```'
  const parsed = parseLoose(text)
  assert.equal(parsed.memories[0].title, 'A')
})

function parseLoose(text) {
  try {
    return JSON.parse(text.replace(/```(?:json)?/gi, '').replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return normalizeExtraction(text)
  }
}

check('便携包：buildBundle 含 schema/prompt/tools/graph', () => {
  const state = emptyState()
  mergeExtraction(state, 's1', extraction())
  const bundle = buildBundle(state)
  for (const key of ['schema', 'prompt', 'tools', 'graph']) assert.ok(key in bundle)
  assert.equal(bundle.tools.length, 5)
})

console.log(`\n${passed} 项通过`)
