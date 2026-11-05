'use strict';

/** 由 QH_DEBUG 控制的服务端调试日志。 */

/** 是否开启调试日志 */
function enabled() {
  return process.env.QH_DEBUG === '1';
}

/** 输出调试日志（默认静默） */
function debug(...args) {
  if (!enabled()) return;
  try {
    console.error('[quota-hub]', ...args);
  } catch (e) {
    /* 日志失败不能影响主流程 */
  }
}

module.exports = { debug, enabled };
