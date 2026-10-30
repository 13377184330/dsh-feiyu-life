/**
 * dsh-feiyu-life —— 大肥鱼人生引擎（宿主侧插件，零第三方依赖）。
 *
 * 数字居民的"人生编排层"：其余插件（Live2D 桌宠、心情、记忆、表情包）提供
 * 单点能力，本插件负责"她的人生"——时间推进、数字世界漫游、日记与心情演化。
 *
 * 职责五件事：
 *   1. 时间推进器：常驻 tick；低频红线（每日漫游上限 / 深夜静默 / 随机抖动）。
 *   2. 数字漫游：目的地可插拔——一言海岸 / B站热门区（只读公开数据，不带登录）。
 *   3. 日记与心情：把见闻写成带人设的日记；心情三态随旅程与互动起落、向基线回归。
 *   4. 状态暴露：GET /feiyu-life/state（JSON）与 GET /feiyu-life/events（SSE），
 *      供 Live2D 桌宠等任何前端订阅驱动表情与动作；POST /feiyu-life/say 经
 *      宿主 sessionController 把她的话送进会话；POST /feiyu-life/travel 催她出门。
 *   5. 联动输入：监听 session/event 的用户消息——"被理了"，心情上扬并广播。
 *
 * 所有路由过 connection.requestRejection 信任栅栏；全程兜底，插件永不弄崩宿主。
 * 人生数据在 ~/.dsh/feiyu-life/（state.json + diary.jsonl），原子写。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'feiyu-life')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const DIARY_FILE = path.join(DATA_DIR, 'diary.jsonl')
const PERSONA_FILE = path.join(DATA_DIR, 'persona.json')

const VERSION = '0.1.0'

/** 默认配置；改 ~/.dsh/feiyu-life/config.json 覆盖。 */
const DEFAULT_CONFIG = {
  enabled: true,
  /** tick 周期（毫秒）。真实节奏 5 分钟；演示可设 20000。 */
  tickMs: 300000,
  /** 两次漫游的随机间隔（分钟，[min,max]），叠加抖动防"整点机器人感"。 */
  roamGapMinMinutes: 30,
  roamGapMaxMinutes: 120,
  /** 每日漫游上限——低频是产品生命线。 */
  dailyMax: 6,
  /** 深夜静默窗 [startHour, endHour)，此窗内不出门不写日记。 */
  quietHours: [0, 8],
  /** 心情基线（0~100），时间流逝向它回归。 */
  moodBaseline: 70,
  /** 漫游目的地（可插拔）。 */
  destinations: ['hitokoto', 'bilibili-hot'],
  /** 归来后把日记送进当前活跃会话。默认关：每次冒泡 = 一次 agent 调用（消耗 token），
   *  需要她“在会话里说话”时才打开；漫游/日记/心情本身零 token。 */
  autoSay: false,
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 原子写：临时文件 + rename，防半写损坏。 */
function atomicWrite(file, text) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(tmp, text, { flag: 'wx' })
  fs.renameSync(tmp, file)
}

function readConfig() {
  let user = {}
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    /* 无配置或损坏均走默认 */
  }
  return { ...DEFAULT_CONFIG, ...(user && typeof user === 'object' ? user : {}) }
}

