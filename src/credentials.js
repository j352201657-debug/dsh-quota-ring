'use strict';

/**
 * src/credentials.js
 * ----------------------------------------------------------------------------
 * 凭据读取（v2：账号 OAuth 凭据，不再是 API Key）。
 *
 * 【为什么重写】
 * 三家平台在 DSH 里都不是「填一个 API Key 去查钱」，而是**账号登录态**：
 *   - DeepSeek：DSH「DeepSeek 账号」插件登录后，凭据存在 .credentials.yaml 的
 *               records["deepseek-account-platform/default"].payload.{token,issuer}
 *   - GPT     ：DSH「Codex 订阅」插件登录后，凭据存在
 *               records["codex-subscription/accounts"].payload.accounts[].credential
 *               （OAuth access / refresh / expires / accountId / email）
 *   - Gemini  ：凭据在 dsh-agy-cli 里（Windows 凭据管理器 gemini:antigravity），
 *               本插件不直接读它，而是调用 agy-cli 已缓存的 HTTP 路由，故这里不需要凭据。
 *
 * 【安全】
 *   - 只读取，绝不写入、绝不打印密文；返回结构里不含「用于日志」的字段。
 *   - 任何解析异常都被吞掉并转成 { ok:false, error }，不影响其他两家。
 *
 * 【踩坑记录（务必保留）】
 *   DeepSeek 的 token 是 base64 风格，**含 `/` 和 `+`**。如果像 v1 那样用
 *   `[A-Za-z0-9._-]` 这种字符集去截取，会在第 25 个字符处断掉，服务端返回
 *   {"code":40003,"msg":"Authorization Failed (invalid token)"}。
 *   因此本文件取「整行冒号后的全部内容」，不做字符集裁剪。
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 正则转义（用于把键名拼进 RegExp） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从「插件自身的安装位置」反推 DSH 数据目录。
 *
 * 插件总是装在 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-quota-ring/`，
 * 所以从 __dirname 逐级向上找，哪一级里存在 `.credentials.yaml`，哪一级就是
 * DSH 数据目录。这一条与机器无关，是本文件最重要的跨机器兜底：
 * 用户的数据目录叫 `D:\DSHData\.dsh` 也好、`~/.dsh` 也好、`D:\其他\.dsh` 也好，
 * 只要插件是被正常安装进 profile 的，就一定找得到。
 *
 * @returns {string[]} 由近及远的祖先目录（只保留「看起来像 DSH 数据目录」的）
 */
function homesFromInstallPath() {
  const out = [];
  let dir = __dirname;
  // 2 (src) + 1 (dsh-quota-ring) + 1 (node_modules) + 1 (profile) + 1 (profiles) = 6 层足够
  for (let i = 0; i < 7; i++) {
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
    try {
      // 要么这里直接有凭据文件，要么它本身是 .dsh 目录
      if (fs.existsSync(path.join(dir, '.credentials.yaml'))) out.push(dir);
      else if (path.basename(dir) === '.dsh') out.push(dir);
    } catch (e) {
      /* 权限问题等，跳过 */
    }
  }
  return out;
}

/**
 * 候选的 DSH 数据目录（按优先级）。
 *
 * 顺序：显式配置 → 环境变量 → **插件安装路径反推** → 历史默认位置 → 家目录约定。
 * 中间那条与机器无关，是「换一台电脑也能用」的关键。
 *
 * @param {object} config 归一化配置
 * @returns {string[]}
 */
function candidateHomes(config) {
  const list = [];
  if (config && config.dshHome) list.push(config.dshHome);
  // DSH 自身的约定：DSH_HOME 指向用户数据目录
  if (process.env.DSH_HOME) list.push(process.env.DSH_HOME);
  if (process.env.DSH_DATA_DIR) list.push(process.env.DSH_DATA_DIR);
  // 由插件自身的安装位置反推（跨机器可靠）
  list.push(...homesFromInstallPath());
  // 历史默认位置（某些发行版把数据放到固定盘符）
  list.push('D:\\DSHData\\.dsh');
  // 通用约定
  try {
    list.push(path.join(os.homedir(), '.dsh'));
  } catch (e) {
    /* ignore */
  }
  // 去重 + 过滤空值
  return [...new Set(list.filter(Boolean))];
}

