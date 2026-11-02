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
| `/feiyu-life/days` | GET | 生活档案目录：有记录的日期列表（first / last） |
| `/feiyu-life/archive` | GET | 生活档案单日：`?date=YYYY-MM-DD` → 当天心情采样 + 日记全文 + 统计 |
| `/feiyu-life/travel` | POST | 催她出门（受红线保护：深夜 / 每日上限都会被拒绝） |
| `/feiyu-life/postcard` | GET | 明信片图片（?id=，生图开启时存在） |
| `/feiyu-life/say` | POST | 她说话：`{"text": "..."}` 经宿主 sessionController 送进会话 |

## 生活档案（v0.2.0）

她把每天过成日记，心情每 30 分钟采样一条（`state.moodSamples`，上限 500 条约 10 天），
`/days` + `/archive` 按天提供完整档案。桌宠的「人生」页签据此做成**可翻阅的生活档案**：
日期导航（◀ ▶ 今天）、当天心情心电图、当天日记全文、最近明信片。

> 实验脚本：`npm run experiment`（或 `node tools/experiment.mjs`）读取 `~/.dsh/feiyu-life/`，
> 输出最近 7 天的《独自生活实验报告》到 `~/.dsh/feiyu-life/experiment/`——
> 包含每日生活表、心情心电图、tick 连续性（采样中断检测）、日记唯一率、
> 每日漫游红线核对，五项验收如实打勾/打叉。

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

## 独立实验宿主（不依赖 DSH）

DSH 的 **desktop profile 没有 webServer 服务**，本插件会因依赖缺失而挂起（web profile 正常）。
做「独自生活」实验时，可不依赖 DSH，直接起一个独立宿主：

```sh
npm run host           # 或 node tools/host.mjs [--port 3099] [--tick 300000]
```

它会内置最小宿主（webServer / connection / sessionController 桩），加载本插件完整运行，
数据仍写 `~/.dsh/feiyu-life/`。随后浏览器可直接打开：

- `http://127.0.0.1:3099/feiyu-life/state`
- `http://127.0.0.1:3099/feiyu-life/days`
- `http://127.0.0.1:3099/feiyu-life/archive?date=YYYY-MM-DD`

> 注意：实验宿主与 DSH 里加载的本插件共用同一份数据目录，**不要同时跑两个实例**（会双写）。

## 测试

```sh
npm run smoke       # 或 node tools/smoke.mjs —— mock 宿主全链路演练（30 项）
npm run experiment  # 生活实验报告：最近 7 天验收（tick 连续性 / 心情波动 / 日记质量 / 红线）
npm run host        # 独立实验宿主（无 DSH 也能让她活着，附 HTTP 档案 API）
```

## License

MIT
