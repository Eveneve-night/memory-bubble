/**
 * 忆泡 · 宿主 + 客户端自检（不需要 DSH）
 * 运行：node dev/test-plugin.mjs
 *
 * 覆盖：插件注册契约、HTTP 路由、会话事件折叠、防开局幻觉、手动时间、
 *       pre-step 注入兜底、客户端 slot 注册（无 main 面板）、浮窗默认关闭/可开关。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const profileDir = await mkdtemp(path.join(tmpdir(), 'mb-test-'))
process.env.DSH_PROFILE_DIR = profileDir

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    console.error('FAIL ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ 宿主半 */

const hooks = new Map()
const routes = new Map()
const tools = []
const hostCleanups = []
const services = {
  sessions: {
    get(id) {
      return { id, snapshotEvents: () => [] }
    },
  },
  llm: {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ memories: [{ title: '喜欢猫咖', summary: '喜欢安静的猫咖', evidence: '我周末常去猫咖', keywords: ['猫咖'], importance: 70, kind: 'preference' }], relations: [] }) }
      yield { type: 'finish', reason: {} }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
  tools: { register(definition) { tools.push(definition); return () => {} } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
}

const memBubbleCtx = {
  effect(fn) { const off = fn(); if (typeof off === 'function') hostCleanups.push(off); return off },
  on(name, fn) { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list) },
  get(name) { return services[name] },
  webServer: services.webServer,
  tools: services.tools,
}

function emit(name, ...args) {
  const list = hooks.get(name) || []
  return Promise.all(list.map((fn) => fn(...args)))
}

class FakeReq {
  constructor(url, body, method) {
    this.url = url
    this.method = method || 'GET'
    this._body = body === undefined ? '' : JSON.stringify(body)
    this._listeners = new Map()
  }
  on(event, callback) {
    const list = this._listeners.get(event) || []
    list.push(callback)
    this._listeners.set(event, list)
    return this
  }
  destroy() {}
  flush() {
    for (const cb of this._listeners.get('data') || []) cb(Buffer.from(this._body))
    for (const cb of this._listeners.get('end') || []) cb()
  }
}

function call(pathname, options = {}) {
  const url = new URL(pathname, 'http://dsh.local')
  const handler = routes.get(url.pathname)
  if (!handler) return Promise.reject(new Error('route not found: ' + url.pathname))
  const req = new FakeReq(pathname, options.body, options.method)
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: undefined,
      setHeader(key, value) { this.headers[key] = value },
      end(text) {
        try {
          this.body = text ? JSON.parse(text) : null
          resolve(this)
        } catch (error) { reject(error) }
      },
    }
    handler(req, res).catch(reject)
    setImmediate(() => req.flush())
  })
}

const host = await import('../lib/index.js')

await check('注册契约：name/inject 正确，路由与 5 个工具都注册', async () => {
  assert.equal(host.name, 'memory-bubble')
  assert.deepEqual(host.inject, ['webServer'])
  host.apply(memBubbleCtx)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(routes.size >= 12, 'routes=' + routes.size)
  assert.equal(tools.length, 5)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['memory_brief', 'memory_forget', 'memory_link', 'memory_remember', 'memory_search'])
})

await check('工具注册使用完整 JSON Schema，必填参数和数组元素类型正确', async () => {
  const { TOOL_MANIFEST } = await import('../lib/core.js')
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', tool.name)
    assert.deepEqual(tool.parameters, TOOL_MANIFEST.find((item) => item.name === tool.name).parameters)
    assert.equal(tool.parameters.required === undefined || Array.isArray(tool.parameters.required), true)
  }
  assert.deepEqual(tools.find((tool) => tool.name === 'memory_remember').parameters.properties.keywords.items, { type: 'string' })
})

await check('零起点：/health firstRun=true、auto=false、没有任何记忆', async () => {
  const res = await call('/memory-bubble/api/health')
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.firstRun, true)
  assert.equal(res.body.auto, false)
  assert.equal(res.body.totalNodes, 0)
})