/**
 * 列出 YAML 里所有「行尾只有冒号」的键名（record 级与更深的键都会列出来）。
 * 用于在记录名与预期不一致时做模糊匹配（换 DSH 版本、换插件版本时有用）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function listBlockKeys(text) {
  const keys = new Set();
  const re = /^[ \t]{1,6}([A-Za-z0-9_./@-]+):[ \t]*$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) keys.add(m[1]);
  return [...keys];
}

/**
 * 模糊查找 DeepSeek 凭据块：任何名字里带 deepseek、且块内有非空 token 的记录。
 * 先用精确记录名，找不到再退到这里，避免 DSH 改记录命名后整块功能消失。
 *
 * @param {string} text
 * @returns {{ key:string, block:string }|null}
 */
function findDeepSeekBlock(text) {
  const exact = sliceRecordBlock(text, 'deepseek-account-platform/default');
  if (exact && extractScalar(exact, 'token')) {
    return { key: 'deepseek-account-platform/default', block: exact };
  }
  for (const key of listBlockKeys(text)) {
    if (!/deepseek/i.test(key)) continue;
    if (/device|browser-session/i.test(key)) continue; // 设备记录里没有 token
    const block = sliceRecordBlock(text, key);
    if (block && extractScalar(block, 'token')) return { key, block };
  }
  return null;
}

/**
 * 模糊查找 Codex 凭据块：名字里带 codex / openai，且块内有 access。
 *
 * @param {string} text
 * @returns {{ key:string, block:string }|null}
 */
function findCodexBlock(text) {
  const exact = sliceRecordBlock(text, 'codex-subscription/accounts');
  if (exact) return { key: 'codex-subscription/accounts', block: exact };
  for (const key of listBlockKeys(text)) {
    if (!/codex|openai|chatgpt/i.test(key)) continue;
    const block = sliceRecordBlock(text, key);
    if (block && /^\s*access:/m.test(block)) return { key, block };
  }
  return null;
}

/**
 * 定位 .credentials.yaml。
 * @returns {{ file: string|null, tried: string[] }}
 */
function locateCredentialsFile(config) {
  const tried = [];
  for (const home of candidateHomes(config)) {
    const file = path.join(home, '.credentials.yaml');
    tried.push(file);
    try {
      if (fs.existsSync(file)) return { file, tried };
    } catch (e) {
      /* 权限问题等，继续试下一个 */
    }
  }
  return { file: null, tried };
}

/**
 * 在 YAML 文本中切出某个 record 的文本块。
 * record 形如（顶格 2 空格缩进）：
 *   records:
 *     deepseek-account-platform/default:
 *       kind: grant
 *       payload: ...
 *
 * 切法：找到 `  <recordName>:` 这一行，然后一直收集到「缩进 <= 该 record 缩进」的
 * 下一个非空行为止。这样不用实现完整 YAML 解析器，却对缩进宽度不敏感。
 *
 * @param {string} text 整个 YAML 文本
 * @param {string} recordName 例如 'deepseek-account-platform/default'
 * @returns {string|null} 该 record 的文本块（含首行），找不到返回 null
 */
function sliceRecordBlock(text, recordName) {
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 匹配「缩进 + 键名 + 冒号 + 行尾」；键名允许 / . - @ 等字符
    const m = raw.match(/^(\s*)([A-Za-z0-9_./@-]+):\s*$/);
    if (!m) continue;
    if (m[2] !== recordName) continue;
    start = i;
    baseIndent = m[1].length;
    break;
  }
  if (start < 0) return null;

  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) {
      out.push(raw);
      continue;
    }
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    out.push(raw);
  }
  return out.join('\n');
}

