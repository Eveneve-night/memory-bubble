#!/usr/bin/env node
/**
 * 忆泡 CLI（零依赖）——不启动 DSH 也能导出 / 导入 / 检索记忆，
 * 方便其他 AI 或脚本直接使用。
 *
 *   node interop/cli.mjs list                      列出全部记忆
 *   node interop/cli.mjs search --query 在学 Rust
 *   node interop/cli.mjs brief [--session <id>]
 *   node interop/cli.mjs export --out graph.json  导出可继承的图
 *   node interop/cli.mjs import --file graph.json 合并一份图
 *   node interop/cli.mjs bundle --out bundle.json 导出记忆包（含提示词/工具清单）
 *   node interop/cli.mjs remember --title 标题 --summary 摘要 [--importance 70] [--kind 偏好]
 *
 * 通用参数：--data <state.json>（默认读 DSH profile 的 .memory-bubble/state.json）
 */

import { writeFile } from 'node:fs/promises'
import { exportGraph, truncate } from '../plugin/lib/core.js'
import {
  brief,
  bundle,
  forget,
  importGraphFile,
  listNodes,
  loadState,
  parseArgs,
  remember,
  resolveDataFile,
  saveState,
  search,
} from './lib.mjs'

const args = parseArgs()
const command = args._[0] || 'help'
const dataFile = await resolveDataFile(args.data)

function print(value) {
  if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const HELP = `忆泡 CLI

  list                                 列出全部记忆
  search --query <文本> [--limit 5]    检索
  brief [--session <id>]               读取稳定简报
  export --out <file>                  导出可继承的图（JSON）
  import --file <file>                 合并一份图 / 记忆包
  bundle [--session <id>] [--out <file>]  导出记忆包（图+简报+便携提示词+工具清单）
  remember --title <标题> --summary <摘要> [--importance 70] [--kind 偏好] [--keywords a,b]
  forget --id <记忆 id>
  help

通用：--data <state.json>（默认读 DSH profile 的 .memory-bubble/state.json）
`

if (command === 'help') {
  print(HELP)
} else if (command === 'list') {
  const state = await loadState(dataFile)
  const rows = listNodes(state)
  if (!rows.length) print('（还没有记忆）')
  else for (const row of rows) print(`${row.id}  [${row.kind || '事实'}] ${row.title}（重要性 ${row.importance}）· ${row.updated}`)
} else if (command === 'search') {
  const state = await loadState(dataFile)
  const results = search(state, args.query || '', Number(args.limit) || 5)
  if (!results.length) print('没有匹配的记忆')
  else for (const node of results) print(`${node.id}  ${node.title}\n  ${truncate(node.summary || '', 160)}\n  ${(node.keywords || []).join(' / ')}`)
} else if (command === 'brief') {
  const state = await loadState(dataFile)
  print(brief(state, args.session ? String(args.session) : undefined).digest || '（还没有简报）')
} else if (command === 'export') {
  const state = await loadState(dataFile)
  const graph = exportGraph(state)
  if (args.out) { await writeFile(String(args.out), JSON.stringify(graph, null, 2), 'utf8'); print(`已导出 → ${args.out}`) } else print(graph)
} else if (command === 'import') {
  if (!args.file) { print('缺少 --file <graph.json>'); process.exitCode = 1 } else {
    const state = await loadState(dataFile)
    const report = await importGraphFile(state, String(args.file))
    await saveState(dataFile, state)
    print({ ok: true, report })
  }
} else if (command === 'bundle') {
  const state = await loadState(dataFile)
  const payload = bundle(state, args.session ? String(args.session) : undefined)
  if (args.out) { await writeFile(String(args.out), JSON.stringify(payload, null, 2), 'utf8'); print(`已导出记忆包 → ${args.out}`) } else print(payload)
} else if (command === 'remember') {
  if (!args.title || !args.summary) { print('需要 --title 与 --summary'); process.exitCode = 1 } else {
    const state = await loadState(dataFile)
    const result = remember(state, {
      title: String(args.title),
      summary: String(args.summary),
      importance: args.importance ? Number(args.importance) : 60,
      kind: args.kind ? String(args.kind) : '事实',
      keywords: args.keywords ? String(args.keywords).split(',').map((item) => item.trim()).filter(Boolean) : [],
    })
    await saveState(dataFile, state)
    print(result)
  }
} else if (command === 'forget') {
  if (!args.id) { print('需要 --id <记忆 id>'); process.exitCode = 1 } else {
    const state = await loadState(dataFile)
    const result = forget(state, { id: String(args.id) })
    await saveState(dataFile, state)
    print(result)
  }
} else {
  print(`未知命令：${command}\n\n${HELP}`)
  process.exitCode = 1
}
