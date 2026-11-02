/**
 * dsh-feiyu-life 冒烟测试：mock 宿主全链路演练（不依赖真实 DSH）。
 *
 * 跑法：node tools/smoke.mjs
 * 覆盖：挂载 → 状态 → 真实漫游（mock fetch 拦截外部 API → 馆内风景回退）
 *       → SSE → 被理了 → autoSay 默认关 → 人设自定义 → 明信片生图（mock）
 *       → QQ 水群（mock OneBot）→ say → 持久化。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// DSH_HOME 必须在 import 插件前指到测试目录（插件在模块顶层读它）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-life-smoke-'))
process.env.DSH_HOME = TMP

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// persona.json / config.json 必须在 import 插件前写入（模块顶层读取）
{
  const dir = path.join(TMP, 'feiyu-life')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'persona.json'),
    JSON.stringify({
      diaryOpenings: ['自定义开场：路过{dest}时，自定义地记下了'],
      diaryClosings: { happy: ['自定义开心收尾'], normal: ['自定义普通收尾'], sad: ['自定义低落收尾'] },
      moodWords: { happy: '自定义好心情', normal: '自定义还行', sad: '自定义低落' },
    }),
    'utf8',
  )
  // 测试配置：开启明信片生图（compatible 后端指向 mock）与 QQ 水群（指向 mock）
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      quietHours: [0, 0],
      postcard: { enabled: true, backend: 'compatible', baseUrl: 'http://mock-image', apiKey: 'test-key', model: 'mock-model', size: '2K' },
      qq: { enabled: true, httpUrl: 'http://mock-qq', token: 't', groups: [123456] },
    }),
    'utf8',
  )
}

// mock 全局 fetch：生图端点返回 PNG、QQ 端点记录调用、其余一律失败（触发馆内风景回退）
const imageCalls = []
const qqCalls = []
const PNG_MAGIC = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000100000001000806000000' +
    '5d720000001b49444154789c6360000002000100' + 'ffffffffff' + '0000000049454e44ae426082',
  'hex',
)
// 生图产物合理性检查要求 >1000 字节，mock 补齐（真实图都在几百 KB 以上）
const PNG_MOCK = Buffer.concat([PNG_MAGIC, Buffer.alloc(1500 - PNG_MAGIC.length, 0x61)])
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('http://mock-image')) {
    imageCalls.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ data: [{ b64_json: PNG_MOCK.toString('base64') }] }) }
  }
  if (u.startsWith('http://mock-qq')) {
    qqCalls.push({ url: u, body: JSON.parse(init.body) })
    return { ok: true }
  }
  return { ok: false, status: 404, json: async () => ({}) }
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
check('五个路由已注册', ['/feiyu-life/state', '/feiyu-life/events', '/feiyu-life/travel', '/feiyu-life/say', '/feiyu-life/postcard']
  .every((p) => routes.has(p)))
check('不注入任何 UI（展示交给桌宠）', ![...routes.keys()].includes('/feiyu-life/panel.js'))

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

// —— 4. 催出门（mock fetch 全拦截 → 馆内风景回退也算正常产出） ——
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

// —— 5b. autoSay 默认关闭：归来不冒泡（不消耗 token） ——
{
  said.length = 0
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('autoSay 默认关：归来不冒泡', body.ok === true && body.spoken === false, 'spoken=' + body.spoken)
}

// —— 5c. 人设自定义生效：日记用 persona.json 词库 ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('日记使用自定义人设开场白', body.diary.includes('自定义开场：'), body.diary.split('\n')[0].slice(0, 26))
}

// —— 5d. 明信片生图（mock）：归来产出 PNG + 索引 + 静态路由 ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('生图协议被调用（images/generations）', imageCalls.length >= 1 && imageCalls[imageCalls.length - 1].model === 'mock-model',
    'prompt 长度 ' + (imageCalls[imageCalls.length - 1] ? imageCalls[imageCalls.length - 1].prompt.length : 0))
  check('归来产出明信片 PNG', body.ok === true && /^[0-9]+\.png$/.test(body.postcardId || ''), body.postcardId)
  const img = mockRes()
  await routes.get('/feiyu-life/postcard')({ method: 'GET', url: '/feiyu-life/postcard?id=' + body.postcardId }, img)
  check('明信片可路由（PNG 魔数）', img.statusCode === 200 && img.body.slice(0, 4).equals(PNG_MAGIC.subarray(0, 4)),
    img.body.length + ' bytes')
  const st = mockRes()
  await routes.get('/feiyu-life/state')({ method: 'GET' }, st)
  check('state 暴露明信片索引', (JSON.parse(st.body).postcards || []).length >= 1)
}

// —— 5e. QQ 水群（mock OneBot）：归来发群消息 ——
{
  const res = mockRes()
  await routes.get('/feiyu-life/travel')({ method: 'POST' }, res)
  const body = JSON.parse(res.body)
  check('QQ 通道被调用（send_group_msg）', qqCalls.length >= 1 && qqCalls[qqCalls.length - 1].body.group_id === 123456,
    qqCalls.length ? '已发 ' + qqCalls.length + ' 条' : '未调用')
  check('归来报告 qqSent', body.qqSent === true)
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
  const cardsDir = path.join(TMP, 'feiyu-life', 'postcards')
  check('明信片 PNG 已落盘', fs.existsSync(cardsDir) && fs.readdirSync(cardsDir).some((f) => f.endsWith('.png')))
}

// —— 8. 生活档案（新增）：/days 与 /archive ——
{
  const todayKeyOf = (d) => {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const today = todayKeyOf(new Date())

  const daysRes = mockRes()
  await routes.get('/feiyu-life/days')({ method: 'GET' }, daysRes)
  const days = JSON.parse(daysRes.body)
  check('GET /days 200 且包含今天', daysRes.statusCode === 200 && days.days.includes(today), JSON.stringify(days.days))

  const arcRes = mockRes()
  await routes.get('/feiyu-life/archive')({ method: 'GET', url: '/feiyu-life/archive?date=' + today }, arcRes)
  const arc = JSON.parse(arcRes.body)
  check('GET /archive 返回当天日记全文', arcRes.statusCode === 200 && arc.ok === true && arc.diary.length >= 1,
    'diary=' + (arc.diary ? arc.diary.length : 'n/a'))
  check('archive 含心情采样与统计', Array.isArray(arc.moodSamples) && arc.stats && arc.stats.diaryCount === arc.diary.length)

  const badRes = mockRes()
  await routes.get('/feiyu-life/archive')({ method: 'GET', url: '/feiyu-life/archive?date=bad' }, badRes)
  check('坏日期返回 400', badRes.statusCode === 400)
}

console.log()
console.log(failed === 0 ? `全部通过 ✅（${passed} 项）` : `${failed} 项失败 ❌`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
process.exitCode = failed === 0 ? 0 : 1
