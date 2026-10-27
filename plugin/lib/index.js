/**
 * 忆泡（Memory Bubble）· 宿主半
 *
 * 一个把「AI 与用户的日常对话」沉淀成可视图谱的 DSH 插件：
 *  - 每回合结束后去抖调用一次当前默认模型，抽取值得长期记住的记忆点与关系；
 *  - 记忆点写进独立存储 <profile>/.memory-bubble/state.json（不进会话日志）；
 *  - 每步请求前把「稳定简报」注入上下文，让模型带着记忆聊天，同时控制上下文长度；
 *  - 向 Web UI 暴露 /memory-bubble/api/*，渲染暖色泡泡图，支持编辑/删除/改重要性/撤销；
 *  - 注册 5 个模型工具，让 AI 自己也能查、记、连、忘；
 *  - 支持导出/导入整张图，供跨对话、跨模型「继承」。
 *
 * 约定：
 *  - 只依赖 node 内置模块与本目录的 core.js / store.js，不引第三方依赖；
 *  - 所有宿主服务都用 ctx.get() 可选获取，缺服务时插件安静降级，不影响 DSH 本体；
 *  - 位置由出现频率决定、用户不可拖动；大小由重要性决定、用户可拖动改权重。
 */

import {
  emptyState,
  sessionState,
  mergeExtraction,
  computeLayout,
  buildDigest,
  refreshDigest,
  digestFor,
  rollbackBatch,
  parseExtraction,
  buildExtractionPrompt,
  EXTRACTION_SYSTEM,
  formatTranscript,
  exportGraph,
  importGraph,
  decorate,
  nowIso,
  truncate,
  clamp,
  sanitizeKeywords,
  sanitizeKind,
  formatDate,
  buildBundle,
  searchNodes,
  PORTABLE_PROMPT,
  TOOL_MANIFEST,
} from './core.js'
import { resolveProfileDir, readState, writeState, writeExport, statePath } from './store.js'

export const name = 'memory-bubble'
export const inject = ['webServer']

const ROUTE_BASE = '/memory-bubble/api'
const MAX_BUFFER_MESSAGES = 80
const EXTRACT_TIMEOUT_MS = 90_000

