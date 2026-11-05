'use strict';

/**
 * src/usage.js
 * ----------------------------------------------------------------------------
 * DeepSeek「今日消耗」统计。
 *
 * 为什么需要自己记账：
 *   DeepSeek 的 ```get_user_summary``` 只给**当前余额**和**累计消费**，
 *   没有「今天花了多少」这种按天聚合的字段。官方网页版的日用量也是
 *   前端自己用余额差算出来的。所以唯一诚实的做法是：
 *     今日消耗 = 今日起始余额 + 今日充值 − 当前余额
 *
 * 我们自己按天记账：
 *   - 每次成功拿到余额就与上一次比较，余额**减少**记为消耗，
 *     余额**增加**记为充值（这样用户中途充值不会把消耗算成负数）；
 *   - 状态写在 `$DSH_HOME/dsh-quota-ring/usage-state.json`，DSH 重启后接着算；
 *   - 首次安装时，若 DSH 自己已经维护过一份 `.dshw-usage.json`（同一天），
 *     就用它当天已记录的消耗作为起点，避免"从此刻开始算"显得像没花钱。
 *
 * 日期边界用 UTC+8 的日历日（北京时间 / 新加坡时间同为 +8，无夏令时）。
 * ----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR_NAME = 'dsh-quota-ring';
const STATE_FILE_NAME = 'usage-state.json';
const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;
const HISTORY_LIMIT = 30;

/** 北京时间日历日，形如 2026-11-05。 */
function dayKey(atMs) {
  return new Date(Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** 金额保留 4 位小数：余额是十进制字符串，直接相减会出现浮点噪声。 */
function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function stateFilePath(homeDir) {
  return path.join(homeDir, STATE_DIR_NAME, STATE_FILE_NAME);
}

/** 读状态文件；不存在或损坏都当作空状态，绝不因为记账失败影响额度展示。 */
function loadState(homeDir) {
  try {
    const raw = fs.readFileSync(stateFilePath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 原子写：先写临时文件再 rename，避免 DSH 退出时留下半个 JSON。 */
function saveState(homeDir, state) {
  const file = stateFilePath(homeDir);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 DSH 自己维护的 `.dshw-usage.json`（若存在且是今天）作为种子。
 * 这个文件由 DSH 的账号额度跟踪维护，字段为
 *   { date, lastBalance, todayUsage, history, ... }
 * 它可能停止更新（例如对应机制被移除），所以只当作**起点**，
 * 之后完全由我们自己累加。读不到就返回 null，不影响主流程。
 */
function readSeed(homeDir, todayKey) {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.dshw-usage.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.date !== todayKey) return null;
    const usage = Number(parsed.todayUsage);
    const last = Number(parsed.lastBalance);
    if (!Number.isFinite(usage) || usage < 0) return null;
    return {
      debits: usage,
      lastBalance: Number.isFinite(last) ? last : null,
      source: 'dsh-usage',
    };
  } catch {
    return null;
  }
}

/**
 * 记录一次余额观测，返回今日消耗汇总。
 *
 * @param {object} params
 * @param {number} params.balance 当前余额（正数）
 * @param {string} [params.currency] 币种，默认 CNY
 * @param {string} params.homeDir  DSH 用户数据目录
 * @param {number} [params.nowMs]
 * @returns {{today:number, currency:string, sinceMs:number|null, credits:number, source:string, history:Array<{date:string,amount:number}>}}
 */
function observeBalance(params) {
  const balance = Number(params && params.balance);
  const currency = (params && params.currency) || 'CNY';
  const homeDir = params && params.homeDir;
  const nowMs = Number.isFinite(params && params.nowMs) ? params.nowMs : Date.now();

  // 记账是附加信息：任何一步失败都返回「本轮不展示」，绝不抛给调用方
  const empty = { today: null, currency, sinceMs: null, credits: 0, source: 'none', history: [] };
  if (!Number.isFinite(balance) || balance < 0 || !homeDir) return empty;

  const today = dayKey(nowMs);
  let state = loadState(homeDir);

  // 跨天：把昨天的消耗归档进历史，然后以当前余额作为今天的新起点
  if (!state || state.date !== today) {
    const history = Object.assign({}, state && state.history);
    if (state && state.date && Number.isFinite(state.debits)) {
      history[state.date] = round4(state.debits);
    }
    state = {
      date: today,
      debits: 0,
      credits: 0,
      lastBalance: balance,
      currency,
      sinceMs: nowMs,
      source: 'self',
      history,
    };
    // 首次安装时尝试用 DSH 已有的日用量做起点，避免明明已经花了不少钱却显示 ¥0
    const seed = readSeed(homeDir, today);
    if (seed) {
      state.debits = round4(seed.debits);
      state.lastBalance = Number.isFinite(seed.lastBalance) ? seed.lastBalance : balance;
      state.source = seed.source;
      // 种子来自更早的观测，当日起点时间未知：置空以免界面宣称「自 xx:xx 起」
      state.sinceMs = null;
    }
  }

  // 同一天：比较余额变化，区分「消耗」与「充值」
  if (Number.isFinite(state.lastBalance)) {
    const delta = state.lastBalance - balance;
    if (delta > 0) {
      state.debits = round4((Number(state.debits) || 0) + delta);
    } else if (delta < 0) {
      state.credits = round4((Number(state.credits) || 0) + -delta);
    }
  }
  state.lastBalance = balance;
  state.currency = currency;
  state.updatedAt = nowMs;

  // 历史只保留最近 30 天
  const hist = Object.assign({}, state.history);
  hist[today] = round4(state.debits);
  const keys = Object.keys(hist).sort().slice(-HISTORY_LIMIT);
  state.history = {};
  for (const k of keys) state.history[k] = hist[k];

  saveState(homeDir, state);

  return {
    today: round4(state.debits),
    currency,
    sinceMs: Number.isFinite(state.sinceMs) ? state.sinceMs : null,
    credits: round4(state.credits),
    source: state.source || 'self',
    history: keys.map((date) => ({ date, amount: hist[date] })),
  };
}

module.exports = { observeBalance, dayKey, stateFilePath, round4 };
