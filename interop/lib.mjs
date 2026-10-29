/**
 * 忆泡 · 跨 AI 互操作库
 *
 * 让 DSH 之外的其他 AI / 客户端也能读取和使用忆泡记忆：
 *  - 读同一个 <profile>/.memory-bubble/state.json（或 --data 指定的任意导出文件）
 *  - 提供与插件内部一致的检索 / 简报 / 写入 / 连线 / 删除语义
 *  - 打包 memory-bubble-bundle（图 + 简报 + 便携提示词 + 工具清单）
 *
 * 本文件只依赖 node 内置模块 + plugin/lib/core.js，不引第三方依赖。
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildBundle,
  buildDigest,
  emptyState,
  formatDate,
  importGraph,
  mergeExtraction,
  refreshDigest,
  searchNodes,
  truncate,
  STATE_VERSION,
} from '../plugin/lib/core.js'

/** 解析 --key value / --flag 形式的参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i += 1 }
      else out[key] = true
    } else out._.push(arg)
  }
  return out
}

/** 记忆数据文件位置：--data > $MEMORY_BUBBLE_STATE > DSH profile 默认位置 */
export async function resolveDataFile(explicit) {
  if (explicit) return path.resolve(explicit)
  if (process.env.MEMORY_BUBBLE_STATE) return path.resolve(process.env.MEMORY_BUBBLE_STATE)
  try {
    const { resolveProfileDir, statePath } = await import('../plugin/lib/store.js')
    return statePath(await resolveProfileDir())
  } catch {
    return path.join(process.cwd(), 'state.json')
  }
}

export async function loadState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && parsed.nodes && parsed.edges) {
      if (parsed.version !== STATE_VERSION) parsed.version = STATE_VERSION
      if (!Array.isArray(parsed.batches)) parsed.batches = []
      if (!parsed.sessions) parsed.sessions = {}
      return parsed
    }
    throw new Error(`Invalid Memory Bubble state: ${file}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return emptyState()
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 1), 'utf8')
  try {
    await copyFile(file, `${file}.bak`)
  } catch {
    /* 首次写入没有旧文件 */
  }
  await rename(tmp, file)
  return file
}

export function search(state, query, limit = 5) {
  return searchNodes(state, query, limit)
}

/** 没有指定会话时，取最近有记忆写入的会话 */
export function latestSessionId(state) {
  const sessions = Object.values(state.sessions || {})
  sessions.sort((a, b) => String(b.updatedAt || b.lastTurnAt || '').localeCompare(String(a.updatedAt || a.lastTurnAt || '')))
  return sessions[0] && sessions[0].id ? sessions[0].id : null
}

export function brief(state, sessionId) {
  const id = sessionId || latestSessionId(state)
  const text = buildDigest(state, id || null).text
  return { ok: true, sessionId: id || null, digest: text }
}

export function remember(state, args = {}) {
  const sessionId = String(args.sessionId || 'external-ai')
  const batch = mergeExtraction(state, sessionId, {
    memories: [{
      title: args.title,
      summary: args.summary,
      keywords: args.keywords,
      importance: args.importance,
      kind: args.kind,
      // 外部 AI / CLI / MCP 的 remember 是“用户明确要求记下”，属于手工新增：
      // 与自动抽取的“必须有用户原话依据”规则区分开，否则会被防幻觉守卫丢弃。
      manual: true,
      evidence: args.evidence ? String(args.evidence) : '',
    }],
    relations: [],
  })
  refreshDigest(state, sessionId)
  const id = batch.created[0] || (batch.updated[0] && batch.updated[0].id) || null
  return { ok: true, id, node: id ? state.nodes[id] : null }
}

export function link(state, args = {}) {
  const sessionId = String(args.sessionId || 'external-ai')
  const batch = mergeExtraction(state, sessionId, {
    memories: [],
    relations: [{
      from: args.from,
      to: args.to,
      summary: args.summary,
      relation: args.relation,
      conflict: args.conflict === true,
    }],
  })
  return { ok: true, id: batch.edges[0] || null }
}

export function forget(state, args = {}) {
  const id = args.id
  if (!id || !state.nodes[id]) return { ok: false, error: 'node not found' }
  const title = state.nodes[id].title
  delete state.nodes[id]
  for (const edge of Object.values(state.edges)) if (edge.from === id || edge.to === id) delete state.edges[edge.id]
  return { ok: true, id, title }
}

export function bundle(state, sessionId) {
  return buildBundle(state, sessionId)
}

/** 读取一个图 / 记忆包文件并合并进当前状态 */
export async function importGraphFile(state, file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const graph = parsed && parsed.graph ? parsed.graph : parsed
  return importGraph(state, graph)
}

/** 给人看的列表 */
export function listNodes(state) {
  return Object.values(state.nodes).map((node) => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    importance: node.importance,
    keywords: node.keywords,
    summary: truncate(node.summary || '', 120),
    updated: formatDate(node.updated),
    sessions: node.sessions,
  }))
}