export function apply(ctx) {
  /** @type {import('./core.js')} */
  let state = emptyState()
  let profileDir = ''
  let disposed = false
  const ready = init()

  /** sessionId → [{ role, text, at }] 尚未被抽取的对话 */
  const buffers = new Map()
  /** sessionId → timer */
  const timers = new Map()
  const extracting = new Set()
  /** 已经通过 agent.ctx 注册了专属 systemPrompt 的 agent id */
  const sectioned = new Set()
  /** 串行化磁盘写，避免并发写坏文件 */
  let writeChain = Promise.resolve()
  let warnedNoLlm = false

  async function init() {
    try {
      profileDir = await resolveProfileDir()
      state = await readState(profileDir)
    } catch (error) {
      console.error('[memory-bubble] load state failed:', error && error.message ? error.message : error)
    }
  }

  function persist() {
    const snapshot = state
    writeChain = writeChain
      .then(() => (profileDir ? writeState(profileDir, snapshot) : undefined))
      .catch((error) => {
        console.error('[memory-bubble] persist failed:', error && error.message ? error.message : error)
      })
    return writeChain
  }

  /* ------------------------------------------------------------ 会话事件折叠 */

  ctx.on('session/event', (session, event) => {
    if (disposed) return
    ready
      .then(() => foldEvent(session, event))
      .catch((error) => console.error('[memory-bubble] fold failed:', error && error.message ? error.message : error))
  })

  function sessionIdOf(session) {
    if (!session) return null
    if (typeof session === 'string') return session
    if (typeof session.id === 'string') return session.id
    if (session.session && typeof session.session.id === 'string') return session.session.id
    return null
  }

  async function foldEvent(session, event) {
    const sessionId = sessionIdOf(session)
    if (!sessionId || !event || typeof event.type !== 'string') return
    const data = event.data

    if (event.type === 'user/message') {
      const sourceKind = data && data.source && data.source.kind
      if (sourceKind !== 'user') return
      const text = contentText(data && data.content)
      if (!text) return
      if (text.includes('【忆泡记忆简报】') || text.includes('【忆泡 · ')) return
      pushBuffer(sessionId, { role: 'user', text, at: event.at || nowIso() })
      return
    }

    if (event.type === 'assistant/message') {
      const message = data && data.message
      const text = contentText(message && message.content)
      if (!text) return
      pushBuffer(sessionId, { role: 'assistant', text, at: event.at || nowIso() })
      return
    }

    if (event.type === 'session/title') {
      const title = (data && (data.title || data.text)) || ''
      if (title) {
        const sess = sessionState(state, sessionId)
        sess.title = truncate(String(title), 80)
      }
      return
    }

    if (event.type === 'turn/end') {
      const sess = sessionState(state, sessionId)
      sess.lastTurnAt = nowIso()
      if (sess.enabled !== false && state.config.auto !== false) scheduleExtract(sessionId)
    }
  }

  function contentText(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  function pushBuffer(sessionId, entry) {
    const list = buffers.get(sessionId) || []
    list.push(entry)
    if (list.length > MAX_BUFFER_MESSAGES) list.splice(0, list.length - MAX_BUFFER_MESSAGES)
    buffers.set(sessionId, list)
  }

  /* ------------------------------------------------------------ 去抖自动总结 */

  function scheduleExtract(sessionId) {
    const cfg = state.config
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const sess = state.sessions[sessionId]
    const last = sess && sess.lastExtractAt ? new Date(sess.lastExtractAt).getTime() : 0
    const remaining = Math.max(0, last + (cfg.minIntervalMs || 0) - Date.now())
    const delay = Math.max(cfg.debounceMs || 0, remaining)
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId)
      void runExtract(sessionId, 'auto')
    }, delay))
  }

  async function runExtract(sessionId, reason) {
    await ready
    if (disposed) return { ok: false, error: 'disposed' }
    if (extracting.has(sessionId)) return { ok: false, error: 'busy' }
    const sess = sessionState(state, sessionId)
    if (sess.enabled === false) return { ok: false, error: 'disabled' }

    const fresh = (buffers.get(sessionId) || []).slice(-MAX_BUFFER_MESSAGES)
    let transcriptMessages = fresh
    if (fresh.filter((m) => m.role === 'user').length === 0 && fresh.length < 4) {
      transcriptMessages = await backfillTranscript(sessionId)
    }
    const transcript = formatTranscript(transcriptMessages, state.config.maxTranscriptChars)
    if (!transcript || transcript.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length < 12) {
      return { ok: false, error: 'not enough conversation yet' }
    }

    extracting.add(sessionId)
    sess.pending = true
    try {
      const prompt = buildExtractionPrompt({
        existing: existingForPrompt(),
        transcript,
        sessionNote: sess.digest && sess.digest.text ? sess.digest.text.replace(/【忆泡记忆简报】[^\n]*\n?/, '') : '',
        maxNew: state.config.maxPerExtraction,
      })
      const raw = await callModel(prompt)
      const extraction = parseExtraction(raw)
      if (!extraction) throw new Error('模型没有返回可解析的 JSON（可点「立即总结」重试）')
      const batch = mergeExtraction(state, sessionId, extraction, nowIso())
      buffers.delete(sessionId)
      refreshDigest(state, sessionId)
      await persist()
      return { ok: true, batchId: batch.id, created: batch.created.length, updated: batch.updated.length, edges: batch.edges.length }
    } catch (error) {
      sess.lastError = String(error && error.message ? error.message : error)
      await persist()
      return { ok: false, error: sess.lastError }
    } finally {
      extracting.delete(sessionId)
      sess.pending = false
    }
  }

  function existingForPrompt() {
    const max = state.config.maxExistingInPrompt || 40
    return Object.values(state.nodes)
      .slice()
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, max)
      .map((node) => ({ id: node.id, kind: node.kind, title: node.title, summary: node.summary, keywords: node.keywords }))
  }

  /** 第一次抽取时，把会话日志里最近的对话补进来（跨回合上下文） */
  async function backfillTranscript(sessionId) {
    try {
      const sessions = ctx.get('sessions')
      if (!sessions || typeof sessions.get !== 'function') return []
      const session = sessions.get(sessionId)
      if (!session) return []
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
      if (!Array.isArray(events)) return []
      const out = []
      for (const event of events.slice(-60)) {
        if (!event || !event.type || !event.data) continue
        if (event.type === 'user/message' && event.data.source && event.data.source.kind === 'user') {
          const text = contentText(event.data.content)
          if (text) out.push({ role: 'user', text })
        } else if (event.type === 'assistant/message' && event.data.message) {
          const text = contentText(event.data.message.content)
          if (text) out.push({ role: 'assistant', text })
        }
      }
      return out
    } catch {
      return []
    }
  }

  /* ------------------------------------------------------------ 调模型 */

  async function callModel(prompt) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('llm 服务不可用，无法自动总结')
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    let provider = selection && selection.provider
    let model = selection && selection.model
    if (!provider || !model) {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      const first = Array.isArray(providers) && providers[0]
      if (first && first.id) {
        provider = first.id
        try {
          const models = await llm.listModels(provider)
          model = models && models[0] && models[0].id
        } catch {
          model = undefined
        }
      }
    }
    if (!provider || !model) {
      if (!warnedNoLlm) {
        warnedNoLlm = true
        console.warn('[memory-bubble] 没有可用的默认模型，自动总结暂停；在设置里选一个模型即可')
      }
      throw new Error('没有可用的默认模型')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS)
    try {
      const stream = llm.stream({
        provider,
        model,
        system: EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.2,
        maxTokens: 1800,
        signal: controller.signal,
        sessionId: undefined,
      })
      let text = ''
      for await (const chunk of stream) {
        if (!chunk || typeof chunk.type !== 'string') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish') {
          if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            const failure = chunk.reason.failure
            throw new Error(failure && failure.message ? failure.message : '模型调用失败')
          }
        }
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  /* ------------------------------------------------------------ 每步前注入简报 */

  ctx.on('agent/created', ({ agent }) => {
    if (disposed || !agent || typeof agent.id !== 'string') return
    try {
      const agentCtx = agent.ctx
      const prompt = agentCtx && agentCtx.systemPrompt
      if (prompt && typeof prompt.section === 'function') {
        const dispose = prompt.section({
          name: 'memory-bubble',
          order: 45,
          text: () => {
            const digest = digestFor(state, agent.id)
            return digest ? digest : ''
          },
        })
        sectioned.add(agent.id)
        if (typeof agentCtx.effect === 'function') agentCtx.effect(() => () => {
          sectioned.delete(agent.id)
          try { dispose() } catch { /* ignore */ }
        })
      }
    } catch {
      /* agent.ctx 不是公开契约，失败就走 pre-step 兜底 */
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (disposed || !decision || decision.kind !== 'enter') return decision
      const sessionId = payload && payload.agent && payload.agent.id
      if (!sessionId || sectioned.has(sessionId)) return decision
      if (state.config.injection === 'off') return decision
      const digest = digestFor(state, sessionId)
      if (!digest) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : payload.messages
      if (!Array.isArray(messages)) return decision
      const synthetic = {
        role: 'user',
        id: `memory-bubble-context-${Date.now().toString(36)}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text: `【忆泡记忆简报】（由忆泡自动附加，不是用户新说的话）\n${digest}` }],
      }
      return { ...decision, messages: [...messages, synthetic] }
    } catch {
      return decision
    }
  })

  /* ------------------------------------------------------------ HTTP 路由 */

  const html = (res) => ({
    send: (status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    },
  })

  function readJson(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) {
          resolve({})
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  function route(path, handler) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}${path}`,
      handler,
    }))
  }

  function stats() {
    const nodes = Object.values(state.nodes)
    return {
      nodes: nodes.length,
      edges: Object.keys(state.edges).length,
      sessions: Object.keys(state.sessions).length,
      conflicts: Object.values(state.edges).filter((edge) => edge.conflict === true).length,
      lastExtractAt: nodes.length ? state.updatedAt : null,
    }
  }

  route('/health', async (req, res) => {
    await ready
    html(res).send(200, { ok: true, name, version: 1, profileDir, stats: stats() })
  })

  /* ---- 跨 AI 互操作：其他 AI 可下载 bundle、读取 manifest、按同一份 schema 继承记忆 ---- */

  route('/interop', async (req, res) => {
    await ready
    return html(res).send(200, {
      ok: true,
      schema: 'memory-bubble-interop',
      schemaVersion: 1,
      app: {
        name,
        routes: {
          bundle: `${ROUTE_BASE}/ai/bundle`,
          prompt: `${ROUTE_BASE}/ai/prompt`,
          graph: `${ROUTE_BASE}/graph`,
          import: `${ROUTE_BASE}/import`,
          export: `${ROUTE_BASE}/export`,
        },
      },
      data: { profileDir, stateFile: profileDir ? statePath(profileDir) : null, dataFile: statePath(profileDir) },
      bundleFormat: 'memory-bubble-bundle v1',
      prompt: PORTABLE_PROMPT,
      tools: TOOL_MANIFEST,
      clients: [
        { name: 'MCP', transport: 'stdio', entry: 'interop/mcp-server.mjs', args: ['--data', statePath(profileDir)] },
        { name: 'CLI', transport: 'process', entry: 'interop/cli.mjs', args: ['list', '--data', statePath(profileDir)] },
        { name: 'HTTP', transport: 'http', entry: `${ROUTE_BASE}/ai/bundle`, args: ['?sessionId=<id>'] },
        { name: 'DSH plugin', transport: 'in-process', entry: '自动注入 system prompt / 工具' },
      ],
    })
  })

  route('/ai/bundle', async (req, res) => {
    await ready
    const url = new URL(req.url || '/', 'http://dsh.local')
    const sessionId = url.searchParams.get('sessionId') || undefined
    decorate(state, sessionId)
    return html(res).send(200, { ok: true, ...buildBundle(state, sessionId) })
  })

  route('/ai/prompt', async (req, res) => {
    await ready
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`${PORTABLE_PROMPT}\n`)
  })

  route('/graph', async (req, res) => {
    await ready
    const url = new URL(req.url || '/', 'http://dsh.local')
    const sessionId = url.searchParams.get('sessionId') || undefined
    const scope = url.searchParams.get('scope') || 'all'
    decorate(state, sessionId)
    let graph = computeLayout(state)
    if (scope === 'session' && sessionId) {
      const keep = new Set(graph.nodes.filter((node) => node.sessions.includes(sessionId)).map((node) => node.id))
      graph = {
        ...graph,
        nodes: graph.nodes.filter((node) => keep.has(node.id)),
        edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
      }
    }
    const sess = sessionId ? state.sessions[sessionId] : undefined
    html(res).send(200, {
      ok: true,
      sessionId: sessionId || null,
      scope,
      layout: graph,
      config: state.config,
      stats: stats(),
      session: sess
        ? { enabled: sess.enabled !== false, tray: sess.tray || [], title: sess.title || '', lastExtractAt: sess.lastExtractAt, lastError: sess.lastError, pending: sess.pending === true, extractCount: sess.extractCount || 0 }
        : { enabled: true, tray: [], title: '', lastExtractAt: null, lastError: null, pending: false, extractCount: 0 },
      digest: sessionId ? buildDigest(state, sessionId).text : '',
      sessions: Object.values(state.sessions).map((item) => ({ id: item.id, title: item.title || '', enabled: item.enabled !== false, extractCount: item.extractCount || 0, lastExtractAt: item.lastExtractAt })),
    })
  })

  route('/config', async (req, res) => {
    await ready
    if (req.method === 'GET') return html(res).send(200, { ok: true, config: state.config })
    const body = await readJson(req)
    const patch = body && body.config && typeof body.config === 'object' ? body.config : body
    for (const key of Object.keys(state.config)) {
      if (patch && typeof patch[key] !== 'undefined') {
        const type = typeof state.config[key]
        if (type === 'number') state.config[key] = clamp(Number(patch[key]) || 0, 0, 600000)
        else if (type === 'boolean') state.config[key] = patch[key] === true
        else if (type === 'string') state.config[key] = String(patch[key]).slice(0, 40)
      }
    }
    state.config.maxPerExtraction = clamp(Math.round(Number(state.config.maxPerExtraction) || 3), 1, 5)
    state.config.maxTotalNodes = clamp(Math.round(Number(state.config.maxTotalNodes) || 300), 20, 2000)
    await persist()
    return html(res).send(200, { ok: true, config: state.config })
  })

  route('/extract', async (req, res) => {
    await ready
    const body = await readJson(req)
    const sessionId = body && body.sessionId
    if (!sessionId) return html(res).send(400, { ok: false, error: 'missing sessionId' })
    const result = await runExtract(sessionId, body.force ? 'manual-forced' : 'manual')
    return html(res).send(result.ok ? 200 : 200, result)
  })

  route('/rollback', async (req, res) => {
    await ready
    const body = await readJson(req)
    if (!body || (!body.sessionId && !body.batchId)) return html(res).send(400, { ok: false, error: 'missing sessionId or batchId' })
    const batch = rollbackBatch(state, { sessionId: body.sessionId, batchId: body.batchId })
    if (!batch) return html(res).send(404, { ok: false, error: '没有可撤销的批次' })
    if (body.sessionId) refreshDigest(state, body.sessionId)
    await persist()
    return html(res).send(200, { ok: true, batchId: batch.id, removed: batch.created.length, restored: batch.updated.length })
  })

  route('/node', async (req, res) => {
    await ready
    if (req.method === 'DELETE') {
      const url = new URL(req.url || '/', 'http://dsh.local')
      deleteNode(res, url.searchParams.get('id'))
      return
    }
    const body = await readJson(req)
    if (!body || !body.id) return html(res).send(400, { ok: false, error: 'missing id' })
    const node = state.nodes[body.id]
    if (!node) return html(res).send(404, { ok: false, error: 'node not found' })
    const patch = body.patch || body
    if (typeof patch.title === 'string' && patch.title.trim()) node.title = truncate(patch.title.trim(), 40)
    if (typeof patch.summary === 'string') node.summary = truncate(patch.summary.trim(), 600)
    if (Array.isArray(patch.keywords)) node.keywords = sanitizeKeywords(patch.keywords)
    if (typeof patch.importance === 'number') node.importance = Math.round(clamp(patch.importance, 0, 100))
    if (typeof patch.kind === 'string') node.kind = sanitizeKind(patch.kind)
    if (typeof patch.pinned === 'boolean') node.pinned = patch.pinned
    node.updated = nowIso()
    if (body.sessionId) refreshDigest(state, body.sessionId)
    await persist()
    return html(res).send(200, { ok: true, node })
  })

  route('/node/delete', async (req, res) => {
    await ready
    const body = await readJson(req)
    deleteNode(res, body && body.id, body && body.sessionId)
  })

  function deleteNode(res, id, sessionId) {
    if (!id || !state.nodes[id]) return html(res).send(404, { ok: false, error: 'node not found' })
    delete state.nodes[id]
    for (const edge of Object.values(state.edges)) {
      if (edge.from === id || edge.to === id) delete state.edges[edge.id]
    }
    for (const sess of Object.values(state.sessions)) {
      if (Array.isArray(sess.tray)) sess.tray = sess.tray.filter((item) => item !== id)
    }
    if (sessionId) refreshDigest(state, sessionId)
    void persist()
    return html(res).send(200, { ok: true })
  }

  route('/node/create', async (req, res) => {
    await ready
    const body = await readJson(req)
    const title = body && typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return html(res).send(400, { ok: false, error: 'missing title' })
    const sessionId = body.sessionId || 'manual'
    const batch = mergeExtraction(state, sessionId, {
      memories: [{
        title,
        summary: typeof body.summary === 'string' ? body.summary : '',
        keywords: Array.isArray(body.keywords) ? body.keywords : [],
        importance: typeof body.importance === 'number' ? body.importance : 55,
        kind: body.kind,
      }],
      relations: [],
    })
    refreshDigest(state, sessionId)
    await persist()
    return html(res).send(200, { ok: true, id: batch.created[0] || null, node: state.nodes[batch.created[0]] || null })
  })

  route('/edge', async (req, res) => {
    await ready
    const body = await readJson(req)
    if (!body || !body.id) return html(res).send(400, { ok: false, error: 'missing id' })
    const edge = state.edges[body.id]
    if (!edge) return html(res).send(404, { ok: false, error: 'edge not found' })
    const patch = body.patch || body
    if (typeof patch.summary === 'string') edge.summary = truncate(patch.summary.trim(), 400)
    if (typeof patch.relation === 'string') edge.relation = truncate(patch.relation.trim(), 20)
    if (typeof patch.conflict === 'boolean') edge.conflict = patch.conflict
    edge.updated = nowIso()
    if (body.sessionId) refreshDigest(state, body.sessionId)
    await persist()
    return html(res).send(200, { ok: true, edge })
  })

  route('/edge/delete', async (req, res) => {
    await ready
    const body = await readJson(req)
    if (!body || !body.id || !state.edges[body.id]) return html(res).send(404, { ok: false, error: 'edge not found' })
    delete state.edges[body.id]
    if (body.sessionId) refreshDigest(state, body.sessionId)
    void persist()
    return html(res).send(200, { ok: true })
  })

  route('/tray', async (req, res) => {
    await ready
    const body = await readJson(req)
    const sessionId = body && body.sessionId
    if (!sessionId) return html(res).send(400, { ok: false, error: 'missing sessionId' })
    const sess = sessionState(state, sessionId)
    if (body.clear) sess.tray = []
    if (body.add && state.nodes[body.add] && !sess.tray.includes(body.add)) sess.tray.push(body.add)
    if (body.remove) sess.tray = sess.tray.filter((id) => id !== body.remove)
    refreshDigest(state, sessionId)
    await persist()
    return html(res).send(200, { ok: true, tray: sess.tray })
  })

  route('/session', async (req, res) => {
    await ready
    const body = await readJson(req)
    const sessionId = body && body.sessionId
    if (!sessionId) return html(res).send(400, { ok: false, error: 'missing sessionId' })
    const sess = sessionState(state, sessionId)
    if (typeof body.enabled === 'boolean') {
      sess.enabled = body.enabled
      if (!body.enabled) {
        const timer = timers.get(sessionId)
        if (timer) clearTimeout(timer)
        timers.delete(sessionId)
      }
    }
    await persist()
    return html(res).send(200, { ok: true, session: { id: sessionId, enabled: sess.enabled !== false } })
  })

  route('/export', async (req, res) => {
    await ready
    const graph = exportGraph(state)
    let file = null
    try {
      file = await writeExport(profileDir, graph)
    } catch {
      file = null
    }
    return html(res).send(200, { ok: true, graph, file })
  })

  route('/import', async (req, res) => {
    await ready
    const body = await readJson(req)
    const payload = body && (body.graph || body)
    const inner = payload && payload.graph ? payload.graph : payload
    if (!inner || !Array.isArray(inner.nodes)) return html(res).send(400, { ok: false, error: 'invalid graph' })
    const report = importGraph(state, payload)
    await persist()
    return html(res).send(200, { ok: true, report })
  })

  route('/batch', async (req, res) => {
    await ready
    const url = new URL(req.url || '/', 'http://dsh.local')
    const sessionId = url.searchParams.get('sessionId') || undefined
    const list = state.batches
      .filter((batch) => !sessionId || batch.sessionId === sessionId)
      .slice(0, 10)
      .map((batch) => ({ id: batch.id, sessionId: batch.sessionId, at: batch.at, created: batch.created.length, updated: batch.updated.length, edges: batch.edges.length }))
    return html(res).send(200, { ok: true, batches: list })
  })

  /* ------------------------------------------------------------ 模型工具 */

  try {
    const tools = ctx.get('tools')
    if (tools && typeof tools.register === 'function') {
      for (const definition of toolDefinitions()) tools.register(definition)
    }
  } catch (error) {
    console.warn('[memory-bubble] tools register failed:', error && error.message ? error.message : error)
  }

  function toolDefinitions() {
    const render = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    const output = { schema: { type: 'object', additionalProperties: true }, render }
    return [
      {
        name: 'memory_search',
        description: '在「忆泡」长期记忆图谱里检索记忆点。用户提到过去说过的事、偏好、计划时先查这里。',
        parameters: {
          query: { type: 'string', required: true, description: '关键词或自然语言描述' },
          limit: { type: 'number', description: '最多返回几条，默认 5' },
        },
        output,
        async execute(args) {
          await ready
          const query = String((args && args.query) || '').trim()
          const limit = clamp(Number((args && args.limit) || 5), 1, 20)
          const words = query.split(/\s+/).filter(Boolean)
          const scored = Object.values(state.nodes).map((node) => {
            const haystack = `${node.title} ${node.summary} ${(node.keywords || []).join(' ')}`.toLowerCase()
            let score = 0
            for (const word of words) if (word && haystack.includes(word.toLowerCase())) score += 3
            if (haystack.includes(query.toLowerCase())) score += 5
            score += (node.importance || 50) / 100
            return { node, score }
          }).filter((item) => item.score > 1).sort((a, b) => b.score - a.score).slice(0, limit)
          return {
            count: scored.length,
            results: scored.map(({ node }) => ({
              id: node.id, title: node.title, kind: node.kind, importance: node.importance,
              keywords: node.keywords, summary: truncate(node.summary || '', 200),
              created: formatDate(node.created), updated: formatDate(node.updated),
            })),
          }
        },
      },
      {
        name: 'memory_brief',
        description: '读取「忆泡」为本会话生成的稳定记忆简报（当前会随每步自动注入，需要完整清单时调用）。',
        parameters: {
          sessionId: { type: 'string', description: '会话 id；省略则取最近活跃会话' },
        },
        output,
        async execute(args) {
          await ready
          let sessionId = args && args.sessionId
          if (!sessionId) {
            const sessions = Object.values(state.sessions).filter((item) => item.lastTurnAt)
            sessions.sort((a, b) => String(b.lastTurnAt).localeCompare(String(a.lastTurnAt)))
            sessionId = sessions[0] && sessions[0].id
          }
          const digest = sessionId ? digestFor(state, sessionId) : '（还没有活跃会话）'
          return { sessionId: sessionId || null, digest }
        },
      },
      {
        name: 'memory_remember',
        description: '把一个值得长期记住的信息写进「忆泡」。用户明确说“记住”、透露重要偏好/身份/计划时调用。',
        parameters: {
          title: { type: 'string', required: true, description: '不超过 12 字的短标题' },
          summary: { type: 'string', required: true, description: '1-2 句、可脱离对话独立看懂' },
          keywords: { type: 'array', description: '2-5 个短关键词' },
          importance: { type: 'number', description: '0-100，影响长期行为越高越重要' },
          kind: { type: 'string', description: '偏好|事实|计划|关系|目标|情绪|禁忌' },
          sessionId: { type: 'string', description: '来源会话 id，可省略' },
        },
        output,
        async execute(args, exec) {
          await ready
          const sessionId = (args && args.sessionId) || (exec && exec.sessionId) || 'mcp-manual'
          const batch = mergeExtraction(state, sessionId, {
            memories: [{ title: args && args.title, summary: args && args.summary, keywords: args && args.keywords, importance: args && args.importance, kind: args && args.kind }],
            relations: [],
          })
          refreshDigest(state, sessionId)
          await persist()
          const id = batch.created[0] || (batch.updated[0] && batch.updated[0].id)
          return { ok: true, id, node: state.nodes[id] || null }
        },
      },
      {
        name: 'memory_link',
        description: '在「忆泡」里连接两条记忆，并写清关系；内容矛盾时把 conflict 设为 true。',
        parameters: {
          from: { type: 'string', required: true, description: '记忆 id' },
          to: { type: 'string', required: true, description: '记忆 id' },
          summary: { type: 'string', required: true, description: '关系说明' },
          relation: { type: 'string', description: '因果|印证|同主题|对立|相关' },
          conflict: { type: 'boolean', description: '两条记忆是否互相矛盾' },
        },
        output,
        async execute(args) {
          await ready
          const batch = mergeExtraction(state, 'mcp-manual', {
            memories: [],
            relations: [{ from: args && args.from, to: args && args.to, summary: args && args.summary, relation: args && args.relation, conflict: args && args.conflict === true }],
          })
          await persist()
          return { ok: true, id: batch.edges[0] || null }
        },
      },
      {
        name: 'memory_forget',
        description: '从「忆泡」里删除一条记忆（连同它的连线）。用户说“忘掉这个”时调用。',
        parameters: {
          id: { type: 'string', required: true, description: '记忆 id' },
        },
        output,
        async execute(args) {
          await ready
          const id = args && args.id
          if (!id || !state.nodes[id]) return { ok: false, error: 'node not found' }
          const title = state.nodes[id].title
          delete state.nodes[id]
          for (const edge of Object.values(state.edges)) if (edge.from === id || edge.to === id) delete state.edges[edge.id]
          await persist()
          return { ok: true, forgot: title }
        },
      },
    ]
  }

  /* ------------------------------------------------------------ 生命周期 */

  ctx.effect(() => () => {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })
}
