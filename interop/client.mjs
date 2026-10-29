/** Platform-neutral adapter: live plugin when available, locked files offline. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { BRIDGE_ROUTES } from '../plugin/lib/bridge.js'
import { lockState } from '../plugin/lib/store.js'
import { carryMemories, chatPacket, exportGraph, importGraph, TOOL_MANIFEST, validateToolArgs } from '../plugin/lib/core.js'
import { brief, bundle, forget, link, listNodes, loadState, remember, resolveDataFile, saveState, search } from './lib.mjs'

export const ACTION_TOOL = {
  name: 'memory_action',
  description: '操作运行中的 DSH 忆泡，sessionId 默认使用启动参数。edit:{id,patch:{title,summary,keywords,importance,kind,createdAt}}；edge:{id,patch:{summary,relation,conflict}}；unlink/forget:{id}；tray:{add:节点id|remove:节点id|clear:true}；configure:{config}；session:{enabled}；extract:{force}；conversation:{messages:[{role:"user"|"assistant",text}]}，用 DSH 当前模型总结外部对话；rollback:{batchId}；carry:{from,to}；import:{graph,updateExisting}；clear 清空当前会话归属；graph:{scope:"session"|"all"}、bundle、chat、export、batches、health、interop 为读取。',
  parameters: { type: 'object', properties: {
    operation: { type: 'string', enum: Object.keys(BRIDGE_ROUTES).filter((name) => name !== 'tools') },
    params: { type: 'object', description: '对应 HTTP 接口的参数；sessionId 可省略以使用启动参数。', additionalProperties: true },
  }, required: ['operation'] },
}

export async function createClient({ data, url, token, session: sessionId, 'read-only': readOnly = false } = {}) {
  const file = await resolveDataFile(data)
  if (!url) {
    try {
      const descriptor = JSON.parse(await readFile(path.join(path.dirname(file), 'bridge.json'), 'utf8'))
      if (path.resolve(descriptor.stateFile) === file) {
        url = descriptor.url
        token = descriptor.token
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const live = Boolean(url)

  async function remote(operation, params) {
    const [method, route] = BRIDGE_ROUTES[operation]
    const target = new URL(`/memory-bubble/api${route}`, url)
    if (method === 'GET') for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) target.searchParams.set(key, String(value))
    }
    const response = await fetch(target, { method, headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: method === 'GET' ? undefined : JSON.stringify(params), signal: AbortSignal.timeout(120000) })
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text()
    if (!response.ok) throw new Error(result.error || `Bridge HTTP ${response.status}`)
    return result
  }

  function offline(state, operation, params) {
    switch (operation) {
      case 'list': return listNodes(state).filter((node) => !params.sessionId || node.sessions.includes(params.sessionId))
      case 'bundle': return bundle(state, params.sessionId)
      case 'export': return { ok: true, graph: exportGraph(state) }
      case 'chat': return chatPacket(state, params.sessionId)
      case 'carry': return carryMemories(state, params)
      case 'import': return { ok: true, report: importGraph(state, params.graph, params) }
      case 'tools': {
        const args = { ...params.arguments, sessionId: params.arguments.sessionId || params.sessionId }
        switch (params.name) {
          case 'memory_search': {
            const scoped = params.sessionId ? { ...state, nodes: Object.fromEntries(Object.entries(state.nodes).filter(([, node]) => node.sessions.includes(params.sessionId))) } : state
            const results = search(scoped, args.query, args.limit)
            return { count: results.length, results }
          }
          case 'memory_brief': return brief(state, args.sessionId)
          case 'memory_remember': return remember(state, args)
          case 'memory_link': return link(state, args)
          case 'memory_forget': return forget(state, args)
        }
      }
      default: throw new Error(`${operation} requires a running DSH plugin`)
    }
  }

  async function call(operation, params = {}) {
    const args = { sessionId, ...params }
    if (!BRIDGE_ROUTES[operation] && operation !== 'list') throw new Error(`Unknown operation: ${operation}`)
    if (operation === 'tools') args.arguments ||= {}
    if (operation === 'carry' && (!args.from || !args.to)) throw new Error('carry requires from and to')
    if (operation === 'import' && !Array.isArray((args.graph?.graph || args.graph)?.nodes)) throw new Error('import requires a graph or memory bundle')
    const writing = operation === 'tools' ? !['memory_search', 'memory_brief'].includes(args.name)
      : BRIDGE_ROUTES[operation]?.[0] === 'POST'
    if (writing && readOnly) throw new Error('server is read-only')
    if (live) {
      if (operation === 'list') {
        const result = await remote('graph', { ...args, scope: args.sessionId ? 'session' : 'all' })
        return result.layout.nodes
      }
      return remote(operation, args)
    }
    if (operation === 'tools') validateToolArgs(args.name, args.arguments)
    const release = writing ? await lockState(file) : null
    try {
      const state = await loadState(file)
      const result = offline(state, operation, args)
      if (writing) await saveState(file, state)
      return result
    } finally {
      if (release) await release()
    }
  }
  return { live, file, call, tools: live ? [...TOOL_MANIFEST, ACTION_TOOL] : TOOL_MANIFEST }
}
