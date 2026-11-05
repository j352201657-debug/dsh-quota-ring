'use strict';

/** Antigravity 额度适配器：读取分组额度，失败时回退到 AGY 状态接口。 */

const { httpGetJson, httpPostJson } = require('../http');
const { makeResult, failResult, clamp, toResetAt } = require('../shape');
const { readAntigravityToken } = require('../keyring');

const ID = 'agy';
const LABEL = 'Gemini';

/**
 * 端口未知时**不做猜测**（0 = 跳过 agy-cli 状态接口）。
 * 理由：DSH 的 Web 端口每次重启都可能变化，任何写死的默认值在别人机器上
 * 只会带来一段无意义的连接等待；而原始额度接口只依赖凭据管理器里的令牌，
 * 与端口无关，跳过状态接口并不损失额度数据。
 */

/** Antigravity 的原始额度接口（daily 才是真实账本，prod 是空账本，勿用）。 */
const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

/**
 * 身份请求头。
 * 注释说明（来自 agy-cli 的实测）：UA 太简短时，daily 的
 * retrieveUserQuotaSummary 会**整个省略 Gemini group**，只返回第三方组。
 * 所以这里必须带完整的 CLI 身份。
 */
const IDENTITY_HEADERS = {
  'User-Agent': 'antigravity/cli/1.4.2 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)',
  'X-Goog-Api-Client': 'antigravity/cli/1.4.2 aidev_client windows/amd64 consumer',
};

/** 窗口 → 秒数，用于界面显示"窗口长度" */
const WINDOW_SECONDS = { '5h': 18000, weekly: 604800 };

/** group displayName 的中文映射（名称变了就原样展示，不做模糊猜测） */
const GROUP_LABEL_MAP = {
  'gemini models': 'Gemini 模型',
  'claude and gpt models': 'Claude 与 GPT 模型',
  'gemini 4 argon': 'Gemini 4 Argon',
};

/** 窗口 label */
const WINDOW_LABEL = { '5h': '5 小时配额', weekly: '每周配额' };

/**
 * 决定 agy-cli 状态接口的端口。
 * @param {object} config
 * @param {object} [runtime] { webPort }
 * @returns {number}
 */
function resolvePort(config, runtime) {
  const fromCfg = Number(config && config.dshWebPort);
  if (Number.isInteger(fromCfg) && fromCfg > 0 && fromCfg <= 65535) return fromCfg;
  const fromReq = Number(runtime && runtime.webPort);
  if (Number.isInteger(fromReq) && fromReq > 0 && fromReq <= 65535) return fromReq;
  return 0; // 未知：跳过状态接口，直接走原始额度接口
}

/**
 * 把一个「剩余比例」窗口转成统一窗口结构。
 * @param {string} label
 * @param {*} fraction 0..1 的剩余比例（undefined/null 视为未上报）
 * @param {*} resetRaw 重置时间（ISO 串或秒/毫秒）
 * @param {number|null} windowSeconds
 * @returns {object}
 */
function makeWindow(label, fraction, resetRaw, windowSeconds) {
  const normalized = clamp(fraction, 0, 1);
  const pct = normalized === null ? null : normalized * 100;
  if (pct === null) {
    return {
      label,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: toResetAt(resetRaw, null),
      windowSeconds: windowSeconds || null,
      unknown: true,
    };
  }
  return {
    label,
    remainingPercent: pct,
    usedPercent: clamp(100 - pct, 0, 100),
    resetsAt: toResetAt(resetRaw, null),
    windowSeconds: windowSeconds || null,
    unknown: false,
  };
}

/**
 * 解析原始接口返回的 groups → 分组窗口。
 * @param {any} json retrieveUserQuotaSummary 的响应
 * @returns {Array<{label:string, description:string, windows:object[]}>}
 */
function parseGroups(json) {
  const groups = Array.isArray(json && json.groups) ? json.groups : [];
  const out = [];
  for (const group of groups) {
    const displayName = String((group && group.displayName) || '').trim();
    const desc = String((group && group.description) || '').trim();
    const label = GROUP_LABEL_MAP[displayName.toLowerCase()] || displayName || '未命名额度组';

    const windows = [];
    for (const b of Array.isArray(group && group.buckets) ? group.buckets : []) {
      // disabled=true 是 Google 自己的说法（"该窗口当前不适用"），
      // 不是一个读数：跳过它，让这一行保持「未知」而不是继承过期的值。
      if (b && b.disabled === true) continue;
      const win = String((b && (b.window || b.bucketId)) || '').toLowerCase();
      let key = null;
      if (win.includes('5h') || win.includes('five_hour') || win.includes('5-hour')) key = '5h';
      else if (win.includes('weekly') || win.includes('week')) key = 'weekly';
      if (!key) continue;

      windows.push(
        makeWindow(
          WINDOW_LABEL[key],
          b.remainingFraction,
          b.resetTime,
          WINDOW_SECONDS[key]
        )
      );
    }
    if (windows.length === 0) continue;

    // 固定顺序：5 小时在前、每周在后，与官方面板一致
    windows.sort((a, b) => (a.windowSeconds || 0) - (b.windowSeconds || 0));
    out.push({ label, description: desc, windows });
  }
  return out;
}

