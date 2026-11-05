'use strict';

/** 并发聚合额度查询，合并在途请求并缓存已完成的结果。 */

const { adapters } = require('./adapters');
const { failResult } = require('./shape');

/**
 * 创建聚合器实例。
 * @param {object} config 归一化后的完整配置
 * @param {object|function():object} credentials 凭据对象或读取函数
 */
function createAggregator(config, credentials) {
  /** 内存缓存：{ summary, fetchedAt } */
  let cache = null;
  let inFlight = null;

  /**
   * 无缓存地重新拉取全部适配器。
   * @param {object} runtime 运行期上下文（例如 { webPort }）
   * @returns {Promise<object>} summary 对象
   */
  async function fetchOnce(runtime) {
    const currentCredentials = typeof credentials === 'function' ? credentials() : credentials;
    const settled = await Promise.allSettled(
      adapters.map((adapter) => Promise.resolve().then(() => adapter.fetch(currentCredentials, config, runtime)))
    );

    // 逐个整理结果：fulfilled 直接用；rejected 兜底成 error 条目
    const providers = settled.map((item, idx) => {
      const adapter = adapters[idx];
      if (item.status === 'fulfilled' && item.value) {
        return item.value;
      }
      const reason = item.reason && item.reason.message ? item.reason.message : '未知异常';
      return failResult(adapter.id, adapter.label, 'error', `${adapter.label} 聚合异常：${reason}`);
    });

    const okCount = providers.filter((p) => p.status === 'ok').length;

    return {
      providers,
      fetchedAt: Date.now(),
      // 顶部圆环 / 总览用的健康度摘要
      health: { ok: okCount, total: providers.length },
    };
  }

  /**
   * 获取 summary（带缓存）。
   * @param {{ force?: boolean, runtime?: object }} [opts]
   *   force=true 强制绕过缓存；runtime 透传给适配器
   */
  async function getSummary(opts = {}) {
    const force = Boolean(opts.force);
    const runtime = opts.runtime || {};
    const now = Date.now();
    const ttl = config.serverCacheTtlMs || 0;

    if (inFlight) return inFlight;

    if (!force && cache && ttl > 0 && now - cache.fetchedAt < ttl) {
      return cache.summary;
    }

    inFlight = fetchOnce(runtime).then((summary) => {
      cache = { summary, fetchedAt: Date.now() };
      return summary;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** 清空缓存（例如凭据变更后调用） */
  function invalidate() {
    cache = null;
  }

  return { getSummary, invalidate };
}

module.exports = { createAggregator };
