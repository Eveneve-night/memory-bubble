#!/usr/bin/env node
/**
 * 忆泡 MCP 服务器（stdio，零依赖）
 *
 * 让 Claude Desktop / Cursor / 其他 MCP 客户端直接使用忆泡记忆：
 *   node interop/mcp-server.mjs [--data <state.json 或 bundle.json>] [--session <sessionId>] [--read-only]
 *
 * 协议：MCP 2024-11-05（换行分隔的 JSON-RPC 2.0），日志一律走 stderr，stdout 只输出协议消息。
 */

import readline from 'node:readline'
import { readFile } from 'node:fs/promises'
import { PORTABLE_PROMPT } from '../plugin/lib/core.js'
import { parseArgs } from './lib.mjs'
import { createClient } from './client.mjs'

const VERSION = JSON.parse(await readFile(new URL('../plugin/package.json', import.meta.url), 'utf8')).version
const args = parseArgs()
const client = await createClient(args)

function log(...parts) {
  process.stderr.write(`[memory-bubble-mcp] ${parts.join(' ')}\n`)
}

const RESOURCES = [
  { uri: 'memory://graph', name: '忆泡记忆图（JSON）', description: '完整记忆图谱：节点、连线、权重、会话来源', mimeType: 'application/json' },
  { uri: 'memory://digest', name: '忆泡记忆简报（文本）', description: '当前会话的稳定简报，可直接贴进上下文', mimeType: 'text/plain' },
  { uri: 'memory://prompt', name: '跨 AI 使用说明', description: '其他 AI 读取并使用这份记忆的规则', mimeType: 'text/plain' },
  { uri: 'memory://chat', name: '纯对话记忆包', description: '可粘贴到无工具对话端的使用说明与记忆 JSON', mimeType: 'text/plain' },
]

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
}

function textContent(text) {
  return [{ type: 'text', text }]
}

async function handleToolsCall(params) {
  const name = params && params.name
  const toolArgs = (params && params.arguments) || {}
  if (!client.tools.some((tool) => tool.name === name)) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
  const result = name === 'memory_action' ? await client.call(toolArgs.operation, toolArgs.params)
    : await client.call('tools', { name, arguments: toolArgs })
  return { content: textContent(JSON.stringify(result, null, 2)), isError: result && result.ok === false ? true : undefined }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: {} },
        serverInfo: { name: 'memory-bubble', version: VERSION },
        instructions: PORTABLE_PROMPT,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: client.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }
    case 'tools/call':
      return handleToolsCall(params)
    case 'resources/list':
      return { resources: RESOURCES }
    case 'resources/read': {
      const uri = params && params.uri
      if (uri === 'memory://graph') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify((await client.call('bundle')).graph, null, 2) }] }
      if (uri === 'memory://digest') return { contents: [{ uri, mimeType: 'text/plain', text: (await client.call('tools', { name: 'memory_brief' })).digest || '（还没有记忆）' }] }
      if (uri === 'memory://prompt') return { contents: [{ uri, mimeType: 'text/plain', text: PORTABLE_PROMPT }] }
      if (uri === 'memory://chat') return { contents: [{ uri, mimeType: 'text/plain', text: await client.call('chat') }] }
      throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32602 })
    }
    case 'prompts/list':
      return { prompts: [{ name: 'memory-bubble-usage', description: '把忆泡记忆包交给当前 AI 的使用说明', arguments: [{ name: 'sessionId', description: '会话 id，可省略', required: false }] }] }
    case 'prompts/get':
      return { description: '忆泡记忆使用说明', messages: [{ role: 'user', content: { type: 'text', text: await client.call('chat', { sessionId: params?.arguments?.sessionId || args.session }) } }] }
    case 'logging/setLevel':
      return {}
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
let queue = Promise.resolve()
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    log('invalid json on stdin')
    return
  }
  const isNotification = typeof message.id === 'undefined'
  if (isNotification) return
  queue = queue.then(() => dispatch(message.method, message.params))
    .then((result) => {
      if (!isNotification) ok(message.id, result)
    })
    .catch((error) => {
      log(`error ${message.method}: ${error && error.message ? error.message : error}`)
      if (!isNotification) fail(message.id, error && error.code ? error.code : -32603, error && error.message ? error.message : 'internal error')
    })
})

log(`ready · transport=${client.live ? 'live' : 'file'} · session=${args.session || 'auto'}`)