/**
 * 回退路径：把 agy-cli /status 压平后的 family 还原成"分组"形态。
 * 显示状态接口中可用的 Gemini 与 Claude/GPT 额度组。
 */
function groupsFromStatus(quotas) {
  const out = [];
  const google = quotas && quotas.google;
  if (google) {
    const windows = [];
    if (google.fiveHourUnknown !== true) {
      windows.push(makeWindow('5 小时配额', google.remainingFraction, google.resetTime, 18000));
    } else {
      windows.push(makeWindow('5 小时配额', null, google.resetTime, 18000));
    }
    if ('weeklyFraction' in google || 'weeklyResetTime' in google) {
      windows.push(makeWindow('每周配额', google.weeklyFraction, google.weeklyResetTime, 604800));
    }
    out.push({
      label: 'Gemini 模型',
      description: String((google && google.description) || ''),
      windows,
    });
  }
  // anthropic 与 openai 在 antigravity 里是同一个 group 的两个别名，只取一个
  const third = (quotas && quotas.anthropic) || (quotas && quotas.openai);
  if (third) {
    const windows = [];
    if (third.fiveHourUnknown !== true) {
      windows.push(makeWindow('5 小时配额', third.remainingFraction, third.resetTime, 18000));
    }
    if ('weeklyFraction' in third || 'weeklyResetTime' in third) {
      windows.push(makeWindow('每周配额', third.weeklyFraction, third.weeklyResetTime, 604800));
    }
    if (windows.length) {
      out.push({
        label: 'Claude 与 GPT 模型',
        description: String((third && third.description) || ''),
        windows,
      });
    }
  }
  return out;
}

/** 把所有分组里的已知窗口摊平，用于算汇总值。 */
function flattenWindows(groups) {
  const all = [];
  for (const g of groups) for (const w of g.windows || []) all.push(w);
  return all;
}

/**
 * 走原始接口拿完整额度池。
 * @returns {Promise<{groups:Array, description:string}|{expired:true}|null>}
 *          失败返回 null（不抛）
 */
async function fetchRawGroups(config) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 第一次用缓存令牌；第二次强制重新读 —— 因为 agy-cli 的 /status 可能刚刚
    // 触发了令牌轮换，此时缓存里是被替换掉的旧令牌，请求必然 401。
    const token = await readAntigravityToken({ force: attempt > 1 });
    if (!token || !token.accessToken) return null;
    if (token.expired) {
      // 令牌过期时不请求（必然 401）。等 agy-cli 下次续期后自然恢复。
      return { expired: true, groups: [], description: '' };
    }
    try {
      const json = await httpPostJson(QUOTA_URL, {}, {
        headers: Object.assign({ accept: 'application/json' }, IDENTITY_HEADERS, {
          Authorization: 'Bearer ' + token.accessToken,
        }),
        timeoutMs: Math.min(config.requestTimeoutMs, 15000),
        // 这个域名必须走代理（直连挂起），交给 http.js 的探测逻辑
        proxy: config.proxy,
      });
      const groups = parseGroups(json);
      if (groups.length === 0) return null;
      return {
        groups,
        description: String((json && json.description) || ''),
      };
    } catch (e) {
      const status = Number(e && e.status);
      const msg = String((e && e.message) || e);
      // 401/403 = 令牌已失效：强制重读一次再试，第二次还失败就交给回退路径
      if ((status === 401 || status === 403) && attempt === 1) {
        if (process.env.QH_DEBUG === '1') {
          console.error('[quota-hub] 原始额度接口 401，重读令牌后重试');
        }
        continue;
      }
      // 排障时设 QH_DEBUG=1 可以看到真实原因
      if (process.env.QH_DEBUG === '1') {
        console.error('[quota-hub] 原始额度接口失败:', msg);
      }
      return null;
    }
  }
  return null;
}

/**
 * 拉取 Gemini 额度。
 * @param {object} credentials resolveCredentials() 的返回（本适配器不使用）
 * @param {object} config 归一化配置
 * @param {object} [runtime] { webPort }
 * @returns {Promise<object>} 统一结构
 */
