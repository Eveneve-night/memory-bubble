#!/usr/bin/env node
/** CLI and MCP share the same live/file adapter. */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from './lib.mjs'
import { createClient } from './client.mjs'

const args = parseArgs()
const command = args.help ? 'help' : args._[0] || 'help'
const HELP = `忆泡 CLI

  list / search --query <文本> / brief
  remember --title <标题> --summary <内容> [--session <会话>]
  forget --id <记忆 id>
  export / bundle / chat [--session <会话>] [--out <文件>]
  import --file <图或记忆包> [--session <目标会话>] [--apply]
  carry --from <来源会话> --to <目标会话>
  action <操作名> [--json <参数 JSON> | --file <参数文件>]

通用：--data <state.json>；自动发现该数据文件旁的 bridge.json。
可用 --url <桥接地址> --token <令牌> 显式连接。在线操作不直接写文件。
chat 输出可粘贴到纯对话 AI 的记忆包；--apply 显式允许导入已有条目的修改。
`

if (command === 'help') {
  console.log(HELP)
} else {
  const client = await createClient(args)
  let result
  switch (command) {
    case 'list':
      result = (await client.call('list')).map((node) => `${node.id}  [${node.kind}] ${node.title}（重要性 ${node.importance}）`).join('\n') || '（还没有记忆）'
      break
    case 'search':
      result = await client.call('tools', { name: 'memory_search', arguments: { query: args.query || '', limit: Number(args.limit) || 5 } })
      break
    case 'brief':
      result = (await client.call('tools', { name: 'memory_brief' })).digest || '（还没有简报）'
      break
    case 'remember':
      result = await client.call('tools', { name: 'memory_remember', arguments: {
        title: args.title, summary: args.summary, importance: args.importance === undefined ? 60 : Number(args.importance),
        kind: args.kind || '事实', keywords: args.keywords ? args.keywords.split(',').map((word) => word.trim()) : [],
      } })
      break
    case 'forget':
      result = await client.call('tools', { name: 'memory_forget', arguments: { id: args.id } })
      break
    case 'bundle': case 'chat':
      result = await client.call(command)
      break
    case 'export':
      result = (await client.call('export')).graph
      break
    case 'import':
      result = await client.call('import', { graph: JSON.parse(await readFile(args.file, 'utf8')), updateExisting: args.apply === true })
      break
    case 'carry':
      result = await client.call('carry', { from: args.from, to: args.to })
      break
    case 'action':
      result = await client.call(args._[1], args.file ? JSON.parse(await readFile(args.file, 'utf8')) : JSON.parse(args.json || '{}'))
      break
    default:
      throw new Error(`Unknown command: ${command}`)
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  if (args.out) await writeFile(args.out, text, 'utf8')
  else console.log(text)
}