await check('防开局幻觉：运行时上下文/注入消息不折叠进对话', async () => {
  await emit('session/event', { id: 'S1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Current runtime context.\nCurrent working directory: D:\\x' }] } })
  await emit('session/event', { id: 'S1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<available_skills>foo</available_skills>' }] } })
  await emit('session/event', { id: 'S1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '【忆泡记忆简报】旧简报不应该被自己读进记忆' }] } })
  const res = await call('/memory-bubble/api/extract', { method: 'POST', body: { sessionId: 'S1' } })
  assert.equal(res.body.ok, false, '没有任何用户本人发言时不应总结')
  assert.equal(res.body.created, undefined)
  const graph = await call('/memory-bubble/api/graph?sessionId=S1&scope=session')
  assert.equal(graph.body.layout.nodes.length, 0)
})

await check('真实用户发言 + 回合结束：抽取成记忆并生成本会话简报', async () => {
  await emit('session/event', { id: 'S1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我周末常去猫咖，喜欢橘猫' }] } })
  const extracted = await call('/memory-bubble/api/extract', { method: 'POST', body: { sessionId: 'S1', force: true } })
  assert.equal(extracted.body.ok, true)
  assert.ok(extracted.body.created >= 1)
  const graph = await call('/memory-bubble/api/graph?sessionId=S1&scope=session')
  assert.equal(graph.body.layout.nodes.length, 1)
  assert.ok(graph.body.digest.includes('喜欢猫咖'))
  const health = await call('/memory-bubble/api/health?sessionId=S1')
  assert.equal(health.body.firstRun, false)
  assert.equal(health.body.sessionNodes, 1)
})

await check('会话隔离：S2 从零开始，看不到 S1 的记忆', async () => {
  const graph = await call('/memory-bubble/api/graph?sessionId=S2&scope=session')
  assert.equal(graph.body.layout.nodes.length, 0)
  assert.equal(graph.body.digest, '')
})

await check('手动新增可指定记录时间，编辑可改时间', async () => {
  const createdAt = '2025-12-24T10:00:00.000Z'
  const created = await call('/memory-bubble/api/node/create', {
    method: 'POST',
    body: { title: '手动记录', summary: '手动填写的内容', keywords: ['手记'], importance: 60, sessionId: 'S2', createdAt },
  })
  assert.equal(created.body.ok, true)
  assert.equal(created.body.node.created, createdAt)
  const changed = '2024-01-02T03:04:00.000Z'
  const patched = await call('/memory-bubble/api/node', {
    method: 'POST',
    body: { id: created.body.id, sessionId: 'S2', patch: { title: '手动记录（改）', createdAt: changed } },
  })
  assert.equal(patched.body.node.created, changed)
  assert.equal(patched.body.node.title, '手动记录（改）')
})

await check('清空本会话：只清 S2，S1 不受影响', async () => {
  const forgotten = await call('/memory-bubble/api/session/forget', { method: 'POST', body: { sessionId: 'S2' } })
  assert.equal(forgotten.body.ok, true)
  assert.ok(forgotten.body.removed >= 1)
  const s2 = await call('/memory-bubble/api/graph?sessionId=S2&scope=session')
  assert.equal(s2.body.layout.nodes.length, 0)
  const s1 = await call('/memory-bubble/api/graph?sessionId=S1&scope=session')
  assert.equal(s1.body.layout.nodes.length, 1)
})

await check('工具 memory_search 能查到本会话记忆', async () => {
  const tool = tools.find((item) => item.name === 'memory_search')
  const result = await tool.execute({ query: '猫咖' }, { sessionId: 'S1' })
  const text = JSON.stringify(result)
  assert.ok(text.includes('喜欢猫咖'))
})

