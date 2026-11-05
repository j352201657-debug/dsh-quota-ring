'use strict';

/** DeepSeek 额度适配器：读取余额和累计消费，附加时段与消耗估算。 */

const { httpGetJson } = require('../http');
const { makeResult, failResult } = require('../shape');
const { debug } = require('../log');
const { peakSnapshot } = require('../peak');
const { observeBalance } = require('../usage');

/** 适配器 id（同时也是 credentials 的 key） */
const ID = 'deepseek';
const LABEL = 'DeepSeek';

/** 把钱包数组里指定币种的金额求和（无法解析的项按 0 计） */
function sumByCurrency(list, field, currency) {
  if (!Array.isArray(list)) return 0;
  return list
    .filter((x) => x && x.currency === currency)
    .reduce((sum, x) => {
      const n = parseFloat(x[field]);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
}

/** 金额格式化成两位小数（仅用于 notes 文案） */
function fmt(n) {
  return Number(n).toFixed(2);
}

/**
 * 拉取 DeepSeek 余额。
 * @param {object} credentials resolveCredentials() 的返回
 * @param {object} config 归一化配置
 * @returns {Promise<object>} 统一结构
 */
async function fetch(credentials, config) {
  const t0 = Date.now();
  const grant = credentials && credentials[ID];

  // ---- 1. 凭据检查（缺失 → missing_key，属「可预期降级」，不算错误）----
  if (!grant || grant.ok === false || !grant.token) {
    return failResult(ID, LABEL, 'missing_key', (grant && grant.error) || '未找到 DeepSeek 账号登录凭据', {
      kind: 'money',
      ms: Date.now() - t0,
    });
  }

  const base = String(grant.issuer || 'https://platform.deepseek.com').replace(/\/+$/, '');
  const url = base + '/api/v0/users/get_user_summary';

  // ---- 2. 发起请求 ----
  let json;
  try {
    json = await httpGetJson(url, {
      headers: {
        // 不是 Authorization: Bearer，DSH 用的是自定义头 x-dsh-auth-token
        'x-dsh-auth-token': grant.token,
        accept: 'application/json',
      },
      timeoutMs: config.requestTimeoutMs,
      proxy: config.proxy,
    });
  } catch (e) {
    const raw = String((e && e.message) || e);
    debug(ID + ' 上游请求失败:', raw);
    let hint = raw;
    // 把上游错误翻译成用户能理解、能行动的话
    if (/HTTP 401|HTTP 403|40003/i.test(raw)) {
      hint = '账号凭据已失效，请在 DSH 设置 → 账号里重新登录 DeepSeek';
    } else if (/超时|timeout|ETIMEDOUT/i.test(raw)) {
      hint = '请求超时（可能需要配置代理 proxy）';
    }
    return failResult(ID, LABEL, 'error', '请求失败：' + hint, {
      kind: 'money',
      ms: Date.now() - t0,
    });
  }

  // ---- 3. 解析响应 ----
  // 业务层可能返回 code!=0（HTTP 200 但业务失败），必须先判 biz_data
  const biz = json && json.data && json.data.biz_data;
  if (!biz) {
    const code = json && json.code;
    const msg = (json && (json.msg || (json.data && json.data.biz_msg))) || '未知业务错误';
    return failResult(ID, LABEL, 'error', `响应异常：${msg}${code ? '（code ' + code + '）' : ''}`, {
      kind: 'money',
      ms: Date.now() - t0,
    });
  }

  const normalWallets = Array.isArray(biz.normal_wallets) ? biz.normal_wallets : [];
  const bonusWallets = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets : [];
  const totalCosts = Array.isArray(biz.total_costs) ? biz.total_costs : [];

  // 主币种选择：优先 CNY（默认展示币种），否则取出现的第一个币种
  const seen = [
    ...new Set(
      normalWallets
        .concat(bonusWallets)
        .concat(totalCosts)
        .map((w) => w && w.currency)
        .filter(Boolean)
    ),
  ];
  const currency = seen.includes('CNY') ? 'CNY' : seen[0] || 'CNY';

  const normal = sumByCurrency(normalWallets, 'balance', currency);
  const bonus = sumByCurrency(bonusWallets, 'balance', currency);
  const used = sumByCurrency(totalCosts, 'amount', currency);
  const remaining = normal + bonus;

  // ---- 4. 附注：把赠送余额、其他币种一并说明，避免「数字对不上」的困惑 ----
  const notes = [];
  if (bonus > 0) notes.push(`含赠送余额 ${fmt(bonus)} ${currency}`);
  const otherCurrencies = seen.filter((c) => c !== currency);
  for (const c of otherCurrencies) {
    const rem = sumByCurrency(normalWallets, 'balance', c) + sumByCurrency(bonusWallets, 'balance', c);
    if (rem > 0) notes.push(`${c} 余额 ${fmt(rem)} ${c}`);
  }
  if (used > 0) notes.push(`累计消费 ${fmt(used)} ${currency}`);

  // ---- 5. 峰谷时段（官方计价规则，见 src/peak.js）----
  // 这是「计价」信息而不是「额度」信息：DeepSeek 在峰时段单价更高，
  // 用户需要知道现在是不是贵的时候、还有多久切换。
  let peak = null;
  try {
    peak = peakSnapshot(Date.now(), {
      windows: config.deepseekPeakWindows,
      holidays: config.deepseekPeakHolidays,
    });
  } catch (e) {
    peak = null; // 峰谷只是附加信息，失败不影响额度展示
  }

  // ---- 6. 今日消耗（按天记账，见 src/usage.js）----
  // DeepSeek 没有按天聚合的官方字段，只能用余额差自己记。
  let usage = null;
  try {
    usage = observeBalance({
      balance: remaining,
      currency,
      homeDir: config.dshHome || require('../credentials').resolveHome(config),
    });
  } catch (e) {
    usage = null;
  }
  if (usage && usage.today !== null && usage.today > 0) {
    const sinceHint = usage.sinceMs
      ? `（自 ${new Date(usage.sinceMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 起）`
      : '';
    notes.push(`今日消耗 ${fmt(usage.today)} ${currency}${sinceHint}`);
  }

  return makeResult({
    id: ID,
    label: LABEL,
    status: 'ok',
    kind: 'money',
    account: null, // 余额接口不返回邮箱；如需展示可另调 /auth-api/v0/users/current
    remaining,
    used,
    unit: currency,
    windows: [],
    peak,
    usage,
    notes,
    fetchedAt: Date.now(),
    ms: Date.now() - t0,
  });
}

module.exports = { id: ID, label: LABEL, fetch };
