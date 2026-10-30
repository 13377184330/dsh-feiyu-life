/**
 * dsh-feiyu-life · 人生面板（左下角“她的窝”）
 *
 * 她的可见载体：心情表情 + 实时日记流 + 状态，零依赖零 token。
 * 注入方式：由插件经 webserver/index-inject 挂进 DSH Web/Desktop UI，
 * 以 fixed 浮窗呈现，不随宿主布局。样式全部内联，无外部依赖。
 */
(function () {
  'use strict'
  if (window.__FEIYU_PANEL_LOADED__) return
  window.__FEIYU_PANEL_LOADED__ = true

  const MOOD_EMOJI = { happy: '🥰', normal: '🙂', sad: '😔', sleep: '😴' }
  const MOOD_WORD = { happy: '意外地不错', normal: '还行', sad: '有点没劲', sleep: '睡着了' }

  const root = document.createElement('div')
  root.id = 'feiyu-life-panel'
  root.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
    'width:260px', 'background:rgba(20,22,45,.88)', 'backdrop-filter:blur(10px)',
    'border:1px solid rgba(255,215,102,.35)', 'border-radius:16px',
    'box-shadow:0 10px 30px rgba(0,0,0,.5)', 'color:#eef4ff',
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif',
    'overflow:hidden', 'transition:opacity .25s ease',
  ].join(';')

  const head = document.createElement('div')
  head.style.cssText = 'padding:10px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;'
  head.innerHTML =
    '<span id="feiyu-mood-emoji" style="font-size:18px">🙂</span>' +
    '<span id="feiyu-mood-label" style="font-weight:600;font-size:13px">大肥鱼</span>' +
    '<span id="feiyu-status" style="font-size:11px;opacity:.75;margin-left:auto">…</span>'

  const body = document.createElement('div')
  body.style.cssText = 'padding:0 14px 12px;display:none;'
  body.innerHTML =
    '<div id="feiyu-life-text" style="font-size:12px;line-height:1.9;opacity:.92;white-space:pre-wrap;max-height:200px;overflow-y:auto;border-top:1px dashed rgba(255,255,255,.18);padding-top:8px;"></div>'

  root.appendChild(head)
  root.appendChild(body)
  document.body.appendChild(root)

  let collapsed = true
  const el = (id) => document.getElementById(id)

  head.addEventListener('click', () => {
    collapsed = !collapsed
    body.style.display = collapsed ? 'none' : 'block'
    if (!collapsed) fetchState()
  })

  function render(s) {
    if (!s) return
    const mood = s.mood || {}
    const sleeping = s.sleeping
    const label = sleeping ? 'sleep' : mood.label
    el('feiyu-mood-emoji').textContent = MOOD_EMOJI[label] || '🙂'
    el('feiyu-mood-label').textContent = '大肥鱼 · ' + (MOOD_WORD[label] || label)
    el('feiyu-status').textContent = sleeping ? '🌙 睡着' : (s.doing === 'roaming' ? '🏖️ 出门了' : (mood.word || '还行'))
    const last = (s.journeys && s.journeys[0]) || null
    el('feiyu-life-text').textContent = last
      ? `${last.at} · ${last.destination}\n「${last.sight}」\n\n— 已写 ${s.stats.diaryCount} 篇日记 · 今日漫游 ${s.stats.todayRoams}/${s.stats.dailyMax}`
      : '还没有日记。她正在数字世界里闲逛。'
  }

  async function fetchState() {
    try {
      const r = await fetch('/feiyu-life/state')
      render(await r.json())
    } catch (e) {}
  }

  // SSE：她的生活实时进来
  try {
    const ev = new EventSource('/feiyu-life/events')
    ev.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.t === 'diary') {
          el('feiyu-mood-emoji').textContent = MOOD_EMOJI[d.mood] || '📮'
          el('feiyu-status').textContent = '✉️ 刚写日记'
          el('feiyu-life-text').textContent = `${d.destination}\n「${d.sight}」\n${d.text}`
          root.style.opacity = 0.95
          setTimeout(() => { root.style.opacity = 1 }, 2600)
        } else if (d.t === 'attention') {
          el('feiyu-mood-emoji').textContent = MOOD_EMOJI[d.mood] || '🥰'
          el('feiyu-status').textContent = '被理了'
        } else if (d.t === 'roam-start') {
          el('feiyu-status').textContent = '🏖️ 出门去' + d.destination + '…'
        }
      } catch (err) {}
    }
  } catch (err) {}

  fetchState()
})()