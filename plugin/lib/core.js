/**
 * 忆泡 · 纯逻辑核心（无 DSH / 无 Node 依赖，可在 node 里直接单测）
 *
 * 职责：状态模型、抽取结果合并、去重、布局、简报、撤销、导入导出。
 * 所有函数都只操作传入的普通对象，不碰文件、不碰网络、不碰 ctx。
 *
 * 数据模型（v1，与 schema/memory-bubble-v1.schema.json 对齐）：
 *   state = {
 *     version, createdAt, updatedAt,
 *     nodes:   { [id]: Node },
 *     edges:   { [id]: Edge },
 *     sessions:{ [sid]: SessionState },
 *     batches: [ Batch ],            // 最近 40 条抽取批次，用于撤销
 *     config:  Config,
 *   }
 */

export const STATE_VERSION = 1

export function defaultConfig() {
  return {
    /** 每回合结束后是否自动总结（可在面板里逐会话开关） */
    auto: true,
    /** 最后一次对话事件之后静默多久才抽取，避免边聊边抽 */
    debounceMs: 15000,
    /** 两次抽取之间的最小间隔 */
    minIntervalMs: 90000,
    /** 单次送给模型的对话文本上限（字符） */
    maxTranscriptChars: 6000,
    /** 简报最多列入多少条记忆 */
    digestLimit: 12,
    /** 注入方式：digest = 稳定简报（默认）；tray = 只注入钉选；off = 不注入 */
    injection: 'digest',
    /** 抽取时附带给模型的已有记忆条数上限 */
    maxExistingInPrompt: 40,
  }
}

export function emptyState(config) {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    nodes: {},
    edges: {},
    sessions: {},
    batches: [],
    config: { ...defaultConfig(), ...(config || {}) },
  }
}

/** 会话状态惰性创建 */
export function sessionState(state, sessionId) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      id: sessionId,
      enabled: true,
      tray: [],
      digest: { text: '', nodeIds: [], updatedAt: null },
      extractCount: 0,
      lastExtractAt: null,
      lastTurnAt: null,
      lastError: null,
      pending: false,
    }
  }
  return state.sessions[sessionId]
}

