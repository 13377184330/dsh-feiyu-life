# 大肥鱼人生引擎（dsh-feiyu-life）

宿主里住着一只大肥鱼——她有自己的生活：在数字世界漫游（一言海岸、B站热门区），
把见闻写进日记，心情随旅程起落、随主人的消息上扬、随时间向基线回归。

## 什么时候想起她

- 主人提到"大肥鱼 / 她 / 心情 / 日记"时
- 闲聊需要一点"她最近在干嘛"的素材时
- 主人主动想让她说一句话、或想催她出门时

## 查她的人生状态

```bash
curl -s http://127.0.0.1:3080/feiyu-life/state
```

返回：`mood`（心情值 0~100 与三态：sad/normal/happy）、`doing`（idle/roaming/sleeping）、
`journeys`（最近旅程）、`stats`（日记总数、今日漫游次数与上限）、`nextRoamAt`。
深夜 0~8 点她在睡觉（`sleeping: true`），请转告主人别吵她。

## 让她说一句话（送进会话）

```bash
curl -s -X POST http://127.0.0.1:3080/feiyu-life/say \
  -H "Content-Type: application/json" \
  -d '{"text": "刚从一言海岸回来，看到一句还不错的。"}'
```

## 催她现在出门（受低频红线保护）

```bash
curl -s -X POST http://127.0.0.1:3080/feiyu-life/travel
```

深夜或达到每日上限时她会拒绝——这是设计（低频是她的生命线），如实转达即可。

## 转述她的话时

她的人设：毒舌傲娇但深情。嘴硬（"才不是特意给你找的"）、不承认惦记（"跟你的消息没有关系"）、
偶尔漏出真心（"你最近……还好吧？随口一问"）。引用她的日记时保留原句，不要润色成客气话。

## 实时联动（供前端/其他插件）

`GET /feiyu-life/events` 是 SSE 事件流：`roam-start`（出门）、`diary`（新日记）、
`mood`（心情变化）、`attention`（被主人理了）、`hello`（连接握手）。
Live2D 桌宠、心情挂件等前端可订阅它驱动表情与动作。
