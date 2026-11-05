'use strict';

/**
 * src/aggregator.js
 * ----------------------------------------------------------------------------
 * 聚合调度器：并发拉取三家额度、缓存结果、隔离单家失败。
 *
 * 设计要点：
 *   - 并发：Promise.allSettled 同时请求三家，互不阻塞；总耗时 ≈ 最慢的那一家，
 *     而不是三家之和。
 *   - 隔离：单家超时/报错只影响该家条目，不拖垮整份 summary。
 *     各适配器内部已把异常转成 status='error' 的结构化结果，这里再用 allSettled
 *     兜一层，防御「适配器意外 throw」这种极端情况。
 *   - 缓存：TTL 内返回上次结果，配合客户端 10 分钟轮询，避免上游被刷。
 *   - force：手动刷新 / ?force=1 时绕过缓存强制重新拉取。
 *   - runtime：把「本次请求上下文」（如从 Host 头推断出的 web 端口）透传给适配器，
 *     这样 agy 适配器不需要写死端口。
 * ----------------------------------------------------------------------------
 */

const { adapters } = require('./adapters');
const { failResult } = require('./shape');

/**
 * 创建聚合器实例。
 * @param {object} config 归一化后的完整配置
 * @param {object} credentials 解析后的凭据（见 src/credentials.js）
 */
function createAggregator(config, credentials) {
  /** 内存缓存：{ summary, fetchedAt } */
  let cache = null;

  /**
   * 无缓存地重新拉取全部适配器。
   * @param {object} runtime 运行期上下文（例如 { webPort }）
   * @returns {Promise<object>} summary 对象
   */
  async function fetchOnce(runtime) {
    const settled = await Promise.allSettled(
      adapters.map((adapter) => Promise.resolve(adapter.fetch(credentials, config, runtime)))
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

    if (!force && cache && ttl > 0 && now - cache.fetchedAt < ttl) {
      return cache.summary;
    }

    const summary = await fetchOnce(runtime);
    cache = { summary, fetchedAt: now };
    return summary;
  }

  /** 清空缓存（例如凭据变更后调用） */
  function invalidate() {
    cache = null;
  }

  return { getSummary, invalidate };
}

module.exports = { createAggregator };