await check('pre-step 兜底注入：没有 systemPrompt 作用域时把简报追加为一条用户消息', async () => {
  const decision = await emit('agent/pre-step', { agent: { id: 'S1' }, messages: [] }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }))
  const injected = decision[0]
  const last = injected.messages[injected.messages.length - 1]
  const text = last.content.map((block) => block.text).join('')
  assert.ok(text.includes('【忆泡记忆简报】'))
  assert.ok(text.includes('喜欢猫咖'))
})

await check('导出/导入：整图继承去重', async () => {
  const exported = await call('/memory-bubble/api/export')
  assert.equal(exported.body.ok, true)
  const envelope = exported.body.graph
  const totalNodes = Array.isArray(envelope.graph && envelope.graph.nodes) ? envelope.graph.nodes.length : 0
  const again = await call('/memory-bubble/api/import', { method: 'POST', body: { graph: envelope } })
  assert.ok(again.body.report)
  const graph = await call('/memory-bubble/api/graph?sessionId=S1&scope=all')
  assert.equal(graph.body.layout.nodes.length, totalNodes, '重复导入不应新增节点')
})

await check('桥接：在线共享状态、会话继承、纯对话往返、只读与独占写入', async () => {
  const { createClient } = await import('../../interop/client.mjs')
  const { lockState, statePath } = await import('../lib/store.js')
  const data = statePath(profileDir)
  const client = await createClient({ data, session: 'bridge-source' })
  assert.equal(client.live, true)
  const added = await Promise.all(['桥接偏好', '桥接计划'].map((title) => client.call('tools', {
    name: 'memory_remember', arguments: { title, summary: '来自其他软件' },
  })))
  assert.ok(added.every((item) => item.node.sessions.includes('bridge-source')))
  const graph = await call('/memory-bubble/api/graph?sessionId=bridge-source&scope=session')
  assert.equal(graph.body.layout.nodes.length, 2)
  const packet = await client.call('chat')
  const bundle = JSON.parse(packet.split('```json\n')[1].split('\n```')[0])
  bundle.graph.nodes[0].summary = '纯对话端修改的内容'
  await client.call('import', { graph: bundle, sessionId: 'bridge-target', updateExisting: true })
  await client.call('carry', { from: 'bridge-source', to: 'bridge-target' })
  await client.call('clear')
  const target = await client.call('tools', { name: 'memory_brief', arguments: { sessionId: 'bridge-target' } })
  assert.ok(target.digest.includes('纯对话端修改的内容'))
  const readonly = await createClient({ data, 'read-only': true })
  await assert.rejects(readonly.call('clear', { sessionId: 'bridge-target' }), /read-only/)
  await assert.rejects(lockState(data, 0), /state is in use/)
  const descriptor = JSON.parse(await readFile(path.join(profileDir, '.memory-bubble', 'bridge.json'), 'utf8'))
  assert.equal((await fetch(`${descriptor.url}/memory-bubble/api/health`)).status, 403)
})

/* ------------------------------------------------------------------ 客户端半 */

const registrations = []
const clientHooks = new Map()
const fakeWindow = { innerWidth: 1440, innerHeight: 900, listeners: [], addEventListener(type, fn) { this.listeners.push({ type, fn }) }, removeEventListener() {} }
const fakeLocalStorage = new Map()
const cleanups = []

globalThis.window = fakeWindow
globalThis.localStorage = {
  getItem: (key) => (fakeLocalStorage.has(key) ? fakeLocalStorage.get(key) : null),
  setItem: (key, value) => fakeLocalStorage.set(key, String(value)),
  removeItem: (key) => fakeLocalStorage.delete(key),
}
globalThis.document = {
  hidden: false,
  head: { appendChild() {} },
  documentElement: { dataset: {} },
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({ layout: { nodes: [], edges: [], width: 760, height: 560 }, config: {}, session: { enabled: false, tray: [] }, sessions: [] }) })

const fakeReact = {
  createElement(type, props, ...children) {
    return { $$el: true, type, props: Object.assign({}, props, children.length ? { children: children.length === 1 ? children[0] : children } : {}) }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

let clientModule = null
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    clientModule = spec.factory((id) => {
      if (id === 'react') return fakeReact
      throw new Error('unexpected require: ' + id)
    })
  },
}

