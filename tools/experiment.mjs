/**
 * dsh-feiyu-life 生活实验记录与验收脚本（零依赖）
 *
 * 跑法：node tools/experiment.mjs [--days 7] [--out <dir>]
 * 读取：~/.dsh/feiyu-life/（state.json / diary.jsonl / config.json）
 * 输出：终端摘要 + markdown 报告（默认 ~/.dsh/feiyu-life/experiment/report-YYYY-MM-DD.md）
 *
 * 验收五项（如实打勾/打叉，不美化）：
 *   1. tick 连续性 —— 心情采样相邻间隔 > 90 分钟记一次中断
 *   2. 每日产出   —— 窗口内有日记产出
 *   3. 心情波动   —— 采样标准差 > 1（全平 = 心情系统缺陷）
 *   4. 日记质量   —— 唯一正文占比 ≥ 90%
 *   5. 红线       —— 每日漫游不超 dailyMax
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const DAYS = Math.max(1, parseInt(argValue('--days', '7'), 10) || 7)
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'feiyu-life')
const OUT_DIR = argValue('--out', path.join(DATA_DIR, 'experiment'))

const p2 = (n) => String(n).padStart(2, '0')
const dateKey = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
const fmtHM = (iso) => {
  const d = new Date(iso)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// —— 读数据 ——
let state = {}
try {
  state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'))
} catch (e) { /* 首启 */ }
const diary = []
try {
  const text = fs.readFileSync(path.join(DATA_DIR, 'diary.jsonl'), 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { diary.push(JSON.parse(line)) } catch (e) { /* 跳过坏行 */ }
  }
} catch (e) { /* 还没写过日记 */ }

const samplesAll = Array.isArray(state.moodSamples) ? state.moodSamples : []
if (!diary.length && !samplesAll.length) {
  console.error('没有实验数据：' + DATA_DIR)
  process.exit(1)
}

// —— 实验窗口：最近 DAYS 天（含今天） ——
const now = new Date()
const windowStart = new Date(now)
windowStart.setDate(windowStart.getDate() - (DAYS - 1))
windowStart.setHours(0, 0, 0, 0)
const inWindow = (iso) => {
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && t >= windowStart.getTime()
}

const diaryIn = diary.filter((e) => e.at && inWindow(e.at)).sort((a, b) => new Date(a.at) - new Date(b.at))
const samples = samplesAll.filter((m) => m.at && inWindow(m.at)).sort((a, b) => new Date(a.at) - new Date(b.at))

// —— 按天分组 ——
const dayMap = new Map()
for (const e of diaryIn) {
  const k = dateKey(e.at)
  if (!dayMap.has(k)) dayMap.set(k, [])
  dayMap.get(k).push(e)
}

// —— 心情统计 ——
const vals = samples.map((m) => m.value)
const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
const stddev = vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) : 0
const moodMin = vals.length ? Math.min(...vals) : null
const moodMax = vals.length ? Math.max(...vals) : null

// —— 中断检测：相邻采样 > 90 分钟 ——
const GAP_MS = 90 * 60 * 1000
const gaps = []
for (let i = 1; i < samples.length; i++) {
  const gap = new Date(samples[i].at) - new Date(samples[i - 1].at)
  if (gap > GAP_MS) gaps.push({ from: samples[i - 1].at, to: samples[i].at, minutes: Math.round(gap / 60000) })
}
const coveredMinutes = samples.length > 1
  ? Math.round((new Date(samples[samples.length - 1].at) - new Date(samples[0].at)) / 60000)
  : 0
const gapMinutes = gaps.reduce((s, g) => s + g.minutes, 0)
const coverage = coveredMinutes > 0 ? Math.max(0, 1 - gapMinutes / coveredMinutes) : 0

// —— 日记质量 ——
const uniqueText = new Set(diaryIn.map((e) => String(e.text || '').replace(/\s+/g, '').trim()))
const uniqueRate = diaryIn.length ? uniqueText.size / diaryIn.length : 0
const destCount = {}
for (const e of diaryIn) destCount[e.destination] = (destCount[e.destination] || 0) + 1
const moodTags = {}
for (const e of diaryIn) moodTags[e.mood] = (moodTags[e.mood] || 0) + 1

// —— 红线：每日漫游 vs dailyMax ——
function readConfigDailyMax() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'))
    return typeof cfg.dailyMax === 'number' ? cfg.dailyMax : 6
  } catch (e) {
    return 6
  }
}
const dailyMax = readConfigDailyMax()
const overLimitDays = []
if (state.roamCount) {
  for (const [k, n] of Object.entries(state.roamCount)) {
    if (inWindow(k + 'T12:00:00') && n > dailyMax) overLimitDays.push({ day: k, count: n, max: dailyMax })
  }
}

// —— 验收 ——
const checks = []
checks.push({
  name: 'tick 连续性（估算覆盖率 ≥ 70%）',
  ok: samples.length >= 2 && coverage >= 0.7,
  detail: samples.length >= 2
    ? `覆盖率 ${(coverage * 100).toFixed(1)}% · 中断 ${gaps.length} 段`
    : '无采样数据（v0.2.0 起才会记录）',
})
const runDays = new Set(diaryIn.map((e) => dateKey(e.at)))
checks.push({
  name: '每日产出（有活动的日子日记 ≥ 1）',
  ok: diaryIn.length > 0,
  detail: `${diaryIn.length} 篇 / ${runDays.size} 天`,
})
checks.push({
  name: '心情有波动（标准差 > 1）',
  ok: stddev > 1,
  detail: samples.length ? `stddev=${stddev.toFixed(2)}（${moodMin}~${moodMax}）` : '无采样数据',
})
checks.push({
  name: '日记不重复（唯一正文 ≥ 90%）',
  ok: uniqueRate >= 0.9,
  detail: `唯一率 ${(uniqueRate * 100).toFixed(1)}%（${uniqueText.size}/${diaryIn.length}）`,
})
checks.push({
  name: '红线守住（每日漫游 ≤ dailyMax）',
  ok: overLimitDays.length === 0,
  detail: overLimitDays.length
    ? overLimitDays.map((d) => `${d.day} 超 ${d.count - d.max} 次`).join('；')
    : '无超限',
})

