'use strict';

/** 额度响应结构、百分比和重置时间的归一化。 */

/** 数值收敛到 [min, max]；非有限值返回 null */
function clamp(value, min, max) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** 百分比保留两位小数；缺失、空白和布尔值保持为 null。 */
function round2(value) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) return null;
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
      const numStr = Number(absolute);
      if (Number.isFinite(numStr) && numStr > 0) {
        // 10 位是秒，13 位是毫秒
        return numStr < 1e12 ? numStr * 1000 : numStr;
      }
      const parsed = Date.parse(absolute);
      if (Number.isFinite(parsed) && !/^\s*\d+\s*$/.test(absolute)) return parsed;
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
