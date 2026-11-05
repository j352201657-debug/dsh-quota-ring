'use strict';

/** HTTP/HTTPS 请求、代理探测、连接超时与 JSON 响应解析。 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

/** 响应体最大字节数（5MB），超过即中断并报错 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** 不应走代理的目标主机（本机回环） */
const NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

/** 读取 Windows 系统代理设置（注册表）。非 Windows 或读取失败返回空串。 */
function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    // 用 child_process 读注册表比引入原生模块依赖更稳妥
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }
    );
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return '';
    let server = m[1].trim();
    // 形如 "http=host:port;https=host:port" 时取 http(s) 那一段
    if (server.includes('=')) {
      const parts = server.split(';');
      const hit =
        parts.find((p) => /^https=/i.test(p)) || parts.find((p) => /^http=/i.test(p));
      server = hit ? hit.split('=')[1] : '';
    }
    if (!server) return '';
    return /^https?:\/\//i.test(server) ? server : 'http://' + server;
  } catch (e) {
    return '';
  }
}

/**
 * 解析代理地址字符串为 { host, port, auth }。
 * 支持 http://host:port 与 host:port 两种写法；返回 null 表示无效。
 */
function parseProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : 'http://' + s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (!host) return null;
    let auth = null;
    if (u.username) {
      auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '');
    }
    return { host, port, auth, protocol: u.protocol };
  } catch (e) {
    return null;
  }
}

/**
 * 决定本次请求使用哪个代理。
 * @param {string} targetHost 目标主机
 * @param {object} [opts]
 * @returns {{host:string,port:number,auth:string|null,source:string}|null} null 表示直连
 */
function resolveProxy(targetHost, opts = {}) {
  const host = String(targetHost || '').toLowerCase();
  // 本机回环一律直连
  if (NO_PROXY_HOSTS.includes(host)) return null;

  // 1. 显式传入（插件配置）
  if (opts.proxy) {
    const p = parseProxy(opts.proxy);
    if (p) return { ...p, source: 'config' };
  }

  // 2. 环境变量（大小写两种写法都要覆盖）
  const envCandidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const raw of envCandidates) {
    const p = parseProxy(raw);
    if (p) return { ...p, source: 'env' };
  }

  // 3. Windows 系统代理
  const sys = parseProxy(readWindowsSystemProxy());
  if (sys) return { ...sys, source: 'system' };

  return null;
}

/**
 * 通过 CONNECT 隧道访问 HTTPS 目标，返回响应 { statusCode, headers, body }。
 * @param {URL} target 目标 URL 对象
 * @param {object} proxy { host, port, auth }
 * @param {object} headers 请求头
 * @param {string} [method] HTTP 方法，默认 GET
 * @param {Buffer} [bodyBuf] 请求体（POST 时使用）
 */
