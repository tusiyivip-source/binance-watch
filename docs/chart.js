/* K 线图视图 —— 基于 TradingView Lightweight Charts（已本地化，不走 CDN）
 *
 * 两个视图共用同一套建图/绘制代码：
 *   multi  多级别视图：当前币种的 14 个级别按周期升序铺开
 *   alert  报警视图：右侧每条报警取它**组合里的确认级别**画一张，按报警顺序排列
 *
 * 配色与交互：
 *   涨 = 红 #f6465d，跌 = 绿 #0ecb81（币安习惯）
 *   均线只画两条：MA7 = 金 #f0b90b，EMA7 = 青 #0ef0f0（MA25 已按需求去掉）
 *   十字光标磁吸、金黄标签、滚轮缩放、拖拽平移
 *   副图：MACD（柱 + DIF/DEA）；叠加：缠论笔折线 + 顶/底分型标记
 */
'use strict';

const LC = window.LightweightCharts;

const C = {
  up: '#f6465d', down: '#0ecb81',
  ma7: '#f0b90b', ema7: '#0ef0f0',
  text: '#848e9c', grid: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.1)',
  gold: '#f0b90b', pen: '#94a3b8',
};

const COL_H = { 1: 480, 2: 360, 3: 300, 4: 250, 5: 210, 7: 170 };
const HEAD_H = 28, CARD_BORDER = 2, GAP = 10, GRID_PAD = 10;
const TARGET_RATIO = 1.6;          // 绘图区目标宽高比
const MIN_CH = 95, MIN_CW = 165;   // 多级别视图：尽量塞进一屏，允许缩到这个下限
const PX_PER_CANDLE = 5.5;

/* 报警视图：不硬塞一屏，优先保证可读尺寸，放不下就滚动 */
const ALERT_MIN_H = { compact: 0, normal: 220, large: 300, xl: 420 };
const ALERT_MIN_W = 300;
function alertMinH() {
  const v = document.querySelector('#alert-size')?.value ?? 'normal';
  return ALERT_MIN_H[v] ?? ALERT_MIN_H.normal;
}

/* ---------------- 视图状态 ---------------- */
const VIEWS = {
  multi: { kind: 'multi', grid: null, entries: [], items: [], roles: {}, cols: 4 },
  alert: { kind: 'alert', grid: null, entries: [], items: [], roles: {}, cols: 4 },
  // ⚠ 必须和 alert 同构（entries/items 都不能少）：卡片渲染复用同一套 ensureCards，
  //   少了 entries 就会在 view.entries.push 处抛异常，界面表现为状态栏/空态不更新。
  wave: { kind: 'wave', grid: null, entries: [], items: [], roles: {}, cols: 4 },
  top: { kind: 'top', grid: null, entries: [], items: [], roles: {}, cols: 4 },
};
let activeView = 'wave';         // 'matrix' | 'multi' | 'alert'
/**
 * 级别下拉：把「全部 + 各报警/各展示级别」填进 select，并保持当前选择不丢。
 * 只在选项集合发生变化时才重建，避免每 3 秒刷新把用户的选择打回去。
 */
function fillLevelSel(id, pairs, allText) {
  const sel = document.querySelector(id);
  if (!sel) return 'all';
  const cur = sel.dataset.__v || sel.value || 'all';
  const want = ['all', ...pairs.map(p => p.key)];
  const have = [...sel.options].map(o => o.value);
  if (want.join('|') !== have.join('|')) {
    sel.innerHTML = ['<option value="all">' + (allText || '全部级别') + '</option>']
      .concat(pairs.map(p => '<option value="' + p.key + '">' + (p.label || p.key) + '</option>'))
      .join('');
  }
  sel.value = want.includes(cur) ? cur : 'all';
  sel.dataset.__v = sel.value;
  return sel.value;
}

let chartSkip = 0;        // 连续跳到下一个币种的次数（防止空图表时无限跳）
let chartList = [];
let viewTimer = null;