/**
 * 从文本块里取某个键的值。
 * 取「整行冒号后的全部内容」再剥掉 YAML 引号 —— 不做字符集裁剪，
 * 以兼容 DeepSeek token 这类含 `/` `+` `=` 的 base64 值。
 *
 * @param {string} block 文本块
 * @param {string} keyName 键名
 * @returns {string} 值（找不到返回空串）
 */
function extractScalar(block, keyName) {
  if (!block) return '';
  const re = new RegExp('^\\s*' + escapeRe(keyName) + ':[ \\t]*(.*)$', 'm');
  const m = block.match(re);
  if (!m) return '';
  let v = m[1].trim();
  if (v.length >= 2) {
    const q1 = v[0];
    const q2 = v[v.length - 1];
    if ((q1 === "'" && q2 === "'") || (q1 === '"' && q2 === '"')) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

/**
 * 读取 DeepSeek 账号凭据。
 * @returns {{ ok:boolean, token:string, issuer:string, error?:string }}
 */
function readDeepSeekGrant(config) {
  const { file, tried } = locateCredentialsFile(config);
  if (!file) {
    return {
      ok: false,
      token: '',
      issuer: '',
      error: '未找到 DSH 凭据文件 .credentials.yaml（已尝试：' + tried.join(' / ') + '）',
    };
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, token: '', issuer: '', error: '凭据文件读取失败：' + (e.message || e) };
  }

  const found = findDeepSeekBlock(text);
  if (!found) {
    return {
      ok: false,
      token: '',
      issuer: '',
      error: '凭据文件里没有 DeepSeek 账号记录（需要在 DSH 里登录 DeepSeek 账号）',
    };
  }

  const block = found.block;
  const token = extractScalar(block, 'token');
  const issuer = extractScalar(block, 'issuer') || 'https://platform.deepseek.com';
  if (!token) {
    return { ok: false, token: '', issuer, error: 'DeepSeek 记录里缺少 token 字段' };
  }
  return { ok: true, token, issuer, file, record: found.key };
}

/**
 * 从 codex-subscription/accounts 记录里切出各个 account 条目。
 * 结构：
 *   accounts:
 *     - id: 842f...
 *       label: Account 1
 *       credential:
 *         type: oauth
 *         access: ...
 * @returns {Array<{ id:string, block:string }>}
 */
function splitAccountEntries(block) {
  if (!block) return [];
  const lines = String(block).split(/\r?\n/);
  const heads = []; // { index, id }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/);
    if (m) heads.push({ index: i, id: m[1] });
  }
  const out = [];
  for (let k = 0; k < heads.length; k++) {
    const from = heads[k].index;
    const to = k + 1 < heads.length ? heads[k + 1].index : lines.length;
    out.push({ id: heads[k].id, block: lines.slice(from, to).join('\n') });
  }
  return out;
}

/**
 * 读取 GPT / Codex 订阅凭据。
 * 优先取 accounts 里与 activeId 匹配的那个账号；找不到则取第一个。
 * 主记录缺 access 时，回退解析 refs.OPENAI_CODEX_SUBSCRIPTION_OAUTH（JSON 串）。
 *
 * @returns {{ ok:boolean, access:string, refresh:string, expires:number, accountId:string,
 *             email:string, source:string, error?:string }}
 */