/* ------------------------------------------------------------------ 文本工具 */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function truncate(text, max) {
  const s = String(text == null ? '' : text)
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

export function normTitle(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\-_·:：,，。.!！?？"'“”‘’()（）【】\[\]<>《》]/g, '')
}

export function tokenSet(text) {
  const out = new Set()
  const s = String(text == null ? '' : text).toLowerCase()
  for (const token of s.split(/[\s\-_·:：,，。.!！?？"'“”‘’()（）【】\[\]<>《》/\\|]+/)) {
    if (token.length >= 2) out.add(token)
  }
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) out.add(ch)
  }
  return out
}

export function jaccard(a, b) {
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function nowIso() {
  return new Date().toISOString()
}

export function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* ------------------------------------------------------------------ 节点与边 */

export function nodeText(node) {
  return `${node.title || ''} ${node.summary || ''} ${(node.keywords || []).join(' ')}`
}

/** 计算出现频率（被动位置用）：跨会话 + 命中次数 */
export function frequencyOf(state, node) {
  const sessionCount = Array.isArray(node.sessions) ? node.sessions.length : 0
  const hits = Number.isFinite(node.hits) ? node.hits : 1
  const inSession = (sid) => (Array.isArray(node.sessions) && sid && node.sessions.includes(sid) ? 0.18 : 0)
  const base = clamp(0, 1, (sessionCount - 1) * 0.3 + (hits - 1) * 0.04)
  return clamp(base + inSession(node._focusSession), 0, 1)
}

/** 给所有节点补 _freq 字段（前端排序 / 布局用，不落盘） */
export function decorate(state, focusSession) {
  for (const node of Object.values(state.nodes)) {
    node._focusSession = focusSession || null
    node._freq = Number(node._freq || 0)
  }
  const nodes = Object.values(state.nodes)
  const maxHits = Math.max(1, ...nodes.map((n) => n.hits || 1))
  for (const node of nodes) {
    const sessionCount = Array.isArray(node.sessions) ? node.sessions.length : 1
    const hits = node.hits || 1
    const raw = (sessionCount - 1) * 0.3 + (hits / maxHits) * 0.55
    node._freq = clamp(raw, 0, 1)
  }
  return state
}

/**
 * 画布布局（服务端算好，客户端只画）：频率越高越靠中心，重要性决定圆半径。
 * 位置只由数据决定，用户不能拖动 → 与「位置被动变化」的约定一致。
 */
export function computeLayout(state) {
  const W = 760
  const H = 560
  const cx = W / 2
  const cy = H / 2
  const nodes = Object.values(state.nodes)
  const ranked = nodes.slice().sort((a, b) => {
    const sa = (b._freq || 0) * 2.5 + (b.importance || 50) / 60
    const sb = (a._freq || 0) * 2.5 + (a.importance || 50) / 60
    return sa - sb
  })
  const maxR = Math.min(W, H) * 0.42
  const golden = Math.PI * (3 - Math.sqrt(5))
  const positions = {}
  ranked.forEach((node, i) => {
    const t = ranked.length <= 1 ? 0 : i / (ranked.length - 1)
    const radius = maxR * (0.16 + 0.84 * Math.pow(t, 0.82))
    const angle = i * golden + hash01(node.id) * 0.8
    const jitterX = (hash01(node.id + 'x') - 0.5) * 18
    const jitterY = (hash01(node.id + 'y') - 0.5) * 14
    const r = Math.round(16 + ((node.importance == null ? 50 : node.importance) / 100) * 30)
    positions[node.id] = {
      x: Math.round(cx + Math.cos(angle) * radius + jitterX),
      y: Math.round(cy + Math.sin(angle) * radius + jitterY),
      r,
    }
  })
  const edges = Object.values(state.edges).map((edge) => {
    const a = positions[edge.from]
    const b = positions[edge.to]
    if (!a || !b) return null
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      summary: edge.summary || '',
      relation: edge.relation || '',
      conflict: edge.conflict === true,
      updated: edge.updated || edge.created || null,
    }
  }).filter(Boolean)
  return {
    width: W,
    height: H,
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      summary: node.summary || '',
      kind: node.kind || '事实',
      tone: node.tone || 'peach',
      keywords: Array.isArray(node.keywords) ? node.keywords.slice(0, 6) : [],
      importance: node.importance == null ? 50 : node.importance,
      freq: node._freq || 0,
      hits: node.hits || 1,
      sessions: Array.isArray(node.sessions) ? node.sessions.slice() : [],
      created: node.created || node.updated || null,
      updated: node.updated || node.created || null,
      pinned: node.pinned === true,
      ...positions[node.id],
    })),
    edges,
  }
}

