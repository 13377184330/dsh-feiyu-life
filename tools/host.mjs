/**
 * dsh-feiyu-life 独立实验宿主（零依赖）
 *
 * 跑法：node tools/host.mjs [--port 3099] [--tick 300000]
 *
 * 不依赖 DSH：内置一个最小 Cordis 宿主（webServer 适配 node:http、
 * connection 放行、sessionController 空实现），加载 lib/index.js 让她完整地活。
 * 数据仍写 ~/.dsh/feiyu-life/（与 DSH 插件共用同一份人生）。
 *
 * 用途：DSH 的 desktop profile 没有 webServer 服务，插件会挂起等依赖；
 * 独立宿主保证「独自生活」实验不依赖任何宿主配置，随时可跑。
 *
 * API（浏览器可直接打开）：
 *   GET  /feiyu-life/state
 *   GET  /feiyu-life/days
 *   GET  /feiyu-life/archive?date=YYYY-MM-DD
 *   GET  /feiyu-life/events（SSE）
 *   GET  /feiyu-life/postcard?id=...
 *   POST /feiyu-life/travel
 *   POST /feiyu-life/say（无会话时返回 503）
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = parseInt(argValue('--port', '3099'), 10)
const TICK = parseInt(argValue('--tick', '300000'), 10)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default

// —— 最小宿主：只实现插件声明的 inject 依赖 ——
const routes = []
const webServer = {
  register({ kind, path: p, handler }) {
    routes.push({ kind, path: p, handler })
    return () => {
      const i = routes.findIndex((r) => r.path === p)
      if (i >= 0) routes.splice(i, 1)
    }
  },
}
const listeners = new Map()
const ctx = {
  webServer,
  get(name) {
    if (name === 'connection') return { requestRejection: () => false }
    if (name === 'sessionController') {
      return {
        create: async () => ({ sessionId: 'host-session' }),
        prompt: async () => ({ ok: true }),
      }
    }
    return undefined
  },
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set())
    listeners.get(evt).add(fn)
    return () => {
      const set = listeners.get(evt)
      if (set) set.delete(fn)
    }
  },
  emit(evt, payload) {
    const set = listeners.get(evt)
    if (set) for (const fn of set) { try { fn(payload) } catch (e) {} }
  },
}

const dispose = plugin.apply(ctx)

function matchRoute(reqPath) {
  for (const r of routes) {
    if (r.kind === 'exact' && r.path === reqPath) return r
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = matchRoute(url.pathname)
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('feiyu-life host: 404 ' + url.pathname)
    return
  }
  try {
    await route.handler(req, res)
  } catch (err) {
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('feiyu-life host: ' + (err && err.message ? err.message : String(err)))
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[feiyu-life host] 实验宿主已启动：http://127.0.0.1:${PORT}/feiyu-life/state`)
  console.log(`[feiyu-life host] tick=${TICK}ms · 数据目录 ~/.dsh/feiyu-life/ · Ctrl+C 停止`)
})

process.on('SIGINT', () => {
  console.log('\n[feiyu-life host] 停止中…')
  try { dispose() } catch (e) {}
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  try { dispose() } catch (e) {}
  server.close(() => process.exit(0))
})