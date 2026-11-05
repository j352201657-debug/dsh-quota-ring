'use strict';

/**
 * src/adapters/index.js
 * ----------------------------------------------------------------------------
 * 适配器注册表。顺序即卡片里的展示顺序。
 *
 * 三家形态不同，故意的：
 *   deepseek → kind:'money'   （CNY 金额，有剩余也有已用）
 *   codex    → kind:'percent' （5h + 周 两个速率窗口）
 *   agy      → kind:'percent' （周额度为主；Gemini 走 agy-cli）
 *
 * 新增一个平台只需写一个 { id, label, fetch(credentials, config, runtime) }
 * 并加到这个数组里 —— 聚合器会自动并发调用、隔离失败、纳入缓存。
 * ----------------------------------------------------------------------------
 */

const deepseek = require('./deepseek');
const codex = require('./codex');
const agy = require('./agy');

/** 全部适配器（顺序 = 界面顺序） */
const adapters = [deepseek, codex, agy];

module.exports = { adapters };