function hash01(text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

/* ------------------------------------------------------------------ 合并抽取 */

const KINDS = ['偏好', '事实', '计划', '关系', '目标', '情绪', '禁忌']

export function sanitizeKind(kind) {
  return KINDS.includes(kind) ? kind : '事实'
}

export function sanitizeKeywords(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const k = String(item == null ? '' : item).trim().replace(/^#/, '')
    if (k && k.length <= 16 && !out.includes(k)) out.push(k)
    if (out.length >= 6) break
  }
  return out
}

function uniqueId(state, prefix) {
  let id = ''
  do {
    id = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  } while (state.nodes[id] || state.edges[id])
  return id
}

function findExisting(state, cand) {
  const title = normTitle(cand.title)
  const titleChars = tokenSet(cand.title || '')
  const kw = tokenSet((cand.keywords || []).join(' '))
  let best = null
  let bestScore = 0
  for (const node of Object.values(state.nodes)) {
    const nodeTitle = normTitle(node.title)
    const sameTitle = title && nodeTitle === title
    const titleContained =
      title.length >= 3 && nodeTitle.length >= 3 && (nodeTitle.includes(title) || title.includes(nodeTitle))
    const score = sameTitle
      ? 1
      : titleContained
        ? 0.9
        : Math.max(jaccard(kw, tokenSet((node.keywords || []).join(' '))), jaccard(titleChars, tokenSet(node.title || '')))
    if (score > bestScore) {
      best = node
      bestScore = score
    }
  }
  return bestScore >= 0.55 ? best : null
}

/**
 * 把模型抽取结果并进状态。返回批次记录（用于撤销），并原地修改 state。
 * extraction = { memories: [...], relations: [...] }
 */
export function mergeExtraction(state, sessionId, extraction, now = nowIso()) {
  const batch = { id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, sessionId, at: now, created: [], updated: [], edges: [], digestPrev: null }
  const sess = sessionState(state, sessionId)
  batch.digestPrev = sess.digest ? { text: sess.digest.text, nodeIds: sess.digest.nodeIds.slice(), updatedAt: sess.digest.updatedAt } : null
  const refs = new Map()
  const memories = Array.isArray(extraction && extraction.memories) ? extraction.memories : []
  const relations = Array.isArray(extraction && extraction.relations) ? extraction.relations : []

  memories.forEach((raw, index) => {
    const cand = {
      title: truncate(String(raw && raw.title ? raw.title : '').trim(), 40),
      summary: truncate(String(raw && raw.summary ? raw.summary : '').trim(), 600),
      keywords: sanitizeKeywords(raw && raw.keywords),
      importance: clamp(Number(raw && raw.importance) || 50, 0, 100),
      kind: sanitizeKind(raw && raw.kind),
      tone: ['peach', 'apricot', 'butter', 'rose', 'cream'][index % 5],
    }
    if (!cand.title) return
    let node = raw && raw.id && state.nodes[raw.id] ? state.nodes[raw.id] : null
    if (!node) node = findExisting(state, cand)
    const isUpdate = Boolean(node)
    if (isUpdate) {
      batch.updated.push({ id: node.id, prev: { title: node.title, summary: node.summary, keywords: node.keywords.slice(), importance: node.importance } })
      node.title = cand.title || node.title
      if (cand.summary) node.summary = cand.summary
      node.keywords = Array.from(new Set([...(node.keywords || []), ...cand.keywords])).slice(0, 6)
      node.importance = Math.round((node.importance * 0.7 + cand.importance * 0.3))
      node.hits = (node.hits || 1) + 1
      node.updated = now
      if (!node.kind || node.kind === '事实') node.kind = cand.kind
    } else {
      node = {
        id: uniqueId(state, 'n'),
        title: cand.title,
        summary: cand.summary,
        keywords: cand.keywords,
        importance: Math.round(cand.importance),
        hits: 1,
        kind: cand.kind,
        tone: cand.tone,
        created: now,
        updated: now,
        sessions: [sessionId],
        source: { sessionId, at: now },
        pinned: false,
      }
      state.nodes[node.id] = node
      batch.created.push(node.id)
    }
    if (!Array.isArray(node.sessions)) node.sessions = []
    if (!node.sessions.includes(sessionId)) node.sessions.push(sessionId)
    if (raw && raw.ref) refs.set(String(raw.ref), node.id)
  })

  for (const raw of relations) {
    const from = refs.get(String(raw && raw.from)) || (raw && state.nodes[raw.from] ? raw.from : null)
    const to = refs.get(String(raw && raw.to)) || (raw && state.nodes[raw.to] ? raw.to : null)
    if (!from || !to || from === to) continue
    const key = edgeKey(from, to)
    let edge = null
    for (const e of Object.values(state.edges)) {
      if (edgeKey(e.from, e.to) === key) { edge = e; break }
    }
    const payload = {
      summary: truncate(String(raw && raw.summary ? raw.summary : '').trim(), 400),
      relation: truncate(String(raw && raw.relation ? raw.relation : '相关').trim(), 20),
      conflict: raw && raw.conflict === true,
    }
    if (edge) {
      edge.summary = payload.summary || edge.summary
      edge.relation = payload.relation || edge.relation
      edge.conflict = payload.conflict
      edge.updated = now
    } else {
      edge = {
        id: uniqueId(state, 'e'),
        from, to,
        summary: payload.summary,
        relation: payload.relation,
        conflict: payload.conflict,
        created: now,
        updated: now,
        source: { sessionId, at: now },
      }
      state.edges[edge.id] = edge
      batch.edges.push(edge.id)
    }
  }

  sess.extractCount += 1
  sess.lastExtractAt = now
  sess.lastError = null
  state.batches.unshift(batch)
  if (state.batches.length > 40) state.batches.length = 40
  state.updatedAt = now
  return batch
}

function edgeKey(a, b) {
  return [String(a), String(b)].sort().join('|')
}

/** 撤销一个批次；也能撤销某个会话最近一次 */
export function rollbackBatch(state, scope) {
  const batch = state.batches.find((b) => (scope && scope.batchId ? b.id === scope.batchId : b.sessionId === scope.sessionId))
  if (!batch) return null
  for (const id of batch.created) {
    delete state.nodes[id]
    for (const edge of Object.values(state.edges)) {
      if (edge.from === id || edge.to === id) delete state.edges[edge.id]
    }
  }
  for (const item of batch.updated) {
    const node = state.nodes[item.id]
    if (!node) continue
    node.title = item.prev.title
    node.summary = item.prev.summary
    node.keywords = item.prev.keywords
    node.importance = item.prev.importance
  }
  for (const id of batch.edges) delete state.edges[id]
  const sess = state.sessions[batch.sessionId]
  if (sess && batch.digestPrev) {
    sess.digest = { text: batch.digestPrev.text, nodeIds: batch.digestPrev.nodeIds.slice(), updatedAt: batch.digestPrev.updatedAt }
  }
  state.batches = state.batches.filter((b) => b.id !== batch.id)
  state.updatedAt = nowIso()
  return batch
}

/* ------------------------------------------------------------------ 简报与注入 */

/**
 * 稳定简报：按「与当前会话相关度 + 重要性」挑几条最重要记忆，输出固定格式文本。
 * 同样的记忆在同样的会话里产出同样的文本（稳定前缀，利于 KV 缓存）。
 */
export function buildDigest(state, sessionId, limit) {
  const cfg = state.config || defaultConfig()
  const max = limit || cfg.digestLimit || 12
  const sess = state.sessions[sessionId]
  const nodes = Object.values(state.nodes)
  const score = (node) => {
    const related = sess && Array.isArray(node.sessions) && node.sessions.includes(sessionId) ? 1 : 0
    return related * 110 + (node.importance || 50) + (node.hits || 1) * 6
  }
  const ranked = nodes.slice().sort((a, b) => score(b) - score(a))
  const picked = ranked.slice(0, max)
  const tray = sess ? sess.tray || [] : []
  const trayNodes = tray.map((id) => state.nodes[id]).filter(Boolean)
  const conflictEdges = Object.values(state.edges).filter((edge) => edge.conflict === true)
  const lines = []
  lines.push('【忆泡记忆简报】')
  lines.push('以下是从以往对话里沉淀的记忆。与当前问题相关的才采用；若与本轮用户明确说法冲突，以用户最新说法为准。')
  if (picked.length === 0) {
    lines.push('（还没有沉淀记忆，这是早期对话。）')
  } else {
    lines.push('长期记忆：')
    picked.forEach((node, i) => {
      const kw = Array.isArray(node.keywords) && node.keywords.length ? `（关键词：${node.keywords.join(' / ')}）` : ''
      lines.push(`${i + 1}. [${node.kind || '事实'}] ${node.title}：${truncate(node.summary || '', 140)}${kw}`)
    })
  }
  if (conflictEdges.length) {
    lines.push('注意：以下记忆之间存在冲突，请谨慎采用并向用户确认：')
    for (const edge of conflictEdges.slice(0, 4)) {
      const a = state.nodes[edge.from]
      const b = state.nodes[edge.to]
      if (a && b) lines.push(`- ⚠ ${a.title} ↔ ${b.title}：${truncate(edge.summary || '说法不一致', 100)}`)
    }
  }
  if (trayNodes.length) {
    lines.push('用户本轮钉选、希望我记住的：')
    for (const node of trayNodes) lines.push(`- ★ ${node.title}：${truncate(node.summary || '', 130)}`)
  }
  return {
    text: lines.join('\n'),
    nodeIds: picked.map((n) => n.id),
  }
}

/** 每步调用前动态取最新简报（不落盘，纯函数） */
export function digestFor(state, sessionId) {
  const cfg = state.config || defaultConfig()
  if (cfg.injection === 'off') return ''
  const sess = state.sessions[sessionId]
  if (cfg.injection === 'tray') {
    const tray = (sess && sess.tray) || []
    const nodes = tray.map((id) => state.nodes[id]).filter(Boolean)
    if (!nodes.length) return ''
    return ['【忆泡 · 用户钉选记忆】', ...nodes.map((n) => `- ${n.title}：${truncate(n.summary || '', 120)}`)].join('\n')
  }
  if (sess && sess.digest && sess.digest.text) return sess.digest.text
  const built = buildDigest(state, sessionId)
  return built.text
}

export function refreshDigest(state, sessionId) {
  const sess = sessionState(state, sessionId)
  const built = buildDigest(state, sessionId)
  sess.digest = { text: built.text, nodeIds: built.nodeIds, updatedAt: nowIso() }
  state.updatedAt = nowIso()
  return sess.digest
}

/* ------------------------------------------------------------------ 提示词 */

export const EXTRACTION_SYSTEM = [
  '你是「忆泡」记忆整理器。你的任务是从一段 AI 与用户的日常对话里，提炼值得长期记住的信息，画成一张记忆网。',
  '只输出 JSON，不要解释、不要 Markdown 代码围栏。JSON 形状：',
  '{"memories":[{"ref":"n1","title":"≤12字","summary":"1-2句，保留关键细节","keywords":["2-5个短词"],"importance":0到100的整数,"kind":"偏好|事实|计划|关系|目标|情绪|禁忌"}],"relations":[{"from":"n1","to":"n2","summary":"两者关系的说明","relation":"因果|印证|同主题|对立|相关","conflict":false}]}',
  '规则：',
  '1. 只记「以后还有用」的信息：长期偏好、身份事实、正在推进的计划、目标、重要关系、情绪模式、禁忌。不要记录寒暄、一次性操作、模型自己的推理。',
  '2. 每条记忆必须能脱离对话独立看懂，不要用「这个/那个/上面说的」指代。',
  '3. 与「已有记忆」语义重复时用 {"op":"update","id":"已有id"} 并给出更新后的 title/summary；新信息才 create。',
  '4. relations 只在两条记忆确实有解释关系时给出，宁缺毋滥；互相矛盾的内容标 "conflict": true。',
  '5. importance：会影响长期行为/身份/关系的 70-95；一般偏好 40-70；一次性背景 20-40。',
].join('\n')

export function buildExtractionPrompt({ existing, transcript, sessionNote }) {
  const cfgLines = []
  const existingNodes = Array.isArray(existing) ? existing : []
  cfgLines.push('已有记忆（用于去重/更新，格式：id｜类型｜标题：摘要｜关键词）：')
  if (!existingNodes.length) cfgLines.push('（无）')
  for (const node of existingNodes) {
    cfgLines.push(`${node.id}｜${node.kind || '事实'}｜${node.title}：${truncate(node.summary || '', 90)}｜${(node.keywords || []).join(',')}`)
  }
  cfgLines.push('')
  if (sessionNote) {
    cfgLines.push(`本会话此前累积的摘要（供衔接）：${truncate(sessionNote, 400)}`)
    cfgLines.push('')
  }
  cfgLines.push('本轮新增对话（只从这里抽取新信息；已有记忆只是参照）：')
  cfgLines.push(transcript)
  cfgLines.push('')
  cfgLines.push('请输出 JSON：')
  return cfgLines.join('\n')
}

/* ------------------------------------------------------------------ 解析 */

export function parseExtraction(text) {
  let raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  raw = raw.slice(start, end + 1)
  const attempts = [raw, raw.replace(/,\s*([}\]])/g, '$1'), raw.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1')]
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (!parsed || typeof parsed !== 'object') continue
      return normalizeExtraction(parsed)
    } catch {
      /* 下一个尝试 */
    }
  }
  return null
}

