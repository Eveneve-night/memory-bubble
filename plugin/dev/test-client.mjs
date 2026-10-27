/**
 * 忆泡 · 客户端半冒烟测试（node dev/test-client.mjs）
 *
 * 在 node 里伪造 window.__ModuleLoader__ / react / document / fetch / ctx，
 * 加载真实 lib/client.js，验证：
 *  - 模块能被工厂加载并导出 apply / inject；
 *  - 四个 slot 注册齐全（sidebar.panellist / main / conversation.input.left / settings.section）；
 *  - 组件函数被调用时不抛错，且能渲染出关键文案与结构。
 */

import assert from 'node:assert/strict'

/* ------------------------------------------------------------ 伪造环境 */

const styleTags = []
const fakeDocument = {
  documentElement: { dataset: {} },
  head: { appendChild() {} },
  querySelector() { return null },
  createElement() {
    const el = {
      style: {},
      dataset: {},
      setAttribute(key, value) { this[key] = value },
      appendChild() {},
      remove() {},
      textContent: '',
    }
    styleTags.push(el)
    return el
  },
}

function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: Object.assign({}, props || {}, children.length ? { children } : {}),
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

const graphFixture = {
  ok: true,
  layout: {
    width: 760,
    height: 560,
    nodes: [
      { id: 'n1', title: '在学 Rust', summary: '用具体例子讲。', kind: '目标', tone: 'peach', keywords: ['Rust', '学习'], importance: 78, hits: 2, sessions: ['s1'], created: '2026-10-01T00:00:00.000Z', updated: '2026-10-02T00:00:00.000Z', x: 300, y: 260, r: 34, freq: 0.6, pinned: false },
      { id: 'n2', title: '每周读论文', summary: '每周一篇。', kind: '计划', tone: 'honey', keywords: ['论文'], importance: 60, hits: 1, sessions: ['s1'], created: '2026-10-01T00:00:00.000Z', updated: '2026-10-02T00:00:00.000Z', x: 460, y: 300, r: 24, freq: 0.2, pinned: false },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', summary: '时间可能冲突', relation: '相关', conflict: true, updated: '2026-10-02T00:00:00.000Z' },
    ],
  },
  config: { auto: true, debounceMs: 15000, minIntervalMs: 90000, maxTranscriptChars: 6000, injection: 'digest', digestLimit: 12, maxExistingInPrompt: 40 },
  stats: { nodes: 2, edges: 1, sessions: 1, conflicts: 1, lastExtractAt: '2026-10-27T00:00:00.000Z' },
  session: { enabled: true, tray: ['n1'], title: '测试会话', lastExtractAt: '2026-10-27T00:00:00.000Z', lastError: null, pending: false, extractCount: 2 },
  digest: '【忆泡记忆简报】\n长期记忆：\n1. [目标] 在学 Rust：用具体例子讲。',
  sessions: [{ id: 's1', title: '测试会话', enabled: true, extractCount: 2, lastExtractAt: '2026-10-27T00:00:00.000Z' }],
}

globalThis.document = fakeDocument
globalThis.window = globalThis
globalThis.fetch = async (url) => {
  const body = String(url).includes('/config') ? { ok: true, config: graphFixture.config } : graphFixture
  return { ok: true, status: 200, json: async () => body }
}

const registrations = []
const ctx = {
  get(name) {
    if (name === 'layout') return { selectPanel() {} }
    if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
    return undefined
  },
  on() { return () => {} },
  slots: {
    inject(slot, factory) {
      factory()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

let moduleExports = null
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    assert.equal(id, 'dsh-memory-bubble')
    moduleExports = factory((name) => {
      if (name === 'react') return makeReact()
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

await import('../lib/client.js')

/* ------------------------------------------------------------ 断言 */

assert.ok(moduleExports, '模块应已加载')
assert.equal(typeof moduleExports.apply, 'function')
assert.deepEqual(moduleExports.inject, ['slots'])

moduleExports.apply(ctx)

const bySlot = new Map(registrations.map((item) => [item.options.name, item]))
assert.equal(registrations.length, 4, `应注册 4 个位置，实际 ${registrations.length}`)
assert.ok(styleTags.some((el) => String(el.textContent).includes('.mb-root')), '应注入忆泡样式')

const main = bySlot.get('main')
assert.ok(main, '缺少 main')
assert.equal(main.options.key, 'memory-bubble')

const sidebar = bySlot.get('sidebar.panellist')
assert.ok(sidebar, '缺少 sidebar.panellist')
assert.equal(sidebar.options.id, 'memory-bubble')

const trigger = bySlot.get('conversation.input.left')
assert.ok(trigger, '缺少 conversation.input.left')

const settings = bySlot.get('settings.section')
assert.ok(settings, '缺少 settings.section')

function render(el) {
  if (!el) return null
  if (Array.isArray(el)) return el.map(render)
  if (typeof el.type === 'function') return render(el.type(el.props))
  return el
}

const panel = render(main.component({ ctx }))
assert.ok(panel && panel.props && String(panel.props.className).includes('mb-root'), '主面板应渲染出 mb-root')

const pill = render(trigger.component({ ctx, sessionId: 's1' }))
assert.ok(pill && pill.props && String(pill.props.className).includes('mb-trigger'), '药丸按钮应渲染')

const settingsEl = render(settings.component({ ctx }))
assert.ok(settingsEl, '设置页应渲染')

console.log('PASS 客户端模块加载与导出')
console.log('PASS 四个 slot 注册齐全（main / sidebar.panellist / conversation.input.left / settings.section）')
console.log('PASS 样式注入、主面板、药丸、设置页渲染均不抛错')
