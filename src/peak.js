'use strict';

/** 按内置或自定义时段计算 DeepSeek 峰谷提示。计费以平台账单为准。 */

/** 峰时段窗口（UTC 小时，半开区间）。与 dsh-cost-meter 的 DEFAULT_PEAK_WINDOWS 一致。 */
const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

/** 峰谷规则生效时刻（此前按基础价，无峰谷之分）。 */
const PEAK_EFFECTIVE_AT = Date.parse('2026-08-16T16:00:00Z');

/** 周末全天谷价的生效时刻。 */
const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z');

/**
 * 中国公众假期（北京时间日历日）。来自国务院办公厅 2026 年安排中
 * 峰谷规则生效之后剩余的假期。新的一年需要补充。
 */
const DEFAULT_PEAK_HOLIDAYS = [
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
];

const BEIJING_OFFSET_MS = 8 * 3600000;
const DAY_MS = 86400000;

/**
 * 取某个时刻的「北京时间日历日」字符串，形如 2026-11-05。
 * 注意：这里必须整体平移到 UTC+8 再取 UTC 年月日，
 * 直接对本地时间取日期会在跨时区的机器上算错。
 */
function beijingDayKey(atMs) {
  return new Date(Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** 该时刻是否落在北京时间的周末（周五 16:00Z 起算到周日 16:00Z）。 */
function isBeijingWeekend(atMs) {
  if (atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return false;
  const day = new Date(Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS).getUTCDay();
  return day === 0 || day === 6;
}

/** 该时刻是否落在配置的中国公众假期（北京时间日历日）。 */
function isHoliday(atMs, holidays) {
  if (!Array.isArray(holidays) || holidays.length === 0) return false;
  return holidays.includes(beijingDayKey(atMs));
}

/**
 * 判断某一时刻处于峰还是谷。
 * @param {number} atMs 毫秒时间戳
 * @param {Array<{start:number,end:number}>} windows 峰时段窗口（UTC 小时）
 * @param {string[]} holidays 节假日（北京时间日期）
 * @returns {{phase:'peak'|'offPeak', reason:'weekend'|'holiday'|'window'|'preRule'}}
 */
function phaseAt(atMs, windows, holidays) {
  const ws = Array.isArray(windows) && windows.length ? windows : DEFAULT_PEAK_WINDOWS;
  const hs = Array.isArray(holidays) ? holidays : DEFAULT_PEAK_HOLIDAYS;

  // 规则生效前没有峰谷之分，按「平价」呈现，并标注原因
  if (!Number.isFinite(atMs) || atMs < PEAK_EFFECTIVE_AT) {
    return { phase: 'offPeak', reason: 'preRule' };
  }
  if (isHoliday(atMs, hs)) return { phase: 'offPeak', reason: 'holiday' };
  if (isBeijingWeekend(atMs)) return { phase: 'offPeak', reason: 'weekend' };

  const hour = new Date(atMs).getUTCHours()
    + new Date(atMs).getUTCMinutes() / 60
    + new Date(atMs).getUTCSeconds() / 3600;

  for (const w of ws) {
    const start = Number(w && w.start);
    const end = Number(w && w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // 常规窗口与跨午夜窗口都支持
    const hit = start < end ? hour >= start && hour < end : hour >= start || hour < end;
    if (hit) return { phase: 'peak', reason: 'window' };
  }
  return { phase: 'offPeak', reason: 'window' };
}

/**
 * 找出「下一次相位切换」的时刻。
 *
 * 做法：把所有可能发生切换的候选时刻都枚举出来（每个 UTC 日的 00:00、
 * 峰窗口的起止点，以及北京时间午夜 = UTC 16:00 用于周末进出），
 * 再逐个比较相邻候选的相位是否变化。窗口数量很少，候选表只有几十项，
 * 不需要更复杂的算法。
 *
 * @param {number} atMs 当前时刻
 * @param {Array<{start:number,end:number}>} windows
 * @param {string[]} holidays
 * @returns {{phase:string, reason:string, nextAtMs:number|null, nextPhase:string|null}}
 */
function describeNow(atMs, windows, holidays) {
  const ws = Array.isArray(windows) && windows.length ? windows : DEFAULT_PEAK_WINDOWS;
  const hs = Array.isArray(holidays) ? holidays : DEFAULT_PEAK_HOLIDAYS;
  const now = phaseAt(atMs, ws, hs);

  // 候选切换点：向前向后各 9 天足够覆盖最长的连续假期
  const hours = new Set([0, 16]);
  for (const w of ws) {
    const s = Number(w && w.start);
    const e = Number(w && w.end);
    if (Number.isFinite(s)) hours.add(s % 24);
    if (Number.isFinite(e)) hours.add(e % 24);
  }
  const midnight = Math.floor(atMs / DAY_MS) * DAY_MS;
  const candidates = [];
  for (let day = -9; day <= 9; day++) {
    for (const h of hours) candidates.push(midnight + day * DAY_MS + h * 3600000);
  }
  candidates.sort((a, b) => a - b);

  let nextAtMs = null;
  for (const t of candidates) {
    if (t <= atMs) continue;
    if (phaseAt(t, ws, hs).phase !== now.phase) { nextAtMs = t; break; }
  }
  return {
    phase: now.phase,
    reason: now.reason,
    nextAtMs,
    nextPhase: nextAtMs === null ? null : phaseAt(nextAtMs, ws, hs).phase,
  };
}

/**
 * 生成界面用的峰谷快照。
 *
 * 除了相位本身，还给出「当日 00:00–24:00（北京时间）的峰/谷分段」，
 * 客户端据此画那条橙色/蓝色时间条，并在条上标出当前时刻。
 *
 * @param {number} atMs
 * @param {{windows?:Array, holidays?:string[]}} [options]
 */
function peakSnapshot(atMs, options) {
  const ws = (options && options.windows) || DEFAULT_PEAK_WINDOWS;
  const hs = (options && options.holidays) || DEFAULT_PEAK_HOLIDAYS;
  const now = describeNow(atMs, ws, hs);

  // 北京时间的当日 00:00 对应的毫秒时刻
  const bjMidnight = Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;

  // 把一天切成最多 96 个 15 分钟片段做分段，足够画出时间条，也避免逐毫秒扫描。
  // 同一相位的连续片段会合并成一段，减少前端节点数。
  const SEGMENTS = 96;
  const stepMs = DAY_MS / SEGMENTS;
  const segments = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const from = bjMidnight + i * stepMs;
    const phase = phaseAt(from + 1, ws, hs).phase;
    const last = segments[segments.length - 1];
    if (last && last.phase === phase) {
      last.end = from + stepMs;
    } else {
      segments.push({ phase, start: from, end: from + stepMs });
    }
  }

  return {
    phase: now.phase,
    reason: now.reason,
    nextAtMs: now.nextAtMs,
    nextPhase: now.nextPhase,
    dayStartMs: bjMidnight,
    dayEndMs: bjMidnight + DAY_MS,
    nowMs: atMs,
    // 时间条分段：每段给相对当日的 0–1 比例，客户端直接按百分比布局
    segments: segments.map((s) => ({
      phase: s.phase,
      from: (s.start - bjMidnight) / DAY_MS,
      to: (s.end - bjMidnight) / DAY_MS,
    })),
  };
}

module.exports = {
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_PEAK_HOLIDAYS,
  PEAK_EFFECTIVE_AT,
  phaseAt,
  describeNow,
  peakSnapshot,
  beijingDayKey,
};