export function normalizeExtraction(parsed) {
  const memories = Array.isArray(parsed.memories) ? parsed.memories : Array.isArray(parsed.nodes) ? parsed.nodes : []
  const relations = Array.isArray(parsed.relations) ? parsed.relations : Array.isArray(parsed.edges) ? parsed.edges : []
  return {
    memories: memories
      .filter((m) => m && typeof m === 'object' && (m.title || m.id))
      .slice(0, 12)
      .map((m) => ({
        ref: m.ref ? String(m.ref) : undefined,
        op: m.op === 'update' ? 'update' : 'create',
        id: typeof m.id === 'string' && m.id ? m.id : undefined,
        title: String(m.title || '').slice(0, 40),
        summary: String(m.summary || '').slice(0, 600),
        keywords: Array.isArray(m.keywords) ? m.keywords.map((k) => String(k).slice(0, 16)) : [],
        importance: clamp(Number(m.importance) || 50, 0, 100),
        kind: sanitizeKind(m.kind),
      })),
    relations: relations
      .filter((r) => r && typeof r === 'object' && (r.from || r.to))
      .slice(0, 18)
      .map((r) => ({
        from: String(r.from || ''),
        to: String(r.to || ''),
        summary: String(r.summary || '').slice(0, 400),
        relation: String(r.relation || '相关').slice(0, 20),
        conflict: r.conflict === true,
      })),
  }
}

