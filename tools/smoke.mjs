/**
 * dsh-feiyu-life 冒烟测试：mock 宿主全链路演练（不依赖真实 DSH）。
 *
 * 跑法：node tools/smoke.mjs
 * 覆盖：插件挂载 → 状态端点 → 催出门（真实网络，断网时走馆内风景回退）
 *       → SSE 事件 → "被理了"心情联动 → say 端点 → 卸载清理。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// DSH_HOME 必须在 import 插件前指到测试目录（插件在模块顶层读它）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-life-smoke-'))
process.env.DSH_HOME = TMP

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// persona.json 必须在 import 插件前写入（模块顶层 loadPersona）
{
  const personaDir = path.join(TMP, 'feiyu-life')
  fs.mkdirSync(personaDir, { recursive: true })
  fs.writeFileSync(
    path.join(personaDir, 'persona.json'),
    JSON.stringify({
      diaryOpenings: ['自定义开场：路过{dest}时，自定义地记下了'],
      diaryClosings: { happy: ['自定义开心收尾'], normal: ['自定义普通收尾'], sad: ['自定义低落收尾'] },
      moodWords: { happy: '自定义好心情', normal: '自定义还行', sad: '自定义低落' },
    }),
    'utf8',
  )
}
const plugin = (await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)).default

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  ok ? passed++ : failed++
}

function mockRes() {
  return {
    statusCode: 0,
    chunks: [],
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this },
    end(text) { this.body = text ?? '' },
    write(s) { this.chunks.push(s); return true },
    closed: false,
    on(evt, fn) { if (evt === 'close') this._onClose = fn },
    fireClose() { if (this._onClose) this._onClose() },
  }
}

// —— mock 宿主 ——
const routes = new Map()
const handlers = []
const said = []
const ctx = {
  webServer: {
    register(r) {
      routes.set(r.path, r.handler)
      return () => routes.delete(r.path)
    },
  },
  on(evt, fn) {
    handlers.push({ evt, fn })
    return () => {}
  },
  get(name) {
    if (name === 'connection') return { requestRejection: () => false }
    if (name === 'sessionController') {
      return {
        create: async () => ({ sessionId: 'smoke-session' }),
        prompt: async (request) => { said.push(request); return { ok: true } },
      }
    }
    return undefined
  },
  effect() {},
}

// —— 1. 挂载 ——
// Cordis 约束：apply 的返回值只能是 undefined / 清理函数 / Promise / iterable
// （返回普通对象会 TypeError: Invalid effect，宿主实测踩过）。本插件返回清理函数。
const dispose = plugin.apply(ctx)
check('插件挂载并返回清理函数', typeof dispose === 'function')
check('五个路由已注册（含面板）', ['/feiyu-life/state', '/feiyu-life/events', '/feiyu-life/travel', '/feiyu-life/say', '/feiyu-life/panel.js']
  .every((p) => routes.has(p)))

// —— 2. 状态端点 ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/state')({ method: 'GET' }, res)
  const body = JSON.parse(res.body)
  check('GET /state 200', res.statusCode === 200)
  check('状态含心情三件套', body.mood && typeof body.mood.value === 'number' && typeof body.mood.label === 'string')
  check('状态含旅程与统计', Array.isArray(body.journeys) && body.stats && body.stats.dailyMax > 0)
}

// —— 3. SSE 握手 ——
const sse = mockRes()
await routes.get('/feiyu-life/events')({ method: 'GET' }, sse)
check('SSE 握手事件', sse.chunks.length === 1 && sse.chunks[0].includes('"hello"'))

// —— 4. 催出门（真实网络漫游；断网走馆内风景回退，两者都算通过） ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  const roamed = body.ok === true && typeof body.diary === 'string' && body.diary.length > 10
  check('催出门产出日记', roamed, roamed ? body.diary.split('\n')[0].slice(0, 30) : JSON.stringify(body))
  check('SSE 收到日记事件', sse.chunks.some((c) => c.includes('"diary"')))
  const stateRes = mockRes()
  await routes.get('/feiyu-life/state')({ method: 'GET' }, stateRes)
  const s = JSON.parse(stateRes.body)
  check('旅程已入档', s.journeys.length >= 1 && s.stats.todayRoams >= 1)
}

// —— 5. 被理了：心情联动 + 主会话记录 ——
{
  const before = JSON.parse((await (async () => {
    const res = mockRes()
    await routes.get('/feiyu-life/state')({ method: 'GET' }, res)
    return { body: res.body }
  })()).body)
  const sessionHandler = handlers.find((h) => h.evt === 'session/event')
  check('已订阅 session/event', !!sessionHandler)
  if (sessionHandler) {
    sessionHandler.fn({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] } })
    const after = mockRes()
    await routes.get('/feiyu-life/state')({ method: 'GET' }, after)
    const a = JSON.parse(after.body)
    check('被理了心情上扬', a.mood.value > before.mood.value, `${before.mood.value} -> ${a.mood.value}`)
    check('SSE 收到 attention 事件', sse.chunks.some((c) => c.includes('"attention"')))
  }
}



// —— 5b. autoSay 默认关闭：归来不冒泡（不消耗 token）；面板脚本可路由 ——
{
  said.length = 0
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('autoSay 默认关：归来不冒泡', body.ok === true && said.length === 0, 'said=' + said.length)
  const panel = mockRes()
  await routes.get('/feiyu-life/panel.js')({ method: 'GET' }, panel)
  check('面板脚本可路由', panel.statusCode === 200 && panel.body.includes('feiyu-life-panel'), panel.body.slice(0, 30))
}

// —— 5c. 人设自定义生效：日记用 persona.json 词库 ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('日记使用自定义人设开场白', body.diary.includes('自定义开场：'), body.diary.split('\n')[0].slice(0, 26))
}

// —— 6. say 端点 ——
{
  said.length = 0
  const res = mockRes()
  await routes.get('/feiyu-life/say')(
    { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: '刚回来。' })) } },
    res,
  )
  const body = JSON.parse(res.body)
  check('say 经 sessionController 送进会话', body.ok === true && said.length === 1 && said[0].content[0].text === '刚回来。')
  const res2 = mockRes()
  await routes.get('/feiyu-life/say')(
    {
      method: 'POST',
      [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}') },
    },
    res2,
  )
  check('空文本被拒绝(400)', res2.statusCode === 400)
}

// —— 7. 数据落盘 ——
{
  const stateFile = path.join(TMP, 'feiyu-life', 'state.json')
  const diaryFile = path.join(TMP, 'feiyu-life', 'diary.jsonl')
  check('state.json 已持久化', fs.existsSync(stateFile))
  check('diary.jsonl 已追加日记', fs.existsSync(diaryFile) && fs.readFileSync(diaryFile, 'utf8').trim().split('\n').length >= 1)
}

console.log()
console.log(failed === 0 ? `全部通过 ✅（${passed} 项）` : `${failed} 项失败 ❌`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
process.exitCode = failed === 0 ? 0 : 1