/* ---------------- 视图切换（只剩「报警级别K线」+「五浪反弹」） ---------------- */
function setView(mode) {
  if (mode !== 'alert' && mode !== 'wave' && mode !== 'top') mode = 'wave';
  activeView = mode;
  document.body.classList.toggle('chartmode', mode === 'alert');
  document.body.classList.toggle('alertchartmode', mode === 'alert');
  // 五浪视图用**独立** body class：复用 alertchartmode 会让多个容器同时显示、各占 1/3 宽
  document.body.classList.toggle('wavemode', mode === 'wave');
  document.body.classList.toggle('topmode', mode === 'top');
  document.querySelector('#tab-wave')?.classList.toggle('on', mode === 'wave');
  document.querySelector('#tab-alert')?.classList.toggle('on', mode === 'alert');
  document.querySelector('#tab-top')?.classList.toggle('on', mode === 'top');
  document.querySelector('#alert-symbar').style.display = mode === 'alert' ? '' : 'none';
  document.querySelector('#wave-symbar').style.display = mode === 'wave' ? '' : 'none';
  document.querySelector('#top-symbar').style.display = mode === 'top' ? '' : 'none';
  const tw = document.querySelector('#topchartwrap');
  if (tw) tw.style.display = mode === 'top' ? '' : 'none';
  const wl = document.querySelector('#wave-level');
  if (wl) wl.style.display = mode === 'wave' ? '' : 'none';
  document.querySelector('#wavechartwrap').style.display = mode === 'wave' ? '' : 'none';
  document.querySelector('#alertchartwrap').style.display = mode === 'alert' ? '' : 'none';
  const al = document.querySelector('#alert-level');
  if (al) al.style.display = mode === 'alert' ? '' : 'none';
  const ak = document.querySelector('#alert-kind');
  if (ak) ak.style.display = mode === 'alert' ? '' : 'none';
  startLoop();
}

function startLoop() {
  stopLoop();
  refreshActive();
  viewTimer = setInterval(refreshActive, 3000);
}
function stopLoop() {
  if (viewTimer) { clearInterval(viewTimer); viewTimer = null; }
}
function refreshActive() {
  if (activeView === 'alert') refreshAlertView();
  else if (activeView === 'top') refreshTopView();
  else refreshWaveView();
}

/* ---------------- 布局 ---------------- */
function currentCols() {
  const v = document.querySelector('#chart-cols').value;
  return v === 'fit' ? null : Math.max(1, Math.min(8, +v || 2));
}

/**
 * 布局试算。
 * @param {number} minH 卡片绘图区的**最小可读高度**：低于它宁可滚动也不压缩
 * @param {number} minW 卡片最小宽度
 *
 * 两段式判定：
 *   1. 优先选「整屏能铺满」的方案里宽高比最好的；
 *   2. 一个都铺不满时（报警很多），选**行数最少**的（列数最多）——
 *      反正要滚动，列多一行能少滚很多，同时宽高比不偏离目标太多。
 */
function computeFit(grid, n, minH = 0, minW = MIN_CW) {
  const availH = grid.clientHeight;
  const availW = grid.clientWidth;
  if (!availH || !availW || !n) return null;
  const cand = [];
  for (let cols = 1; cols <= 8; cols++) {          // 从 1 列起：只有 1 张时应当铺满整行
    const rows = Math.ceil(n / cols);
    const cw = (availW - GRID_PAD * 2 - (cols - 1) * GAP) / cols;
    if (cw < minW) continue;
    const chFit = (availH - GRID_PAD * 2 - (rows - 1) * GAP) / rows - HEAD_H - CARD_BORDER;
    const ch = Math.max(minH, Math.floor(chFit));
    if (ch < MIN_CH) continue;
    let score = Math.abs(Math.log(((cw - 70) / ch) / TARGET_RATIO));
    if (n % cols !== 0) score += 0.35;            // 末行不满 → 稍微不优先（尽量选铺得满的列数）
    if (cols > n) score += 0.5;                   // 列数超过张数没意义
    const totalH = rows * (ch + HEAD_H + CARD_BORDER) + (rows - 1) * GAP;
    cand.push({ cols, rows, ch, cw: Math.floor(cw), score, fits: chFit >= ch, totalH });
  }
  if (!cand.length) return null;
  const fitting = cand.filter(c => c.fits && c.totalH <= availH - 1);
  if (fitting.length) {
    fitting.sort((a, b) => a.score - b.score);
    return fitting[0];
  }
  // 都放不下：列数多 = 行数少 = 滚动少，优先行数少，其次看比例
  cand.sort((a, b) => (a.rows - b.rows) || (a.score - b.score));
  return cand[0];
}

