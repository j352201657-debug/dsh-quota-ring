'use strict';

/** 插件配置默认值、归一化与客户端配置脱敏。 */

/** 深拷贝对象（用于合并默认值，不依赖任何第三方库） */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const k of Object.keys(value)) out[k] = clone(value[k]);
  return out;
}

/** 深合并：b 覆盖 a 的同名键，返回新对象（不改动入参） */
function deepMerge(a, b) {
  const out = clone(a);
  if (b === null || typeof b !== 'object') return out;
  for (const k of Object.keys(b)) {
    const bv = b[k];
    const av = out[k];
    if (
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      av &&
      typeof av === 'object' &&
      !Array.isArray(av)
    ) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = clone(bv);
    }
  }
  return out;
}

/** 全部默认配置（务必与 cordis.patch.yml 的 config 字段保持一致） */
const DEFAULT_CONFIG = {
  /** 客户端轮询周期（毫秒），默认 10 分钟 */
  refreshIntervalMs: 600000,
  /** 失焦降频倍数（失焦时周期 = refreshIntervalMs × idleMultiplier） */
  idleMultiplier: 3,
  /** 失焦是否直接暂停轮询（false = 只降频） */
  pauseWhenHidden: false,

  /**
   * DSH 用户数据目录（存放 .credentials.yaml）。
   * 留空则按顺序自动探测：环境变量 DSH_HOME / DSH_DATA_DIR → 由插件安装路径反推
   * → ~/.dsh。
   */
  dshHome: '',

  /**
   * DSH Web 服务端口（用于访问 dsh-agy-cli 的 /plugins/agy-cli/status）。
   * 留空 / 0 = 从当前请求的 Host 头自动推断（推荐，端口变化也不用改配置）。
   */
  dshWebPort: 0,

  /**
   * 代理地址（可选，如 'http://127.0.0.1:12450'）。
   * 留空则自动探测：环境变量 HTTPS_PROXY/HTTP_PROXY → Windows 系统代理 → 直连。
   * chatgpt.com / platform.deepseek.com 在部分网络下必须走代理，否则会挂到超时。
   */
  proxy: '',

  /** 服务端聚合缓存（毫秒）。客户端 10 分钟轮询 + 服务端 60 秒缓存，双保险防刷 */
  serverCacheTtlMs: 60000,
  /** 单家请求超时（毫秒） */
  requestTimeoutMs: 15000,

  /** CORS 白名单（另对回环地址任意端口一律放行） */
  corsOrigins: ['http://127.0.0.1', 'http://localhost'],

  /**
   * DeepSeek 峰时段窗口覆盖（UTC 小时，半开区间 [start, end)）。
   * null = 使用内置时段 [{1,4},{6,10}]，即北京时间 09:00–12:00、14:00–18:00。
   * 可通过配置覆盖内置时段。
   */
  deepseekPeakWindows: null,

  /**
   * 中国公众假期覆盖（北京时间日期串，如 '2026-10-01'）。
   * null = 使用内置的 2026 年剩余假期表。跨年后建议在配置里补新一年的表。
   */
  deepseekPeakHolidays: null,
};

/**
 * 归一化用户配置：深合并到默认值，并兜底补齐嵌套字段。
 * @param {object} [user] 用户传入的原始配置（可能为 undefined 或残缺）
 * @returns {object} 完整的归一化配置
 */
function normalizeConfig(user) {
  const c = deepMerge(DEFAULT_CONFIG, user || {});

  // 数值型字段兜底：非法值一律回退默认值，避免 setInterval(0) 之类的事故
  const num = (v, def, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return def;
    return n;
  };
  c.refreshIntervalMs = num(c.refreshIntervalMs, DEFAULT_CONFIG.refreshIntervalMs, 5000);
  c.idleMultiplier = num(c.idleMultiplier, DEFAULT_CONFIG.idleMultiplier, 1);
  c.serverCacheTtlMs = num(c.serverCacheTtlMs, DEFAULT_CONFIG.serverCacheTtlMs, 0);
  c.requestTimeoutMs = num(c.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000);
  c.dshWebPort = num(c.dshWebPort, 0, 0);

  c.pauseWhenHidden = Boolean(c.pauseWhenHidden);
  c.dshHome = typeof c.dshHome === 'string' ? c.dshHome.trim() : '';
  c.proxy = typeof c.proxy === 'string' ? c.proxy.trim() : '';
  c.corsOrigins = Array.isArray(c.corsOrigins) ? c.corsOrigins : DEFAULT_CONFIG.corsOrigins;

  // 峰谷覆盖项：非法值一律当 null（表示"用内置默认"），避免脏配置算出错误时段
  const validWindows = Array.isArray(c.deepseekPeakWindows)
    ? c.deepseekPeakWindows.filter(
        (w) =>
          w &&
          Number.isFinite(Number(w.start)) &&
          Number.isFinite(Number(w.end)) &&
          Number(w.start) >= 0 &&
          Number(w.start) <= 24 &&
          Number(w.end) >= 0 &&
          Number(w.end) <= 24 &&
          Number(w.start) !== Number(w.end)
      )
    : [];
  c.deepseekPeakWindows = validWindows.length ? validWindows : null;
  c.deepseekPeakHolidays =
    Array.isArray(c.deepseekPeakHolidays) &&
    c.deepseekPeakHolidays.length > 0 &&
    c.deepseekPeakHolidays.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      ? c.deepseekPeakHolidays
      : null;

  return c;
}

/**
 * 脱敏配置：供客户端通过 GET /config 拉取。
 * 不返回任何密钥明文 / 令牌 / 客户端可推断的敏感路径，只返回展示所需字段。
 * @param {object} config 归一化后的完整配置
 * @returns {object} 脱敏后的配置
 */
function sanitizeConfig(config) {
  return {
    refreshIntervalMs: config.refreshIntervalMs,
    idleMultiplier: config.idleMultiplier,
    pauseWhenHidden: config.pauseWhenHidden,
    serverCacheTtlMs: config.serverCacheTtlMs,
    requestTimeoutMs: config.requestTimeoutMs,
    // 代理不暴露具体地址，只告知是否配置
    proxyConfigured: Boolean(config.proxy),
    corsOrigins: config.corsOrigins,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  sanitizeConfig,
  deepMerge,
};
