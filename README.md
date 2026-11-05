# dsh-quota-ring

[![License: MIT](https://img.shields.io/badge/license-MIT-16a34a.svg)](./LICENSE)
![DSH](https://img.shields.io/badge/DSH-Web%20UI%20plugin-2563eb.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)

DSH Web UI 额度展示插件。在右下角显示悬浮圆环，点击查看 DeepSeek 余额、Codex 订阅额度及 Antigravity 额度。

[English](./README.en.md)

![额度卡片](preview/card-final.png)

## 功能

- 圆环显示已知百分比窗口中的最低剩余额度。
- DeepSeek 显示余额、累计消费、今日消耗估算和峰谷时段提示。
- GPT（Codex）显示账号上报的速率窗口及重置时间。
- Gemini 按 Antigravity 返回的额度组显示；可用组和窗口随账号及上游接口变化。
- 各平台独立查询；某个平台失败时，其余平台继续显示。
- 默认每 10 分钟刷新，支持手动刷新、后台降频和服务端缓存。

金额和百分比分别展示，不进行相加或汇率折算。未上报的数据不作为零额度或满额度处理。

## 安装

需要带 Web UI 和 `webServer` 服务的 DSH，以及 Node.js 18 或更高版本。

在 DSH 使用的终端中执行：

```bash
dsh plugin --profile desktop add https://github.com/j352201657-debug/dsh-quota-ring
```

使用独立 Web profile 时，将 `desktop` 替换为 `web`。安装后重启对应的 DSH 实例。

| 平台 | 登录与组件要求 |
|---|---|
| DeepSeek | 在 DSH 内置的 DeepSeek 账号组件中登录 |
| GPT（Codex） | 安装 `dsh-codex-subscription` 并登录订阅账号 |
| Gemini | 安装 `dsh-agy-cli` 并完成 Antigravity 授权 |

Gemini 原始额度读取依赖 Windows 凭据管理器。其他平台使用 AGY 状态接口回退，可能缺少部分窗口。只有对应平台具备有效登录状态时，才能显示其额度。

卸载时，在对应 profile 中移除本插件的依赖和注册条目，再重启 DSH。统计状态位于 DSH 数据目录下的 `dsh-quota-ring/usage-state.json`，可按需保留。

## 数据与显示

| 平台 | 数据来源 | 显示单位 |
|---|---|---|
| DeepSeek | `platform.deepseek.com/api/v0/users/get_user_summary` | 账号钱包币种 |
| GPT（Codex） | `chatgpt.com/backend-api/wham/usage` | 速率窗口剩余百分比 |
| Gemini | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`；失败时回退到本机 `/plugins/agy-cli/status` | 额度组剩余百分比 |

这些接口并非本插件定义的稳定公开协议，上游字段或鉴权变化可能导致查询失败。AGY 回退数据不一定包含原始接口的全部额度组。

### 今日消耗

今日消耗依据余额变化估算：余额下降计入消耗，余额增加计入充值。记录按 UTC+8 日历日保存，保留最近 30 天，重启后延续。

首次观测时以当前余额为起点；存在同日 `.dshw-usage.json` 记录时可用作初始值。界面在起点已知时显示统计起始时间。

两次观测之间同时发生充值与消费时，只能记录净变化。该统计不等同于官方账单。

### 峰谷提示

内置参考窗口为 UTC 01:00–04:00、06:00–10:00，即北京时间 09:00–12:00、14:00–18:00。周末和内置的 2026 年假期表参与时段计算。

时段与假期可通过配置覆盖。提示不用于计算官方账单，实际计费以平台公布的规则和账单为准。

## 配置

配置位于对应 profile 的本插件注册条目 `config` 中。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `refreshIntervalMs` | `600000` | 前端刷新间隔，毫秒，最小 5000 |
| `idleMultiplier` | `3` | 失焦时的刷新间隔倍数 |
| `pauseWhenHidden` | `false` | 页面隐藏时是否暂停刷新 |
| `dshHome` | `''` | DSH 数据目录；留空自动查找 |
| `dshWebPort` | `0` | AGY 状态接口端口；0 表示从请求 Host 推断 |
| `proxy` | `''` | HTTP 或 HTTPS 代理地址；留空自动探测 |
| `serverCacheTtlMs` | `60000` | 服务端缓存时长，毫秒；0 关闭缓存 |
| `requestTimeoutMs` | `15000` | 单次上游请求超时，毫秒 |
| `corsOrigins` | 回环来源 | 允许的跨域来源；另允许回环主机的任意端口 |
| `deepseekPeakWindows` | `null` | UTC 峰时段列表，例如 `[{start:1,end:4},{start:6,end:10}]` |
| `deepseekPeakHolidays` | `null` | UTC+8 假期日期列表，例如 `['2026-10-01']` |

凭据目录按以下顺序查找：

1. `config.dshHome`。
2. 环境变量 `DSH_HOME`、`DSH_DATA_DIR`。
3. 从插件安装目录向上查找。
4. 用户主目录下的 `.dsh`。

代理按配置、`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量、Windows 系统代理的顺序探测；无可用代理时直连。回环请求始终直连。

服务端合并并发的额度查询。手动刷新绕过已完成结果的缓存，但复用仍在进行的请求。登录或切换账号后，下一次实际查询会重新读取凭据。

## HTTP API

路由前缀为 `/api/quota-hub`。访问需遵循 DSH 宿主的身份验证和网络访问设置。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/summary` | 查询聚合额度，支持缓存 |
| GET | `/summary?force=1` | 绕过已完成结果的缓存 |
| POST | `/refresh` | 手动刷新 |
| GET | `/config` | 获取界面所需配置，代理仅返回配置状态 |
| GET | `/diag` | 查询本地诊断信息，不请求上游额度接口 |

额度结果包含 `providers`、`fetchedAt` 和 `health`。平台条目的状态为 `ok`、`missing_key`、`unavailable` 或 `error`，明细包含 `windows`，Gemini 还可包含 `groups`。DeepSeek 附带 `peak` 和 `usage`。

`/diag` 的详细结果位于 `diag` 字段，包括凭据文件路径、解析状态、插件版本及处理建议。诊断结果可能包含本机路径，分享前应检查内容。

## 数据保存与隐私

- DeepSeek 和 Codex 登录凭据从本机 `.credentials.yaml` 读取。
- Gemini 访问令牌从 Windows 凭据管理器读取。插件不主动写回或续期凭据；AGY 状态接口可能触发 AGY 自身的续期逻辑。
- 额度查询需要联网，使用上表列出的服务及配置的代理。DeepSeek 的请求地址也受凭据中 `issuer` 字段影响。
- 今日消耗统计会写入本机 `usage-state.json`；生成预览页时会保存额度快照。
- 项目没有遥测上报逻辑。界面动态文本使用 `textContent` 写入。

## 开发与验证

源码使用 CommonJS，客户端为原生 DOM，无构建步骤。

```bash
npm test
node --check client.js
node --check index.js
```

`npm test` 执行离线回归测试，使用临时目录和本地测试服务器，不读取真实登录凭据，不请求平台额度接口。失败时返回非零退出码。

需要使用本机账号生成预览时：

```bash
node preview/build-preview.cjs
```

然后打开生成的 `preview/preview.html`。此命令会实际查询额度并更新本机消耗统计。预览页使用静态快照，生成文件不应直接公开；脱敏处理不能替代人工检查。

源码职责：

- `index.js`：路由与宿主生命周期。
- `client.js`：圆环、卡片和刷新交互。
- `src/aggregator.js`：请求合并、缓存及平台隔离。
- `src/adapters/`：各平台请求和响应解析。
- `src/credentials.js`、`src/keyring.js`：凭据读取。
- `src/http.js`：HTTP、代理、超时及响应解析。
- `src/peak.js`、`src/usage.js`：时段提示及消耗估算。
- `tests/`：离线回归测试。

## 排障

| 现象 | 检查项 |
|---|---|
| 圆环未显示 | 检查插件安装的 profile、注册条目和 DSH 启动日志 |
| 显示未登录 | 检查对应账号登录状态及 `/diag` 中的解析结果 |
| 登录后仍显示旧状态 | 手动刷新；检查 DSH 登录组件是否已保存新的凭据 |
| Gemini 数据不可用 | 检查 AGY 授权、组件启用状态和 DSH Web 端口 |
| Gemini 缺少部分窗口 | 检查是否使用 AGY 状态接口回退 |
| 查询超时 | 检查网络和 `proxy` 配置 |
| 峰谷提示不符合当前规则 | 更新时段和假期配置 |

`QH_DEBUG=1` 可启用服务端调试日志。公开日志前应检查其中的账号信息和本机路径。

## License

[MIT](./LICENSE)
