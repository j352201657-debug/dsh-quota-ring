'use strict';

/**
 * src/diag.js —— 自检（给别人装、换电脑时第一个要看的东西）
 * ----------------------------------------------------------------------------
 * 目标：让「装上去不显示额度」这件事可以自己查清楚，而不是让人猜。
 *
 * 只做三件事，全部是本地读取，不发起任何网络请求：
 *   1. 凭据文件找没找到、找过哪些路径；
 *   2. 两家的账号记录解析出来了吗（只报「有/没有」，绝不回显密文）；
 *   3. 依赖的两个 DSH 插件装没装、版本是多少。
 *
 * 输出直接对应 README 的排查表，前端与 curl 都可用：
 *   GET /api/quota-hub/diag
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { candidateHomes, locateCredentialsFile, readDeepSeekGrant, readCodexCredential } = require('./credentials');

/** 本插件依赖的「别人机器上必须也装」的两个 DSH 插件 */
const REQUIRED_PLUGINS = [
  {
    name: 'dsh-codex-subscription',
    provides: 'GPT (Codex) 额度',
    missingTip: '未安装 dsh-codex-subscription：GPT 那一行会显示「未登录」。安装并登录后即可取到 5 小时 / 每周窗口。',
  },
  {
    name: 'dsh-agy-cli',
    provides: 'Gemini（Antigravity）额度',
    missingTip: '未安装 dsh-agy-cli：Gemini 那一行会显示「不可用」。安装并在终端执行一次 agy 登录后即可取到三个额度池。',
  },
];

/** 为 DeepSeek 提供账号登录态的内置组件（一般随 DSH 自带，无需另装） */
const BUILTIN_NOTE = 'DeepSeek 的账号登录态由 DSH 内置的 dsh-deepseek-account-platform 提供，通常无需额外安装。';

/** 读 package.json 里的版本号；读不到返回 null */
function readPluginVersion(profileDir, name) {
  const candidates = [
    path.join(profileDir, 'node_modules', name, 'package.json'),
    path.join(profileDir, 'node_modules', '@deepseek-ai', name, 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { version: pkg.version || '?', file };
    } catch (e) {
      /* 继续试下一个 */
    }
  }
  return null;
}

/** 列出 <home>/profiles/* 目录 */
function listProfileDirs(home) {
  try {
    return fs
      .readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(home, 'profiles', d.name));
  } catch (e) {
    return [];
  }
}

/**
 * 组装自检报告。
 *
 * @param {object} params
 * @param {object} params.config 归一化配置
 * @param {number|null} params.webPort 从请求 Host 头推断出的端口
 * @returns {object}
 */
function buildDiag({ config, webPort }) {
  const homes = candidateHomes(config);
  const { file, tried } = locateCredentialsFile(config);
  const home = file ? path.dirname(file) : homes[0] || '';

  // 凭据解析（只保留布尔与来源，不回显任何密文）
  let deepseek = { ok: false, error: '未读取' };
  let codex = { ok: false, error: '未读取' };
  try {
    const ds = readDeepSeekGrant(config);
    deepseek = {
      ok: !!ds.ok,
      record: ds.record || null,
      issuer: ds.issuer || null,
      error: ds.ok ? null : ds.error || null,
    };
  } catch (e) {
    deepseek = { ok: false, error: String((e && e.message) || e) };
  }
  try {
    const cx = readCodexCredential(config);
    const now = Date.now();
    codex = {
      ok: !!cx.ok,
      source: cx.source || null,
      accountConfigured: !!cx.accountId,
      expiresAt: cx.expires || null,
      expired: !!(cx.expires && cx.expires < now),
      error: cx.ok ? null : cx.error || null,
    };
  } catch (e) {
    codex = { ok: false, error: String((e && e.message) || e) };
  }

  // 依赖插件探测：扫所有 profile 的 node_modules
  const profileDirs = listProfileDirs(home);
  const plugins = REQUIRED_PLUGINS.map((dep) => {
    let found = null;
    for (const profileDir of profileDirs) {
      const hit = readPluginVersion(profileDir, dep.name);
      if (hit) {
        found = { version: hit.version, profile: path.basename(profileDir) };
        break;
      }
    }
    return {
      name: dep.name,
      provides: dep.provides,
      installed: !!found,
      version: found ? found.version : null,
      profile: found ? found.profile : null,
      tip: found ? null : dep.missingTip,
    };
  });

  // 平台能力差异（诚实说明，免得在别的系统上以为插件坏了）
  const platforms = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    keyringAvailable: process.platform === 'win32',
    systemProxyDiscovery: process.platform === 'win32',
    note:
      process.platform === 'win32'
        ? null
        : '非 Windows：Gemini 凭据管理器读取不可用，会回退到 agy-cli 的 /status（5 小时窗口可能显示「未知」）；系统代理不会自动发现，请用 proxy 配置或 HTTPS_PROXY 环境变量。',
  };

  const tips = [];
  if (!file) {
    tips.push('没有找到 .credentials.yaml。请在 DSH 里至少登录一家账号，或用 config.dshHome 显式指定 DSH 数据目录。');
  }
  if (!deepseek.ok) tips.push(deepseek.error || 'DeepSeek 账号记录不可用');
  if (!codex.ok) tips.push(codex.error || 'Codex 订阅记录不可用');
  for (const p of plugins) if (!p.installed) tips.push(p.tip);
  if (platforms.note) tips.push(platforms.note);

  return {
    ok: true,
    diag: {
      credentialsFile: file || null,
      triedHomes: tried,
      dshHome: home || null,
      webPort: webPort || null,
      deepseek,
      codex,
      plugins,
      builtinNote: BUILTIN_NOTE,
      runtime: platforms,
      tips,
    },
  };
}

module.exports = { buildDiag, REQUIRED_PLUGINS };
