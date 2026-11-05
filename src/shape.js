'use strict';

/**
 * src/shape.js
 * ----------------------------------------------------------------------------
 * 三家适配器的**统一返回结构**。前端只需要认这一份契约，不必关心每家 API
 * 的原始字段差异。
 *
 * {
 *   id:      'deepseek' | 'codex' | 'agy',
 *   label:   'DeepSeek' | 'GPT (Codex)' | 'Gemini',
 *   status:  'ok' | 'unavailable' | 'error' | 'missing_key',
 *   kind:    'money' | 'percent',   // 额度形态：真金额 / 百分比速率窗口
 *   plan:    'plus' | 'Pro' | null, // 订阅计划（若平台提供）
 *   account: 'j35*****57@gmail.com' | null,
 *
 *   // kind='money' 时有效：金额数值 + 币种
 *   remaining: 17.42, used: 168.59, unit: 'CNY',
 *
 *   // kind='percent' 时有效：取所有窗口里「剩余百分比最低」的那个作为汇总值
 *   remaining: 60, used: 40, unit: '%',
 *
 *   // 明细窗口（kind='percent' 时至少一项；money 时为空数组）
 *   windows: [{ label:'5小时窗口', remainingPercent:60, usedPercent:40,
 *               resetsAt: <ms>|null, windowSeconds:18000, unknown:false }],
 *
 *   // 分组窗口（Gemini 的额度按 group 划分：Gemini 模型 / Claude 与 GPT / Argon）
 *   groups: [{ label:'Gemini 模型', description:'', windows:[...] }],
 *
 *   // DeepSeek 专用：峰谷时段（见 src/peak.js）
 *   peak: { phase:'peak'|'offPeak', reason:'window'|'weekend'|'holiday'|'preRule',
 *           nextAtMs:<ms>|null, nextPhase:'peak'|'offPeak'|null,
 *           dayStartMs, dayEndMs, nowMs, segments:[{phase,from,to}] },
 *
 *   // DeepSeek 专用：今日消耗（见 src/usage.js）
 *   usage: { today: 7.88, currency:'CNY', sinceMs:<ms>|null, credits:0,
 *            source:'self'|'dsh-usage'|'none', history:[{date,amount}] },
 *
 *   notes: ['计划：plus', '赠送余额：0 USD'],  // 附注（原样展示，非关键信息）
 *   message: '',       // 失败/降级时的中文说明
 *   fetchedAt: <ms>,
 *   ms: 905            // 本次请求耗时
 * }
 * ----------------------------------------------------------------------------
 */

/** 数值收敛到 [min, max]；非有限值返回 null */
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * 百分比保留两位小数。
 * 上游常给出 0.9859288 这类分数，乘 100 会得到 98.59288000000001 这种
 * 浮点噪声（JS 二进制浮点的固有表现），直接展示会很难看，所以在这里统一收敛。
 *
 * 「未知」必须原样保留为 null：注意 Number(null) === 0 且是有限值，若只做
 * Number.isFinite 判断，未知窗口会被悄悄变成「0% 剩余」——那正好是最危险的
 * 误导（一个已耗尽的账号显示 0%，一个未知窗口也可能就是 0%）。因此这里先
 * 显式排除 null / undefined / 空字符串。
 */
function round2(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * 构造一条标准结果。传 partial 覆盖默认值。
 *
 * 这里顺带做两处**展示层归一**，让三个适配器都不必各自重复处理：
 *   1. 百分比窗口的 remainingPercent / usedPercent 收敛到两位小数；
 *   2. kind='percent' 时 remaining / used 同样收敛到两位小数。
 * 金额型（kind='money'）不做四舍五入，保留上游精度，格式化交给客户端。
 *
 * @param {object} partial
 * @returns {object}
 */
function makeResult(partial) {
  const result = Object.assign(
    {
      id: '',
      label: '',
      status: 'ok',
      kind: 'percent',
      plan: null,
      account: null,
      remaining: null,
      used: null,
      unit: '',
      windows: [],
      groups: [],
      peak: null,
      usage: null,
      notes: [],
      message: '',
      fetchedAt: Date.now(),
      ms: 0,
    },
    partial || {}
  );

  // 明细窗口的百分比收敛
  if (Array.isArray(result.windows)) {
    result.windows = result.windows.map((w) =>
      Object.assign({}, w, {
        remainingPercent: round2(w.remainingPercent),
        usedPercent: round2(w.usedPercent),
      })
    );
  }

  // 分组窗口同样收敛（Gemini 按 group 展示时用）
  if (Array.isArray(result.groups)) {
    result.groups = result.groups.map((g) =>
      Object.assign({}, g, {
        windows: Array.isArray(g && g.windows)
          ? g.windows.map((w) =>
              Object.assign({}, w, {
                remainingPercent: round2(w.remainingPercent),
                usedPercent: round2(w.usedPercent),
              })
            )
          : [],
      })
    );
  }

  // 百分比型的汇总值收敛（金额型保留原精度）
  if (result.kind === 'percent') {
    result.remaining = round2(result.remaining);
    result.used = round2(result.used);
  }

  return result;
}

/**
 * 便捷构造：失败/降级结果。
 * @param {string} id
 * @param {string} label
 * @param {'error'|'unavailable'|'missing_key'} status
 * @param {string} message 中文说明
 * @param {object} [extra] 额外字段（如 kind / ms）
 */
function failResult(id, label, status, message, extra) {
  return makeResult(
    Object.assign(
      {
        id,
        label,
        status,
        message: message || '',
      },
      extra || {}
    )
  );
}

/**
 * 把「重置时间」统一成毫秒时间戳。
 * 支持三种来源（各家 API 风格不同）：
 *   - 绝对秒级时间戳（GPT 的 reset_at）
 *   - 相对秒数（GPT 的 reset_after_seconds）
 *   - ISO 字符串（Gemini 的 weeklyResetTime）
 *
 * @param {*} absolute 绝对时间（秒或毫秒或 ISO 串）
 * @param {*} afterSeconds 相对秒数
 * @returns {number|null} 毫秒时间戳
 */
function toResetAt(absolute, afterSeconds) {
  // 1) 绝对时间戳
  if (absolute !== null && absolute !== undefined && absolute !== '') {
    if (typeof absolute === 'string') {
      const parsed = Date.parse(absolute);
      if (Number.isFinite(parsed)) return parsed;
      const numStr = Number(absolute);
      if (Number.isFinite(numStr) && numStr > 0) {
        // 10 位是秒，13 位是毫秒
        return numStr < 1e12 ? numStr * 1000 : numStr;
      }
    } else {
      const n = Number(absolute);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    }
  }
  // 2) 相对秒数
  const rel = Number(afterSeconds);
  if (Number.isFinite(rel) && rel > 0) return Date.now() + rel * 1000;
  return null;
}

module.exports = { makeResult, failResult, clamp, round2, toResetAt };