await import('../lib/client.js')
const client = clientModule
const clientCtx = {
  on(name, fn) { const list = clientHooks.get(name) || []; list.push(fn); clientHooks.set(name, list) },
  get(name) { return name === 'slots' ? undefined : undefined },
  slots: {
    inject(slot, register) { register() },
    register(options, component) { registrations.push({ options, component }) },
  },
  layout: { selectPanel() {} },
  effect(fn) { fn() },
}

await check('客户端注册：只有侧栏入口/浮层/设置三项，不再注册 main 面板', async () => {
  client.apply(clientCtx)
  const names = registrations.map((item) => item.options.name).sort()
  assert.deepEqual(names, ['settings.section', 'shell.overlay', 'sidebar.panellist'])
  assert.equal(registrations.some((item) => item.options.name === 'main'), false)
  const side = registrations.find((item) => item.options.name === 'sidebar.panellist')
  assert.equal(side.options.id, 'memory-bubble')
  assert.ok(side.options.order >= 500, '侧栏顺序应靠后，避免打乱已装插件入口')
})

await check('浮窗默认关闭（下载后不自动打开）', async () => {
  const overlay = registrations.find((item) => item.options.name === 'shell.overlay')
  const tree = render(overlay.component({ ctx: clientCtx }))
  assert.equal(tree, null)
})

await check('点侧栏图标打开浮窗，浮窗内关闭按钮可收起', async () => {
  const side = registrations.find((item) => item.options.name === 'sidebar.panellist')
  const entry = render(side.component({ ctx: clientCtx }))
  assert.equal(entry.type, 'button')
  entry.props.onClick()
  // 真实鼠标点击带 detail>0（已由 pointerdown 处理）；键盘 Enter 是 detail=0
  entry.props.onClick({ detail: 0, preventDefault() {}, stopPropagation() {} })
  const persisted = JSON.parse(fakeLocalStorage.get('memory-bubble.window.v1'))
  assert.equal(persisted.open, true)
  const overlay = registrations.find((item) => item.options.name === 'shell.overlay')
  const win = render(overlay.component({ ctx: clientCtx }))
  assert.equal(win.props.className, 'mb-window')
  // 八方向缩放把手：n/s/e/w + 四个角
  const handles = []
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) collect(item); return }
    if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf('mb-rz') === 0) handles.push(node)
    for (const child of ensureArray(node.props && node.props.children)) collect(child)
  }
  collect(win)
  assert.equal(handles.length, 8, '应渲染 8 个缩放把手，实际 ' + handles.length)
  assert.deepEqual(handles.map((node) => node.props.className.split(' ')[1]).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  assert.ok(handles.every((node) => typeof node.props.onPointerDown === 'function'))
  const header = ensureArray(win.props.children).find((child) => child && child.props && child.props.className === 'mb-winbar')
  const flat = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.props) flat.push(node)
    for (const child of ensureArray(node.props && node.props.children)) walk(child)
  }
  walk(header)
  const close = flat.find((node) => node.props && typeof node.props.title === 'string' && node.props.title.startsWith('关闭'))
  assert.ok(close, '应有关闭按钮')
  close.props.onClick()
  assert.equal(JSON.parse(fakeLocalStorage.get('memory-bubble.window.v1')).open, false)
})

function render(el) {
  if (el === undefined || el === null) return el
  if (Array.isArray(el)) return el.map(render)
  if (typeof el === 'function') return render(el({}))
  if (el.$$el && typeof el.type === 'function') return render(el.type(el.props))
  return el
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

for (const cleanup of cleanups) { try { cleanup() } catch { /* ignore */ } }
for (const cleanup of hostCleanups.reverse()) await cleanup()
await rm(profileDir, { recursive: true, force: true })
await new Promise((resolve) => setTimeout(resolve, 20))
console.log(`\n${passed} 项通过`)
if (process.exitCode) process.exit(process.exitCode)