function applyCols(view) {
  const grid = view.grid;
  if (!grid) return;
  const n = grid.childElementCount || 14;
  const fixed = currentCols();
  const isAlert = view.kind === 'alert';   // 尺寸档位只认报警视图（五浪视图有自己的 #wave-size）
  const minH = isAlert && document.querySelector('#alert-size').value !== 'compact' ? alertMinH() : 0;
  const minW = isAlert && minH ? ALERT_MIN_W : MIN_CW;
  let cols, ch;
  if (fixed) { cols = fixed; ch = Math.max(minH, COL_H[fixed] ?? Math.round(1200 / fixed)); }
  else {
    const fit = computeFit(grid, n, minH, minW);
    if (fit) { cols = fit.cols; ch = fit.ch; view.fits = fit.fits; view.rows = fit.rows; }
    else { cols = 4; ch = Math.max(minH, COL_H[4]); view.fits = false; view.rows = Math.ceil(n / cols); }
  }
  view.cols = cols;
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--ch', ch + 'px');
  layoutSpans(view, cols);
  // 尺寸没变就不要调 applyOptions：改动图表尺寸会让 Lightweight Charts 重置十字光标，
  // 结果是悬停时每 3 秒刷新一次 tooltip 就闪一下（实测到的真实问题）。
  requestAnimationFrame(() => view.entries.forEach(e => {
    const holder = e.card.querySelector('.cchart');
    if (!holder) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    if (e._w === w && e._h === h) return;
    try { e.chart.applyOptions({ width: w, height: h }); e._w = w; e._h = h; } catch { }
  }));
}

/**
 * 末行不满时的排布。
 *
 * ⚠ 历史行为：把末行卡片**拉宽**（span N）以填满整行 —— 结果 14 张 4 列时，
 *   末行 2 张变成双倍宽（290px → 589px），与上面几行尺寸不一致，看起来「不协调」。
 * 现在改为：**尺寸与其它卡片完全一致**，把末行整体**居中**摆放（左右各留等量空列）。
 */
function layoutSpans(view, cols) {
  const cards = [...view.grid.children];
  const n = cards.length;
  // 必须全部清掉：内联 grid-column 优先级高于 .zoomed 的 CSS 规则
  for (const c of cards) c.style.gridColumn = '';
  if (!cols || !n) return;
  const rem = n % cols;
  if (rem === 0) return;                       // 末行正好铺满，无需处理
  if (rem === 1) {                             // 末行只有 1 张 → 铺满整行（单张大图看着自然）
    const last = cards[n - 1];
    if (!last.classList.contains('zoomed')) last.style.gridColumn = `1 / span ${cols}`;
    return;
  }
  const pad = Math.floor((cols - rem) / 2);    // 否则：尺寸与其它卡片一致，末行整体居中
  for (let i = n - rem; i < n; i++) {
    const pos = pad + (i - (n - rem)) + 1;     // grid-column 从 1 开始
    if (!cards[i].classList.contains('zoomed')) cards[i].style.gridColumn = `${pos} / span 1`;
  }
}

/** 自动根数：按单张卡片宽度反推，保证每根蜡烛的像素宽度 */
function currentBars(view) {
  const sel = document.querySelector('#chart-bars').value;
  if (sel !== 'auto') return +sel;
  const grid = view.grid;
  const cols = view.cols || 2;
  const avail = (grid.clientWidth || 1200) - GRID_PAD * 2 - (cols - 1) * GAP;
  const cardW = Math.max(260, avail / cols) - 70;
  return Math.max(30, Math.min(400, Math.round(cardW / PX_PER_CANDLE)));
}

/* ---------------- 建图 ---------------- */
function buildCard() {
  const card = document.createElement('div');
  card.className = 'chartcard';
  card.innerHTML = `<div class="cchead">
      <span class="lv"></span>
      <span class="roles"></span>
      <span class="st"></span>
      <span class="sp"></span>
      <span class="px"></span>
    </div>
    <div class="cchart"></div>`;
  return card;
}

