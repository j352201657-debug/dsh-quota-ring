'use strict';
/**
 * 本地自测：峰谷 / 今日消耗 / 三家端到端
 */
const path = require('node:path');
const ROOT = __dirname;

const { peakSnapshot, phaseAt } = require(path.join(ROOT, 'src', 'peak'));
const { observeBalance } = require(path.join(ROOT, 'src', 'usage'));
const { normalizeConfig, sanitizeConfig } = require(path.join(ROOT, 'src', 'config'));
const { resolveCredentials } = require(path.join(ROOT, 'src', 'credentials'));

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

(async () => {
  console.log('===== 1. 峰谷判定 =====');
  const now = Date.now();
  const snap = peakSnapshot(now);
  console.log('现在:', fmtTime(now), '| 阶段:', snap.phase, '| 原因:', snap.reason);
  console.log('下一次切换:', fmtTime(snap.nextAtMs), '→', snap.nextPhase);
  console.log('距切换:', Math.round((snap.nextAtMs - now) / 60000), '分钟');
  console.log('分段数:', snap.segments.length, '| 前 4 段:', JSON.stringify(snap.segments.slice(0, 4)));

  // 交叉验证几个已知时刻（UTC 小时）
  const cases = [
    ['2026-11-06T01:30:00Z', 'peak', '周三 北京 09:30 应在峰'],
    ['2026-11-06T03:30:00Z', 'peak', '周三 北京 11:30 应在峰'],
    ['2026-11-06T04:30:00Z', 'offPeak', '周三 北京 12:30 应平价'],
    ['2026-11-06T07:00:00Z', 'peak', '周三 北京 15:00 应在峰'],
    ['2026-11-06T11:00:00Z', 'offPeak', '周三 北京 19:00 应平价'],
    ['2026-11-07T02:00:00Z', 'offPeak', '周六 北京 10:00 周末应全天平价'],
    ['2026-11-08T07:00:00Z', 'offPeak', '周日 北京 15:00 周末应全天平价'],
    ['2026-10-01T02:00:00Z', 'offPeak', '国庆 北京 10:00 假期应全天平价'],
  ];
  let ok = 0;
  for (const [iso, expect, desc] of cases) {
    const r = phaseAt(Date.parse(iso));
    const pass = r.phase === expect;
    if (pass) ok++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${desc} → ${r.phase}(${r.reason}) 期望 ${expect}`);
  }
  console.log(`  小计 ${ok}/${cases.length}`);

  console.log('\n===== 2. 今日消耗 =====');
  const config = normalizeConfig({});
  // ★ 用临时目录做记账测试，绝不污染真实状态文件
  const os = require('node:os');
  const fsx = require('node:fs');
  const home = fsx.mkdtempSync(path.join(os.tmpdir(), 'qh-usage-'));
  console.log('临时目录:', home);
  const u1 = observeBalance({ balance: 16.73, currency: 'CNY', homeDir: home, nowMs: now });
  console.log('第一次（无种子 → 从当前余额起算）:', JSON.stringify({ today: u1.today, credits: u1.credits, source: u1.source }));
  // 模拟消耗 0.5
  const u2 = observeBalance({ balance: 16.23, currency: 'CNY', homeDir: home, nowMs: now + 60000 });
  console.log('消耗 0.5 后:', JSON.stringify({ today: u2.today, credits: u2.credits, source: u2.source }));
  // 模拟充值 10
  const u3 = observeBalance({ balance: 26.23, currency: 'CNY', homeDir: home, nowMs: now + 120000 });
  console.log('充值 10 后:', JSON.stringify({ today: u3.today, credits: u3.credits }));
  // 充值后再消耗 1
  const u4 = observeBalance({ balance: 25.23, currency: 'CNY', homeDir: home, nowMs: now + 180000 });
  console.log('再消耗 1 后:', JSON.stringify({ today: u4.today, credits: u4.credits }));

  console.log('\n===== 3. 配置归一化/脱敏 =====');
  console.log('deepseekPeakWindows:', JSON.stringify(config.deepseekPeakWindows));
  console.log('sanitize:', JSON.stringify(sanitizeConfig(config)));

  console.log('\n===== 4. 凭据 =====');
  const creds = resolveCredentials(config);
  console.log('deepseek.ok =', creds.deepseek.ok, '| codex.ok =', creds.codex.ok, '| agy =', JSON.stringify(creds.agy));

  console.log('\n===== 5. 三家端到端 =====');
  const { createAggregator } = require(path.join(ROOT, 'src', 'aggregator'));
  const agg = createAggregator(config, creds);
  // 端口只影响 agy-cli 的 /status 回退路径；原始额度接口不依赖它。
// 需要时用 QH_SELFTEST_PORT 指定，默认 0（=不猜端口）。
const port = Number(process.env.QH_SELFTEST_PORT || 0);
const summary = await agg.getSummary({ force: true, runtime: { webPort: port } });
  console.log('health:', JSON.stringify(summary.health));
  for (const p of summary.providers) {
    console.log(`\n--- ${p.label} [${p.status}] kind=${p.kind} ${p.ms}ms`);
    if (p.message) console.log('    message:', p.message);
    if (p.kind === 'money') {
      console.log(`    剩余 ${p.remaining} 已用 ${p.used} ${p.unit}`);
      if (p.usage) console.log('    今日:', p.usage.today, '来源', p.usage.source);
      if (p.peak) console.log('    峰谷:', p.peak.phase, p.peak.reason, '→', fmtTime(p.peak.nextAtMs), p.peak.nextPhase);
    }
    if (Array.isArray(p.groups) && p.groups.length) {
      for (const g of p.groups) {
        console.log(`    [${g.label}]`);
        for (const w of g.windows) {
          console.log(`      ${w.label}: 剩 ${w.remainingPercent === null ? '未知' : w.remainingPercent + '%'} | 重置 ${fmtTime(w.resetsAt)}`);
        }
      }
    } else if (Array.isArray(p.windows)) {
      for (const w of p.windows) {
        console.log(`      ${w.label}: 剩 ${w.remainingPercent === null ? '未知' : w.remainingPercent + '%'} | 重置 ${fmtTime(w.resetsAt)}`);
      }
    }
    if (p.notes && p.notes.length) console.log('    notes:', p.notes.map((n) => String(n).slice(0, 70)).join(' | '));
  }
})();