function readCodexCredential(config) {
  const empty = {
    ok: false,
    access: '',
    refresh: '',
    expires: 0,
    accountId: '',
    email: '',
    source: '',
  };

  const { file, tried } = locateCredentialsFile(config);
  if (!file) {
    return { ...empty, error: '未找到 DSH 凭据文件 .credentials.yaml（已尝试：' + tried.join(' / ') + '）' };
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ...empty, error: '凭据文件读取失败：' + (e.message || e) };
  }

  const foundCodex = findCodexBlock(text);
  const block = foundCodex ? foundCodex.block : null;

  // ---- 路径 1：records 里的 accounts 列表 ----
  if (block) {
    const activeId = extractScalar(block, 'activeId');
    const entries = splitAccountEntries(block);
    let chosen = null;
    if (activeId) chosen = entries.find((e) => e.id === activeId) || null;
    if (!chosen && entries.length > 0) chosen = entries[0];

    if (chosen) {
      const access = extractScalar(chosen.block, 'access');
      const refresh = extractScalar(chosen.block, 'refresh');
      const expiresRaw = extractScalar(chosen.block, 'expires');
      const accountId = extractScalar(chosen.block, 'accountId');
      const email = extractScalar(chosen.block, 'email');
      const expires = Number(expiresRaw) || 0;
      if (access && accountId) {
        return { ok: true, access, refresh, expires, accountId, email, source: 'records' };
      }
    }
  }

  // ---- 路径 2：refs.OPENAI_CODEX_SUBSCRIPTION_OAUTH（单引号包裹的 JSON 串）----
  const refsBlock = sliceRecordBlock(text, 'refs');
  const rawRef = refsBlock ? extractScalar(refsBlock, 'OPENAI_CODEX_SUBSCRIPTION_OAUTH') : '';
  if (rawRef) {
    try {
      const parsed = JSON.parse(rawRef);
      // 该 JSON 可能是对象，也可能是数组（多账号）
      const one = Array.isArray(parsed) ? parsed[0] : parsed;
      if (one && one.access && (one.accountId || one.account_id)) {
        return {
          ok: true,
          access: String(one.access),
          refresh: String(one.refresh || ''),
          expires: Number(one.expires) || 0,
          accountId: String(one.accountId || one.account_id),
          email: String(one.email || ''),
          source: 'refs',
        };
      }
    } catch (e) {
      /* JSON 解析失败则走下面的统一报错 */
    }
  }

  if (!block) {
    return { ...empty, error: '凭据文件里没有 Codex 订阅记录（需要安装并登录 dsh-codex-subscription）' };
  }
  return { ...empty, error: 'Codex 记录里缺少 access / accountId（登录信息不完整，请重新登录）' };
}

/**
 * 解析全部凭据。
 * Gemini 不在此处读取（由 dsh-agy-cli 持有并自动续期），因此只标记可用性。
 *
 * @param {object} config 归一化配置
 * @returns {{ deepseek:object, codex:object, agy:{ok:boolean} }}
 */
function resolveCredentials(config) {
  let deepseek;
  let codex;

  try {
    deepseek = readDeepSeekGrant(config);
  } catch (e) {
    deepseek = { ok: false, token: '', issuer: '', error: '解析 DeepSeek 凭据异常：' + (e.message || e) };
  }
  try {
    codex = readCodexCredential(config);
  } catch (e) {
    codex = {
      ok: false,
      access: '',
      refresh: '',
      expires: 0,
      accountId: '',
      email: '',
      source: '',
      error: '解析 Codex 凭据异常：' + (e.message || e),
    };
  }

  return { deepseek, codex, agy: { ok: true } };
}

/**
 * 解析出真正要用的 DSH 数据目录。
 *
 * 与 candidateHomes 的区别：这里只返回**一个**目录，且优先挑真实存在的，
 * 供「今日消耗」的记账状态文件落盘使用。全都不存在时返回第一候选。
 *
 * @param {object} config
 * @returns {string}
 */
function resolveHome(config) {
  const homes = candidateHomes(config);
  for (const home of homes) {
    try {
      if (fs.existsSync(home)) return home;
    } catch (e) {
      /* ignore */
    }
  }
  return homes[0] || process.cwd();
}

module.exports = {
  resolveCredentials,
  readDeepSeekGrant,
  readCodexCredential,
  locateCredentialsFile,
  candidateHomes,
  resolveHome,
  // 模糊匹配/跨版本兼容（也供 diag 使用）
  listBlockKeys,
  findDeepSeekBlock,
  findCodexBlock,
  // 以下导出主要为了单测/排障
  sliceRecordBlock,
  extractScalar,
  splitAccountEntries,
};
