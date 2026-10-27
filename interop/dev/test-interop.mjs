/**
 * 忆泡 · 跨 AI 互操作测试（node interop/dev/test-interop.mjs）
 *
 * 验证其他 AI / 客户端能真正用上忆泡：
 *  1. CLI：remember / list / search / brief / export / bundle / import
 *  2. MCP stdio：initialize / tools/list / tools/call / resources/read
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadState, remember, saveState, search } from '../lib.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'memory-bubble-interop-'))
const dataFile = path.join(tmp, 'state.json')

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    console.error(`FAIL ${name}:`, error)
  }
}

await check('CLI remember 写入一条记忆', async () => {
  const r = await run(process.execPath, ['interop/cli.mjs', 'remember', '--data', dataFile, '--title', '在学 Rust', '--summary', '用具体例子讲，不要抽象概念。', '--importance', '78', '--kind', '目标', '--keywords', 'Rust,学习'])
  assert.equal(r.code, 0, r.stderr)
  const state = await loadState(dataFile)
  assert.equal(Object.keys(state.nodes).length, 1)
})

await check('CLI list / search / brief 能读出来', async () => {
  const state = await loadState(dataFile)
  remember(state, { title: '每周读论文', summary: '每周一篇，偏 HCI。', importance: 60, kind: '计划', keywords: ['论文'] })
  await saveState(dataFile, state)

  const list = await run(process.execPath, ['interop/cli.mjs', 'list', '--data', dataFile])
  assert.ok(list.stdout.includes('在学 Rust'), list.stdout)

  const found = await run(process.execPath, ['interop/cli.mjs', 'search', '--data', dataFile, '--query', 'Rust'])
  assert.ok(found.stdout.includes('在学 Rust'), found.stdout)

  const briefOut = await run(process.execPath, ['interop/cli.mjs', 'brief', '--data', dataFile])
  assert.ok(briefOut.stdout.includes('忆泡记忆简报') || briefOut.stdout.includes('长期记忆'), briefOut.stdout)
})

await check('CLI export / bundle / import', async () => {
  const exported = path.join(tmp, 'graph.json')
  const exp = await run(process.execPath, ['interop/cli.mjs', 'export', '--data', dataFile, '--out', exported])
  assert.equal(exp.code, 0, exp.stderr)
  const graph = JSON.parse(await readFile(exported, 'utf8'))
  assert.equal(graph.schema, 'memory-bubble/v1')
  assert.ok(Array.isArray(graph.graph.nodes) && graph.graph.nodes.length === 2)

  const bundleFile = path.join(tmp, 'bundle.json')
  const bun = await run(process.execPath, ['interop/cli.mjs', 'bundle', '--data', dataFile, '--out', bundleFile])
  assert.equal(bun.code, 0, bun.stderr)
  const payload = JSON.parse(await readFile(bundleFile, 'utf8'))
  assert.equal(payload.schema, 'memory-bubble-bundle')
  assert.ok(payload.prompt.includes('忆泡'))
  assert.equal(payload.tools.length, 5)
  assert.equal(payload.graph.nodes.length, 2)

  const other = path.join(tmp, 'other.json')
  const imp = await run(process.execPath, ['interop/cli.mjs', 'import', '--data', other, '--file', bundleFile])
  assert.equal(imp.code, 0, imp.stderr)
  const imported = await loadState(other)
  assert.equal(Object.keys(imported.nodes).length, 2)
})

await check('bundle 符合 memory-bubble-bundle v1 结构', async () => {
  const bundleFile = path.join(tmp, 'bundle.json')
  const bundle = JSON.parse(await readFile(bundleFile, 'utf8'))
  for (const key of ['schema', 'schemaVersion', 'graph', 'prompt', 'tools', 'digest']) assert.ok(key in bundle, `missing ${key}`)
  assert.equal(bundle.schema, 'memory-bubble-bundle')
  assert.equal(bundle.sourceFormat, 'memory-bubble/v1')
  for (const tool of bundle.tools) assert.ok(tool.name.startsWith('memory_') && tool.parameters && tool.parameters.type === 'object')

  const schemaFiles = ['memory-bubble-v1.schema.json', 'memory-bubble-bundle-v1.schema.json']
  for (const name of schemaFiles) {
    const schema = JSON.parse(await readFile(path.join(root, 'schema', name), 'utf8'))
    assert.ok(schema.$defs && schema.type === 'object', `${name} 结构不完整`)
  }
})

await check('MCP：initialize / tools/list / tools/call / resources/read', async () => {
  const child = spawn(process.execPath, ['interop/mcp-server.mjs', '--data', dataFile], { cwd: root, windowsHide: true })
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        const message = JSON.parse(line)
        const resolve = pending.get(message.id)
        if (resolve) { pending.delete(message.id); resolve(message) }
      }
      index = buffer.indexOf('\n')
    }
  })
  let nextId = 1
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000)
  })

  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.serverInfo.name, 'memory-bubble')
    assert.ok(init.result.instructions.includes('忆泡'))

    const tools = await request('tools/list', {})
    assert.equal(tools.result.tools.length, 5)
    assert.ok(tools.result.tools.some((tool) => tool.name === 'memory_search'))

    const call = await request('tools/call', { name: 'memory_search', arguments: { query: 'Rust' } })
    const payload = JSON.parse(call.result.content[0].text)
    assert.ok(payload.count >= 1 && payload.results[0].title.includes('Rust'))

    const read = await request('resources/read', { uri: 'memory://graph' })
    const graph = JSON.parse(read.result.contents[0].text)
    assert.equal(graph.nodes.length, 2)

    const digest = await request('resources/read', { uri: 'memory://digest' })
    assert.ok(digest.result.contents[0].text.includes('忆泡'))

    const removed = await request('tools/call', { name: 'memory_forget', arguments: { id: graph.nodes[0].id } })
    assert.equal(JSON.parse(removed.result.content[0].text).ok, true)
  } finally {
    child.kill()
  }
})

await rm(tmp, { recursive: true, force: true })
const failed = results.filter((item) => item.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1
