/** Local transport only. Operations stay in the existing plugin handlers. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

export const BRIDGE_ROUTES = {
  health: ['GET', '/health'], interop: ['GET', '/interop'], graph: ['GET', '/graph'], bundle: ['GET', '/ai/bundle'],
  prompt: ['GET', '/ai/prompt'], chat: ['GET', '/ai/chat'],
  config: ['GET', '/config'], configure: ['POST', '/config'],
  remember: ['POST', '/node/create'], edit: ['POST', '/node'], forget: ['POST', '/node/delete'],
  edge: ['POST', '/edge'], unlink: ['POST', '/edge/delete'],
  extract: ['POST', '/extract'], conversation: ['POST', '/conversation'], rollback: ['POST', '/rollback'], batches: ['GET', '/batch'],
  tray: ['POST', '/tray'], session: ['POST', '/session'], carry: ['POST', '/session/attach'],
  clear: ['POST', '/session/forget'], import: ['POST', '/import'], export: ['GET', '/export'],
  tools: ['POST', '/tools/call'],
}

export async function startBridge(profileDir, handlers) {
  const token = randomUUID()
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
        res.writeHead(403).end(JSON.stringify({ ok: false, error: 'Bridge authentication required' }))
        return
      }
      const pathname = new URL(req.url, 'http://localhost').pathname
      const route = Object.values(BRIDGE_ROUTES).find(([method, routePath]) => method === req.method && pathname === `/memory-bubble/api${routePath}`)
      if (!route) { res.writeHead(404).end(); return }
      await handlers.get(route[1])(req, res)
    } catch (error) {
      res.writeHead(error.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const file = path.join(profileDir, '.memory-bubble', 'bridge.json')
  try {
    await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid,
      stateFile: path.join(profileDir, '.memory-bubble', 'state.json') }), { mode: 0o600 })
  } catch (error) {
    await new Promise((resolve) => server.close(resolve))
    throw error
  }
  return async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(file, { force: true })
  }
}