// —— 报告 ——
const report = []
report.push('# 大肥鱼「独自生活」实验报告')
report.push('')
report.push(`- 生成时间：${now.toLocaleString('zh-CN')}`)
report.push(`- 实验窗口：最近 ${DAYS} 天（${dateKey(windowStart.toISOString())} → ${dateKey(now.toISOString())}）`)
report.push(`- 数据目录：${DATA_DIR}`)
report.push('')
report.push('## 一、每日生活')
report.push('')
report.push('| 日期 | 日记 | 心情标签 | 目的地 |')
report.push('|---|---|---|---|')
for (let i = 0; i < DAYS; i++) {
  const d = new Date(now)
  d.setDate(d.getDate() - (DAYS - 1 - i))
  const k = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  const list = dayMap.get(k) || []
  const tags = {}
  const dests = {}
  for (const e of list) {
    tags[e.mood] = (tags[e.mood] || 0) + 1
    dests[e.destination] = (dests[e.destination] || 0) + 1
  }
  report.push(
    `| ${k} | ${list.length} 篇 | ${Object.entries(tags).map(([m, n]) => `${m}×${n}`).join(' ') || '—'} | ${Object.entries(dests).map(([m, n]) => `${m}×${n}`).join(' ') || '—'} |`,
  )
}
report.push('')
report.push('## 二、心情心电图')
report.push('')
if (samples.length) {
  report.push(`- 采样 ${samples.length} 条（30 分钟一条）`)
  report.push(`- 范围 ${moodMin} ~ ${moodMax} · 均值 ${mean.toFixed(1)} · 标准差 ${stddev.toFixed(2)}`)
  report.push(`- 结论：${stddev > 1 ? '有波动' : '**几乎没有波动——心情系统需要审视（漫游涨幅 / 回归速度 / 缺少负向事件）**'}`)
} else {
  report.push('- 暂无心情采样（v0.2.0 起记录）')
}
report.push('')
report.push('## 三、tick 连续性')
report.push('')
if (samples.length >= 2) {
  report.push(`- 采样跨度 ${coveredMinutes} 分钟 · 中断 ${gaps.length} 段、共 ${gapMinutes} 分钟`)
  for (const g of gaps.slice(0, 20)) {
    report.push(`  - ${fmtHM(g.from)} → ${fmtHM(g.to)}（${g.minutes} 分钟，可能是 DSH 未运行）`)
  }
  if (gaps.length > 20) report.push(`  - ……其余 ${gaps.length - 20} 段略`)
  report.push(`- 覆盖估计：${(coverage * 100).toFixed(1)}%（DSH 实际运行时间占比的近似）`)
} else {
  report.push('- 采样不足，无法评估')
}
report.push('')
report.push('## 四、日记质量')
report.push('')
report.push(`- 总篇数：${diaryIn.length}`)
report.push(`- 唯一正文率：${(uniqueRate * 100).toFixed(1)}%（${uniqueText.size}/${diaryIn.length}）`)
report.push(`- 目的地分布：${Object.entries(destCount).map(([k, n]) => `${k}×${n}`).join(' · ') || '—'}`)
report.push(`- 心情标签分布：${Object.entries(moodTags).map(([k, n]) => `${k}×${n}`).join(' · ') || '—'}`)
report.push('')
report.push('## 五、验收结论')
report.push('')
for (const c of checks) {
  report.push(`- [${c.ok ? 'x' : ' '}] ${c.name} —— ${c.detail}`)
}
report.push('')
report.push('## 六、自动发现的问题')
report.push('')
const problems = []
if (stddev <= 1 && samples.length > 2) {
  problems.push('- 心情曲线几乎水平：漫游 +8~15 且每日多次，基线回归 5%/h 追不上，可能永远停在 happy')
}
if (overLimitDays.length) {
  problems.push('- 存在每日漫游超过 dailyMax 的日子（旧版 forced 绕过上限的 bug，v0.2.0 已修）')
}
if (uniqueRate < 0.9) {
  problems.push('- 日记正文重复率偏高：人设词库 / 目的地样本不够宽')
}
if (coverage < 0.7 && samples.length >= 2) {
  problems.push('- tick 覆盖率偏低：DSH 未长时间运行（实验环境问题，不是引擎问题）')
}
if (!problems.length) problems.push('- 无')
report.push(problems.join('\n'))

fs.mkdirSync(OUT_DIR, { recursive: true })
const outFile = path.join(OUT_DIR, `report-${dateKey(now.toISOString())}.md`)
fs.writeFileSync(outFile, report.join('\n') + '\n', 'utf8')

// —— 终端摘要 ——
console.log('大肥鱼「独自生活」实验报告')
console.log(`窗口 ${DAYS} 天 · 日记 ${diaryIn.length} 篇 · 心情采样 ${samples.length} 条`)
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'WARN'}  ${c.name} —— ${c.detail}`)
console.log('报告已写入：' + outFile)