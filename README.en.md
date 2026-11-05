# dsh-quota-ring

[![License: MIT](https://img.shields.io/badge/license-MIT-16a34a.svg)](./LICENSE)
![DSH](https://img.shields.io/badge/DSH-Web%20UI%20plugin-2563eb.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg)

**DeepSeek, GPT (Codex) and Gemini quotas, in one ring at the bottom-right of DSH.**

The ring's arc shows the *tightest* percentage window across all providers. Click it to expand a card with remaining / used / reset countdowns per provider, plus DeepSeek peak/off-peak timing and today's spend. Polling defaults to 10 minutes with debounce and idle back-off; a provider that fails only degrades its own row.

[中文说明](./README.md)

![quota card](preview/card-final.png)

---

## Why

In DSH these three quotas come from three completely different places, and none of them is "paste an API key and read a balance":

| | Where the quota lives | What the quota *is* |
|---|---|---|
| DeepSeek | DSH account login (grant token in `.credentials.yaml`) | **real money** (CNY/USD) |
| GPT (Codex) | Codex subscription plugin's OAuth session | **percentage rate windows** (5h + weekly) |
| Gemini | Antigravity CLI login (Windows Credential Manager) | **percentage rate windows** (3 pools × weekly/5h) |

This plugin reads those three chains directly and renders them together, without ever mixing their semantics (see [Semantic honesty](#semantic-honesty)).

## Features

- **Floating ring**: arc = lowest remaining percentage; center shows that number, or `¥` when only money is known, or `!` on errors. Click to expand.
- **Three providers at once**: DeepSeek remaining/used/today spend/peak-off-peak bar; GPT's two windows; Gemini's three quota pools (five windows) with reset countdowns.
- **DeepSeek peak hours**: the day is sliced into 15-minute segments drawn as an orange (peak) / blue (off-peak) bar with a dark "now" tick and copy like `平价 · 11 小时 53 分后进入高峰`.
- **DeepSeek today's spend**: there is no official per-day figure, so the plugin ledgers it from balance deltas, recognises top-ups, survives restarts, and archives daily.
- **Per-provider degradation**: concurrent fetches, per-provider timeouts and fallbacks.
- **Three layers of request protection**: 60 s server cache + 600 ms debounce / 3 s rate limit + idle back-off or pause.
- **Read-only and offline**: reads local DSH credentials, talks only to the three official hosts, never logs or persists secrets, no telemetry.
- **No frontend framework**: the client is plain DOM in a single file — no React / react-dom dependency.

## Install

```powershell
$profile = "D:\DSHData\.dsh\profiles\desktop"   # your profile path
Copy-Item -Recurse -Force .\dsh-quota-ring "$profile\node_modules\dsh-quota-ring"
```

Add to `$profile/package.json` → `dependencies`:

```json
"dsh-quota-ring": "file:./node_modules/dsh-quota-ring"
```

Append this package's `cordis.patch.yml` block to `$profile/cordis.patch.yml`:

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

Restart DSH (the client bundle is loaded at startup). The ring appears bottom-right; the first fetch takes ~2–5 s (Gemini reads the credential manager and opens TLS on that first call), then the 60 s cache takes over.

### What must exist on the machine

This plugin reads **DSH login sessions**, not API keys. Per provider:

| Requirement | Provides | If missing |
|---|---|---|
| **DSH desktop** (Web UI + `webServer`) | host for the route and the client bundle | plugin never loads |
| **`dsh-codex-subscription`**, signed in | GPT (Codex) OAuth credential (record `codex-subscription/accounts`) | GPT row shows "未登录" |
| **`dsh-agy-cli`**, with `agy` logged in once | Gemini quotas (Windows Credential Manager `gemini:antigravity` + `/plugins/agy-cli/status`) | Gemini row shows "unavailable" |
| DeepSeek account session (built into DSH: `dsh-deepseek-account-platform`) | balance and total spend (record `deepseek-account-platform/default`) | DeepSeek row shows "未登录" |
| Node.js ≥ 18 | runtime (no third-party deps) | server does not start |

> **In one line**: GPT and Gemini work **as long as those two plugins are installed and signed in** — `dsh-codex-subscription` and `dsh-agy-cli`. If either plugin (or its credential record names) differs, adjust the corresponding reader in `src/credentials.js` / `src/adapters/agy.js`.

### Portability notes

| Concern | How it is handled |
|---|---|
| Data dir is not `D:\DSHData\.dsh` | `dshHome` empty → tries `DSH_HOME` / `DSH_DATA_DIR` → **walks up from the plugin's own install path looking for `.credentials.yaml`** → `D:\DSHData\.dsh` → `~/.dsh` |
| Web port changes on every restart | inferred from the request `Host` header (`dshWebPort: 0`) |
| Different user name / home | only `os.homedir()` and relative paths; no absolute path or user name in code |
| Different proxy setup | `proxy` empty → env vars → Windows registry → direct |
| Upstream record renamed in a DSH update | falls back to fuzzy matching (records whose name contains `deepseek` / `codex` and contain `token` / `access`) |

### Self-check first

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/quota-hub/diag | ConvertTo-Json -Depth 6
```

It answers: was the credentials file found (`credentialsFile`, `triedHomes`), did both account records parse (`deepseek.ok`, `codex.ok`, `codex.expired`), are the two dependency plugins installed (`plugins[].installed` + versions), and which platform capabilities are degraded (`runtime.note`). `tips` holds the next actions. It makes **no network calls** and never echoes secrets.

## How quotas are fetched

| Provider | DSH component | Request | Shape |
|---|---|---|---|
| **DeepSeek** | `dsh-deepseek-account-platform` | `GET https://platform.deepseek.com/api/v0/users/get_user_summary`, header `x-dsh-auth-token` (grant token from `.credentials.yaml`) | money, CNY/USD, remaining **and** used |
| **GPT** | `dsh-codex-subscription` | `GET https://chatgpt.com/backend-api/wham/usage`, headers `authorization: Bearer <access>` + `chatgpt-account-id` (OAuth from `.credentials.yaml`) | `rate_limit.primary_window` (5h) / `secondary_window` (weekly), `used_percent` |
| **Gemini** | `dsh-agy-cli` | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` using the read-only token from Windows Credential Manager (`gemini:antigravity`); falls back to `GET /plugins/agy-cli/status` | three groups / five buckets, `remainingFraction` |

### Why Gemini's 5-hour window used to be "unknown"

Antigravity reports **three groups, five buckets** (`gemini-weekly` + `gemini-5h`, `3p-weekly` + `3p-5h`, `gemini-argon-wtu-weekly`). `dsh-agy-cli` flattens them into three families and lets *later groups overwrite earlier ones* — `Gemini 4 Argon` has no 5h bucket, so it overwrites the `gemini-5h` from `Gemini Models`, and `google.fiveHourUnknown` is permanently `true`.

The quota was always there; it was dropped in transit. This plugin reads the raw endpoint and renders groups as-is, falling back to the flattened data only when the token is missing/expired or the call fails — and then says so in a note.

### DeepSeek peak / off-peak

| | Rule |
|---|---|
| Peak | **UTC** `01:00–04:00` and `06:00–10:00` = **09:00–12:00, 14:00–18:00 Beijing** |
| Weekends | All day off-peak (Beijing Sat/Sun) |
| Holidays | All day off-peak (2026 schedule built in, overridable) |
| Precedence | Weekends/holidays beat peak windows |
| Effective from | `2026-08-16T16:00:00Z` |

### DeepSeek today's spend

No official per-day figure exists, so the plugin ledgers it:

```
today = opening balance + top-ups − current balance
```

Balance drops are spend, balance jumps are top-ups (so a mid-day top-up never produces negative spend). State lives in `$DSH_HOME/dsh-quota-ring/usage-state.json`, survives restarts, archives daily for 30 days. On first install it seeds from DSH's own `.dshw-usage.json` when that file has a same-day record, and labels the window as `（自 20:11 起）` when the ledger didn't start at midnight.

### Semantic honesty

DeepSeek is **money**; GPT and Gemini are **percentage rate windows**. The footer therefore reports two independent conclusions rather than a fake total:

```
可用余额 ¥15.03（DeepSeek）
最紧窗口 49% 剩余（GPT (Codex) · 5小时窗口）
```

No currency conversion — turning "60% remaining" into dollars would be false precision.

An unknown window renders as **未知** with an empty grey bar, never as `1.0`. A depleted account showing "100% remaining" would be the worst possible lie.

## Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `refreshIntervalMs` | number | `600000` | Poll period (ms), min 5000 |
| `idleMultiplier` | number | `3` | Period multiplier while unfocused |
| `pauseWhenHidden` | boolean | `false` | `true` pauses polling while hidden |
| `dshHome` | string | `''` | DSH data dir containing `.credentials.yaml`; auto-detected when empty |
| `dshWebPort` | number | `0` | DSH Web port for agy-cli; `0` infers it from the request Host header (recommended, it changes per restart) |
| `proxy` | string | `''` | e.g. `http://127.0.0.1:12450`; auto-detected when empty |
| `serverCacheTtlMs` | number | `60000` | Aggregation cache; `0` disables |
| `requestTimeoutMs` | number | `15000` | Per-provider timeout |
| `corsOrigins` | string[] | loopback origins | CORS allow-list; loopback hosts are always allowed |
| `deepseekPeakWindows` | array \| null | `null` | Override peak windows (UTC hours, half-open) |
| `deepseekPeakHolidays` | string[] \| null | `null` | Override holiday dates |

**Credential dir order**: `DSH_HOME` → `DSH_DATA_DIR` → `D:\DSHData\.dsh` → `~/.dsh`.

**Proxy order**: `config.proxy` → `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` env → Windows registry `Internet Settings\ProxyServer` → direct. Loopback is always direct.

> Node's `http`/`https` honour neither the Windows system proxy nor `HTTP(S)_PROXY` — without a manual CONNECT tunnel, `chatgpt.com` just hangs until timeout.

## HTTP API

`webServer.register({ kind: 'prefix', path: '/api/quota-hub' })`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/quota-hub/summary` | Aggregated quotas (cached) |
| `GET` | `/api/quota-hub/summary?force=1` | Bypass cache |
| `GET` | `/api/quota-hub/config` | Sanitised config (never contains secrets) |
| `POST` | `/api/quota-hub/refresh` | Same as `summary?force=1` |
| `GET` | `/api/quota-hub/diag` | Self-check: credentials file, parsed account records, dependency plugin versions, platform degradations. **No network, no secrets** |

Each provider returns `{ id, label, status, kind: 'money' | 'percent', remaining, used, unit, windows[], groups[]?, notes[], message, ms }`, where `status` is one of `ok | unavailable | error | missing_key`. DeepSeek additionally returns `peak` (phase, next switch, 15-minute `segments` of the day) and `usage` (today, credits, source, history).

## Privacy & security

- Credentials are **read-only** — never written back, never refreshed by this plugin, never persisted, never logged.
- Only three official hosts are contacted (`platform.deepseek.com`, `chatgpt.com`, `daily-cloudcode-pa.googleapis.com`) plus the local `127.0.0.1` agy-cli status route.
- `/config` returns sanitised values only (`proxyConfigured: boolean`).
- All dynamic text is written with `textContent`, so upstream strings cannot inject markup.

## Project layout

```
dsh-quota-ring/
├── package.json        # main / exports / dsh.bundle.patch / dsh.client
├── cordis.patch.yml    # registers the plugin into the profile
├── index.js            # server: /api/quota-hub/* routes (CommonJS)
├── client.js           # client: ring + card + peak bar (plain DOM)
├── src/
│   ├── config.js       # defaults / normalisation / sanitising
│   ├── credentials.js  # .credentials.yaml: DeepSeek grant + Codex OAuth
│   ├── keyring.js      # read-only Windows Credential Manager access
│   ├── http.js         # GET/POST + CONNECT proxy tunnel + system proxy discovery
│   ├── shape.js        # shared result shape + time/percent helpers
│   ├── peak.js         # DeepSeek peak/off-peak evaluation + segments
│   ├── usage.js        # DeepSeek daily spend ledger
│   ├── aggregator.js   # concurrent fan-out + TTL cache + isolation
│   └── adapters/       # deepseek.js | codex.js | agy.js (+ registry)
├── preview/            # offline preview harness (dev only)
└── selftest-v3.cjs     # peak + ledger self-tests
```

Adding a fourth provider means one `adapters/xxx.js` exporting `{ id, label, fetch(credentials, config, runtime) }` and one line in `adapters/index.js`.

## Development

```powershell
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
node selftest-v3.cjs
node preview/build-preview.cjs    # then open preview/preview.html
```

The preview page stubs `window.fetch` and `window.__ModuleLoader__.load` and injects real `/summary` data, so rendering can be verified without restarting DSH.

## Known limitations

- Upstream endpoints for GPT and Antigravity are unofficial; if they change shape the row degrades to `error` / `unavailable` instead of inventing numbers.
- Gemini needs `dsh-agy-cli` / an Antigravity login.
- Platform differences (the other two rows are unaffected):

  | Capability | Windows | macOS / Linux |
  |---|---|---|
  | Gemini raw quota API (all three pools) | yes (PowerShell + `advapi32!CredRead` on `gemini:antigravity`) | no → falls back to agy-cli `/status`, so the **5-hour window may show "unknown"** |
  | System proxy discovery | reads `Internet Settings` | env vars / explicit `proxy` only |
  | DeepSeek, GPT, peak hours, today's spend | yes | yes |
- DeepSeek "today" is an inference from balance deltas, not an official statement; a top-up and spend between two polls can only be netted.
- The holiday table is 2026; override it for later years.
- The DSH Web port changes on restart — don't hard-code it.

## Troubleshooting

Start with `/api/quota-hub/diag`. Then:

| Symptom | Likely cause | Action |
|---|---|---|
| No ring at all | plugin not loaded | check the DSH log for `dsh-quota-ring`; verify the `- insert:` entry; **restart DSH** |
| Every row says "未登录" | no login on this machine | check `deepseek.ok` / `codex.ok` / `plugins[].installed` in `/diag` |
| GPT row: 401 | OAuth access expired | sign in again in `dsh-codex-subscription` (`codex.expired` is `true`) |
| Gemini row: unavailable | `dsh-agy-cli` missing, or port not inferred | install it and run `agy` once, or set `dshWebPort` |
| Gemini 5-hour window "unknown" | flattened `/status` fallback | expected on non-Windows (see limitations) |
| All rows time out | proxy is required but not detected | set `proxy`, or `HTTPS_PROXY`, then restart DSH |

`QH_DEBUG=1` prints the real upstream error to stderr (never secrets).

## License

[MIT](./LICENSE)
