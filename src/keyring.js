'use strict';

/**
 * src/keyring.js
 * ----------------------------------------------------------------------------
 * 从 Windows 凭据管理器读取 Antigravity（Gemini）的 OAuth 访问令牌。
 *
 * 为什么需要它：
 *   DSH 的 `dsh-agy-cli` 插件把 antigravity 的额度**压平**成三个 family
 *   （google / anthropic / openai）之后才通过 `/plugins/agy-cli/status` 暴露。
 *   而 antigravity 的真实额度是**三个 group、五个 bucket**：
 *       Gemini Models      → gemini-weekly       + gemini-5h
 *       Claude and GPT     → 3p-weekly           + 3p-5h
 *       Gemini 4 Argon     → gemini-argon-wtu-weekly（只有周额度）
 *   压平时后出现的 group 会覆盖前面的，于是 Gemini Models 的 5 小时窗口
 *   在 /status 里变成了「未知」。要看全，只能自己请求原始接口。
 *
 * 安全边界（刻意为之）：
 *   - **只读**。本模块绝不刷新、绝不写回凭据。令牌续期始终由 agy-cli /
 *     agy.exe 负责，避免两套逻辑互相踩踏把用户踢下线。
 *   - 令牌只在内存中用于一次 HTTPS 请求，不落盘、不打印、不进日志。
 *   - 读取方式与 agy-cli 完全一致：PowerShell + advapi32!CredRead，
 *     target = `gemini:antigravity`，blob 是 base64 编码的 JSON。
 *
 * 非 Windows 平台直接返回 null，调用方回退到 `/status` 的压平数据。
 * ----------------------------------------------------------------------------
 */

const { execFile } = require('node:child_process');

/** 凭据管理器里的条目名。 */
const KEYRING_TARGET = 'gemini:antigravity';

/** 缓存：避免每次轮询都起一个 PowerShell 进程（单次 0.2–3 s）。 */
const CACHE_TTL_MS = 30000;
let cached = { at: 0, value: null };

/**
 * PowerShell 脚本：P/Invoke 调用 CredRead 取出凭据 blob，base64 输出。
 *
 * 注意调用形式必须是 `-Command "& { <script> } <arg>"`。
 * 曾经试过用 `-Command -` 从 stdin 喂脚本，PowerShell 会解析 here-string
 * 后以退出码 0 结束、stdout 为空，静默失败——因此这里保持与 agy-cli 相同的
 * 调用形状。
 */
const PS_SCRIPT = String.raw`
param($target)
$sig = @'
using System;
using System.Runtime.InteropServices;
public class DshQuotaHubCred {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return "";
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return System.Text.Encoding.UTF8.GetString(b);
    } finally { CredFree(ptr); }
  }
}
'@
Add-Type -TypeDefinition $sig
$blob = [DshQuotaHubCred]::Read($target)
if ([string]::IsNullOrEmpty($blob)) { Write-Output "NOBLOB" } else {
  Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($blob)))
}
`;

/** 起一次 PowerShell 读凭据，返回解析后的对象；失败返回 null。 */
function readBlobViaPowerShell() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `& { ${PS_SCRIPT} } ${KEYRING_TARGET}`],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout || '').trim();
        if (!out || out === 'NOBLOB') return resolve(null);
        try {
          const json = Buffer.from(out, 'base64').toString('utf8');
          resolve(JSON.parse(json));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 读取 antigravity 的访问令牌。
 *
 * @param {{force?:boolean}} [options] force 为真时跳过缓存
 * @returns {Promise<{accessToken:string, expiresAtMs:number|null, expired:boolean}|null>}
 */
async function readAntigravityToken(options) {
  const force = Boolean(options && options.force);
  const now = Date.now();
  if (!force && cached.value && now - cached.at < CACHE_TTL_MS) return cached.value;

  const blob = await readBlobViaPowerShell();
  if (!blob) {
    cached = { at: now, value: null };
    return null;
  }

  const token = blob.token || {};
  const accessToken = typeof token.access_token === 'string' ? token.access_token : null;
  if (!accessToken) {
    cached = { at: now, value: null };
    return null;
  }

  // `expiry` 是 agy.exe 自己续期时比较的字段，直接采信；解析不了就不判定过期
  const rawExpiry = token.expiry;
  const expiresAtMs = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN;
  const value = {
    accessToken,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    // 提前 30 秒算过期，避免请求发出去时刚好失效
    expired: Number.isFinite(expiresAtMs) ? expiresAtMs - 30000 <= now : false,
  };
  cached = { at: now, value };
  return value;
}

/** 仅供测试/排障：清掉缓存。 */
function clearCache() {
  cached = { at: 0, value: null };
}

module.exports = { readAntigravityToken, clearCache, KEYRING_TARGET };
