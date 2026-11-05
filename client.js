/** 客户端入口：悬浮额度圆环、明细卡片和轮询交互。 */
(function () {
  'use strict';

  // 防止重复注入（若宿主重复执行本脚本）
  if (window.__quotaHubLoaded) return;
  window.__quotaHubLoaded = true;

  /* ============================ 客户端内联默认配置 ============================ */
  // 与 src/config.js 保持一致；真正的权威配置会在运行时从 GET /config 拉取覆盖。
  const DEFAULT_CONFIG = {
    refreshIntervalMs: 600000, // 轮询周期 10 分钟
    idleMultiplier: 3,         // 失焦降频倍数
    pauseWhenHidden: false,    // 失焦是否暂停
    serverCacheTtlMs: 60000,
    requestTimeoutMs: 15000,
  };

  /** 浅合并对象（客户端侧足够） */
  function shallowMerge(a, b) {
    const out = Object.assign({}, a);
    if (b && typeof b === 'object') {
      for (const k of Object.keys(b)) {
        if (b[k] !== undefined) out[k] = b[k];
      }
    }
    return out;
  }

  /** 归一化客户端配置 */
  function normalizeConfig(raw) {
    const c = shallowMerge(DEFAULT_CONFIG, raw || {});
    const num = (v, def, min) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : def;
    };
    c.refreshIntervalMs = num(c.refreshIntervalMs, DEFAULT_CONFIG.refreshIntervalMs, 5000);
    c.idleMultiplier = num(c.idleMultiplier, DEFAULT_CONFIG.idleMultiplier, 1);
    c.serverCacheTtlMs = num(c.serverCacheTtlMs, DEFAULT_CONFIG.serverCacheTtlMs, 0);
    c.pauseWhenHidden = Boolean(c.pauseWhenHidden);
    return c;
  }

  /* ============================ 全局状态 ============================ */
  const state = {
    config: normalizeConfig({}),
    summary: null,    // 最近一次 /summary 结果
    loadError: null,  // 最近一次网络/解析错误
    loading: false,
    expanded: false,  // 卡片是否展开
    hasLoadedOnce: false,
  };

  /* ============================ 常量与工具 ============================ */
  const API_BASE = '/api/quota-hub';

  /** 状态 → 中文文案 + 颜色（浅色底：深一档，保证白底可读） */
  const STATUS_META = {
    ok: { text: '正常', color: '#15803d' },
    unavailable: { text: '额度不可用', color: '#b45309' },
    error: { text: '请求失败', color: '#dc2626' },
    missing_key: { text: '未登录', color: '#6b7280' },
  };

  /** 币种 → 符号 */
  const CURRENCY_SYMBOL = { USD: '$', CNY: '¥', EUR: '€', JPY: '¥', GBP: '£' };

  /** 金额格式化（保留两位小数，异常值显示「—」） */
  function fmtMoney(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const symbol = CURRENCY_SYMBOL[currency] || '';
    return symbol + Number(value).toFixed(2);
  }

  /** 百分比格式化（保留一位小数，异常值显示「—」） */
  function fmtPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    // 100% 与 0% 不要显示成 100.0%，视觉上更干净
    if (Math.abs(n - Math.round(n)) < 0.05) return Math.round(n) + '%';
    return n.toFixed(1) + '%';
  }

  /**
   * 把「重置时间」格式化成倒计时文案。
   * @param {number|null} resetsAt 毫秒时间戳
   * @returns {string}
   */
  function fmtCountdown(resetsAt) {
    if (!resetsAt) return '';
    const diff = Number(resetsAt) - Date.now();
    if (!Number.isFinite(diff)) return '';
    if (diff <= 0) return '即将重置';
    const mins = Math.floor(diff / 60000);
    // 卡片里一行要塞下「标签 + 进度条 + 百分比 + 倒计时」，
    // 倒计时使用紧凑的时、分单位。
    if (mins < 60) return `${Math.max(1, mins)} 分后重置`;
    const hours = Math.floor(mins / 60);
    const restMin = mins % 60;
    if (hours < 24) return restMin > 0 ? `${hours} 时 ${restMin} 分后重置` : `${hours} 时后重置`;
    const days = Math.floor(hours / 24);
    const restHour = hours % 24;
    return restHour > 0 ? `${days} 天 ${restHour} 时后重置` : `${days} 天后重置`;
  }

  /** 剩余百分比 → 颜色（越少越红；浅色底用 600 档色，保证白底对比度） */
  function pctColor(pct) {
    if (pct === null || pct === undefined) return '#9aa4b2';
    if (pct <= 10) return '#dc2626';
    if (pct <= 30) return '#ea580c';
    if (pct <= 60) return '#ca8a04';
    return '#16a34a';
  }

  /**
   * 把「多少分钟之后」格式化成紧凑文案，如「11 小时 53 分」「27 分」「2 天 3 小时」。
   * 用于峰谷切换倒计时（不带「后重置」这类后缀，因为调用方自己拼）。
   */
  function fmtDuration(mins) {
    const m = Math.max(0, Math.floor(Number(mins) || 0));
    if (m < 60) return `${m} 分`;
    const hours = Math.floor(m / 60);
    const restMin = m % 60;
    if (hours < 24) return restMin > 0 ? `${hours} 小时 ${restMin} 分` : `${hours} 小时`;
    const days = Math.floor(hours / 24);
    const restHour = hours % 24;
    return restHour > 0 ? `${days} 天 ${restHour} 小时` : `${days} 天`;
  }

  /* ============================ 样式注入 ============================ */
  function injectStyles() {
    if (document.getElementById('qh-quota-hub-style')) return;
    const style = document.createElement('style');
    style.id = 'qh-quota-hub-style';
    style.textContent = [
      /* ============================================================
       * 配色：白底黑字（浅色主题）
       * ------------------------------------------------------------
       * 卡片、圆环、进度条全部走浅色底，文字用近黑色分层：
       *   #111827 主文案 / #6b7280 次文案 / #9aa4b2 弱提示
       * 强调色统一用 600 档（#16a34a/#ca8a04/#ea580c/#dc2626），
       * 因为浅底上 400 档的翠绿、柠檬黄几乎不可读。
       * ============================================================ */

      /* ---- 悬浮圆环 ---- */
      '#qh-fab { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;',
      '  width: 52px; height: 52px; padding: 0; border: 1px solid #e4e7ec; border-radius: 50%;',
      '  background: #ffffff; cursor: pointer;',
      '  display: flex; align-items: center; justify-content: center;',
      '  box-shadow: 0 4px 14px rgba(15,23,42,.16);',
      '  transition: transform .18s ease, box-shadow .18s ease; }',
      '#qh-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(15,23,42,.22); }',
      '#qh-fab svg { position: absolute; inset: 0; }',
      '#qh-fab .qh-fab-label { position: relative; font: 600 13px/1 -apple-system, "Segoe UI", sans-serif;',
      '  color: #111827; letter-spacing: -.3px; }',
      '#qh-fab.qh-fab-loading .qh-fab-label { animation: qh-pulse 1.1s ease-in-out infinite; }',
      '@keyframes qh-pulse { 0%,100%{opacity:.35} 50%{opacity:1} }',
      '#qh-fab .qh-ring-track { stroke: #e9edf2; }',
      '#qh-fab .qh-ring-prog { transition: stroke-dashoffset .5s ease, stroke .3s ease; }',

      /* ---- 卡片 ---- */
      '#qh-card { position: fixed; right: 24px; bottom: 88px; z-index: 2147483000;',
      '  width: 348px; max-width: calc(100vw - 32px);',
      '  background: #ffffff; color: #111827;',
      '  border: 1px solid #e4e7ec; border-radius: 14px;',
      '  box-shadow: 0 12px 40px rgba(15,23,42,.18); overflow: hidden;',
      '  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;',
      '  transform-origin: bottom right;',
      '  transition: opacity .16s ease, transform .16s ease; }',
      '#qh-card.qh-hidden { opacity: 0; transform: scale(.96) translateY(6px); pointer-events: none; }',

      /* ---- 头部 ---- */
      '#qh-card .qh-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px;',
      '  border-bottom: 1px solid #eef1f4; }',
      '#qh-card .qh-title { font-weight: 600; font-size: 14px; flex: 1; color: #111827; }',
      '#qh-card .qh-updated { font-size: 11px; color: #9aa4b2; }',
      '#qh-card .qh-btn { border: 1px solid #d8dee6; background: #ffffff; color: #374151;',
      '  border-radius: 7px; padding: 4px 9px; cursor: pointer; font-size: 12px; line-height: 1;',
      '  transition: background .15s ease, color .15s ease, border-color .15s ease; }',
      '#qh-card .qh-btn:hover { background: #f1f5f9; border-color: #c2cad6; color: #111827; }',
      '#qh-card .qh-btn:disabled { opacity: .5; cursor: not-allowed; }',
      '#qh-card .qh-close { font-size: 16px; padding: 2px 8px; }',

      /* ---- 主体 ---- */
      '#qh-card .qh-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px;',
      '  max-height: 468px; overflow-y: auto; }',
      '#qh-card .qh-provider { border: 1px solid #eceff3; border-radius: 10px;',
      '  padding: 10px 12px; background: #fcfdfe; }',
      '#qh-card .qh-phead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }',
      '#qh-card .qh-pname { font-weight: 600; color: #111827; }',
      '#qh-card .qh-psub { font-size: 10px; color: #9aa4b2; flex: 1; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap; }',
      '#qh-card .qh-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px;',
      '  background: #f1f5f9; white-space: nowrap; }',

      /* 金额行 */
      '#qh-card .qh-money { display: flex; gap: 18px; font-size: 12px; color: #6b7280; }',
      '#qh-card .qh-money b { color: #111827; font-weight: 600; font-size: 14px; }',

      /* 窗口行（百分比） */
      '#qh-card .qh-win { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 3px; }',
      '#qh-card .qh-win-label { color: #6b7280; min-width: 58px; flex: none; }',
      '#qh-card .qh-win-bar { flex: 1 1 40px; min-width: 36px; height: 5px; border-radius: 999px;',
      '  background: #e9edf2; overflow: hidden; }',
      '#qh-card .qh-win-fill { height: 100%; border-radius: 999px; transition: width .4s ease; }',
      '#qh-card .qh-win-pct { font-weight: 600; min-width: 44px; flex: none; text-align: right; }',
      '#qh-card .qh-win-reset { color: #9aa4b2; font-size: 10px; flex: 0 1 auto; min-width: 0;',
      '  text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#qh-card .qh-win.qh-unknown .qh-win-label { color: #9aa4b2; }',

      /* 附注与消息 */
      '#qh-card .qh-notes { margin-top: 6px; font-size: 10px; color: #9aa4b2; line-height: 1.45; }',
      '#qh-card .qh-notes-warn { color: #b45309; }',
      '#qh-card .qh-msg { margin-top: 6px; font-size: 11px; color: #b45309; line-height: 1.45; }',
      '#qh-card .qh-provider[data-status="error"] .qh-msg { color: #dc2626; }',

      /* ---- DeepSeek 峰谷时间条 ---- */
      /* 峰=橙 #f59e0b，平价/谷=蓝 #2563eb（浅色底上取 600 档，与整卡同调） */
      '#qh-card .qh-peak { margin-top: 7px; display: flex; flex-direction: column; gap: 5px; }',
      '#qh-card .qh-peak-strip { position: relative; height: 6px; border-radius: 999px;',
      '  overflow: hidden; display: flex; background: #e9edf2; }',
      '#qh-card .qh-peak-seg { height: 100%; }',
      '#qh-card .qh-peak-seg.qh-peak-on { background: #f59e0b; }',
      '#qh-card .qh-peak-seg.qh-peak-off { background: #2563eb; }',
      /* 「此刻」标记：一条 2px 深色竖线（白底上无法用白线） */
      '#qh-card .qh-peak-now { position: absolute; top: -2px; width: 2px; height: 10px;',
      '  background: #111827; border-radius: 1px; box-shadow: 0 0 0 1px rgba(255,255,255,.85); }',
      '#qh-card .qh-peak-text { display: flex; align-items: center; gap: 6px; font-size: 11px; }',
      '#qh-card .qh-peak-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }',
      '#qh-card .qh-peak-phase { font-weight: 600; }',
      '#qh-card .qh-peak-next { color: #9aa4b2; }',

      /* ---- 今日消耗 ---- */
      '#qh-card .qh-usage { margin-top: 6px; display: flex; gap: 16px; font-size: 12px; color: #6b7280; }',
      '#qh-card .qh-usage b { color: #111827; font-weight: 600; }',
      '#qh-card .qh-usage .qh-usage-hint { font-size: 10px; color: #9aa4b2; }',

      /* ---- Gemini 分组 ---- */
      '#qh-card .qh-group { margin-top: 8px; }',
      '#qh-card .qh-group:first-child { margin-top: 0; }',
      '#qh-card .qh-group-title { font-size: 11px; color: #6b7280; font-weight: 600;',
      '  margin-bottom: 2px; }',

      /* ---- 底部总览 ---- */
      '#qh-card .qh-foot { padding: 10px 14px; border-top: 1px solid #eef1f4;',
      '  font-size: 11px; color: #6b7280; display: flex; flex-direction: column; gap: 3px;',
      '  background: #fbfcfd; }',
      '#qh-card .qh-foot b { color: #111827; font-weight: 600; }',
      '#qh-card .qh-empty { color: #6b7280; text-align: center; padding: 18px 0; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ============================ DOM 构建 ============================ */
  /** 圆环半径与周长（SVG viewBox 52x52，r=22） */
  const RING_R = 22;
  const RING_C = 2 * Math.PI * RING_R;

  let fabEl = null;
  let fabLabelEl = null;
  let ringProgEl = null;
  let cardEl = null;
  let bodyEl = null;
  let footEl = null;
  let updatedEl = null;
  let refreshBtnEl = null;

  /** 创建悬浮圆环按钮（SVG 环形进度 + 中心数字） */
  function buildFab() {
    fabEl = document.createElement('button');
    fabEl.id = 'qh-fab';
    fabEl.type = 'button';
    fabEl.title = '额度总览（DeepSeek / GPT / Gemini）';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 52 52');
    svg.setAttribute('width', '52');
    svg.setAttribute('height', '52');

    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', '26');
    track.setAttribute('cy', '26');
    track.setAttribute('r', String(RING_R));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '3.5');
    track.setAttribute('class', 'qh-ring-track');

    ringProgEl = document.createElementNS(svgNS, 'circle');
    ringProgEl.setAttribute('cx', '26');
    ringProgEl.setAttribute('cy', '26');
    ringProgEl.setAttribute('r', String(RING_R));
    ringProgEl.setAttribute('fill', 'none');
    ringProgEl.setAttribute('stroke-width', '3.5');
    ringProgEl.setAttribute('stroke-linecap', 'round');
    // 从 12 点方向顺时针画
    ringProgEl.setAttribute('transform', 'rotate(-90 26 26)');
    ringProgEl.setAttribute('stroke-dasharray', String(RING_C));
    ringProgEl.setAttribute('stroke-dashoffset', '0');
    ringProgEl.setAttribute('class', 'qh-ring-prog');
    ringProgEl.setAttribute('stroke', '#16a34a');

    svg.appendChild(track);
    svg.appendChild(ringProgEl);

    fabLabelEl = document.createElement('span');
    fabLabelEl.className = 'qh-fab-label';
    fabLabelEl.textContent = '…';

    fabEl.appendChild(svg);
    fabEl.appendChild(fabLabelEl);
    fabEl.addEventListener('click', () => {
      state.expanded = !state.expanded;
      renderCard();
    });
    document.body.appendChild(fabEl);
  }

  /** 创建额度卡片 */
  function buildCard() {
    cardEl = document.createElement('div');
    cardEl.id = 'qh-card';
    cardEl.className = 'qh-hidden';

    // 头部
    const head = document.createElement('div');
    head.className = 'qh-head';
    const title = document.createElement('span');
    title.className = 'qh-title';
    title.textContent = '额度总览';
    updatedEl = document.createElement('span');
    updatedEl.className = 'qh-updated';
    refreshBtnEl = document.createElement('button');
    refreshBtnEl.className = 'qh-btn';
    refreshBtnEl.type = 'button';
    refreshBtnEl.textContent = '刷新';
    refreshBtnEl.title = '获取最新额度';
    refreshBtnEl.addEventListener('click', scheduleManualRefresh);
    const close = document.createElement('button');
    close.className = 'qh-btn qh-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = '收起';
    close.addEventListener('click', () => {
      state.expanded = false;
      renderCard();
    });
    head.appendChild(title);
    head.appendChild(updatedEl);
    head.appendChild(refreshBtnEl);
    head.appendChild(close);

    bodyEl = document.createElement('div');
    bodyEl.className = 'qh-body';

    footEl = document.createElement('div');
    footEl.className = 'qh-foot';

    cardEl.appendChild(head);
    cardEl.appendChild(bodyEl);
    cardEl.appendChild(footEl);
    document.body.appendChild(cardEl);
  }

  /* ============================ 渲染 ============================ */
  /** 生成「金额型」额度行：剩余 + 已用 */
  function renderMoneyRows(provider) {
    const rows = document.createElement('div');
    rows.className = 'qh-money';

    const rem = document.createElement('span');
    rem.appendChild(document.createTextNode('剩余 '));
    const remB = document.createElement('b');
    remB.textContent = fmtMoney(provider.remaining, provider.unit);
    rem.appendChild(remB);

    const used = document.createElement('span');
    used.appendChild(document.createTextNode('已用 '));
    const usedB = document.createElement('b');
    usedB.textContent = fmtMoney(provider.used, provider.unit);
    used.appendChild(usedB);

    rows.appendChild(rem);
    rows.appendChild(used);
    return rows;
  }

  /** 生成「百分比窗口」行：进度条 + 剩余% + 重置倒计时 */
  function renderWindowRows(provider) {
    const wrap = document.createElement('div');
    const windows = Array.isArray(provider.windows) ? provider.windows : [];

    if (windows.length === 0) {
      const none = document.createElement('div');
      none.className = 'qh-win';
      none.textContent = '未上报速率窗口';
      wrap.appendChild(none);
      return wrap;
    }

    for (const w of windows) {
      wrap.appendChild(buildWindowRow(w));
    }
    return wrap;
  }

  /** 单行窗口：label + 进度条 + 剩余% + 重置倒计时 */
  function buildWindowRow(w) {
    const row = document.createElement('div');
    row.className = 'qh-win' + (w.unknown ? ' qh-unknown' : '');

    const label = document.createElement('span');
    label.className = 'qh-win-label';
    label.textContent = w.label || '窗口';

    const bar = document.createElement('div');
    bar.className = 'qh-win-bar';
    const fill = document.createElement('div');
    fill.className = 'qh-win-fill';
    const pct = w.unknown ? 0 : Math.max(0, Math.min(100, Number(w.remainingPercent) || 0));
    fill.style.width = pct + '%';
    fill.style.background = pctColor(w.unknown ? null : pct);
    bar.appendChild(fill);

    const pctEl = document.createElement('span');
    pctEl.className = 'qh-win-pct';
    pctEl.textContent = w.unknown ? '未知' : fmtPercent(w.remainingPercent);
    pctEl.style.color = pctColor(w.unknown ? null : pct);

    const resetEl = document.createElement('span');
    resetEl.className = 'qh-win-reset';
    resetEl.textContent = w.unknown ? '未上报' : fmtCountdown(w.resetsAt);

    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(pctEl);
    row.appendChild(resetEl);
    return row;
  }

  /**
   * 生成「分组窗口」：Gemini 的额度按 group 划分（Gemini 模型 / Claude 与 GPT /
   * Gemini 4 Argon），与 antigravity 官方面板的结构一致。
   * 没有 groups 时退回单层窗口列表。
   */
  function renderGroupedWindows(provider) {
    const groups = Array.isArray(provider.groups) ? provider.groups : [];
    if (groups.length === 0) return renderWindowRows(provider);

    const wrap = document.createElement('div');
    for (const g of groups) {
      const box = document.createElement('div');
      box.className = 'qh-group';

      const title = document.createElement('div');
      title.className = 'qh-group-title';
      title.textContent = g.label || '额度组';
      // 注意：g.description 是上游的大段英文说明，按「不上界面」的约定这里不渲染、
      // 也不挂 tooltip——仅展示额度组名称。
      box.appendChild(title);

      for (const w of g.windows || []) {
        box.appendChild(buildWindowRow(w));
      }
      wrap.appendChild(box);
    }
    return wrap;
  }

  /**
   * DeepSeek 峰谷时间条（仿 DSH 费用插件的效果）：
   *   一条 24 小时横向时间条，橙色 = 高峰、蓝色 = 平价，白线标出当前时刻；
   *   下面一行文字「平价 · 11 小时 53 分后进入高峰」。
   */
  function renderPeakBar(provider) {
    const peak = provider.peak;
    if (!peak || !Array.isArray(peak.segments) || peak.segments.length === 0) return null;

    const isPeak = peak.phase === 'peak';
    // 与时间条同色（浅色底取 600 档）：峰=橙，平价=蓝
    const color = isPeak ? '#d97706' : '#2563eb';

    const box = document.createElement('div');
    box.className = 'qh-peak';

    // ---- 时间条 ----
    const strip = document.createElement('div');
    strip.className = 'qh-peak-strip';
    strip.title = '北京时间 00:00–24:00 的峰谷时段分布（橙 = 高峰，蓝 = 平价）';

    for (const seg of peak.segments) {
      const el = document.createElement('div');
      el.className = 'qh-peak-seg ' + (seg.phase === 'peak' ? 'qh-peak-on' : 'qh-peak-off');
      const width = Math.max(0, (Number(seg.to) - Number(seg.from)) * 100);
      el.style.width = width + '%';
      strip.appendChild(el);
    }

    // 「此刻」标记：把当前时刻换算成当日 0–1 的比例
    if (Number.isFinite(peak.nowMs) && Number.isFinite(peak.dayStartMs) && Number.isFinite(peak.dayEndMs)) {
      const total = peak.dayEndMs - peak.dayStartMs;
      if (total > 0) {
        const ratio = Math.max(0, Math.min(1, (peak.nowMs - peak.dayStartMs) / total));
        const marker = document.createElement('div');
        marker.className = 'qh-peak-now';
        marker.style.left = ratio * 100 + '%';
        strip.appendChild(marker);
      }
    }
    box.appendChild(strip);

    // ---- 文字：当前阶段 · 距离切换的倒计时 ----
    const text = document.createElement('div');
    text.className = 'qh-peak-text';

    const dot = document.createElement('span');
    dot.className = 'qh-peak-dot';
    dot.style.background = color;
    text.appendChild(dot);

    const phaseEl = document.createElement('span');
    phaseEl.className = 'qh-peak-phase';
    phaseEl.style.color = color;
    let phaseText = isPeak ? '高峰' : '平价';
    // 周末 / 节假日会整日按谷价，说明原因比只写「平价」更有用
    if (!isPeak && peak.reason === 'weekend') phaseText = '平价 · 周末';
    if (!isPeak && peak.reason === 'holiday') phaseText = '平价 · 节假日';
    phaseEl.textContent = phaseText;
    text.appendChild(phaseEl);

    if (Number.isFinite(peak.nextAtMs)) {
      const nextEl = document.createElement('span');
      nextEl.className = 'qh-peak-next';
      const mins = Math.max(1, Math.round((peak.nextAtMs - peak.nowMs) / 60000));
      const into = peak.nextPhase === 'peak' ? '进入高峰' : '转为平价';
      nextEl.textContent = '· ' + fmtDuration(mins) + '后' + into;
      text.appendChild(nextEl);
    }

    box.appendChild(text);
    return box;
  }

  /** 今日消耗行（DeepSeek 专用） */
  function renderUsageRow(provider) {
    const usage = provider.usage;
    if (!usage || usage.today === null || usage.today === undefined) return null;

    const row = document.createElement('div');
    row.className = 'qh-usage';

    const span = document.createElement('span');
    span.appendChild(document.createTextNode('今日消耗 '));
    const b = document.createElement('b');
    b.textContent = fmtMoney(usage.today, usage.currency || provider.unit);
    span.appendChild(b);

    // 起点不是零点时要说明，否则「今日」二字会误导
    if (Number.isFinite(usage.sinceMs)) {
      const hint = document.createElement('span');
      hint.className = 'qh-usage-hint';
      const t = new Date(usage.sinceMs);
      hint.textContent =
        ' （自 ' +
        String(t.getHours()).padStart(2, '0') +
        ':' +
        String(t.getMinutes()).padStart(2, '0') +
        ' 起）';
      span.appendChild(hint);
    }
    row.appendChild(span);
    return row;
  }

  /** 生成单个平台条目（全部 textContent，使用 textContent 写入动态文本） */
  function renderProvider(provider) {
    const wrap = document.createElement('div');
    wrap.className = 'qh-provider';
    wrap.dataset.status = provider.status;

    const meta = STATUS_META[provider.status] || STATUS_META.error;

    // ---- 头部：名称 + 副标题（计划/账号）+ 状态徽标 ----
    const phead = document.createElement('div');
    phead.className = 'qh-phead';

    const pname = document.createElement('span');
    pname.className = 'qh-pname';
    pname.textContent = provider.label || provider.id;
    phead.appendChild(pname);

    const subParts = [];
    if (provider.plan) subParts.push(provider.plan);
    if (provider.account) subParts.push(provider.account);
    if (subParts.length > 0) {
      const psub = document.createElement('span');
      psub.className = 'qh-psub';
      psub.textContent = subParts.join(' · ');
      psub.title = subParts.join(' · ');
      phead.appendChild(psub);
    } else {
      // 占位，把徽标推到右侧
      const spacer = document.createElement('span');
      spacer.className = 'qh-psub';
      phead.appendChild(spacer);
    }

    const badge = document.createElement('span');
    badge.className = 'qh-badge';
    badge.textContent = meta.text;
    badge.style.color = meta.color;
    phead.appendChild(badge);

    wrap.appendChild(phead);

    // ---- 主体：按 kind 分派 ----
    if (provider.status === 'ok') {
      if (provider.kind === 'money') {
        wrap.appendChild(renderMoneyRows(provider));
        // 今日消耗：只要上游给了就显示（DeepSeek 专用）
        const usageRow = renderUsageRow(provider);
        if (usageRow) wrap.appendChild(usageRow);
        // 峰谷时间条：DeepSeek 官方有峰谷计价，其他平台没有
        const peakBar = renderPeakBar(provider);
        if (peakBar) wrap.appendChild(peakBar);
      } else {
        // Gemini 会带 groups（三个额度池）；GPT 只有一层 windows
        wrap.appendChild(renderGroupedWindows(provider));
      }
    }

    // ---- 附注：只显示需要用户注意的告警，解释性文字不上界面 ----
    // 上游常返回大段英文说明（如 antigravity 的 group.description）与
    // 「数据源：…」「登录态剩余约…」这类内部信息，堆在卡片里只会变噪音。
    // 只有以 ⚠ 开头的告警（如「该窗口已用尽」）值得占用界面空间。
    if (Array.isArray(provider.notes) && provider.notes.length > 0 && provider.status === 'ok') {
      const warnings = provider.notes.filter((n) => typeof n === 'string' && n.trim().startsWith('⚠'));
      if (warnings.length > 0) {
        const notes = document.createElement('div');
        notes.className = 'qh-notes qh-notes-warn';
        notes.textContent = warnings.join(' · ');
        wrap.appendChild(notes);
      }
    }

    // ---- 错误/降级说明 ----
    if (provider.message) {
      const msg = document.createElement('div');
      msg.className = 'qh-msg';
      msg.textContent = provider.message;
      wrap.appendChild(msg);
    }

    return wrap;
  }

  /**
   * 计算底部「总览」。
   * 金额余额与百分比速率窗口分别汇总。
   * 百分比不参与金额折算。
   */
  function computeOverview(providers) {
    const okProviders = providers.filter((p) => p.status === 'ok');

    // 金额型：只有 DeepSeek，直接展示
    const money = okProviders.filter((p) => p.kind === 'money' && p.remaining !== null &&
      p.remaining !== undefined && String(p.remaining).trim() !== '' && Number.isFinite(Number(p.remaining)));

    // 百分比型：找出「最紧的窗口」（剩余最少）
    let tightest = null;
    for (const p of okProviders) {
      if (p.kind !== 'percent') continue;
      for (const w of p.windows || []) {
        if (w.unknown || w.remainingPercent === null || w.remainingPercent === undefined ||
            String(w.remainingPercent).trim() === '' || !Number.isFinite(Number(w.remainingPercent))) continue;
        const r = Number(w.remainingPercent);
        if (!tightest || r < tightest.remainingPercent) {
          tightest = { provider: p.label, label: w.label, remainingPercent: r };
        }
      }
    }

    return { money, tightest, okCount: okProviders.length, total: providers.length };
  }

  /** 重绘卡片与圆环 */
  function renderCard() {
    if (!cardEl) return;

    // 展开/折叠
    cardEl.classList.toggle('qh-hidden', !state.expanded);

    // 头部时间
    if (state.summary && state.summary.fetchedAt) {
      const d = new Date(state.summary.fetchedAt);
      updatedEl.textContent = '更新 ' + d.toLocaleTimeString('zh-CN', { hour12: false });
      updatedEl.title = d.toLocaleString('zh-CN', { hour12: false });
    } else {
      updatedEl.textContent = '';
    }

    // 主体
    bodyEl.textContent = '';
    const providers = (state.summary && state.summary.providers) || [];

    if (!state.summary && state.loading) {
      const empty = document.createElement('div');
      empty.className = 'qh-empty';
      empty.textContent = '正在加载…';
      bodyEl.appendChild(empty);
    } else if (!state.summary && state.loadError) {
      const empty = document.createElement('div');
      empty.className = 'qh-empty';
      empty.textContent = '加载失败：' + state.loadError;
      bodyEl.appendChild(empty);
    } else if (providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qh-empty';
      empty.textContent = '暂无数据';
      bodyEl.appendChild(empty);
    } else {
      providers.forEach((p) => bodyEl.appendChild(renderProvider(p)));
    }

    // 底部总览
    footEl.textContent = '';
    const ov = computeOverview(providers);

    if (providers.length === 0) {
      const line = document.createElement('span');
      line.textContent = '等待首次刷新…';
      footEl.appendChild(line);
    } else {
      // 第一行：金额余额
      const line1 = document.createElement('span');
      if (ov.money.length > 0) {
        const parts = ov.money.map((p) => fmtMoney(p.remaining, p.unit) + '（' + p.label + '）');
        line1.appendChild(document.createTextNode('可用余额 '));
        const b = document.createElement('b');
        b.textContent = parts.join(' + ');
        line1.appendChild(b);
      } else {
        line1.textContent = '可用余额：暂无可统计的账户余额';
      }
      footEl.appendChild(line1);

      // 第二行：最紧的速率窗口
      const line2 = document.createElement('span');
      if (ov.tightest) {
        line2.appendChild(document.createTextNode('最紧窗口 '));
        const b = document.createElement('b');
        b.textContent = fmtPercent(ov.tightest.remainingPercent);
        line2.appendChild(b);
        line2.appendChild(
          document.createTextNode(` 剩余（${ov.tightest.provider} · ${ov.tightest.label}）`)
        );
      } else {
        line2.textContent = '速率窗口：无可用百分比数据';
      }
      footEl.appendChild(line2);
    }

    renderFab(providers, ov);
  }

  /** 根据聚合结果更新圆环进度与颜色 */
  function renderFab(providers, ov) {
    if (!fabEl) return;

    // 加载中：数字脉冲
    const loadingFirst = state.loading && !state.hasLoadedOnce;
    fabEl.classList.toggle('qh-fab-loading', loadingFirst);

    if (!providers || providers.length === 0) {
      ringProgEl.setAttribute('stroke-dashoffset', String(RING_C));
      ringProgEl.setAttribute('stroke', '#95a5a6');
      fabLabelEl.textContent = loadingFirst ? '…' : '—';
      return;
    }

    const hasError = providers.some((p) => p.status === 'error');
    const allOk = providers.every((p) => p.status === 'ok');

    // 有百分比数据：环显示「最紧窗口剩余」
    if (ov && ov.tightest) {
      const pct = Math.max(0, Math.min(100, ov.tightest.remainingPercent));
      ringProgEl.setAttribute('stroke-dashoffset', String(RING_C * (1 - pct / 100)));
      ringProgEl.setAttribute('stroke', pctColor(pct));
      fabLabelEl.textContent = Math.round(pct) + '%';
      return;
    }

    // 只有金额数据：环满格，颜色表示健康度
    ringProgEl.setAttribute('stroke-dashoffset', '0');
    if (hasError) {
      ringProgEl.setAttribute('stroke', '#dc2626');
      fabLabelEl.textContent = '!';
    } else if (allOk) {
      ringProgEl.setAttribute('stroke', '#16a34a');
      fabLabelEl.textContent = '¥';
    } else {
      ringProgEl.setAttribute('stroke', '#ca8a04');
      fabLabelEl.textContent = '¥';
    }
  }

  /* ============================ 数据获取 ============================ */
  /** 拉取脱敏配置（权威配置，覆盖内联默认值） */
  async function loadConfig() {
    try {
      const res = await fetch(API_BASE + '/config', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data && data.config) {
        state.config = normalizeConfig(data.config);
      }
    } catch (e) {
      // 配置拉取失败不致命：保留内联默认值继续运行
      console.warn('[dsh-quota-ring] 配置拉取失败，使用默认配置：', e && e.message);
    }
  }

  /**
   * 拉取聚合 summary 并重绘。
   * @param {boolean} [force] 是否强制服务端绕过缓存（手动刷新用）
   */
  async function refreshSummary(force) {
    if (state.loading) return; // 避免并发重复请求
    state.loading = true;
    renderCard();
    try {
      const url = API_BASE + '/summary' + (force ? '?force=1' : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.summary = data && data.ok !== false ? data : { providers: [] };
      state.loadError = null;
      state.hasLoadedOnce = true;
    } catch (e) {
      state.loadError = e && e.message ? e.message : '网络错误';
    } finally {
      state.loading = false;
      renderCard();
    }
  }

  /* ============================ 轮询 / 防抖 / 失焦降频 ============================ */
  let pollTimer = null;
  let manualTimer = null;
  let lastManualAt = 0;
  const MANUAL_DEBOUNCE_MS = 600;   // 手动刷新防抖窗口
  const MANUAL_MIN_INTERVAL = 3000; // 手动刷新最小间隔

  /** 当前是否处于「失焦/隐藏」状态 */
  function isIdle() {
    return document.hidden || !document.hasFocus();
  }

  /** 当前轮询周期（失焦时按倍数拉长，或按配置暂停） */
  function currentInterval() {
    if (isIdle()) {
      if (state.config.pauseWhenHidden) return 0; // 0 表示暂停
      return state.config.refreshIntervalMs * state.config.idleMultiplier;
    }
    return state.config.refreshIntervalMs;
  }

  /** 启动（重建）轮询定时器 */
  function restartPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    const iv = currentInterval();
    if (iv > 0) {
      pollTimer = setInterval(() => {
        // 周期内若进入暂停态则跳过本次
        if (currentInterval() > 0) refreshSummary(false);
      }, iv);
    }
  }

  /**
   * 手动刷新：防抖 + 最小间隔双重保护，避免连点刷爆上游。
   * 防抖 600ms（连点只发一次）+ 最小间隔 3s（跨点击限流）。
   */
  function scheduleManualRefresh() {
    if (manualTimer) clearTimeout(manualTimer);
    const now = Date.now();
    const wait = Math.max(0, lastManualAt + MANUAL_MIN_INTERVAL - now);
    refreshBtnEl.disabled = true;
    manualTimer = setTimeout(() => {
      manualTimer = null;
      lastManualAt = Date.now();
      refreshBtnEl.disabled = false;
      refreshSummary(true);
    }, Math.max(MANUAL_DEBOUNCE_MS, wait));
  }

  /** 失焦/隐藏处理：降频或暂停 */
  function onIdle() {
    restartPolling();
  }

  /** 聚焦/可见处理：立即刷一次并恢复正常轮询 */
  function onActive() {
    refreshSummary(false);
    restartPolling();
  }

  /** 绑定浏览器事件 */
  function bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) onIdle();
      else onActive();
    });
    window.addEventListener('blur', onIdle);
    window.addEventListener('focus', onActive);
  }

  /* ============================ 启动 ============================ */
  function mountWidget() {
    // 幂等：宿主重复 apply 时不重复挂载
    if (document.getElementById('qh-fab')) return;
    injectStyles();
    buildFab();
    buildCard();
    bindLifecycle();
    renderCard();

    // 先拉权威配置，再拉首屏数据，然后启动轮询
    loadConfig().then(() => {
      refreshSummary(false);
      restartPolling();
    });
  }

  /* ============================ 模块注册 ============================ */
  const loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') {
    console.error('[dsh-quota-ring] 未找到 window.__ModuleLoader__，客户端组件无法注册');
    return;
  }

  loader.load({
    id: 'dsh-quota-ring',
    factory: function () {
      return {
        name: 'dsh-quota-ring',
        inject: [],
        apply: function (ctx, rawConfig) {
          // 用宿主传入配置更新内联默认值（权威配置仍会经 /config 二次覆盖）
          if (rawConfig && typeof rawConfig === 'object') {
            state.config = normalizeConfig(rawConfig);
          }
          mountWidget();
        },
      };
    },
  });
})();