/* ------------------------------------------------------------------ 导入导出 */

export function exportGraph(state) {
  return {
    schema: 'memory-bubble/v1',
    version: STATE_VERSION,
    exportedAt: nowIso(),
    source: { host: 'dsh' },
    graph: {
      id: 'default',
      nodes: Object.values(state.nodes).map((node) => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        keywords: node.keywords,
        importance: node.importance,
        hits: node.hits,
        kind: node.kind,
        tone: node.tone,
        created: node.created,
        updated: node.updated,
        sessions: node.sessions,
      })),
      edges: Object.values(state.edges),
    },
  }
}

/** 兼容三种输入：v1 信封 {graph}、旧版扁平 {nodes,edges}、记忆包 {graph:{id,nodes,edges}} */
function unwrapGraph(input) {
  if (!input || typeof input !== 'object') return null
  if (input.graph && typeof input.graph === 'object') return input.graph
  return input
}

/** 把导出的图并进当前状态（id 冲突时重新分配） */
export function importGraph(state, input) {
  const graph = unwrapGraph(input)
  const report = { nodes: 0, edges: 0, skipped: 0 }
  if (!graph || typeof graph !== 'object') return report
  const idMap = new Map()
  for (const raw of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (!raw || !raw.title) { report.skipped += 1; continue }
    let node = raw.id && state.nodes[raw.id] ? state.nodes[raw.id] : null
    if (!node) node = findExisting(state, raw)
    if (node) {
      node.hits = (node.hits || 1) + 1
      node.importance = Math.max(node.importance || 0, Number(raw.importance) || 0)
      if (!node.summary && raw.summary) node.summary = raw.summary
    } else {
      node = { id: uniqueId(state, 'n'), title: raw.title, summary: raw.summary || '', keywords: sanitizeKeywords(raw.keywords), importance: clamp(Number(raw.importance) || 50, 0, 100), hits: Number(raw.hits) || 1, kind: sanitizeKind(raw.kind), tone: raw.tone || 'peach', created: raw.created || nowIso(), updated: raw.updated || nowIso(), sessions: Array.isArray(raw.sessions) ? raw.sessions.slice(0, 40) : [], pinned: false }
      state.nodes[node.id] = node
    }
    if (raw.id) idMap.set(raw.id, node.id)
    report.nodes += 1
  }
  for (const raw of Array.isArray(graph.edges) ? graph.edges : []) {
    const from = idMap.get(raw.from) || raw.from
    const to = idMap.get(raw.to) || raw.to
    if (!state.nodes[from] || !state.nodes[to] || from === to) { report.skipped += 1; continue }
    const exists = Object.values(state.edges).some((e) => edgeKey(e.from, e.to) === edgeKey(from, to))
    if (exists) { report.skipped += 1; continue }
    const edge = { id: uniqueId(state, 'e'), from, to, summary: raw.summary || '', relation: raw.relation || '相关', conflict: raw.conflict === true, created: raw.created || nowIso(), updated: raw.updated || nowIso() }
    state.edges[edge.id] = edge
    report.edges += 1
  }
  state.updatedAt = nowIso()
  return report
}

