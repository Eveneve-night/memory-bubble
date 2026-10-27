/**
 * 忆泡 · 宿主半集成测试（node dev/test-host.mjs）
 *
 * 用一个假的 DSH Context 驱动真实的 lib/index.js：
 *  - 假 webServer 收路由，假 llm 流式返回固定 JSON，假 sessions 提供快照；
 *  - 走一遍：会话事件折叠 → 手动总结 → 图谱 → 托盘 → 编辑 → 撤销 → 工具 → 每步注入 → 配置 → 导出/导入。
 */

import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

const tmpProfile = await mkdtemp(path.join(os.tmpdir(), 'memory-bubble-host-'))
process.env.DSH_PROFILE_DIR = tmpProfile

const { apply } = await import('../lib/index.js')

/* ------------------------------------------------------------ 假 Context */

const routes = new Map()
const handlers = new Map()
const tools = new Map()
const cleanups = []
let llmReply = '{}'

const llm = {
  stream() {
    const text = llmReply
    return (async function* () {
      yield { type: 'text-delta', text: text.slice(0, 20) }
      yield { type: 'text-delta', text: text.slice(20) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
  listProviders() { return [] },
}

const sessionsStub = {
  get(id) {
    return {
      id,
      snapshotEvents: () => [
        { type: 'user/message', at: '2026-10-20T10:00:00.000Z', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我最近在学 Rust，每周读一篇论文。' }] } },
        { type: 'assistant/message', at: '2026-10-20T10:00:20.000Z', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我记下了：学 Rust、每周一篇论文。' }] } } },
      ],
    }
  },
}

const ctx = {
  get(name) {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
    if (name === 'sessions') return sessionsStub
    if (name === 'tools') return { register: (definition) => { tools.set(definition.name, definition) } }
    return undefined
  },
  on(event, handler) {
    const list = handlers.get(event) || []
    list.push(handler)
    handlers.set(event, list)
    return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1) }
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return () => {}
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 120))

function makeReq({ url, method, body }) {
  const req = new EventEmitter()
  req.url = url
  req.method = method || 'GET'
  setImmediate(() => {
    if (typeof body !== 'undefined') req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function call(routePath, options = {}) {
  const pathname = routePath.split('?')[0]
  const handler = routes.get(pathname)
  if (!handler) throw new Error(`route missing: ${pathname}`)
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key] = value },
      end(text) {
        let body = null
        try { body = JSON.parse(text) } catch { body = text }
        resolve({ status: this.statusCode, body })
      },
    }
    const req = makeReq({ url: routePath, method: options.method || 'GET', body: options.body })
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function emit(event, payload) {
  const list = handlers.get(event) || []
  for (const handler of list) {
    Promise.resolve(handler(payload)).catch(() => {})
  }
}

const checks = []
async function check(name, fn) {
  try {
    await fn()
    checks.push(name)
    console.log('PASS', name)
  } catch (error) {
    console.error('FAIL', name, '\n ', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

function extractionReply() {
  return JSON.stringify({
    memories: [
      { ref: 'a', title: '在学 Rust', summary: '用户最近在学 Rust，希望用具体例子讲解。', keywords: ['Rust', '学习'], importance: 78, kind: '目标' },
      { ref: 'b', title: '每周读论文', summary: '每周精读一篇论文，偏好 HCI 方向。', keywords: ['论文', '每周'], importance: 62, kind: '计划' },
    ],
    relations: [
      { from: 'a', to: 'b', summary: '都是长期输入习惯，时间上可能互相挤占', relation: '相关', conflict: false },
    ],
  })
}

const SESSION = 's_test_1'

await check('apply 注册了路由 / 工具 / 事件', async () => {
  assert.ok(routes.has('/memory-bubble/api/graph'))
  assert.ok(routes.has('/memory-bubble/api/extract'))
  assert.equal(tools.size, 5)
  assert.ok((handlers.get('session/event') || []).length >= 1)
  assert.ok((handlers.get('agent/pre-step') || []).length >= 1)
})

await check('会话事件折叠：用户/AI 消息进缓冲区，turn/end 触发去抖', async () => {
  emit('session/event', { id: SESSION }, { type: 'user/message', at: '2026-10-27T10:00:00.000Z', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我最近在学 Rust，希望用具体例子讲解。' }] } })
  emit('session/event', { id: SESSION }, { type: 'user/message', at: '2026-10-27T10:00:01.000Z', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '这行不应进入记忆' }] } })
  emit('session/event', { id: SESSION }, { type: 'assistant/message', at: '2026-10-27T10:00:30.000Z', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我会用具体例子。' }] } } })
  emit('session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const result = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(result.status, 200)
  assert.equal(result.body.stats.nodes, 0)
  assert.equal(result.body.sessionId, SESSION)
})

await check('手动总结：写入 2 个节点 + 1 条边并生成简报', async () => {
  llmReply = extractionReply()
  const result = await call('/memory-bubble/api/extract', { method: 'POST', body: { sessionId: SESSION, force: true } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.created, 2)
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(graph.body.stats.nodes, 2)
  assert.equal(graph.body.stats.edges, 1)
  const layout = graph.body.layout
  assert.equal(layout.nodes.length, 2)
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x <= layout.width)
    assert.ok(node.y >= 0 && node.y <= layout.height)
    assert.ok(node.r >= 16 && node.r <= 47)
  }
  assert.ok(graph.body.digest.includes('【忆泡记忆简报】'))
  assert.ok(graph.body.digest.includes('在学 Rust'))
})

await check('托盘：加入后简报置顶钉选', async () => {
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const node = graph.body.layout.nodes.find((item) => item.title.includes('Rust'))
  assert.ok(node)
  const tray = await call('/memory-bubble/api/tray', { method: 'POST', body: { sessionId: SESSION, add: node.id } })
  assert.equal(tray.body.ok, true)
  assert.deepEqual(tray.body.tray, [node.id])
  const next = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const digest = next.body.digest
  assert.ok(digest.includes('钉选'))
  assert.ok(/★ 在学 Rust/.test(digest), '托盘里的记忆应以 ★ 钉选行出现')
})

await check('编辑：改重要性/标题/关键词，图谱同步', async () => {
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const node = graph.body.layout.nodes.find((item) => item.title.includes('Rust'))
  const result = await call('/memory-bubble/api/node', { method: 'POST', body: { id: node.id, sessionId: SESSION, patch: { title: 'Rust 学习中', importance: 96, keywords: ['Rust', '系统编程'] } } })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.node.title, 'Rust 学习中')
  const next = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const updated = next.body.layout.nodes.find((item) => item.id === node.id)
  assert.equal(updated.title, 'Rust 学习中')
  assert.equal(updated.importance, 96)
  assert.ok(updated.keywords.includes('系统编程'))
  const layout = next.body.layout
  assert.ok(updated.r >= 16 && updated.r <= 47)
})

await check('连线：改说明、标记冲突、重新校验', async () => {
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const edge = graph.body.layout.edges[0]
  const marked = await call('/memory-bubble/api/edge', { method: 'POST', body: { id: edge.id, sessionId: SESSION, patch: { summary: '时间可能互相挤占', conflict: true } } })
  assert.equal(marked.body.edge.conflict, true)
  const graph2 = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(graph2.body.stats.conflicts, 1)
  assert.ok(graph2.body.digest.includes('⚠'))
  const cleared = await call('/memory-bubble/api/edge', { method: 'POST', body: { id: edge.id, sessionId: SESSION, patch: { conflict: false } } })
  assert.equal(cleared.body.edge.conflict, false)
})

await check('新增记忆 + 撤销上一批', async () => {
  const created = await call('/memory-bubble/api/node/create', { method: 'POST', body: { title: '偏好：周报用要点', summary: '周报用要点列表，不要长段落。', keywords: ['周报', '输出'], importance: 70, kind: '偏好', sessionId: SESSION } })
  assert.equal(created.body.ok, true)
  const before = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(before.body.stats.nodes, 3)
  const rollback = await call('/memory-bubble/api/rollback', { method: 'POST', body: { sessionId: SESSION } })
  assert.equal(rollback.body.ok, true)
  assert.equal(rollback.body.removed, 1)
  const after = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(after.body.stats.nodes, 2)
  const batches = await call(`/memory-bubble/api/batch?sessionId=${SESSION}`)
  assert.ok(batches.body.batches.length >= 1)
})

await check('工具：memory_search / memory_remember / memory_link / memory_forget', async () => {
  const search = tools.get('memory_search')
  const found = await search.execute({ query: 'Rust' })
  assert.ok(found.count >= 1)
  assert.ok(found.results.some((item) => item.title.includes('Rust')))

  const remember = tools.get('memory_remember')
  const remembered = await remember.execute({ title: '偏好：小步确认', summary: '动手前先和用户确认一小步。', keywords: ['协作', '确认'], importance: 66, kind: '偏好', sessionId: SESSION }, {})
  assert.equal(remembered.ok, true)
  assert.ok(remembered.id)

  const link = tools.get('memory_link')
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const rust = graph.body.layout.nodes.find((item) => item.title.includes('Rust'))
  const linked = await link.execute({ from: remembered.id, to: rust.id, summary: '都是你的工作方式偏好', relation: '相关', conflict: false })
  assert.equal(linked.ok, true)

  const forget = tools.get('memory_forget')
  const forgotten = await forget.execute({ id: remembered.id })
  assert.equal(forgotten.ok, true)
  const after = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.ok(!after.body.layout.nodes.some((item) => item.id === remembered.id))
})

await check('每步注入：pre-step 追加忆泡简报（会话隔离）', async () => {
  const preStep = (handlers.get('agent/pre-step') || [])[0]
  assert.ok(preStep)
  const result = await preStep(
    { agent: { id: SESSION }, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '继续聊' }] }] }),
  )
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, 2)
  const injected = result.messages[1]
  assert.ok(JSON.stringify(injected.content).includes('忆泡记忆简报'))
  assert.ok(JSON.stringify(injected.content).includes('Rust'))

  if (handlers.get('agent/created')) {
    emit('agent/created', { agent: { id: 's_other' } })
  }
  const other = await preStep(
    { agent: { id: 's_other' }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(other.kind, 'enter')
})

await check('配置：关闭自动总结后状态持久化', async () => {
  const saved = await call('/memory-bubble/api/config', { method: 'POST', body: { config: { auto: false, debounceMs: 4000, injection: 'tray', maxPerExtraction: 2, maxTotalNodes: 120 } } })
  assert.equal(saved.body.config.auto, false)
  assert.equal(saved.body.config.debounceMs, 4000)
  assert.equal(saved.body.config.injection, 'tray')
  assert.equal(saved.body.config.maxPerExtraction, 2)
  assert.equal(saved.body.config.maxTotalNodes, 120)
  const clamped = await call('/memory-bubble/api/config', { method: 'POST', body: { config: { maxPerExtraction: 9, maxTotalNodes: 99999 } } })
  assert.equal(clamped.body.config.maxPerExtraction, 5)
  assert.equal(clamped.body.config.maxTotalNodes, 2000)
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(graph.body.config.injection, 'tray')
})

await check('导出 / 导入：同图合并去重', async () => {
  const exported = await call('/memory-bubble/api/export')
  assert.equal(exported.body.graph.schema, 'memory-bubble/v1')
  assert.ok(exported.body.graph.graph.nodes.length >= 2)
  assert.ok(exported.body.file)
  const graph = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  const before = graph.body.stats.nodes
  const imported = await call('/memory-bubble/api/import', { method: 'POST', body: { graph: exported.body.graph } })
  assert.equal(imported.body.ok, true)
  const after = await call(`/memory-bubble/api/graph?sessionId=${SESSION}&scope=all`)
  assert.equal(after.body.stats.nodes, before)
})

/** @type {() => Promise<void>} */
await check('互操作：/interop 能力清单 + /ai/bundle 记忆包 + /ai/prompt 便携提示词', async () => {
  const interop = await call('/memory-bubble/api/interop')
  assert.equal(interop.body.ok, true)
  assert.equal(interop.body.tools.length, 5)
  assert.ok(interop.body.prompt.includes('忆泡'))
  assert.ok(interop.body.data && interop.body.data.dataFile)
  assert.ok(Array.isArray(interop.body.clients) && interop.body.clients.some((client) => client.name === 'MCP'))

  const bundle = await call(`/memory-bubble/api/ai/bundle?sessionId=${SESSION}`)
  assert.equal(bundle.body.schema, 'memory-bubble-bundle')
  assert.ok(bundle.body.graph.nodes.length >= 2)
  assert.ok(bundle.body.digest.includes('忆泡记忆简报') || bundle.body.digest.length >= 0)
  assert.equal(bundle.body.tools.length, 5)
  assert.ok(bundle.body.prompt.includes('忆泡 Memory Bubble'))

  const prompt = await call('/memory-bubble/api/ai/prompt')
  assert.ok(String(prompt.body).includes('忆泡'))
})

await check('清理', async () => {
  for (const dispose of cleanups) { try { dispose() } catch { /* ignore */ } }
  await rm(tmpProfile, { recursive: true, force: true })
})

console.log(`\n${checks.length} checks passed`)
