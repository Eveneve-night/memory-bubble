/**
 * 忆泡 · 状态持久化
 *
 * 独立存储：<profile>/.memory-bubble/state.json，不写进 DSH 会话日志。
 * 原子写（tmp + rename）避免半截文件；读失败时回退到 .bak，再失败给空状态。
 * 本文件的函数只需要 node:fs / node:path / node:os，可在 node 里直接单测。
 */

import { mkdir, readFile, rename, writeFile, copyFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { emptyState, STATE_VERSION } from './core.js'

let cachedDir = null

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * profile 目录：优先 DSH_PROFILE_DIR；否则从当前目录向上找 cordis.patch.yml / cordis.yml；
 * 再否则 ~/.dsh/profiles/<DSH_PROFILE || desktop>。
 */
export async function resolveProfileDir() {
  if (cachedDir) return cachedDir
  if (process.env.DSH_PROFILE_DIR) {
    cachedDir = path.resolve(process.env.DSH_PROFILE_DIR)
    return cachedDir
  }
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    if (await exists(path.join(dir, 'cordis.patch.yml')) || await exists(path.join(dir, 'cordis.yml'))) {
      cachedDir = dir
      return cachedDir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedDir = path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')
  return cachedDir
}

export function memoryBubbleDir(profileDir) {
  return path.join(profileDir, '.memory-bubble')
}

export function statePath(profileDir) {
  return path.join(memoryBubbleDir(profileDir), 'state.json')
}

/** 读取状态；缺失/损坏返回空状态（不抛） */
export async function readState(profileDir) {
  const file = statePath(profileDir)
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const raw = await readFile(candidate, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.nodes && parsed.edges) {
        if (parsed.version !== STATE_VERSION) parsed.version = STATE_VERSION
        if (!Array.isArray(parsed.batches)) parsed.batches = []
        if (!parsed.sessions) parsed.sessions = {}
        return parsed
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return emptyState()
}

/** 原子写状态；保留一份 .bak 供手工恢复 */
export async function writeState(profileDir, state) {
  const dir = memoryBubbleDir(profileDir)
  await mkdir(dir, { recursive: true })
  const file = statePath(profileDir)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const payload = JSON.stringify(state, null, 1)
  await writeFile(tmp, payload, 'utf8')
  try {
    if (await exists(file)) await copyFile(file, `${file}.bak`)
  } catch {
    /* 备份失败不影响主写入 */
  }
  await rename(tmp, file)
  return file
}

/** 导出文件路径（用户可把它拷到别的机器/插件里做继承） */
export async function writeExport(profileDir, graph) {
  const dir = memoryBubbleDir(profileDir)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify(graph, null, 2), 'utf8')
  return file
}