/* ------------------------------------------------------------------ 对话转录 */

/** messages: [{ role:'user'|'assistant', text, at? }] → 抽取用文本 */
export function formatTranscript(messages, maxChars) {
  const lines = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = String((message && message.text) || '').trim()
    if (!text) continue
    const who = message.role === 'assistant' ? 'AI' : '用户'
    lines.push(`${who}：${truncate(text, 900)}`)
  }
  let out = lines.join('\n')
  const cap = maxChars || 6000
  if (out.length > cap) out = '…（更早的对话已省略）\n' + out.slice(out.length - cap)
  return out
}

/* ------------------------------------------------------------------ 跨 AI 互操作（其他 AI 下载并继承记忆） */

/** 给其他 AI 的便携使用说明（随 bundle 导出，直接贴进 system prompt 即可） */
export const PORTABLE_PROMPT = [
  '你有一份来自「忆泡 Memory Bubble」的长期记忆图（memory-bubble v1，JSON）。',
  '使用规则：',
  '1. 只采用与当前问题相关的记忆；记忆与用户最新说法冲突时，以最新说法为准，并提醒用户该条记忆可能已过期。',
  '2. kind = 禁忌 的记忆优先遵守；kind = 偏好 影响表达风格；kind = 计划 / 目标 用于主动提醒；kind = 关系 / 事实 用于称呼与背景。',
  '3. 不要在回复里整段复述记忆，只在相关处自然引用；记忆里没有的内容不要编造。',
  '4. 用户说“忘掉 / 别记这个”时，删除对应节点（有写权限时）。',
  '5. 需要更多细节时向用户确认，不要用记忆推断隐私。',
].join('\n')

