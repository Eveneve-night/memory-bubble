/**
 * 忆泡 · core / store 单测（node dev/test-core.mjs）
 * 不依赖 DSH，只验证纯逻辑与磁盘读写。
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

import {
  emptyState,
  mergeExtraction,
  computeLayout,
  buildDigest,
  digestFor,
  refreshDigest,
  rollbackBatch,
  parseExtraction,
  formatTranscript,
  exportGraph,
  importGraph,
  defaultConfig,
  normalizeExtraction,
  frequencyOf,
} from '../lib/core.js'
import { readState, writeState, memoryBubbleDir } from '../lib/store.js'

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('PASS', name) })
    .catch((error) => { console.error('FAIL', name, '\n ', error && error.stack ? error.stack : error); process.exitCode = 1 })
}

const SID = 's_test'

await check('空状态结构', () => {
  const state = emptyState()
  assert.equal(state.version, 1)
  assert.deepEqual(Object.keys(state.nodes), [])
  assert.equal(state.config.injection, 'digest')
  assert.equal(typeof state.config.debounceMs, 'number')
})

await check('抽取合并：新建 2 节点 + 1 边', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [
      { ref: 'n1', title: '猫咖「年糕」', summary: '常去猫咖，店猫叫年糕，橘猫。', keywords: ['猫咖', '年糕', '橘猫'], importance: 70, kind: '偏好' },
      { ref: 'n2', title: '周六陪父母吃饭', summary: '周六中午固定回家吃饭，尽量不安排其他事。', keywords: ['周六', '父母', '家庭'], importance: 80, kind: '计划' },
    ],
    relations: [{ from: 'n1', to: 'n2', summary: '都属周末安排', relation: '同主题', conflict: false }],
  }))
  const nodes = Object.values(state.nodes)
  assert.equal(nodes.length, 2)
  assert.equal(Object.values(state.edges).length, 1)
  const sess = state.sessions[SID]
  assert.equal(sess.extractCount, 1)
  assert.equal(state.batches.length, 1)
})

await check('去重：同义标题再次抽取 → 更新而不是新建', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [{ title: '猫咖年糕', summary: '常去猫咖。', keywords: ['猫咖', '年糕', '橘猫'], importance: 60, kind: '偏好' }],
  }))
  const before = Object.values(state.nodes)[0]
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [{ title: '猫咖的年糕', summary: '常去猫咖，橘猫年糕，喜欢布偶。', keywords: ['猫咖', '年糕', '布偶'], importance: 80, kind: '偏好' }],
  }))
  const nodes = Object.values(state.nodes)
  assert.equal(nodes.length, 1, '应合并为一条')
  assert.equal(nodes[0].id, before.id)
  assert.equal(nodes[0].hits, 2)
  assert.ok(nodes[0].keywords.includes('布偶'))
  assert.ok(nodes[0].importance >= 60 && nodes[0].importance <= 80)
})

await check('布局：尺寸固定，半径 16–46，越重要越大', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [
      { title: '大记忆', summary: 'a', keywords: ['大'], importance: 95, kind: '目标' },
      { title: '小记忆', summary: 'b', keywords: ['小'], importance: 10, kind: '事实' },
      { title: '中记忆', summary: 'c', keywords: ['中'], importance: 50, kind: '事实' },
    ],
  }))
  const layout = computeLayout(state)
  assert.equal(layout.width, 760)
  assert.equal(layout.height, 560)
  const big = layout.nodes.find((n) => n.title === '大记忆')
  const small = layout.nodes.find((n) => n.title === '小记忆')
  assert.ok(big.r > small.r)
  assert.ok(big.r >= 16 && big.r <= 47)
  assert.equal(layout.edges.length, 0)
})

await check('简报：包含条目、冲突提示、钉选', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [
      { ref: 'a', title: '先结结论', summary: '输出偏好先结论后细节。', keywords: ['输出', '结论'], importance: 85, kind: '偏好' },
      { ref: 'b', title: '技术推导', summary: '技术讨论希望展开推导。', keywords: ['技术', '推导'], importance: 60, kind: '偏好' },
    ],
    relations: [{ from: 'a', to: 'b', summary: '两种回答风格可能冲突', relation: '对立', conflict: true }],
  }))
  state.sessions[SID].tray = [Object.keys(state.nodes)[0]]
  const digest = buildDigest(state, SID)
  assert.ok(digest.text.includes('【忆泡记忆简报】'))
  assert.ok(digest.text.includes('先结结论'))
  assert.ok(digest.text.includes('⚠'))
  assert.ok(digest.text.includes('钉选'))
  const again = buildDigest(state, SID)
  assert.equal(again.text, digest.text, '同样输入必须产出同样文本（稳定前缀）')
  refreshDigest(state, SID)
  assert.equal(digestFor(state, SID), digest.text)
})

await check('撤销：新建的节点与边被移除，更新回滚', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [{ title: '旧记忆', summary: '旧摘要', keywords: ['旧'], importance: 50, kind: '事实' }],
  }))
  const first = state.batches[0]
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [
      { title: '旧记忆', summary: '新摘要', keywords: ['旧'], importance: 90, kind: '事实' },
      { title: '新记忆', summary: '新', keywords: ['新'], importance: 70, kind: '偏好' },
    ],
  }))
  assert.equal(Object.values(state.nodes).length, 2)
  rollbackBatch(state, { batchId: state.batches[0].id })
  const nodes = Object.values(state.nodes)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].title, '旧记忆')
  assert.equal(nodes[0].importance, 50)
  assert.ok(first)
  rollbackBatch(state, { batchId: first.id })
  assert.equal(Object.values(state.nodes).length, 0)
})

await check('解析：代码围栏、尾逗号、单引号都能救回', () => {
  const fenced = '```json\n{"memories":[{"title":"A","summary":"x","keywords":["k"],"importance":60,"kind":"偏好"}],}\n```'
  assert.equal(parseExtraction(fenced).memories.length, 1)
  const broken = "{'memories':[{'title':'B','summary':'y','keywords':['k2'],'importance':30,'kind':'事实',}],}"
  const parsed = parseExtraction(broken)
  assert.ok(parsed && parsed.memories.length === 1)
  assert.equal(parsed.memories[0].title, 'B')
  assert.equal(parseExtraction('抱歉，我无法完成'), null)
  assert.equal(parseExtraction(''), null)
})

await check('转录：角色标注 + 截断保留最近', () => {
  const text = formatTranscript([
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第二句' },
  ], 100)
  assert.ok(text.includes('用户：第一句'))
  assert.ok(text.includes('AI：第二句'))
  const long = formatTranscript(Array.from({ length: 200 }, (_, i) => ({ role: 'user', text: `第${i}句` })), 60)
  assert.ok(long.length <= 80)
  assert.ok(long.includes('更早的对话已省略'))
})

await check('导出 / 导入（继承）', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({
    memories: [
      { ref: 'a', title: '甲', summary: 'a', keywords: ['甲'], importance: 70, kind: '事实' },
      { ref: 'b', title: '乙', summary: 'b', keywords: ['乙'], importance: 40, kind: '事实' },
    ],
    relations: [{ from: 'a', to: 'b', summary: '关联', relation: '相关', conflict: false }],
  }))
  const exported = exportGraph(state)
  const target = emptyState()
  const report = importGraph(target, exported)
  assert.equal(report.nodes, 2)
  assert.equal(report.edges, 1)
  assert.equal(Object.values(target.nodes).length, 2)
  assert.equal(Object.values(target.edges).length, 1)
  const again = importGraph(target, exported)
  assert.equal(again.edges, 0)
  assert.equal(Object.values(target.nodes).length, 2)
})

await check('频率：跨会话、命中越多越高', () => {
  const state = emptyState()
  mergeExtraction(state, SID, normalizeExtraction({ memories: [{ title: '热', summary: '', keywords: ['热'], importance: 60, kind: '偏好' }] }))
  const node = Object.values(state.nodes)[0]
  const low = frequencyOf(state, node)
  node.hits = 6
  node.sessions = ['s_test', 's_2', 's_3']
  const high = frequencyOf(state, node)
  assert.ok(high > low)
})

await check('磁盘：读写往返 + 损坏回退空状态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-bubble-'))
  try {
    const state = emptyState()
    mergeExtraction(state, SID, normalizeExtraction({ memories: [{ title: '落盘', summary: 'ok', keywords: ['盘'], importance: 66, kind: '事实' }] }))
    const file = await writeState(dir, state)
    assert.equal(file, path.join(memoryBubbleDir(dir), 'state.json'))
    const loaded = await readState(dir)
    assert.equal(Object.values(loaded.nodes).length, 1)
    assert.equal(Object.values(loaded.nodes)[0].title, '落盘')
    const dir2 = await mkdtemp(path.join(os.tmpdir(), 'memory-bubble-bad-'))
    await writeFile(path.join(dir2, 'state.json'), '{broken json', 'utf8')
    const fallback = await readState(dir2)
    assert.equal(Object.values(fallback.nodes).length, 0)
    await rm(dir2, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('配置默认值可覆盖', () => {
  const state = emptyState({ debounceMs: 5000 })
  assert.equal(state.config.debounceMs, 5000)
  assert.equal(state.config.injection, defaultConfig().injection)
})

console.log(`\n${passed} checks passed`)
