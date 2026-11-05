'use strict';

/** Codex 额度适配器：读取订阅账号的速率窗口。 */

const { httpGetJson } = require('../http');
const { makeResult, failResult, clamp, toResetAt } = require('../shape');
const { debug } = require('../log');

const ID = 'codex';
const LABEL = 'GPT (Codex)';

/** 上游端点（与 dsh-codex-subscription 完全一致） */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** 窗口缺省长度（秒）：primary=5h，secondary=7d */
const DEFAULT_WINDOW_SECONDS = { primary: 18000, secondary: 604800 };

/**
 * 解析一个「速率窗口」对象。
 * @param {string} label 展示用中文名
 * @param {object} win 上游窗口对象
 * @param {number} defaultSeconds 缺省窗口长度
 * @returns {object|null}
 */
function parseWindow(label, win, defaultSeconds) {
  if (!win || typeof win !== 'object') return null;

  // 已用百分比：上游是 0-100 的数值；非法值直接放弃该窗口
  const usedPercent = clamp(win.used_percent, 0, 100);
  if (usedPercent === null) return null;

  return {
    label,
    usedPercent,
    remainingPercent: clamp(100 - usedPercent, 0, 100),
    windowSeconds: Number(win.limit_window_seconds) || defaultSeconds,
    resetsAt: toResetAt(win.reset_at, win.reset_after_seconds),
    unknown: false,
  };
}

/**
 * 拉取 GPT 额度。
 * @param {object} credentials resolveCredentials() 的返回
 * @param {object} config 归一化配置
 * @returns {Promise<object>} 统一结构
 */
async function fetch(credentials, config) {
  const t0 = Date.now();
  const cred = credentials && credentials[ID];

  // ---- 1. 凭据检查 ----
  if (!cred || cred.ok === false || !cred.access) {
    return failResult(ID, LABEL, 'missing_key', (cred && cred.error) || '未找到 Codex 订阅登录凭据', {
      kind: 'percent',
      ms: Date.now() - t0,
    });
  }

  // ---- 2. 本地过期预判：省掉一次注定 401 的网络往返 ----
  const expires = Number(cred.expires) || 0;
  if (expires > 0 && Date.now() > expires) {
    return failResult(
      ID,
      LABEL,
      'error',
      '登录凭据已过期，请在 DSH 的 Codex 订阅插件里重新登录',
      { kind: 'percent', ms: Date.now() - t0 }
    );
  }

  // ---- 3. 发起请求 ----
  let json;
  try {
    json = await httpGetJson(USAGE_URL, {
      headers: {
        authorization: 'Bearer ' + cred.access,
        // 必须带 chatgpt-account-id，否则 chatgpt.com 会 403 / 返回错账号
        'chatgpt-account-id': cred.accountId,
        accept: 'application/json',
        'user-agent': 'dsh-quota-ring/3.1.1',
      },
      timeoutMs: config.requestTimeoutMs,
      proxy: config.proxy,
    });
  } catch (e) {
    const raw = String((e && e.message) || e);
    debug(ID + ' 上游请求失败:', raw);
    let hint = raw;
    if (/HTTP 401|HTTP 403/i.test(raw)) {
      hint = '登录态失效或被拒绝，请在 DSH 的 Codex 订阅插件里重新登录';
    } else if (/超时|timeout|ETIMEDOUT/i.test(raw)) {
      hint = '请求超时（chatgpt.com 通常需要代理，请检查 proxy 配置）';
    }
    return failResult(ID, LABEL, 'error', '请求失败：' + hint, {
      kind: 'percent',
      ms: Date.now() - t0,
    });
  }

  // ---- 4. 解析 ----
  const rateLimit = (json && json.rate_limit) || {};
  const windows = [];

  const primary = parseWindow('5小时窗口', rateLimit.primary_window, DEFAULT_WINDOW_SECONDS.primary);
  if (primary) windows.push(primary);
  const secondary = parseWindow('周窗口', rateLimit.secondary_window, DEFAULT_WINDOW_SECONDS.secondary);
  if (secondary) windows.push(secondary);

  // Code review 等附加限流窗口（部分账号有）
  const extraLimits = json && json.additional_rate_limits;
  if (Array.isArray(extraLimits)) {
    for (const item of extraLimits) {
      const name = (item && (item.metered_feature || item.feature_name || item.name)) || '附加窗口';
      const w = parseWindow(String(name), item, 18000);
      if (w) windows.push(w);
    }
  }

  if (windows.length === 0) {
    // 账号存在但没上报任何窗口 —— 不假装 0%，如实降级
    return failResult(ID, LABEL, 'unavailable', '上游未上报速率窗口（该账号可能不适用）', {
      kind: 'percent',
      plan: json && json.plan_type,
      account: cred.email || null,
      ms: Date.now() - t0,
    });
  }

  // 汇总值取「剩余最少」的窗口 —— 用于额度总览
  const worst = windows.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));

  // ---- 5. 附注 ----
  const notes = [];
  if (json && json.plan_type) notes.push('计划：' + json.plan_type);
  const credits = (json && json.credits) || null;
  if (credits) {
    if (credits.unlimited) notes.push('额度不限额');
    else if (credits.has_credits && credits.balance && Number(credits.balance) > 0) {
      notes.push('额外额度：' + credits.balance);
    }
  }
  if (rateLimit.limit_reached) notes.push('⚠ 该窗口已用尽');

  return makeResult({
    id: ID,
    label: LABEL,
    status: 'ok',
    kind: 'percent',
    plan: (json && json.plan_type) || null,
    account: (json && json.email) || cred.email || null,
    // 汇总：最紧的窗口
    remaining: worst.remainingPercent,
    used: worst.usedPercent,
    unit: '%',
    windows,
    notes,
    fetchedAt: Date.now(),
    ms: Date.now() - t0,
  });
}

module.exports = { id: ID, label: LABEL, fetch };