function requestViaProxy(target, proxy, headers, method, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    let connectReq;
    let tlsSocket;
    let tunnel;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (connectReq) connectReq.destroy();
      if (tlsSocket) tlsSocket.destroy();
      if (tunnel) tunnel.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('请求超时')), timeoutMs);
    const verb = method || 'GET';
    try {
      const proxyAuthHeaders = proxy.auth
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') }
        : {};

      const transport = proxy.protocol === 'https:' ? https : http;
      connectReq = transport.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}`, ...proxyAuthHeaders },

      });

      connectReq.on('connect', (res, socket) => {
        tunnel = socket;
        socket.on('error', (error) => finish(error));
        if (settled) { socket.destroy(); return; }
        if (res.statusCode !== 200) {
          socket.destroy();
          finish(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
          return;
        }
        // 在隧道上建立 TLS 连接
        tlsSocket = tls.connect(
          { socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] },
          () => {
            // TLS 就绪后手动写 HTTP/1.1 请求
            const path = (target.pathname || '/') + (target.search || '');
            const allHeaders = {
              Host: target.host,
              ...headers,
              Connection: 'close',
            };
            if (bodyBuf) allHeaders['Content-Length'] = bodyBuf.length;
            const headerLines = Object.entries(allHeaders)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n');
            tlsSocket.write(Buffer.concat([
              Buffer.from(`${verb} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`, 'utf8'),
              bodyBuf || Buffer.alloc(0),
            ]));
          }
        );

        // 必须按 Buffer 累积：逐块 toString('utf8') 会把跨块的多字节字符切成乱码，
        // 而 agy 的额度响应里带中文字段的 description 就属于这种情况。
        const chunks = [];
        let total = 0;
        tlsSocket.on('data', (chunk) => {
          chunks.push(chunk);
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            finish(new Error('响应体过大，已中断'));
          }
        });
        tlsSocket.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            // 先按 latin1 定位头部分隔符，避免二进制体里恰好出现 \r\n\r\n 造成误判
            const sepBuf = buf.indexOf('\r\n\r\n');
            if (sepBuf < 0) throw new Error('响应格式异常');
            const head = buf.slice(0, sepBuf).toString('utf8');
            const bodyBufRes = buf.slice(sepBuf + 4);
            const lines = head.split('\r\n');
            const statusLine = lines[0] || '';
            const statusCode = Number((statusLine.match(/HTTP\/\d\.\d (\d+)/) || [])[1]) || 0;
            const respHeaders = {};
            for (const line of lines.slice(1)) {
              const i = line.indexOf(':');
              if (i > 0) respHeaders[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
            }
            // 处理 chunked 编码
            const body = /chunked/i.test(respHeaders['transfer-encoding'] || '')
              ? decodeChunkedBuffer(bodyBufRes).toString('utf8')
              : bodyBufRes.toString('utf8');
            finish(null, { statusCode, headers: respHeaders, body });
          } catch (e) {
            finish(e);
          }
        });
        tlsSocket.on('error', (error) => finish(error));
        tlsSocket.on('close', () => { if (!settled) finish(new Error('响应连接中断')); });
      });

      connectReq.on('error', (error) => finish(error));
      connectReq.end();
    } catch (error) { finish(error); }
  });
}

/** 解码 HTTP chunked 传输编码（Buffer 版，保留多字节字符完整性） */
function decodeChunkedBuffer(buf) {
  const parts = [];
  let idx = 0;
  while (idx < buf.length) {
    const nl = buf.indexOf('\r\n', idx);
    if (nl < 0) break;
    const size = parseInt(buf.slice(idx, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(buf.slice(nl + 2, nl + 2 + size));
    idx = nl + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/**
 * 直连（不走代理）发起请求。
 */
function requestDirect(urlObj, headers, timeoutMs, method, bodyBuf) {
  return new Promise((resolve, reject) => {
    const lib = urlObj.protocol === 'https:' ? https : http;
    let req;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (req) req.destroy();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('请求超时')), timeoutMs);
    try {
      const options = { method: (method || 'GET').toUpperCase(),
        headers: { Accept: 'application/json', 'User-Agent': 'dsh-quota-ring/3.1.1', ...headers } };
      if (bodyBuf) options.headers['Content-Length'] = bodyBuf.length;
      req = lib.request(urlObj, options, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) finish(new Error('响应体过大，已中断'));
          else chunks.push(chunk);
        });
        res.on('end', () => finish(null, { statusCode: res.statusCode || 0,
          headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('aborted', () => finish(new Error('响应连接中断')));
        res.on('error', (error) => finish(error));
      });
      req.on('error', (error) => finish(error));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    } catch (error) { finish(error); }
  });
}

/**
 * 统一执行一次请求（含代理分流与超时兜底），返回 { statusCode, body }。
 * @param {string} url
 * @param {object} opts { headers, timeoutMs, proxy, method, body }
 */
async function requestRaw(url, opts = {}) {
  const { headers = {}, timeoutMs = 15000, method = 'GET', body } = opts;
  const urlObj = new URL(String(url));
  const bodyBuf = body === undefined || body === null
    ? null
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

  const proxy = resolveProxy(urlObj.hostname, opts);

  if (proxy && urlObj.protocol === 'https:') {
    return requestViaProxy(
        urlObj,
        proxy,
        {
          Accept: 'application/json',
          'User-Agent': 'dsh-quota-ring/3.1.1',
          ...(bodyBuf ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        method,
        bodyBuf,
        timeoutMs
    );
  }
  return requestDirect(urlObj, headers, timeoutMs, method, bodyBuf);
}

/**
 * 发起一次 GET 请求并解析 JSON。
 *
 * @param {string} url 完整 URL（http/https 自动选择模块）
 * @param {object} [opts]
 * @param {object} [opts.headers] 额外请求头
 * @param {number} [opts.timeoutMs] 超时（毫秒），默认 15000
 * @param {string} [opts.proxy] 代理地址（可选，如 http://127.0.0.1:7890）
 * @returns {Promise<any>} 解析后的 JSON（响应体为空时返回 null）
 */
async function httpGetJson(url, opts = {}) {
  const res = await requestRaw(url, opts);
  const status = res.statusCode || 0;
  const body = res.body || '';
  if (status >= 200 && status < 300) {
    try {
      return body ? JSON.parse(body) : null;
    } catch (e) {
      throw new Error('额度服务返回了无效的 JSON 数据');
    }
  }
  const error = new Error('HTTP ' + status);
  error.status = status;
  throw error;
}

/**
 * 发起一次 POST 请求并解析 JSON（antigravity 的额度接口需要 POST + JSON 体）。
 *
 * @param {string} url
 * @param {any} body 请求体（对象会被 JSON.stringify，字符串原样发送）
 * @param {object} [opts] 同 httpGetJson
 * @returns {Promise<any>}
 */
async function httpPostJson(url, body, opts = {}) {
  const res = await requestRaw(url, { ...opts, method: 'POST', body });
  const status = res.statusCode || 0;
  const text = res.body || '';
  if (status >= 200 && status < 300) {
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error('额度服务返回了无效的 JSON 数据');
    }
  }
  // 保留状态码供调用方区分鉴权失败与限流。
  const err = new Error('HTTP ' + status);
  err.status = status;
  throw err;
}

module.exports = {
  httpGetJson,
  httpPostJson,
  requestRaw,
  resolveProxy,
  readWindowsSystemProxy,
  parseProxy,
};