async function fetch(credentials, config, runtime) {
  const t0 = Date.now();
  const port = resolvePort(config, runtime);
  const notes = [];
  let account = null;
  let auth = null;

  // ---- 1. 先读 agy-cli 状态：既提供账号信息，也是原始接口失败时的回退数据 ----
  let status = null;
  let statusError = null;
  if (port > 0) {
    try {
      status = await httpGetJson(`http://127.0.0.1:${port}/plugins/agy-cli/status`, {
        headers: { accept: 'application/json' },
        timeoutMs: Math.min(config.requestTimeoutMs, 15000),
        // 本机回环，不需要代理
        proxy: '',
      });
    } catch (e) {
      statusError = e;
    }
  } else {
    notes.push('未提供 DSH Web 端口，跳过 agy-cli 状态接口');
  }

  if (status) {
    auth = status.auth || null;
    const pool = status.pool || {};
    const acc = (pool.accounts || [])[0] || null;
    account = (acc && (acc.email || acc.label)) || null;

    // 登录态判断放在额度之前，否则会把"没登录"显示成"没额度"
    if (status.quotaError === 'unauthorized' || (auth && auth.phase === 'expired')) {
      return failResult(
        ID,
        LABEL,
        'error',
        'Gemini 登录已过期，请在 AGY 插件中重新授权',
        { kind: 'percent', account, ms: Date.now() - t0 }
      );
    }
  } else if (statusError) {
    // 读状态失败**不立即放弃**：原始额度接口只依赖凭据管理器里的令牌，
    // 完全不经过 DSH Web 端口，所以端口推断错了也照样能拿到额度。
    // 先把它记下来，等原始接口也失败时再决定如何报错。
    notes.push('读取 agy-cli 状态失败：' + String((statusError && statusError.message) || statusError).slice(0, 80));
  }

  // ---- 2. 首选原始接口：能拿到完整的三个 group ----
  let groups = [];
  let rawUsed = false;
  const raw = await fetchRawGroups(config);
  if (raw && raw.groups && raw.groups.length) {
    groups = raw.groups;
    rawUsed = true;
    if (raw.description) notes.push(raw.description);
  } else if (raw && raw.expired) {
    notes.push('Antigravity 访问令牌已过期，等 agy-cli 自动续期后恢复');
  }

  // ---- 3. 回退：agy-cli 压平后的 family ----
  if (groups.length === 0 && status) {
    const pool = status.pool || {};
    const acc = (pool.accounts || [])[0] || null;
    groups = groupsFromStatus((acc && acc.quotas) || {});
    if (groups.length) {
      notes.push('额度数据来自 agy-cli 状态接口（已压平，可能缺少部分窗口）');
    }
  }

  // ---- 3.5 两条路都没拿到：此时才把状态接口的错误映射成明确结论 ----
  if (groups.length === 0 && statusError) {
    const msg = String((statusError && statusError.message) || statusError);
    if (/HTTP 404/i.test(msg)) {
      // 404 = 没装/没启用 dsh-agy-cli：这是"本机没这个能力"，不是错误
      return failResult(
        ID,
        LABEL,
        'unavailable',
        'Gemini 额度接口不可用，请检查 dsh-agy-cli 是否已安装并启用',
        { kind: 'percent', ms: Date.now() - t0 }
      );
    }
    if (/ECONNREFUSED/i.test(msg)) {
      return failResult(
        ID,
        LABEL,
        'error',
        '无法连接 Gemini 额度服务，请检查 DSH 服务和网络设置',
        { kind: 'percent', notes, ms: Date.now() - t0 }
      );
    }
  }

  if (groups.length === 0) {
    return failResult(ID, LABEL, 'unavailable', '上游未上报可用的额度窗口', {
      kind: 'percent',
      account,
      notes,
      ms: Date.now() - t0,
    });
  }

  // ---- 4. 汇总：所有已知窗口里剩余百分比最低的那个 ----
  const all = flattenWindows(groups);
  const known = all.filter((w) => !w.unknown && w.remainingPercent !== null);
  if (known.length === 0) {
    return failResult(ID, LABEL, 'unavailable', '上游未上报可用的额度窗口', {
      kind: 'percent',
      account,
      groups,
      notes,
      ms: Date.now() - t0,
    });
  }
  const worst = known.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));

  // ---- 5. 附注 ----
  if (auth && auth.phase === 'signed_in' && Number(auth.tokenExpiresInSeconds) > 0) {
    const mins = Math.round(Number(auth.tokenExpiresInSeconds) / 60);
    notes.push(`登录态剩余约 ${mins} 分钟（agy-cli 会自动续期）`);
  }
  if (rawUsed) notes.push('数据源：Antigravity 原始额度接口');

  return makeResult({
    id: ID,
    label: LABEL,
    status: 'ok',
    kind: 'percent',
    plan: null,
    account,
    remaining: worst.remainingPercent,
    used: worst.usedPercent,
    unit: '%',
    windows: all,
    groups,
    notes,
    fetchedAt: Date.now(),
    ms: Date.now() - t0,
  });
}

module.exports = { id: ID, label: LABEL, fetch, resolvePort };
