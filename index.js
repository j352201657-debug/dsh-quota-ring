'use strict';

/**
 * index.js —— dsh-quota-ring 服务端入口（CommonJS，参考 dsh-plugin-agy-quota 模板）
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 向 cordis 注册一个 webServer 前缀路由 /api/quota-hub。
 *   2. 提供三个端点：
 *        GET  /api/quota-hub/summary?force=1   聚合三家额度（带服务端缓存）
 *        GET  /api/quota-hub/config            脱敏配置（供客户端初始化）
 *        POST /api/quota-hub/refresh           强制刷新（等价 summary?force=1）
 *        GET  /api/quota-hub/diag              自检：凭据文件、账号记录、依赖插件
 *   3. 处理 CORS 与 OPTIONS 预检（回环地址白名单）。
 *
 * 生命周期：ctx.inject(['webServer'], ...) 内用 webCtx.effect 注册，
 *   effect 的返回值为清理函数，插件卸载时自动注销路由。这是 DSH 插件的
 *   标准生命周期规范（与 dsh-restart-now / dsh-plugin-agy-quota 一致）。
 *
 * 【端口自适应】
 *   Gemini 额度要读 dsh-agy-cli 的 /plugins/agy-cli/status，而 agy-cli 与本插件
 *   挂在**同一个** webServer 上。所以从请求的 Host 头即可得到真实端口
 *   （形如 `Host: 127.0.0.1:<port>`），无需在配置里写死端口——
 *   DSH 每次重启都可能换端口，写死会在别人机器上直接失效。
 * ----------------------------------------------------------------------------
 */

const { normalizeConfig, sanitizeConfig } = require('./src/config');
const { resolveCredentials } = require('./src/credentials');
const { createAggregator } = require('./src/aggregator');
const { buildDiag } = require('./src/diag');

/** 路由前缀（与 webServer.register 的 path 一致） */
const PREFIX = '/api/quota-hub';

const plugin = {
  name: 'dsh-quota-ring',
  inject: ['webServer'],

  apply(ctx, rawConfig) {
    // 归一化配置：即便 cordis.patch.yml 只写了部分字段也能安全运行
    const config = normalizeConfig(rawConfig);

    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        // 解析账号凭据（读 DSH 的 .credentials.yaml）
        const credentials = resolveCredentials(config);
        // 创建聚合器（并发 + 缓存 + 降级）
        const aggregator = createAggregator(config, credentials);

        // 注册前缀路由；返回清理函数（disposer）
        const disposer = webCtx.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: async (req, res) => {
            try {
              await handleRequest(req, res, { config, aggregator });
            } catch (err) {
              // 顶层兜底：任何未捕获异常都转成 500 JSON，避免进程崩坏
              sendJson(res, 500, {
                ok: false,
                error: err && err.message ? err.message : '服务端内部错误',
              });
            }
          },
        });

        return () => {
          if (typeof disposer === 'function') disposer();
        };
      }, 'dsh-quota-ring/webServer');
    });
  },
};

/**
 * 解析请求路径与查询参数。
 * 注册的是 prefix 路由，req.url 是完整路径，需剥离前缀后得到子路径。
 */
function parseRequest(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  let pathname = url.pathname;
  if (pathname.startsWith(PREFIX)) pathname = pathname.slice(PREFIX.length);
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  pathname = pathname.replace(/\/+$/, '') || '/';
  return { pathname, search: url.searchParams, method: (req.method || 'GET').toUpperCase() };
}

/**
 * 从请求 Host 头推断本机 webServer 端口。
 * 例如 Host: "127.0.0.1:52341" → 52341。
 * @returns {number|null}
 */
function portFromHost(req) {
  const host = req && req.headers && req.headers.host;
  if (!host) return null;
  const m = String(host).match(/:(\d+)\s*$/);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * 判断来源 origin 是否在 CORS 白名单内。
 * 兼容「白名单写成带端口/无端口」与「本地回环」两类情况。
 */
function isOriginAllowed(origin, allowList) {
  if (!origin) return true; // 同源请求（无 Origin 头）放行
  const list = Array.isArray(allowList) ? allowList : [];
  // 宽松匹配：回环 host 一律放行（127.0.0.1 / localhost 任意端口）
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return true;
  return list.some((o) => o === origin);
}

/** 设置 CORS 响应头（命中白名单才回写 allow-origin） */
function applyCors(req, res, config) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin, config.corsOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

/** 输出 JSON 响应 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/** 主请求分发 */
async function handleRequest(req, res, { config, aggregator }) {
  applyCors(req, res, config);

  // OPTIONS 预检：直接 204 返回，不做业务处理
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const { pathname, search, method } = parseRequest(req);
  // 运行期上下文：端口来自当前请求，用于让 agy 适配器找到 agy-cli
  const runtime = { webPort: portFromHost(req) };

  if (method === 'GET' && pathname === '/summary') {
    const force = search.get('force') === '1';
    const summary = await aggregator.getSummary({ force, runtime });
    sendJson(res, 200, { ok: true, ...summary });
    return;
  }

  if (method === 'GET' && pathname === '/config') {
    sendJson(res, 200, { ok: true, config: sanitizeConfig(config) });
    return;
  }

  if (method === 'POST' && pathname === '/refresh') {
    const summary = await aggregator.getSummary({ force: true, runtime });
    sendJson(res, 200, { ok: true, ...summary });
    return;
  }

  if (method === 'GET' && pathname === '/diag') {
    // 自检：不发起任何网络请求，只回报本地事实，便于「装上没数据」时自查
    sendJson(res, 200, buildDiag({ config, webPort: runtime.webPort }));
    return;
  }

  sendJson(res, 404, { ok: false, error: `未知路由：${method} ${pathname}` });
}

// CommonJS 导出（兼容 DSH 模块加载器：同时暴露 default 与 apply）
module.exports = plugin;
module.exports.apply = plugin.apply;
module.exports.default = plugin;
