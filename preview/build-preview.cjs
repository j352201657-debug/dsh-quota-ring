'use strict';
/**
 * 生成离线预览页面：用真实的服务端数据渲染客户端卡片，
 * 便于在没有重启 DSH 的情况下检查布局（峰谷条 / 今日消耗 / Gemini 三组）。
 *
 * 这个文件只用于开发自查，不参与运行时。它会把真实数据内联进 HTML，
 * 因此**必须脱敏**（账号邮箱、可能的 token 片段），否则截图不能公开。
 */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const { normalizeConfig, sanitizeConfig } = require(path.join(ROOT, 'src', 'config'));
const { resolveCredentials } = require(path.join(ROOT, 'src', 'credentials'));
const { createAggregator } = require(path.join(ROOT, 'src', 'aggregator'));

/** 该脱敏的字段：账号邮箱、任何形似邮箱/密钥的字符串 */
function maskSummary(summary) {
  return JSON.parse(
    JSON.stringify(summary, (key, value) => {
      if (typeof value !== 'string') return value;
      if (key === 'account') return 'user@example.com';
      // 兜底：任何残留的邮箱、Bearer 令牌都抹掉
      return value
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com')
        .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/g, 'Bearer ***');
    }),
  );
}

(async () => {
  const config = normalizeConfig({});
  const creds = resolveCredentials(config);
  const agg = createAggregator(config, creds);
  // 端口只影响 agy-cli 的 /status 回退路径；原始额度接口不依赖它，
  // 所以这里给 0（回退默认值），不要写死某次重启后的端口号。
  const port = Number(process.env.QH_PREVIEW_PORT || 0);
  const summary = maskSummary(await agg.getSummary({ force: true, runtime: { webPort: port } }));

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-quota-ring 预览</title>
<style>
  html,body{margin:0;height:100%;background:#0f1115;
    background-image:radial-gradient(circle at 30% 20%, rgba(56,189,248,.08), transparent 55%);}
  .tip{position:fixed;left:24px;top:20px;color:#64748b;font:12px/1.6 -apple-system,"Segoe UI",sans-serif;}
</style>
</head>
<body>
<div class="tip">dsh-quota-ring 离线预览（真实服务端数据，已脱敏，fetch 已被替换）</div>
<script>
  window.__QH_SUMMARY__ = ${JSON.stringify(summary)};
  window.__QH_CONFIG__ = ${JSON.stringify(sanitizeConfig(config))};
  // 桩：把 /api/quota-hub/* 请求换成上面预置的数据
  window.fetch = function (url) {
    const body = String(url).includes('/config')
      ? window.__QH_CONFIG__
      : window.__QH_SUMMARY__;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  window.__ModuleLoader__ = {
    load: function (opts) { window.__qh = opts.factory(function () { return {}; }); },
  };
</script>
<script src="../client.js"></script>
<script>
  // 挂载后自动展开卡片，方便截图检查
  setTimeout(function () { if (window.__qh && window.__qh.apply) window.__qh.apply({}, {}); }, 30);
  setTimeout(function () {
    const fab = document.getElementById('qh-fab');
    if (fab) fab.click();
  }, 900);
</script>
</body>
</html>`;

  const out = path.join(__dirname, 'preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('已生成:', out);
  console.log('providers:', summary.providers.map((p) => p.label + ':' + p.status).join(', '));
  console.log('gemini groups:', (summary.providers.find((p) => p.id === 'agy') || {}).groups ? '3 组' : '无');
  const leaks = /[\w.+-]+@(?!example\.com)[\w-]+\.[\w.-]+/.test(html);
  console.log('脱敏检查（不应出现真实邮箱）:', leaks ? '发现泄漏!' : '通过');
})();