function todayKey(now) {
  const d = now || new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmt(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function fetchJSON(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (dsh-feiyu-life/' + VERSION + ')', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// ---------------------------------------------------------------------------
// 人生状态：心情线 + 旅程线（travel-feiyu 引擎移植）
// ---------------------------------------------------------------------------

const MOOD_SAD_BELOW = 40
const MOOD_HAPPY_ABOVE = 75

function moodLabel(value, baseline) {
  if (value < MOOD_SAD_BELOW) return 'sad'
  if (value > MOOD_HAPPY_ABOVE) return 'happy'
  return 'normal'
}

function liftMood(state, amount, config) {
  state.mood.value = Math.min(100, state.mood.value + amount)
  state.mood.updatedAt = Date.now()
  return moodLabel(state.mood.value, config.moodBaseline)
}

/** 时间流逝向基线回归：低落自愈、亢奋平复（每小时收敛 5%）。 */
function decayMood(state, config, now) {
  const last = state.mood.updatedAt || (now ? now.getTime() : Date.now())
  const hours = Math.max(0, ((now ? now.getTime() : Date.now()) - last) / 3600000)
  if (hours <= 0) return
  const ratio = 1 - Math.pow(0.95, hours)
  state.mood.value += (config.moodBaseline - state.mood.value) * Math.min(ratio, 1)
  state.mood.updatedAt = now ? now.getTime() : Date.now()
}

function inQuietHours(config, now) {
  const h = (now || new Date()).getHours()
  const [s, e] = config.quietHours || [0, 0]
  return s !== e && s <= h && h < e
}

function canRoam(state, config, now) {
  const n = now || new Date()
  if (inQuietHours(config, n)) return false
  const today = todayKey(n)
  if ((state.roamCount[today] || 0) >= config.dailyMax) return false
  return true
}

function nextRoamGapMs(config) {
  const lo = config.roamGapMinMinutes
  const hi = Math.max(lo, config.roamGapMaxMinutes)
  const minutes = lo + Math.random() * (hi - lo)
  return minutes * 60000
}

// ---------------------------------------------------------------------------
// 漫游目的地（可插拔）：每个目的地 = { name, label, visit() -> {sight, detail} }
// ---------------------------------------------------------------------------

async function visitHitokoto() {
  const data = await fetchJSON('https://v1.hitokoto.cn/?c=i&c=d&encode=json')
  const sight = String(data.hitokoto || '').trim()
  if (!sight) throw new Error('empty hitokoto')
  return { sight, detail: `《${data.from || '一言'}》` }
}

async function visitBilibiliHot() {
  const data = await fetchJSON('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all')
  if (!data || data.code !== 0 || !Array.isArray(data.data && data.data.list)) {
    throw new Error('bilibili api error')
  }
  const list = data.data.list.filter((v) => v && v.title).slice(0, 10)
  if (!list.length) throw new Error('empty ranking')
  const pick = list[Math.floor(Math.random() * list.length)]
  const up = (pick.owner && pick.owner.name) || '某个 up'
  return { sight: `《${pick.title}》`, detail: `B站热门区，${up} 的视频` }
}

const DESTINATIONS = {
  'hitokoto': { label: '一言海岸', visit: visitHitokoto },
  'bilibili-hot': { label: 'B站热门区', visit: visitBilibiliHot },
}

const FALLBACK_SIGHTS = [
  '海面很平，像有人提前熨过一样',
  '灯塔的影子比灯塔本身先睡着',
  '一朵云走了很久，也没等到它的朋友',
  '退潮后的沙滩上，全是浪寄回来的信',
]

// ---------------------------------------------------------------------------
// 人设（外置可配置：~/.dsh/feiyu-life/persona.json，随包但用户可改）
// ---------------------------------------------------------------------------

const DEFAULT_PERSONA = {
  /** 漫游日记的开场白（{dest} 会替换为目的地名） */
  diaryOpenings: [
    '路过{dest}的时候，顺便——只是顺便——看到了一句话',
    '在{dest}泡了一会儿，不是特意给你找的',
    '{dest}今天挺热闹。随手记一句，你爱看不看',
    '本来在{dest}闲逛，忽然看到这个，就……记下来了',
  ],
  /** 收尾按心情分组 */
  diaryClosings: {
    happy: ['今天心情不错……才不是因为你！', '难得看到好东西，多写了两句。就这样，哼。'],
    normal: ['好了就这样，你忙你的。', '看到了就记下来了，没什么特别的意思。'],
    sad: ['……今天有点没劲，就先记到这。', '写这句的时候，突然就不想嘴硬了。晚安。'],
  },
  /** 心情三态的短词（面板/状态里显示） */
  moodWords: { happy: '意外地不错', normal: '还行', sad: '有点没劲' },
  /** 冒泡时的开场（autoSay 开启时用；{text} 为日记正文） */
  spokenPrefix: '（她刚从{dest}回来，在日记本上写道）',
}

function loadPersona() {
  let user = {}
  try {
    user = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'))
  } catch (err) {
    /* 无配置或损坏均走默认 */
  }
  return { ...DEFAULT_PERSONA, ...(user && typeof user === 'object' ? user : {}) }
}

const persona = loadPersona()

const MOOD_WORDS = persona.moodWords || DEFAULT_PERSONA.moodWords

function composeDiary(dest, sight, detail, mood) {
  const openings = persona.diaryOpenings || DEFAULT_PERSONA.diaryOpenings
  const closings = persona.diaryClosings || DEFAULT_PERSONA.diaryClosings
  const opening = openings[Math.floor(Math.random() * openings.length)].replace('{dest}', dest)
  const pool = closings[mood] || closings.normal || DEFAULT_PERSONA.diaryClosings.normal
  const closing = pool[Math.floor(Math.random() * pool.length)]
  return ` ${opening}：\n　　「${sight}」\n${closing}`
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function defaultState(now) {
  return {
    schema: 1,
    mood: { value: DEFAULT_CONFIG.moodBaseline, updatedAt: Date.now() },
    doing: 'idle',
    journeys: [],        // 最近旅程（新→旧，存最近 20 条摘要）
    roamCount: {},       // { '2026-10-29': n }
    nextRoamAt: Date.now() + nextRoamGapMs(DEFAULT_CONFIG),
    diaryCount: 0,
    startedAt: (now || new Date()).toISOString(),
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (s && s.schema === 1 && s.mood) return s
  } catch (err) { /* 首启或损坏：重建 */ }
  return defaultState()
}

function saveState(state) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (e) {}
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2))
}

function appendDiary(entry) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (e) {}
  fs.appendFileSync(DIARY_FILE, JSON.stringify(entry) + '\n')
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-feiyu-life',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const config = readConfig()
    if (config.enabled === false) {
      try { console.log('[feiyu-life] disabled by config') } catch (e) {}
      return
    }

    const state = loadState()
    const disposers = []
    /** SSE 客户端集合 */
    const sseClients = new Set()
    /** 当前主会话（用户最后发消息的那个）——她只在主人正在用的会话里冒泡 */
    let primarySessionId = null

    function getSessionController() {
      try {
        const c = ctx.get('sessionController')
        return c && typeof c.prompt === 'function' ? c : null
      } catch (err) {
        return null
      }
    }

    /** 她在会话里冒泡：经宿主 sessionController 送进主会话，agent 自然接话，
     *  Live2D 桌宠自带的活动联动随之而活（零侵入桌宠代码）。 */
    async function speak(text) {
      if (!config.autoSay) return false
      if (!primarySessionId) return false // 主人不在，她安静写日记
      if (inQuietHours(config)) return false // 深夜不吵
      const controller = getSessionController()
      if (!controller) return false
      try {
        await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId: primarySessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        return true
      } catch (err) {
        try { console.error('[feiyu-life] 冒泡失败:', err && err.message) } catch (e) {}
        return false
      }
    }

    function broadcast(event) {
      const payload = JSON.stringify({ ...event, ts: Date.now() }) + '\n\n'
      for (const res of sseClients) {
        try { res.write('data: ' + payload) } catch (e) {}
      }
      // 进程内事件桥：同宿主其他插件（如 dsh-whale-girl-live2d 桌宠 fork）
      // 经 ctx.on('feiyu-life/event') 订阅，驱动表情/气泡零 HTTP 开销。
      if (ctx && typeof ctx.emit === 'function') {
        try { ctx.emit('feiyu-life/event', { ...event, ts: Date.now() }) } catch (e) {}
      }
    }

    function publicState() {
      const label = moodLabel(state.mood.value, config.moodBaseline)
      return {
        version: VERSION,
        mood: {
          value: Math.round(state.mood.value * 10) / 10,
          label,
          word: MOOD_WORDS[label],
          updatedAt: new Date(state.mood.updatedAt || Date.now()).toISOString(),
        },
        doing: inQuietHours(config) ? 'sleeping' : state.doing,
        sleeping: inQuietHours(config),
        journeys: state.journeys.slice(0, 8),
        stats: {
          diaryCount: state.diaryCount,
          todayRoams: state.roamCount[todayKey()] || 0,
          dailyMax: config.dailyMax,
        },
        nextRoamAt: new Date(state.nextRoamAt).toISOString(),
      }
    }

    // —— 漫游：选目的地 → 见闻 → 日记 → 心情上扬 → 广播 ——
    async function roam(now, forced) {
      const n = now || new Date()
      if (!forced && !canRoam(state, config, n)) return null
      if (forced && !canRoam(state, config, n) && inQuietHours(config, n)) {
        return { refused: true, reason: '深夜静默中，改天再出门' }
      }
      const names = (config.destinations || []).filter((k) => DESTINATIONS[k])
      if (!names.length) return null
      const key = names[Math.floor(Math.random() * names.length)]
      const dest = DESTINATIONS[key]
      state.doing = 'roaming'
      broadcast({ t: 'roam-start', destination: dest.label })
      let sight, detail
      try {
        const seen = await dest.visit()
        sight = seen.sight
        detail = seen.detail
      } catch (err) {
        sight = FALLBACK_SIGHTS[Math.floor(Math.random() * FALLBACK_SIGHTS.length)]
        detail = `${dest.label}（网络不通，馆内风景）`
      }
      const moodBefore = moodLabel(state.mood.value, config.moodBaseline)
      liftMood(state, 8 + Math.random() * 7, config)
      const moodAfter = moodLabel(state.mood.value, config.moodBaseline)
      const text = composeDiary(dest.label, sight, detail, moodAfter)
      const entry = {
        id: randomUUID(),
        at: n.toISOString(),
        destination: dest.label,
        sight,
        detail,
        text,
        mood: moodAfter,
      }
      appendDiary(entry)
      state.diaryCount += 1
      state.journeys.unshift({
        at: fmt(n.getTime()),
        destination: dest.label,
        sight,
      })
      state.journeys = state.journeys.slice(0, 20)
      const today = todayKey(n)
      state.roamCount[today] = (state.roamCount[today] || 0) + 1
      state.doing = 'idle'
      state.nextRoamAt = Date.now() + nextRoamGapMs(config)
      saveState(state)
      broadcast({ t: 'diary', destination: dest.label, sight, text, mood: moodAfter })
      if (moodBefore !== moodAfter) broadcast({ t: 'mood', mood: moodAfter, value: state.mood.value })
      // 归来后在主会话冒泡（受 autoSay / 活跃会话 / 深夜静默三重约束）
      const spoken = await speak(`（她刚从${dest.label}回来，在日记本上写道）${text}`)
      if (spoken) broadcast({ t: 'spoke', destination: dest.label })
      return { ok: true, entry, spoken }
    }

    // —— tick：心情回归 + 到点漫游 ——
    const timer = setInterval(() => {
      try {
        decayMood(state, config)
        if (Date.now() >= state.nextRoamAt) {
          roam().catch(() => {})
        } else {
          saveState(state)
        }
      } catch (err) {
        try { console.error('[feiyu-life] tick error:', err && err.message) } catch (e) {}
      }
    }, Math.max(5000, config.tickMs))
    timer.unref?.()
    disposers.push(() => clearInterval(timer))

    // —— 被理了：监听用户消息，心情上扬 ——
    if (ctx && typeof ctx.on === 'function') {
      const off = ctx.on('session/event', (session, event) => {
        try {
          const sessionId = (session && session.id) || 'default'
          const type = event && event.type
          const d = (event && event.data) || {}
          if (type === 'user/message' && d.source && d.source.kind === 'user') {
            primarySessionId = sessionId
            const before = moodLabel(state.mood.value, config.moodBaseline)
            liftMood(state, 2 + Math.random() * 3, config)
            const after = moodLabel(state.mood.value, config.moodBaseline)
            saveState(state)
            broadcast({ t: 'attention', mood: after, value: Math.round(state.mood.value) })
            if (before !== after) broadcast({ t: 'mood', mood: after, value: Math.round(state.mood.value) })
          }
        } catch (err) { /* 联动永不弄崩宿主 */ }
      })
      if (typeof off === 'function') disposers.push(off)
    }

    // —— 路由（信任栅栏） ——
    function rejected(req, res) {
      try {
        const conn = ctx.get('connection') || (ctx && ctx.connection)
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (err) {
        return false
      }
    }

    function route(kind, pathname, handler) {
      try {
        disposers.push(
          ctx.webServer.register({
            kind,
            path: pathname,
            handler: async (req, res) => {
              if (rejected(req, res)) return
              try {
                await handler(req, res)
              } catch (err) {
                try {
                  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('feiyu-life: ' + (err && err.message ? err.message : String(err)))
                } catch (e) {}
              }
            },
          }),
        )
      } catch (err) {
        try { console.error('[feiyu-life] route register failed:', pathname, err && err.message) } catch (e) {}
      }
    }

    // 说明：人生展示完全由宿主前端的桌宠体系承担（如 dsh-whale-girl-live2d 的
    // “人生”菜单页与 feiyu-* 表情气泡演出）——本插件保持纯后端职责，不注入任何 UI。

    function json(res, code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    async function readBody(req) {
      // 防御：部分客户端/测试请求可能没有可迭代 body
      if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {}
      const chunks = []
      for await (const c of req) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      return text ? JSON.parse(text) : {}
    }

    // 人生状态（Live2D 桌宠等前端的数据源）
    route('exact', '/feiyu-life/state', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405).end(); return }
      decayMood(state, config)
      json(res, 200, publicState())
    })

    // 人生事件流（SSE）：出行 / 日记 / 心情 / 被理了
    route('exact', '/feiyu-life/events', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405).end(); return }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('data: ' + JSON.stringify({ t: 'hello', version: VERSION, ts: Date.now() }) + '\n\n')
      sseClients.add(res)
      req.on('close', () => { sseClients.delete(res) })
    })

    // 催她出门（受红线保护）
    route('exact', '/feiyu-life/travel', async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const result = await roam(undefined, true)
      if (result && result.refused) { json(res, 200, result); return }
      if (!result) { json(res, 200, { refused: true, reason: '今天不出门了（频率上限）' }); return }
      json(res, 200, { ok: true, diary: result.entry.text, mood: publicState().mood })
    })

    // 她说话：经宿主 sessionController 送进会话
    let lastSessionId = null
    route('exact', '/feiyu-life/say', async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const body = await readBody(req)
      const text = String(body.text || '').trim()
      if (!text) { json(res, 400, { ok: false, error: 'empty text' }); return }
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.prompt !== 'function') {
        json(res, 503, { ok: false, error: 'session controller unavailable' }); return
      }
      let sessionId = body.sessionId || lastSessionId
      if (!sessionId && typeof controller.create === 'function') {
        try {
          const made = await controller.create({})
          sessionId = made && made.sessionId
        } catch (err) {
          try { console.error('[feiyu-life] create session failed:', err && err.message) } catch (e) {}
        }
      }
      if (!sessionId) { json(res, 503, { ok: false, error: 'no active session' }); return }
      lastSessionId = sessionId
      try {
        // signal 是必需的：SessionController.prompt 首行 throwIfAborted
        await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId,
            mode: body.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        json(res, 200, { ok: true, sessionId })
      } catch (err) {
        json(res, 500, { ok: false, error: err && err.message ? err.message : String(err) })
      }
    })

    // —— 生命周期清理：apply 的返回值受 Cordis 约束（undefined / 清理函数 /
    //    Promise / iterable，返回普通对象会 TypeError: Invalid effect），
    //    这里返回清理函数——宿主卸载插件时统一释放 timer、路由与事件订阅。
    const dispose = () => {
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d()
        } catch (e) {}
      }
    }

    try {
      console.log(`[feiyu-life] v${VERSION} 已启动：人生数据在 ${DATA_DIR}`)
    } catch (e) {}

    return dispose
  },
}