/** 其他 AI 可直接调用的工具清单（JSON-Schema 风格，供 function calling / MCP 转写） */
export const TOOL_MANIFEST = [
  {
    name: 'memory_search',
    description: '在忆泡长期记忆图谱里检索记忆点。用户提到过去说过的事、偏好、计划时先查这里。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或自然语言描述' },
        limit: { type: 'number', description: '最多返回几条，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_brief',
    description: '读取当前会话的稳定记忆简报。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '会话 id，可省略' } },
    },
  },
  {
    name: 'memory_remember',
    description: '把一个值得长期记住的信息写进忆泡。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '不超过 12 字的短标题' },
        summary: { type: 'string', description: '1-2 句、可脱离对话独立看懂' },
        keywords: { type: 'array', items: { type: 'string' } },
        importance: { type: 'number', description: '0-100' },
        kind: { type: 'string', description: '偏好|事实|计划|关系|目标|情绪|禁忌' },
        sessionId: { type: 'string' },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'memory_link',
    description: '连接两条记忆并写清关系；内容矛盾时 conflict 设为 true。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        summary: { type: 'string' },
        relation: { type: 'string', description: '因果|印证|同主题|对立|相关' },
        conflict: { type: 'boolean' },
      },
      required: ['from', 'to', 'summary'],
    },
  },
  {
    name: 'memory_forget',
    description: '删除一条记忆（连同它的连线）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

/** 简单检索：返回按相关度排序的记忆（供 MCP / CLI / 其他 AI 复用） */
export function searchNodes(state, query, limit = 5) {
  const text = String(query || '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const scored = Object.values(state.nodes || {})
    .map((node) => {
      const haystack = `${node.title} ${node.summary} ${(node.keywords || []).join(' ')}`.toLowerCase()
      let score = 0
      for (const word of words) if (word && haystack.includes(word.toLowerCase())) score += 3
      if (text && haystack.includes(text.toLowerCase())) score += 5
      score += (node.importance || 50) / 100
      return { node, score }
    })
    .filter((item) => item.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, clamp(Number(limit) || 5, 1, 50))
  return scored.map(({ node }) => node)
}

/** 打包成可下载的“记忆包”：图 + 简报 + 便携提示词 + 工具清单 */
export function buildBundle(state, sessionId) {
  const sess = sessionId ? state.sessions && state.sessions[sessionId] : null
  const digest = sessionId ? digestFor(state, sessionId) : buildDigest(state, sessionId || 'portable').text
  return {
    schema: 'memory-bubble-bundle',
    schemaVersion: 1,
    app: { name: 'dsh-memory-bubble', stateVersion: STATE_VERSION },
    exportedAt: nowIso(),
    sessionId: sessionId || null,
    sessionTitle: (sess && sess.title) || null,
    digest,
    prompt: PORTABLE_PROMPT,
    tools: TOOL_MANIFEST,
    sourceFormat: 'memory-bubble/v1',
    graph: exportGraph(state).graph,
  }
}