function initChart(card, minutes) {
  const holder = card.querySelector('.cchart');
  const chart = LC.createChart(holder, {
    width: card.clientWidth,
    height: holder.clientHeight,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    crosshair: {
      mode: LC.CrosshairMode.Magnet,
      vertLine: { color: 'rgba(255,255,255,0.3)', style: 2, width: 1, labelVisible: true, labelBackgroundColor: C.gold },
      horzLine: { color: C.gold, style: 1, width: 1, labelVisible: true, labelBackgroundColor: C.gold, labelTextColor: '#000' },
    },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.06, bottom: 0.24 } },
    timeScale: {
      borderColor: C.border, timeVisible: true, secondsVisible: false,
      rightOffset: 2, barSpacing: PX_PER_CANDLE, minBarSpacing: 1.5,
      lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter: t => fmtCandleTime(t * 1000, minutes),
    },
    handleScroll: { vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: { priceFormatter: p => fmtPrice(p) },
  });

  const candle = chart.addCandlestickSeries({
    upColor: C.up, downColor: C.down,
    borderUpColor: C.up, borderDownColor: C.down,
    wickUpColor: C.up, wickDownColor: C.down,
    priceLineVisible: false, lastValueVisible: true,
  });
  const ema7 = chart.addLineSeries({ color: C.ema7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ma7 = chart.addLineSeries({ color: C.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  // 缠论笔：一条折线穿过所有笔端点（顶底天然交替，单条折线画出来就是笔）
  const macdHist = chart.addHistogramSeries({
    priceScaleId: 'macd', priceFormat: { type: 'price', precision: 8 },
    priceLineVisible: false, lastValueVisible: false, base: 0,
  });
  const macdDif = chart.addLineSeries({ color: C.gold, lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const macdDea = chart.addLineSeries({ color: '#f6465d', lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    priceLineVisible: false, lastValueVisible: false,
  });
  chart.priceScale('macd').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, visible: true });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });

  const e = { card, chart, candle, ma7, ema7, macdHist, macdDif, macdDea, vol, minutes, tip: null };
  chart.subscribeCrosshairMove(p => onCrosshair(e, p));
  holder.addEventListener('click', () => toggleZoom(card, e.view));
  return e;
}

function toggleZoom(card, view) {
  const was = card.classList.contains('zoomed');
  document.querySelectorAll('#' + view.grid.id + ' .chartcard.zoomed').forEach(c => c.classList.remove('zoomed'));
  if (!was) card.classList.add('zoomed');
  applyCols(view);
  setTimeout(() => {
    if (document.querySelector('#chart-bars').value === 'auto') refreshActive();
  }, 80);
}

/**
 * 卡片数量对齐。
 * 用**增量增删**而不是整块重建：报警每来一条，数量就变一次，
 * 整块重建会把已有的 Lightweight Charts 实例全部销毁重建 ——
 * 十字光标和 tooltip 会跟着断掉（实测到的真实抖动）。
 */
function ensureCards(view, items) {
  const grid = view.grid;
  let cur = grid.childElementCount;
  while (cur > items.length) {                 // 多了就删尾
    grid.removeChild(grid.lastElementChild);
    view.entries.pop();
    cur--;
  }
  while (cur < items.length) {                 // 少了就补尾
    const it = items[cur];
    const card = buildCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.view = view;
    view.entries.push(e);
    cur++;
  }
  return view.entries;
}

/* ---------------- 绘制 ---------------- */
const CHART_ROLE = { base: '基准', mid: '确认', big: '最大' };
const CHART_STATE = { 0: '数据不足', 1: '多头排列', 2: '站上MA7', 3: '均线纠缠', 4: '弱势', 5: '空头排列' };

function paintCard(view, i, it) {
  const e = view.entries[i];
  if (!e) return;
  const card = e.card;
  // 五浪信号的卡片也用「信号卡片」头部（显示币种/级别/五浪序列/EMA7）
  const isAlert = view.kind === 'alert' || view.kind === 'wave' || view.kind === 'top';   // 信号卡片样式

  // 不能覆盖 className，否则会抹掉用户的放大状态
  const cls = ['chartcard'];
  if (isAlert) {
    cls.push(it.mode === 'closed' ? 'mode-closed' : 'mode-live');
  } else {
    const roles = view.roles?.[it.key] ?? [];
    if (roles.includes('base')) cls.push('role-base');
    else if (roles.includes('mid')) cls.push('role-mid');
    else if (roles.includes('big')) cls.push('role-big');
  }
  if (card.classList.contains('zoomed')) cls.push('zoomed');
  card.className = cls.join(' ');

  const head = card.querySelector('.cchead');
  const divBadge = '';   // 背驰已彻底移除

  if (isAlert) {
    head.querySelector('.lv').innerHTML = `<span class="sym">${it.symbol}</span>`;
    head.querySelector('.roles').innerHTML = (it.kind === 'top5' || it.kind === 'bot5')
      ? `<span class="rb lvl">${it.levelLabel ?? it.label}</span><span class="rb">${it.kind === 'bot5' ? '底部结构' : '顶部结构'}</span>`
      : it.kind === 'chain'
      ? `<span class="rb lvl">${it.levelLabel ?? it.label}</span>`
        + (it.subLevelLabel ? `<span class="rb">→${it.subLevelLabel}</span>` : '')
        + (it.innerLevelLabel ? `<span class="rb">→${it.innerLevelLabel}</span>` : '')
      : it.kind === 'wave'
      ? `<span class="rb lvl">${it.levelLabel ?? it.label}</span>` + (it.subLevelLabel ? `<span class="rb">← ${it.subLevelLabel}</span>` : '')
      : `<span class="rb lvl">${it.label}</span>`;
    const st = head.querySelector('.st');
    st.textContent = it.mode === 'closed' ? '已确认' : '预警';
    st.className = 'st ' + (it.mode === 'closed' ? 's1' : 's3');
    // 形态提醒没有评分，用方向标签代替；共振信号仍显示组合与评分
    const isDual = it.kind === 'dual';
    if (it.kind === 'top5' || it.kind === 'bot5') {
      head.querySelector('.sp').innerHTML =
        (it.kind === 'bot5'
          ? `<span class="grp">低点${fmtPrice(it.topHigh)} · 向上${it.topBars ?? '?'}根</span><span class="sc">第5根新高</span>`
          : `<span class="grp">高点${fmtPrice(it.topHigh)} · 向下${it.topBars ?? '?'}根</span><span class="sc">第5根新低 ${fmtPrice(it.topLow5)}</span>`) + divBadge;
    } else if (it.kind === 'chain') {
      head.querySelector('.sp').innerHTML =
        `<span class="grp">回调${it.chainBars ?? '?'}根 · 下上下上下</span>`
        + (Array.isArray(it.chainSubBars) ? `<span class="sc">每笔 ${it.chainSubBars.join('/')}根</span>` : '')
        + divBadge;
    } else if (it.kind === 'wave') {
      // 五浪信号：显示五浪序列 + 金叉到上穿隔了几根 + 一笔下跨度
      head.querySelector('.sp').innerHTML =
        `<span class="grp">五浪 ${it.waveSeq ?? ''}</span>`
        + `<span class="sc">金叉后${Math.max(1, it.waveLagBars ?? 1)}根</span>`
        + `<span class="grp">一笔下${it.waveBars ?? '?'}根</span>` + (divBadge ? ' ' + divBadge : '');
    } else {
      const grp = it.group ?? it.levelLabel ?? '';
      const sc = Number.isFinite(it.score) && it.score > 0 ? `<span class="sc">${it.score}分</span>` : '';
      const brk = it.kind === 'breakout' && Number.isFinite(it.streakBars)
        ? `<span class="sc">压制${it.streakBars}根</span>`
        : (it.kind === 'wavefirst' && Number.isFinite(it.fbBars)
          ? `<span class="sc">跨度${it.fbBars}根 · 首底</span>` : '');
      head.querySelector('.sp').innerHTML = isDual
        ? `<span class="grp">${it.side === 'long' ? '双阴不破 · 看多' : '双阳不穿 · 看空'}</span>` + (divBadge ? ' ' + divBadge : '')
        : `<span class="grp">${String(grp).replace(/>/g, '→')}</span>` + sc + brk + divBadge;
    }
    const t = new Date(it.at || Date.now());
    const p = n => String(n).padStart(2, '0');
    head.querySelector('.px').textContent =
      `${fmtPrice(it.price)}　${p(t.getHours())}:${p(t.getMinutes())}`
      + (it.kind === 'wave' && Number.isFinite(it.ema7) ? `　EMA7 ${fmtPrice(it.ema7)}` : '');
  } else {
    // K线图（多级别）：同一个币种的所有级别 —— 每张卡片也标出**币种名称**，
    // 方便放大单张、截图或滚动时辨认。
    const sym = it.symbol ?? '';
    head.querySelector('.lv').innerHTML =
      (sym ? `<span class="sym">${sym}</span> ` : '') + (it.label ?? '');
    head.querySelector('.roles').innerHTML = (view.roles?.[it.key] ?? [])
      .map(r => `<span class="rb ${r}">${CHART_ROLE[r]}</span>`).join('');
    const st = head.querySelector('.st');
    st.textContent = CHART_STATE[it.state] ?? '';
    st.className = 'st s' + it.state;
    head.querySelector('.sp').innerHTML = divBadge;
    head.querySelector('.px').textContent =
      `收 ${fmtPrice(it.price)}　距MA7 ${it.distMa7Pct >= 0 ? '+' : ''}${(it.distMa7Pct ?? 0).toFixed(2)}%`;
  }

  // —— 数据 ——
  // ⚠ 必须容错：报警列表里可能夹着「该币种/该级别还没有K线」的条目（candles 为 null），
  //   以及指标线为 null 的情况。以前这里直接读 .length 会抛异常，
  //   而 paintView 是一个 forEach 循环 —— 第二张卡片一抛，**后面所有卡片就都不画了**
  //   （症状：五浪视图只有第一张图有内容，其余全空）。
  const cs = Array.isArray(it.candles) ? it.candles : [];
  if (!cs.length) {
    if (e.chainLine) e.chainLine.setData([]);
    e.candle.setMarkers([]);
    e.candle.setData([]); e.ma7.setData([]); e.ema7.setData([]);
    e.macdHist.setData([]); e.macdDif.setData([]); e.macdDea.setData([]); e.vol.setData([]);
    return;
  }
  const T = i2 => Math.floor(cs[i2][0] / 1000);      // ms → 秒
  e.candle.setData(cs.map((c, i2) => ({ time: T(i2), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => {
    const o = [];
    if (!Array.isArray(arr)) return o;               // 指标线缺失 → 空数组，不要抛
    for (let i2 = 0; i2 < arr.length; i2++) if (arr[i2] != null) o.push({ time: T(i2), value: arr[i2] });
    return o;
  };
  const showMA = document.querySelector('#chart-ma').checked;
  e.ma7.setData(showMA ? line(it.ma7) : []);
  e.ema7.setData(showMA ? line(it.ema7) : []);

  // 只画这条报警实际使用的五笔快照，避免实时成笔变化后画到另一组结构。
  if (it.kind === 'chain' && !e.chainLine) {
    e.chainLine = e.chart.addLineSeries({ color: '#0ecb81', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  }
  const points = it.kind === 'chain' && it.key === it.subLevel && Array.isArray(it.chainSubPoints)
    ? it.chainSubPoints.filter(p => Number.isFinite(p.t) && Number.isFinite(p.price)
      && p.t >= cs[0][0] && p.t <= cs[cs.length - 1][0]) : [];
  if (e.chainLine) e.chainLine.setData(points.map(p => ({ time: Math.floor(p.t / 1000), value: p.price })));
  const markers = points.map(p => ({ time: Math.floor(p.t / 1000),
    position: p.type === 'top' ? 'aboveBar' : 'belowBar', color: '#0ecb81', shape: 'circle',
    text: String(it.chainSubPoints.indexOf(p)) }));
  if (it.kind === 'chain' && Number.isFinite(it.confirmedAt)) {
    const at = cs.findIndex(c => c[0] + it.ms === it.confirmedAt);
    if (at >= 0) markers.push({ time: T(at), position: 'belowBar', color: '#f0b90b',
      shape: 'arrowUp', text: `${it.levelLabel}底分型收盘确认` });
  }
  e.candle.setMarkers(markers.sort((a, b) => a.time - b.time));

  // MACD 副图
  const showMacd = document.querySelector('#chart-macd').checked;
  if (showMacd && it.macd && Array.isArray(it.macd.hist)) {
    const h = [];
    for (let i2 = 0; i2 < cs.length; i2++) {
      const v = it.macd.hist[i2];
      if (v == null) continue;
      h.push({ time: T(i2), value: v, color: v >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(14,203,129,.75)' });
    }
    e.macdHist.setData(h);
    e.macdDif.setData(line(it.macd.dif));
    e.macdDea.setData(line(it.macd.dea));
    e.chart.priceScale('macd').applyOptions({ visible: true, scaleMargins: { top: 0.78, bottom: 0.02 } });
  } else {
    e.macdHist.setData([]); e.macdDif.setData([]); e.macdDea.setData([]);
    e.chart.priceScale('macd').applyOptions({ visible: false });
  }
  // 成交量（关掉 MACD 时占位）
  const vd = [];
  for (let i2 = 0; i2 < cs.length; i2++) {
    vd.push({ time: T(i2), value: cs[i2][5], color: cs[i2][4] >= cs[i2][1] ? 'rgba(246,70,93,.35)' : 'rgba(14,203,129,.35)' });
  }
  e.vol.setData(showMacd ? [] : vd);

  // 尺寸适配；时间轴只在首次或宽度变化时 fitContent，避免每轮重置用户的缩放
  const holder = card.querySelector('.cchart');
  const w = holder.clientWidth, h = holder.clientHeight;
  if (e._w !== w || e._h !== h) { e.chart.applyOptions({ width: w, height: h }); e._w = w; e._h = h; }
  const fitKey = cs.length + '|' + w;
  if (e._fitFor !== fitKey) { e.chart.timeScale().fitContent(); e._fitFor = fitKey; }
}

function paintView(view) {
  // ⚠ 单张图纸出错必须隔离：以前一张抛异常会让 forEach 中断，
  //   症状就是「只有第一张图有内容，其余全空」（五浪视图踩过这个坑）。
  view.items.forEach((it, i) => {
    try { paintCard(view, i, it); }
    catch (e) { console.warn('[chart] 第 ' + (i + 1) + ' 张绘制失败：' + (e && e.message)); }
  });
}

async function refreshTopView() {
  const view = VIEWS.top;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +document.querySelector('#top-limit').value || 24;
  try {
    const dirSel = document.querySelector('#top-dir');
    const kind = (!dirSel || dirSel.value === 'all') ? 'top5,bot5' : dirSel.value;
    const d = await fetch(`/api/alertchart?kind=${kind}&bars=${bars}&limit=${limit}`).then(r => r.json());
    const lvSel = document.querySelector('#top-level');
    const lv = lvSel ? lvSel.value : 'all';
    view.items = (d.items ?? []).filter(it => lv === 'all' || it.key === lv);
    if (dirSel) { view.dirPick = dirSel.value; }
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    document.querySelector('#top-empty').style.display = view.items.length ? 'none' : '';
    document.querySelector('#top-live').textContent = view.items.length
      ? `共 ${view.items.length} 条结构（顶部 ${view.items.filter(x => x.kind === 'top5').length} · 底部 ${view.items.filter(x => x.kind === 'bot5').length}）· ${bars} 根 · ` + new Date().toLocaleTimeString('zh-CN', { hour12: false })
      : '暂无顶部结构';
  } catch (e) { console.warn('[top] 刷新失败：' + (e && e.message)); }
}

async function refreshWaveView() {
  const view = VIEWS.wave;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +document.querySelector('#wave-limit').value || 24;
  try {
    const d = await fetch(`/api/alertchart?kind=chain&bars=${bars}&limit=${limit}`).then(r => r.json());
    const all = d.items ?? [];
    const pairs = [...new Map(all.map(it => [it.key, { key: it.key, label: it.label ?? it.key }])).values()];
    const pickW = fillLevelSel('#wave-level', pairs, '全部主级别');
    view.items = pickW === 'all' ? all : all.filter(it => it.key === pickW);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    document.querySelector('#wave-empty').style.display = view.items.length ? 'none' : '';
    document.querySelector('#wave-live').textContent = view.items.length
      ? `共 ${all.length} 条两级五浪（3分→15分 / 5分→30分 / 10分→1时 / 15分→2时 / 30分→3时 / 1时→6时）${pickW === 'all' ? '' : '（只看 ' + (pairs.find(p => p.key === pickW)?.label ?? pickW) + '）'} · ${bars} 根 · ` + new Date().toLocaleTimeString('zh-CN', { hour12: false })
      : '暂无两级五浪信号';
  } catch (e) { console.warn('[wave] 刷新失败：' + (e && e.message)); }
}

async function refreshAlertView() {
  const view = VIEWS.alert;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +document.querySelector('#alert-limit').value || 24;
  try {
    const kindSel = document.querySelector('#alert-kind');
    const kind = kindSel && kindSel.value !== 'all' ? '&kind=' + encodeURIComponent(kindSel.value) : '';
    const d = await fetch(`/api/alertchart?bars=${bars}&limit=${limit}${kind}`).then(r => r.json());
    const all = d.items ?? [];
    const pairs = [...new Map(all.map(it => [it.key, { key: it.key, label: it.label ?? it.key }])).values()];
    const pickA = fillLevelSel('#alert-level', pairs, '全部报警级别');
    view.items = pickA === 'all' ? all : all.filter(it => it.key === pickA);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    document.querySelector('#alert-empty').style.display = view.items.length ? 'none' : '';
    const n = view.items.length;
    const rows = view.rows ?? (n ? Math.ceil(n / (view.cols || 4)) : 0);
    const scrollable = view.grid.scrollHeight - view.grid.clientHeight > 4;
    document.querySelector('#alert-live').textContent =
      n
        ? `共 ${d.total} 条报警${pickA === 'all' ? '' : '（只看 ' + (view.items[0]?.label ?? pickA) + '）'}，展示最近 ${n} 条 · ${view.cols} 列 × ${rows} 行 · `
          + `${scrollable ? '可上下滚动' : '一屏看全'} · ${bars} 根 · `
          + new Date().toLocaleTimeString('zh-CN', { hour12: false })
        : `暂无报警`;
  } catch { /* 忽略单次失败 */ }
}

/* ---------------- 十字光标提示 ---------------- */
function onCrosshair(e, param) {
  if (!param || !param.point || param.time == null) { hideTip(e); return; }
  const d = param.seriesData.get(e.candle);
  if (!d) { hideTip(e); return; }
  if (!e.tip) {
    const t = document.createElement('div');
    t.className = 'ctip';
    e.card.appendChild(t);
    e.tip = t;
  }
  const item = e.view?.items?.[e.view.entries.indexOf(e)];
  const cs = item?.candles ?? [];
  const idx = cs.findIndex(c => Math.floor(c[0] / 1000) === param.time);
  const mv = item?.macd && idx >= 0 ? item.macd.hist[idx] : null;
  const dt = new Date(param.time * 1000);
  const p = n => String(n).padStart(2, '0');
  e.tip.style.display = 'block';
  const w = e.card.clientWidth;
  e.tip.style.left = Math.min(param.point.x + 14, Math.max(4, w - 140)) + 'px';
  e.tip.style.top = Math.max(4, param.point.y - 78) + 'px';
  e.tip.innerHTML =
    `<b>${item?.symbol ?? ''}</b> <span class="k">${item?.label ?? ''}</span><br>`
    + `开 ${fmtPrice(d.open)}　高 ${fmtPrice(d.high)}<br>`
    + `低 ${fmtPrice(d.low)}　收 ${fmtPrice(d.close)}<br>`
    + (mv != null ? `<span class="k">MACD柱</span> ${mv.toFixed(4)}<br>` : '')
    + `<span class="k">${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}</span>`;
}
function hideTip(e) { if (e.tip) e.tip.style.display = 'none'; }

/** 按周期决定时间轴格式 */
function fmtCandleTime(ts, minutes) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  if (minutes < 60) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (minutes < 1440) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:00`;
  if (minutes < 10080) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------------- 绑定 ---------------- */
function initCharts() {
  VIEWS.alert.grid = document.querySelector('#alertchartgrid');
  VIEWS.wave.grid = document.querySelector('#wavechartgrid');
  VIEWS.top.grid = document.querySelector('#topchartgrid');

  document.querySelector('#tab-alert').addEventListener('click', () => setView('alert'));
  document.querySelector('#tab-wave').addEventListener('click', () => setView('wave'));
  document.querySelector('#tab-top').addEventListener('click', () => setView('top'));
  document.querySelector('#top-refresh').addEventListener('click', () => refreshTopView());
  document.querySelector('#top-limit').addEventListener('change', () => refreshTopView());
  document.querySelector('#top-dir').addEventListener('change', () => refreshTopView());
  document.querySelector('#top-level').addEventListener('change', () => refreshTopView());
  document.querySelector('#top-size').addEventListener('change', () => { applyCols(VIEWS.top); refreshTopView(); });
  document.querySelector('#chart-cols').addEventListener('change', () => { applyCols(VIEWS.alert); applyCols(VIEWS.wave); refreshActive(); });
  document.querySelector('#chart-bars').addEventListener('change', () => refreshActive());
  document.querySelector('#alert-level').addEventListener('change', e => { e.target.dataset.__v = e.target.value; refreshAlertView(); });
  document.querySelector('#alert-kind').addEventListener('change', () => refreshAlertView());
  document.querySelector('#alert-limit').addEventListener('change', () => refreshAlertView());
  document.querySelector('#alert-size').addEventListener('change', () => { applyCols(VIEWS.alert); refreshAlertView(); });
  ['#chart-ma', '#chart-mark', '#chart-macd'].forEach(s =>
    document.querySelector(s).addEventListener('change', () => {
      paintView(activeView === 'alert' ? VIEWS.alert : (activeView === 'top' ? VIEWS.top : VIEWS.wave));
    }));
  document.querySelector('#alert-refresh').addEventListener('click', () => refreshAlertView());
  document.querySelector('#wave-refresh').addEventListener('click', () => refreshWaveView());
  document.querySelector('#wave-limit').addEventListener('change', () => refreshWaveView());
  document.querySelector('#wave-size').addEventListener('change', () => { applyCols(VIEWS.wave); refreshWaveView(); });
  document.querySelector('#wave-level').addEventListener('change', e => { e.target.dataset.__v = e.target.value; refreshWaveView(); });

  let rt = null;
  window.addEventListener('resize', () => {
    if (activeView === 'matrix') return;
    clearTimeout(rt);
    rt = setTimeout(() => refreshActive(), 250);
  });
  applyCols(VIEWS.alert);
  applyCols(VIEWS.wave);
  applyCols(VIEWS.top);
  setView('wave');   // 默认打开五浪反弹
}

if (typeof LC === 'undefined') {
  console.error('[chart] LightweightCharts 未加载，K线图不可用');
} else {
  initCharts();
}

function openChartFor(sym) {
  // 「K线图」视图已按需求移除：点币种时改为打开该币种的级别明细抽屉
  if (sym && typeof openDetail === 'function') openDetail(sym);
}
