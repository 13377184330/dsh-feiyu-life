# dsh-feiyu-life · 大肥鱼人生引擎

> 数字居民的"人生编排层"插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
> 她自己在数字世界漫游、写日记、心情起落——其余插件（Live2D 桌宠、表情包、挂件）消费她的人生状态。

## 她的人生

```
时间推进器（低频红线：每日上限 / 深夜静默 / 随机抖动）
    └─ 数字漫游（目的地可插拔：一言海岸 / B站热门区，只读公开数据）
        └─ 日记（傲娇人设词库，收尾按心情分组）
            └─ 心情线（三态 0~100：漫游 +8~15 · 被理了 +2~5 · 向基线回归）
                └─ 状态暴露（JSON API + SSE 事件流 → 驱动 Live2D 表情等任何前端）
```

生态分工：本插件管"她的人生"；`dsh-whale-girl-live2d` 等桌宠插件管"她的身体"——
桌宠订阅本插件的事件流即可让表情与动作跟随真实生活状态。

## 安装（本地开发）

```sh
dsh plugin --profile web add "link:D:/teleagent_workspace/travel-feiyu/dsh-feiyu-life"
```

从 GitHub 安装：

```sh
dsh plugin --profile web add github:<你的用户名>/dsh-feiyu-life
```

## API（均过 DSH 信任栅栏）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/feiyu-life/state` | GET | 人生状态 JSON（mood / doing / journeys / postcards / stats） |
| `/feiyu-life/events` | GET | SSE 事件流：roam-start / diary / mood / attention / postcard / qq-sent |
| `/feiyu-life/travel` | POST | 催她出门（受红线保护，深夜/超限会被拒绝） |
| `/feiyu-life/postcard` | GET | 明信片图片（?id=，生图开启时存在） |
| `/feiyu-life/say` | POST | 她说话：`{"text": "..."}` 经宿主 sessionController 送进会话 |

## 配置 `~/.dsh/feiyu-life/config.json`

```json
{
  "tickMs": 300000,
  "roamGapMinMinutes": 30,
  "roamGapMaxMinutes": 120,
  "dailyMax": 6,
  "quietHours": [0, 8],
  "destinations": ["hitokoto", "bilibili-hot"],
  "autoSay": false,
  "postcard": {
    "enabled": false,
    "backend": "ark",
    "baseUrl": "",
    "model": "doubao-seedream-5-0-flash-260915",
    "size": "2K",
    "apiKey": ""
  },
  "qq": {
    "enabled": false,
    "httpUrl": "http://127.0.0.1:3000",
    "token": "",
    "groups": []
  }
}
```

- **autoSay**（默认关）：归来把日记送进当前会话 → agent 接话 → 桌宠活动联动。每次冒泡 = 一次 agent 调用（消耗 token）；漫游/日记/心情本身零 token。
- **postcard**（默认关）：归来生成水彩明信片图（存 `~/.dsh/feiyu-life/postcards/`，借 Travel-Fish 的场景与画风设定，协议 ark/compatible 兼容）。每张图约 ¥0.12 量级，需自行填入 API Key；失败静默回退纯文本。
- **qq**（默认关）：归来把见闻发到 QQ 群，走 NapCat 的 OneBot v11 HTTP（`send_group_msg`）。频率受 dailyMax 红线封顶、深夜静默窗不发。
- 人设词库：`~/.dsh/feiyu-life/persona.json`（开场白/收尾/心情词，随包默认可改）

演示节奏：`tickMs` 调到 20000、`dailyMax` 调大即可看到高频人生流。
人生数据（重启不丢）：`~/.dsh/feiyu-life/`（state.json / diary.jsonl / postcards/）。

## 测试

```sh
npm run smoke   # 或 node tools/smoke.mjs —— mock 宿主全链路演练
```

## License

MIT
