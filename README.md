# dsh-quota-ring

[![License: MIT](https://img.shields.io/badge/license-MIT-16a34a.svg)](./LICENSE)
![DSH](https://img.shields.io/badge/DSH-Web%20UI%20plugin-2563eb.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)

DSH Web UI 插件。在右下角放一个圆环，汇总 DeepSeek、GPT (Codex)、Gemini 三家账号的额度；点开是明细卡片。

圆环的环形进度取「所有百分比窗口中剩余最少的一个」，点开可看到三家的剩余、已用、重置倒计时，以及 DeepSeek 的峰谷时段和今日消耗。默认 10 分钟轮询，带防抖与失焦降频；任一家凭据过期或请求失败只影响自己那一行。

![额度卡片](preview/card-final.png)

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [界面](#界面)
- [取数机制](#取数机制)
- [配置参数](#配置参数)
- [HTTP API](#http-api)
- [轮询与请求保护](#轮询与请求保护)
- [降级与错误状态](#降级与错误状态)
- [隐私与安全](#隐私与安全)
- [目录结构](#目录结构)
- [开发与自测](#开发与自测)
- [已知限制](#已知限制)
- [排障](#排障)
- [实现约束（改代码前必读）](#实现约束改代码前必读)
- [License](#license)

---

## 功能

- **悬浮圆环**：环形进度 = 所有百分比窗口里剩余最少的一个；中心数字与之一致，无百分比数据时显示 `¥`（有金额）或 `!`（有错误）。点击展开/折叠卡片。
- **三家同屏**：DeepSeek 的剩余/已用/今日消耗/峰谷条；GPT 的两个速率窗口；Gemini 的三个额度池共五个窗口，各带重置倒计时。
- **DeepSeek 峰谷条**：当日切成 15 分钟片段，橙=高峰、蓝=平价，深色竖线标出此刻，右侧配文「平价 · 11 小时 53 分后进入高峰」。
- **DeepSeek 今日消耗**：官方无按天数据，插件按余额差自行记账，可识别中途充值，跨重启延续、跨天归档。
- **单家降级**：三家并发、各自超时、各自兜底，一家失败不影响另外两家。
- **三重请求保护**：服务端缓存 + 手动防抖与限流 + 失焦降频或暂停。
- **只读、无外传**：仅读取本机 DSH 凭据，只向三个官方域名发请求；不落盘密文、不打印密钥、无遥测。
- **无前端框架依赖**：客户端为单文件纯 DOM 实现，不依赖 React / react-dom。

## 安装

### 方式一：由 DSH 安装

```bash
dsh plugin --profile web add https://github.com/j352201657-debug/dsh-quota-ring
```

### 方式二：手动放入 profile

1）把本目录复制到 profile 的 `node_modules` 下。目录名必须与 `package.json` 的 `name` 一致，否则 cordis 解析不到：

```powershell
$profile = "D:\DSHData\.dsh\profiles\desktop"   # 替换为实际 profile 路径
Copy-Item -Recurse -Force .\dsh-quota-ring "$profile\node_modules\dsh-quota-ring"
```

2）在 `$profile/package.json` 的 `dependencies` 中加入：

```json
"dsh-quota-ring": "file:./node_modules/dsh-quota-ring"
```

3）把本包的 `cordis.patch.yml` 追加到 `$profile/cordis.patch.yml`：

```yaml
- insert:
    - id: quota-hub
      name: 'dsh-quota-ring'
      config:
        refreshIntervalMs: 600000
        idleMultiplier: 3
        pauseWhenHidden: false
        dshHome: ''
        dshWebPort: 0
        proxy: ''
        serverCacheTtlMs: 60000
        requestTimeoutMs: 15000
        corsOrigins:
          - 'http://127.0.0.1'
          - 'http://localhost'
        deepseekPeakWindows: null
        deepseekPeakHolidays: null
```

4）重启 DSH。客户端 bundle 只在启动时加载。

首次加载约 2~5 秒（三家并发，Gemini 首次需读凭据管理器并建立 TLS 连接），之后由 60 秒缓存承接。

配置项写全是有意的：`cordis.patch.yml` 的覆盖不是深合并，漏写的字段会被抹掉（插件内部仍会归一化兜底）。

### 运行前提

插件不读取 API Key，读的是 DSH 里的登录态。下列条件缺哪一项，就只缺对应那一行：

| 依赖 | 提供什么 | 缺失时的表现 |
|---|---|---|
| DSH 桌面版（含 Web UI 与 `webServer`） | 插件宿主、`/api/quota-hub/*` 路由、`window.__ModuleLoader__` | 插件不加载 |
| `dsh-codex-subscription` 且已登录 | GPT (Codex) 的 OAuth 凭据（记录 `codex-subscription/accounts`） | GPT 行显示「未登录」 |
| `dsh-agy-cli` 且执行过一次 `agy` 登录 | Gemini 额度（凭据管理器 `gemini:antigravity`，回退接口 `/plugins/agy-cli/status`） | Gemini 行显示「不可用」 |
| DeepSeek 账号登录态（DSH 内置 `dsh-deepseek-account-platform`） | 余额与累计消费（记录 `deepseek-account-platform/default`） | DeepSeek 行显示「未登录」 |
| Node.js ≥ 18 | 运行时（无第三方依赖） | 服务端不启动 |

GPT 与 Gemini 的取数分别依赖 `dsh-codex-subscription` 与 `dsh-agy-cli`；这两个插件的凭据记录名若不同，需调整 `src/credentials.js`、`src/adapters/agy.js` 中的读取路径。DeepSeek 走 DSH 内置实现，无需额外安装。

### 跨机器行为

| 事项 | 处理方式 |
|---|---|
| DSH 数据目录不是 `D:\DSHData\.dsh` | `dshHome` 留空即可：依次试 `DSH_HOME` / `DSH_DATA_DIR` → 从插件安装路径逐级上溯查找 `.credentials.yaml` → `D:\DSHData\.dsh` → `~/.dsh` |
| Web 端口每次重启变化 | 不写死，从请求 `Host` 头推断（`dshWebPort: 0`） |
| 用户名与家目录不同 | 全程使用 `os.homedir()` 与相对路径，代码内无绝对路径、无用户名 |
| 代理配置不同或不走代理 | `proxy` 留空时依次探测环境变量 → Windows 注册表 → 直连，也可显式指定 |
| DSH 升级后凭据记录名变化 | 精确匹配失败时按模糊规则匹配（名字含 `deepseek` / `codex` 且块内含 `token` / `access`） |

### 自检接口

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/quota-hub/diag | ConvertTo-Json -Depth 6
```

返回值覆盖四类信息：凭据文件是否找到（`credentialsFile`、`triedHomes`）、两家账号记录是否解析成功（`deepseek.ok`、`codex.ok`、`codex.expired`）、两个依赖插件是否安装及版本（`plugins[]`）、当前平台的降级项（`runtime`）。`tips` 给出下一步动作。该接口不发起网络请求，不回显任何密文。

### 卸载

删除 `$profile/node_modules/dsh-quota-ring`、`package.json` 中的依赖行、`cordis.patch.yml` 中的 `- insert:` 块，重启 DSH。

## 界面

### 圆环

- 固定在右下角，距边 24px，直径 52px，SVG 环形进度。
- 环形长度 = 所有百分比窗口中剩余最少者。
- 颜色分档：`>60%` 绿 `#16a34a`、`≤60%` 黄 `#ca8a04`、`≤30%` 橙 `#ea580c`、`≤10%` 红 `#dc2626`、未知为灰。
- 中心数字为该百分比；无百分比数据时显示 `¥`（有金额）或 `!`（有错误）。

### 卡片

| 平台 | 内容 |
|---|---|
| DeepSeek | 剩余 / 已用（金额）→ 今日消耗 → 峰谷时间条（橙=高峰、蓝=平价、深色竖线=此刻）+ 阶段与倒计时文案 |
| GPT (Codex) | 5 小时窗口、周窗口：进度条 + 剩余百分比 + 「N 小时 M 分后重置」 |
| Gemini | 三个额度池分组（Gemini 模型 / Claude 与 GPT 模型 / Gemini 4 Argon），每组按 5 小时与每周窗口分行 |
| 底部总览 | 「可用余额 ¥15.03（DeepSeek）」「最紧窗口 49% 剩余（GPT (Codex) · 5小时窗口）」，两条独立结论 |

### 配色与文案规则

- **白底黑字**：底色 `#ffffff`，主文案 `#111827`，次文案 `#6b7280`，进度条底 `#e9edf2`，分隔线 `#eef1f4`。强调色统一取 600 档（`#16a34a` / `#ca8a04` / `#ea580c` / `#dc2626`），400 档在浅底上对比度不足。
- **不渲染解释性文字**：上游返回的说明字段、`数据源：…`、`登录态剩余约…` 等内部信息不上界面；`provider.notes` 中仅以 `⚠` 开头的告警会被渲染。

## 取数机制

| 平台 | DSH 内置实现 | 本插件取数方式 | 额度形态 |
|---|---|---|---|
| **DeepSeek** | `dsh-deepseek-account-platform` | 读 `.credentials.yaml` 中的 grant token，请求<br>`GET https://platform.deepseek.com/api/v0/users/get_user_summary`<br>请求头 `x-dsh-auth-token` | **金额**（CNY/USD），有剩余也有已用 |
| **GPT** | `dsh-codex-subscription` | 读 `.credentials.yaml` 中的 OAuth access token，请求<br>`GET https://chatgpt.com/backend-api/wham/usage`<br>请求头 `authorization: Bearer <access>`、`chatgpt-account-id` | **百分比速率窗口**，5 小时 + 每周 |
| **Gemini** | `dsh-agy-cli`（驱动 Antigravity CLI） | 首选：读凭据管理器 `gemini:antigravity` 中的只读令牌，请求<br>`POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`<br>失败时回退 `GET http://127.0.0.1:<DSH端口>/plugins/agy-cli/status` | **百分比速率窗口**，三个额度池共五个窗口 |

DSH 没有统一的额度查询入口，三家的额度分散在三个内置实现的私有 RPC 中。插件直接请求它们所调用的同一批上游端点，语义与数据源一致，也不受 DSH 内部 RPC 协议变动影响。

### Gemini 的额度池结构

Antigravity 上报的是三个 group、五个 bucket：

| 额度池 | 每周 | 5 小时 |
|---|---|---|
| Gemini 模型（Gemini Flash / Pro） | `gemini-weekly` | `gemini-5h` |
| Claude 与 GPT 模型 | `3p-weekly` | `3p-5h` |
| Gemini 4 Argon | `gemini-argon-wtu-weekly` | 无 |

`dsh-agy-cli` 会把它们压平成 `google` / `anthropic` / `openai` 三个 family 再对外暴露，其循环写法是「后出现的 group 覆盖前面的」：`Gemini 4 Argon` 只有周额度，会覆盖掉 `Gemini Models` 的 `gemini-5h`，因此 `/status` 中的 `google.fiveHourUnknown` 恒为 `true`。

额度本身一直在，是传递过程中被丢弃的。插件因此直接读原始接口、按 group 原样渲染；只有在拿不到令牌、令牌过期或接口失败时才回退到压平数据，并在附注中标明来源。

### DeepSeek 峰谷时段

| 项 | 规则 |
|---|---|
| 峰时段 | **UTC** `01:00–04:00`、`06:00–10:00`，即北京时间 09:00–12:00、14:00–18:00 |
| 周末 | 北京时间周六、周日全天平价 |
| 节假日 | 中国公众假期全天平价（内置 2026 年安排，可覆盖） |
| 优先级 | 周末 / 节假日优先于峰窗口 |
| 生效起点 | `2026-08-16T16:00:00Z` 之前不分峰谷 |

卡片上把当日 00:00–24:00 切成 15 分钟片段后合并同相位，绘制成时间条，深色竖线为当前时刻。

### DeepSeek 今日消耗

DeepSeek 未提供「今日消耗」字段，只有当前余额与累计消费，因此插件按天记账：

```
今日消耗 = 今日起始余额 + 今日充值 − 当前余额
```

- 每次取得余额与上一次比较：减少记为消耗，增加记为充值，中途充值不会产生负的消耗。
- 状态存于 `$DSH_HOME/dsh-quota-ring/usage-state.json`，重启后延续计算；跨天归档，保留 30 天。
- 首次安装时，若 DSH 的 `.dshw-usage.json` 含当日记录，则以其为起点。
- 记账起点不是当日零点时，界面标注「（自 20:11 起）」，不把部分数据当全天数据呈现。

### 语义边界

三家额度语义不同，插件不做混合：

- DeepSeek 是**金额**：剩余 17.02 CNY、累计消费 168.98 CNY。
- GPT / Gemini 是**百分比速率窗口**：剩余 60%、98.59%，到点重置。

底部总览因此给出两条独立结论，而不是一个合计值。插件不做汇率折算——把「剩 60%」换算成美元属于伪精度。

上游未上报某个窗口时（Gemini 的 `fiveHourUnknown`，或 bucket 标记 `disabled`），显示**「未知」**配灰色空进度条，不填 100%：已耗尽的账号显示「100% 剩余」是最严重的误导。

## 配置参数

配置写在 profile `cordis.patch.yml` 中本插件的 `config` 下。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `refreshIntervalMs` | number | `600000` | 客户端轮询周期（毫秒），最小 5000 |
| `idleMultiplier` | number | `3` | 失焦降频倍数，失焦时周期 = `refreshIntervalMs × idleMultiplier` |
| `pauseWhenHidden` | boolean | `false` | `true` 表示页面隐藏时暂停轮询，恢复可见立即刷新一次；`false` 仅降频 |
| `dshHome` | string | `''` | DSH 数据目录（含 `.credentials.yaml`），留空自动探测 |
| `dshWebPort` | number | `0` | 访问 agy-cli 用端口。`0` 表示从请求 Host 头推断（推荐，端口每次重启可能变化） |
| `proxy` | string | `''` | 代理地址，如 `http://127.0.0.1:12450`，留空自动探测 |
| `serverCacheTtlMs` | number | `60000` | 服务端聚合缓存 TTL（毫秒），`0` 关闭缓存 |
| `requestTimeoutMs` | number | `15000` | 单家请求超时（毫秒），只影响该家 |
| `corsOrigins` | string[] | `['http://127.0.0.1','http://localhost']` | CORS 白名单，回环地址任意端口另外无条件放行 |
| `deepseekPeakWindows` | array \| null | `null` | 峰时段覆盖（UTC 小时，半开区间 `[start,end)`）；`null` 时用 `[{start:1,end:4},{start:6,end:10}]` |
| `deepseekPeakHolidays` | string[] \| null | `null` | 公众假期覆盖（如 `'2026-10-01'`）；`null` 时用内置 2026 年安排 |

### 凭据目录探测顺序（`dshHome` 留空时）

1. 从插件安装路径逐级上溯，查找含 `.credentials.yaml` 的目录
2. 环境变量 `DSH_HOME`
3. 环境变量 `DSH_DATA_DIR`
4. `D:\DSHData\.dsh`
5. `~/.dsh`

取第一个存在 `.credentials.yaml` 的目录。插件只读不写，不打印密文。

### 代理探测顺序（`proxy` 留空时）

1. `config.proxy`
2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy`
3. Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyServer`（含 `http=host:port;https=host:port` 形态）
4. 直连

回环地址（`127.0.0.1`、`localhost`、`::1`）一律直连。

Node 的 `http`/`https` 既不读 Windows 系统代理，也不自动使用 `HTTP(S)_PROXY` 环境变量，因此插件自带 CONNECT 隧道实现。不启用代理时，`chatgpt.com` 与 `platform.deepseek.com` 会一直挂到超时。

## HTTP API

注册方式：`webServer.register({ kind: 'prefix', path: '/api/quota-hub' })`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/quota-hub/summary` | 聚合三家额度，命中缓存时直接返回 |
| `GET` | `/api/quota-hub/summary?force=1` | 绕过缓存重新拉取 |
| `GET` | `/api/quota-hub/config` | 脱敏配置，不含任何密文，代理仅返回 `proxyConfigured: boolean` |
| `POST` | `/api/quota-hub/refresh` | 等价于 `summary?force=1` |
| `GET` | `/api/quota-hub/diag` | 自检：凭据文件路径、账号记录解析结果、依赖插件版本、平台降级项；不联网、不回显密文 |

### `GET /summary` 响应

```jsonc
{
  "ok": true,
  "fetchedAt": 1793894402000,
  "health": { "ok": 3, "total": 3 },
  "providers": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "status": "ok",                  // ok | unavailable | error | missing_key
      "kind": "money",                 // money | percent
      "plan": null,
      "account": null,
      "remaining": 17.02,              // 金额型：金额；百分比型：最紧窗口剩余百分比
      "used": 168.98,
      "unit": "CNY",                   // 金额型为币种，百分比型为 "%"
      "windows": [],                   // 金额型为空数组
      "notes": ["累计消费 168.98 CNY"],
      "message": "",                   // 失败或降级时的中文说明
      "fetchedAt": 1793894402000,
      "ms": 313,                       // 本次上游耗时
      "peak":  { /* 见下 */ },
      "usage": { /* 见下 */ }
    },
    {
      "id": "codex",
      "label": "GPT (Codex)",
      "status": "ok",
      "kind": "percent",
      "plan": "plus",
      "account": "someone@example.com",
      "remaining": 60,
      "used": 40,
      "unit": "%",
      "windows": [
        { "label": "5小时窗口", "remainingPercent": 60, "usedPercent": 40,
          "resetsAt": 1793894402000, "windowSeconds": 18000, "unknown": false },
        { "label": "周窗口", "remainingPercent": 94, "usedPercent": 6,
          "resetsAt": 1794481202000, "windowSeconds": 604800, "unknown": false }
      ],
      "notes": ["计划：plus"],
      "message": "",
      "ms": 1372
    },
    {
      "id": "agy",
      "label": "Gemini",
      "kind": "percent",
      "status": "ok",
      "remaining": 89.67,
      "used": 10.33,
      "unit": "%",
      "windows": [ /* 五个窗口摊平后的并集，用于总览计算 */ ],
      "groups": [
        { "label": "Gemini 模型",
          "windows": [
            { "label": "5 小时配额", "remainingPercent": 99.94, "resetsAt": 1793924862000, "windowSeconds": 18000, "unknown": false },
            { "label": "每周配额",   "remainingPercent": 99.11, "resetsAt": 1794324635000, "windowSeconds": 604800, "unknown": false }
          ] },
        { "label": "Claude 与 GPT 模型",
          "windows": [
            { "label": "5 小时配额", "remainingPercent": 100 },
            { "label": "每周配额",   "remainingPercent": 89.67 }
          ] },
        { "label": "Gemini 4 Argon",
          "windows": [{ "label": "每周配额", "remainingPercent": 98.27 }] }
      ],
      "notes": ["数据源：Antigravity 原始额度接口"]
    }
  ]
}
```

### DeepSeek 专属字段

```jsonc
{
  "id": "deepseek",
  "kind": "money",
  "remaining": 15.82, "used": 170.19, "unit": "CNY",

  // 峰谷时段
  "peak": {
    "phase": "offPeak",          // 'peak' | 'offPeak'
    "reason": "window",          // 'window' | 'weekend' | 'holiday' | 'preRule'
    "nextAtMs": 1793926800000,   // 下一次相位切换（北京时间 09:00）
    "nextPhase": "peak",
    "dayStartMs": 1793865600000, // 当日 00:00（北京时间）
    "dayEndMs": 1793952000000,
    "nowMs": 1793923239000,
    "segments": [                // 当日 0–1 比例的峰谷分段，用于绘制时间条
      { "phase": "offPeak", "from": 0,     "to": 0.375 },
      { "phase": "peak",    "from": 0.375, "to": 0.5   }
    ]
  },

  // 今日消耗（插件按天记账）
  "usage": {
    "today": 8.01,
    "currency": "CNY",
    "sinceMs": null,             // 非 null 时界面标注「（自 HH:MM 起）」
    "credits": 9.45,             // 今日识别到的充值
    "source": "dsh-usage",       // 'dsh-usage' 种子 | 'self' 自行记账 | 'none'
    "history": [{ "date": "2026-11-05", "amount": 8.01 }]
  }
}
```

## 轮询与请求保护

| 机制 | 实现 |
|---|---|
| 服务端缓存 | `serverCacheTtlMs = 60000`，60 秒内的重复请求直接返回上一次结果 |
| 手动防抖 | 600ms 防抖（连点只发一次）+ 3000ms 最小间隔（跨点击限流） |
| 失焦降频 | `visibilitychange` / `blur` 触发周期 × `idleMultiplier`（或按 `pauseWhenHidden` 暂停）；`focus` 或恢复可见时立即刷新一次并恢复周期 |

并发与隔离：

```js
Promise.allSettled(adapters.map(a => a.fetch(credentials, config, runtime)))
```

- 三家并发，总耗时约等于最慢那家，而非三家之和。
- 每家内部把异常转成结构化 `status: 'error'`；`allSettled` 再兜一层，防止适配器意外抛出。
- 单家失败只影响自己那一行。

## 降级与错误状态

| `status` | 含义 | 界面表现 |
|---|---|---|
| `ok` | 正常 | 剩余 / 已用 / 重置倒计时 |
| `missing_key` | 本机无该平台登录记录 | 灰徽标「未登录」+ 缺失原因 |
| `unavailable` | 上游存在但该能力不可用（未装 agy-cli、账号未上报窗口） | 黄徽标 + 说明 |
| `error` | 请求失败、凭据过期或被拒绝 | 红徽标 + 可操作的中文提示 |

错误提示直接给出处理动作：

- `账号凭据已失效，请在 DSH 设置 → 账号里重新登录 DeepSeek`
- `登录凭据已过期，请在 DSH 的 Codex 订阅插件里重新登录`
- `Gemini 登录已过期，请在终端执行一次 agy 重新登录`
- `请求超时（chatgpt.com 通常需要代理，请检查 proxy 配置）`
- `未检测到 dsh-agy-cli 插件（Gemini 额度由它提供），可先安装/启用该插件`
- `连接本机 <port> 端口被拒绝，且原始额度接口也不可用；请确认 DSH Web 服务端口`

## 隐私与安全

- **只读凭据**：仅读取 `.credentials.yaml` 与 Windows 凭据管理器，不写回、不刷新令牌、不落盘、不打印。
- **只连三个官方域名**：`platform.deepseek.com`、`chatgpt.com`、`daily-cloudcode-pa.googleapis.com`，以及本机 `127.0.0.1` 的 agy-cli 状态接口。无遥测、无第三方上报。
- **接口脱敏**：任何 API 都不回显密文，代理地址只返回布尔值。
- **CORS 收紧**：默认只放行回环地址；回环 host 放行任意端口，其余按 `corsOrigins` 白名单。
- **前端不拼 HTML**：所有动态文本经 `textContent` 写入，上游返回值无法注入标记。

## 目录结构

```
dsh-quota-ring/
├── package.json              # 插件清单：main / exports / dsh.bundle.patch / dsh.client
├── cordis.patch.yml          # 注册补丁：把本插件 insert 进 profile 的插件列表
├── index.js                  # 服务端入口：/api/quota-hub/* 路由（CommonJS）
├── client.js                 # 客户端入口：圆环 + 卡片 + 峰谷条（纯 DOM）
├── src/
│   ├── config.js             # 默认配置 / 归一化（深合并 + 数值兜底）/ 脱敏
│   ├── credentials.js        # 读 .credentials.yaml：DeepSeek grant + Codex OAuth
│   ├── keyring.js            # 只读 Windows 凭据管理器（gemini:antigravity）
│   ├── http.js               # GET/POST + CONNECT 代理隧道 + 系统代理探测
│   ├── shape.js              # 三家统一返回结构 + 时间与百分比归一
│   ├── peak.js               # DeepSeek 峰谷判定（UTC 窗口 + 周末/节假日 + 分段）
│   ├── usage.js              # DeepSeek 今日消耗记账（余额差 + 充值识别）
│   ├── aggregator.js         # 并发聚合 + TTL 缓存 + 单家失败隔离
│   ├── diag.js               # 自检：凭据定位、记录解析、依赖插件探测
│   ├── log.js                # 调试日志开关（QH_DEBUG=1）
│   └── adapters/
│       ├── index.js          # 适配器注册表（顺序即界面顺序）
│       ├── deepseek.js       # 金额型：get_user_summary + 峰谷 + 今日消耗
│       ├── codex.js          # 百分比型：chatgpt.com wham/usage
│       └── agy.js            # 百分比型：Antigravity 原始额度池（回退 agy-cli /status）
├── preview/                  # 离线预览（开发辅助，不参与运行时）
│   ├── build-preview.cjs     # 用真实数据生成预览页
│   ├── preview.html          # 桩掉 fetch / __ModuleLoader__ 的渲染页
│   └── card-final.png        # 截图
├── selftest-v3.cjs           # 峰谷与今日消耗记账的自测脚本
├── README.md
└── LICENSE
```

分层职责：`index.js` 只处理 HTTP 协议与生命周期；`aggregator.js` 负责调度与缓存；`adapters/*` 各自负责一家上游的取数与解析；`peak.js` / `usage.js` 是 DeepSeek 专用的纯计算模块；`credentials.js` 是唯一知道凭据位置的地方；`diag.js` 只读且不联网；`client.js` 负责渲染与交互。

替换上游只需改一处：GPT 与 Gemini 的取数分别在 `adapters/codex.js`、`adapters/agy.js`，凭据定位统一在 `credentials.js`。新增第四家平台只需新增一个 `adapters/xxx.js`（导出 `{ id, label, fetch(credentials, config, runtime) }`，返回 `shape.js` 的统一结构）并注册到 `adapters/index.js`。

## 开发与自测

```powershell
# 语法检查（无构建步骤，源码即产物）
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 峰谷判定与今日消耗记账的自测
node selftest-v3.cjs

# 生成离线预览页，不重启 DSH 即可查看真实数据的渲染结果
node preview/build-preview.cjs
# 然后用浏览器打开 preview/preview.html
```

`preview.html` 会桩掉 `window.fetch` 与 `window.__ModuleLoader__.load`，直接注入真实 `/summary` 数据，因此无需宿主即可验证渲染分支。自测中的历史数据、充值与跨天归档均在临时目录中进行，不污染真实的 `usage-state.json`。

## 已知限制

- **额度数据来自上游非公开接口**：GPT 的 `chatgpt.com/backend-api` 与 Antigravity 的 `daily-cloudcode-pa` 都非公开文档接口，上游改结构时对应行会退化为 `error` / `unavailable`，不会伪造数据。
- **Gemini 依赖 `dsh-agy-cli` 与 Antigravity 登录态**：未安装或未登录时该行显示「未登录」。
- **平台能力差异**（不影响另外两家）：

  | 能力 | Windows | macOS / Linux |
  |---|---|---|
  | Gemini 原始额度接口（三池齐全） | 支持（PowerShell + `advapi32!CredRead` 读取 `gemini:antigravity`） | 不支持，回退 agy-cli `/status`，5 小时窗口可能显示「未知」 |
  | 系统代理自动发现 | 读注册表 `Internet Settings` | 仅环境变量或显式 `proxy` |
  | DeepSeek / GPT / 峰谷 / 今日消耗 | 支持 | 支持 |

- **今日消耗是推断值**：基于余额差而非官方账单。若两次轮询之间既充值又消耗，只能按净额记账。
- **峰谷节假日表为 2026 年安排**：跨年后用 `deepseekPeakHolidays` 覆盖。
- **DSH Web 端口每次重启可能变化**：默认从请求 Host 头推断，不应写死。

## 排障

先看 `/api/quota-hub/diag`，再按症状定位：

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 右下角没有圆环 | 插件未加载 | 检查 DSH 启动日志中是否出现 `dsh-quota-ring`；确认 `cordis.patch.yml` 含 `- insert: [{id: quota-hub, name: 'dsh-quota-ring'}]`；确认改后重启过 DSH |
| 卡片内全部「未登录」 | 本机无对应登录态 | 查看 `/diag` 的 `deepseek.ok` / `codex.ok` / `plugins[].installed` |
| GPT 行「未登录」但 Codex 插件已装 | 未登录，或记录名不同 | 在 Codex 订阅插件中登录；`/diag` 的 `codex.source` 应为 `records` 或 `refs` |
| GPT 行显示 401 | OAuth access 过期 | 在 `dsh-codex-subscription` 中重新登录；`/diag` 的 `codex.expired` 为 `true` |
| Gemini 行「不可用」 | 未装 `dsh-agy-cli`，或端口未推断到 | 安装该插件并在终端执行一次 `agy`，或手动设置 `dshWebPort` |
| Gemini 5 小时窗口「未知」 | 回退到压平后的 `/status` | 查看 `/diag` 的 `runtime.keyringAvailable`；非 Windows 平台属预期 |
| 三家全部请求超时 | 网络需代理且未探测到 | 显式设置 `proxy`，或设置 `HTTPS_PROXY` 后重启 DSH |
| 卡片数字长期不变 | 服务端缓存或失焦降频 | 点击「刷新」；或调小 `serverCacheTtlMs` |

设置环境变量 `QH_DEBUG=1` 启动 DSH，服务端会输出每次上游请求的失败原因（不含密文）。

## 实现约束（改代码前必读）

1. **DeepSeek token 不能按字符集截取**。token 为 base64 风格，含 `/` 与 `+`；用 `[A-Za-z0-9._-]` 这类字符集会在第 25 个字符处截断，服务端返回 `{"code":40003,"msg":"Authorization Failed (invalid token)"}`。必须取整行冒号后的全部内容再剥引号。
2. **Node 不读系统代理**。必须自行实现 CONNECT 隧道，否则 `chatgpt.com` 会挂到超时；探测顺序见[代理探测顺序](#代理探测顺序proxy-留空时)。
3. **`.credentials.yaml` 的 `records` 是对象不是数组**。`codex-subscription/accounts` 内部的 `accounts` 才是列表，且 `credential` 为嵌套对象。
4. **百分比「未知」不能当 100%**。Gemini 的 `fiveHourUnknown: true` 必须渲染为「未知」。
5. **`credits.balance = '0'` 不是余额**。Codex 订阅额度制下该字段恒为 0，不能当作金额展示。
6. **`0E-16` 是合法的 0**。DeepSeek 钱包金额可能返回科学计数法字符串，`parseFloat('0E-16') === 0`。
7. **`Number(null) === 0` 且是有限值**。百分比取整时若只判断 `Number.isFinite`，未知窗口会被静默转成「0% 剩余」。`src/shape.js` 的 `round2()` 因此显式排除 `null` / `undefined` / 空字符串。
8. **agy-cli 的 `/status` 会丢额度组**。三个 group 压平成三个 family 时后出现的覆盖前面的，`Gemini 4 Argon`（仅周额度）会覆盖 `Gemini Models` 的 `gemini-5h`。必须直接读 `retrieveUserQuotaSummary`。
9. **读原始接口必须带完整 CLI 身份头**。`User-Agent` 过于简短时，daily 端点会整个省略 Gemini group，只返回第三方组。需带 `antigravity/cli/1.4.2 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)` 与配对的 `X-Goog-Api-Client`。
10. **令牌轮换导致的 401 需强制重读一次**。agy-cli 的 `/status` 调用可能触发令牌续期，此时凭据管理器已换新，而进程内 30 秒缓存仍持有旧令牌，请求必然 401。`src/adapters/agy.js` 因此在 401/403 时强制重读令牌再试，第二次失败才回退。
11. **端口推断失败不应放弃 Gemini**。读 agy-cli `/status` 需要 DSH Web 端口，但原始额度接口只依赖凭据管理器中的令牌。因此 `/status` 失败时仅记一条附注并继续走原始接口，两条路都失败才报错。
12. **不要写死端口兜底值**。DSH Web 端口每次重启可能变化（实测出现过多组端口），`dshWebPort` 为 `0` 时应跳过依赖端口的接口，而不是猜一个值。
13. **不要写死数据目录**。从 `__dirname` 逐级上溯查找 `.credentials.yaml`：插件安装于 `<home>/profiles/<profile>/node_modules/` 下，路径本身即为线索。
14. **Windows 凭据读取必须使用 `-Command "& { … } <target>` 形式**。以 `-Command -` 从 stdin 传入 PowerShell 脚本会静默返回空（退出码 0），易被误判为「没有凭据」。
15. **`.dshw-usage.json` 不可全信**。它是 DSH 自身的日用量账本，可能停止更新，且 `lastBalance` 不含中途充值，只可作为首次记账的起点。
16. **逐块 `toString('utf8')` 会切碎中文**。通过 CONNECT 隧道手写 HTTP 解析时，响应体需按 `Buffer` 累积并用 `buf.indexOf('\r\n\r\n')` 定位头尾；Gemini 额度响应的 `description` 含中文，字符串拼接会出现乱码。

## License

[MIT](./LICENSE)
