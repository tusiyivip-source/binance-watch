/** 两级五浪：次级别下上下上下五笔，等待对应主级别底分型收盘确认。 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { isBottomFractal } from './fractal.js';
import { detectTop5 } from './top5.js';
import { alertTiming } from './alert-timing.js';
import { mergeInclusive, findFractals, buildStrokePoints } from './chan.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 级别视图：K线 + EMA7 + MACD + 分型端点 + 已收盘根数 */
export function chainView(series, key, chanMinBars = 5, asOf = Infinity, withPoints = true) {
  if (!series || !series.t || series.t.length < 8) return null;
  const ind = series.ensure();
  const m = series.macd();
  let closed = series.closedCount;
  while (closed > 0 && series.t[closed - 1] + series.ms > asOf) closed--;
  // 包含处理也必须先截断；仅过滤端点无法撤销形成中K线对已合并K线的修改。
  let pts = null;
  if (withPoints) {
    const h = series.h.slice(0, closed), l = series.l.slice(0, closed);
    const merged = mergeInclusive(h, l);
    pts = buildStrokePoints(findFractals(merged), merged, h, l, chanMinBars);
  }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    ma7: ind.ma7, ema7: ind.ema7, dif: m.dif, dea: m.dea,   // ma7/ema7 供「顶部结构」判定使用
    closed, pts,
  };
}

const pivotIdx = p => (p.origIdx ?? p.mi);
const pivotT = (v, p) => v.t[Math.min(pivotIdx(p), v.t.length - 1)] + v.ms;
const isTop = p => p.type === 'top' || p.type === '顶' || p.type === 'T';

// 先识别五浪，再决定等待哪个主级别；不能先过滤未确认的大级别。
/**
 * 次级别"下跌浪"结构（用户 2026-10-16 放宽）：
 *   原来是**恰好五笔**（下上下上下，TBTBTB）；现在要求 **≥minStrokes 笔**（默认 5），
 *   6 笔、7 笔、8 笔都算 —— "可以高于五浪 有6浪七浪8浪 都行"。
 *   仍要求：方向交替、首笔向下（首端点是顶）、每笔 ≥minBars 根、K线连续。
 */
export function findFiveWaves(sub, minBars = 5, asOf = Infinity, minStrokes = 5) {
  if (!sub) return null;
  const closed = Math.min(sub.closed ?? sub.t.length, sub.t.length);
  let pts = (sub.pts ?? []).filter(p => Number.isInteger(p.confirmIdx)
    && p.confirmIdx < closed && sub.t[p.confirmIdx] + sub.ms <= asOf);
  if (!pts.length) return null;
  // 等待主级别确认期间，后续反弹顶不应挤掉刚完成的那一笔
  if (isTop(pts.at(-1))) pts.pop();
  if (pts.length < minStrokes + 1) return null;

  /** 校验一串端点是否构成合法下跌浪（交替 + 首笔向下 + 每笔根数） */
  const check = six => {
    if (six.map(p => (isTop(p) ? 'T' : 'B')).join('') !== 'TBTB'.repeat(9).slice(0, six.length)) return null;
    const bars = [];
    for (let j = 1; j < six.length; j++) {
      const a = pivotIdx(six[j - 1]), b = pivotIdx(six[j]);
      if (b - a + 1 < minBars) return null;
      if (j % 2 ? six[j - 1].price <= six[j].price : six[j - 1].price >= six[j].price) return null;
      for (let k = a + 1; k <= b; k++) if (sub.t[k] - sub.t[k - 1] !== sub.ms) return null;
      bars.push(b - a + 1);
    }
    return bars;
  };
  // 从末尾往回找**最长**的合法浪（笔数越多越优先，最多吃 12 笔）
  for (let n = Math.min(pts.length, 13); n >= minStrokes + 1; n--) {
    const six = pts.slice(-n);
    const bars = check(six);
    if (!bars) continue;
    return {
      subKey: sub.key, ms: sub.ms, six, bars, strokes: n - 1,
      start: sub.t[pivotIdx(six[0])], end: sub.t[pivotIdx(six[six.length - 1])],
      high: six[0].price, low: six[six.length - 1].price,
    };
  }
  return null;
}

export function sameWaveMove(a, b) {
  const equal = (x, y) => Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x - y) <= Math.max(Math.abs(x), Math.abs(y), 1e-12) * 1e-7;
  const overlap = (x, dx, y, dy) => x < y + dy && y < x + dx;
  return equal(a.high, b.high) && equal(a.low, b.low)
    && overlap(a.start, a.ms, b.start, b.ms) && overlap(a.end, a.ms, b.end, b.ms);
}

export function selectLargestWaves(candidates) {
  const selected = [];
  for (const c of [...candidates].sort((a, b) => b.wave.ms - a.wave.ms)) {
    if (!selected.some(s => sameWaveMove(s.wave, c.wave))) selected.push(c);
  }
  return selected;
}

/**
 * 判定一组（主/次/内）是否构成完整结构
 * @returns {null|object}
 */
export function detectChain(main, sub, inner, opt = {}) {
  const mainMinBars = Math.max(5, opt.mainMinBars ?? 5);
  const subMinBars = Math.max(5, opt.subMinBars ?? 5);

  const lookback = opt.lookback ?? 20;
  //    实测：真实 V 型底那一根往往是「中继/任意」分型（中间高点不是最低），
  //    「标准」分型在回调最低点附近只占 3~18 次 → 默认 any（中间低点最低即算见底分型）
  const fractalType = opt.fractalType ?? 'any';
  if (!main || !sub) return null;

  // ① 主级别：**按「顶部结构」逻辑定义收盘K**（用户 2026-10-16 口径）
  //    五根形态（第1根高点 → 第2根不创新高 → 第3根不超第1根 → 第4根不超第2根 → 第5根创新低）
  //    + 反转点 + **收盘同时站上 MA7 与 EMA7** —— 最后这根的收盘即触发。
  //    mainMode='fractal' 可切回旧口径（主级别回调≥5根 + 最低点底分型）。
  const mainMode = opt.mainMode ?? 'top5';
  const mLen = Number.isFinite(main.closed) ? Math.min(main.closed, main.t.length) : main.t.length;
  if (mLen < mainMinBars + 1) return null;
  const from = Math.max(0, mLen - lookback);
  let hIdx = from;
  for (let k = from; k < mLen; k++) if (main.h[k] > main.h[hIdx]) hIdx = k;
  let lIdx = hIdx;
  for (let k = hIdx; k < mLen; k++) if (main.l[k] < main.l[lIdx]) lIdx = k;
  const mainBars = lIdx - hIdx + 1;
  if (mainBars < mainMinBars) return null;
  const tHigh = main.t[hIdx] + main.ms;

  // 主级别顶部分型/顶部结构确认 —— **两阶段**（用户 2026-10-16：不要偏晚）
  //   预警 stage='warning'：主级别**最低点那根**底分型刚确认（右边那根收盘）→ 最早的一声
  //   确认 stage='confirmed'：再等到收盘同时站上 MA7 与 EMA7（顶部结构逻辑）
  let top = null, warnOnly = false;
  if (mainMode === 'top5') {
    top = detectTop5(main, {
      minBars: 5, lookback,
      needMa: opt.mainNeedMa !== false,
      allowWarn: false,
      freshBars: opt.mainFreshBars ?? 0,
      strictEngulf: opt.mainStrictEngulf !== false,
      dir: 'top',
    });
    if (top) {
      const hi = main.t.indexOf(top.highT);
      if (hi >= 0) hIdx = hi;             // 形态第1根作为整段回调的起点
    } else if (opt.mainWarn !== false) {
      // 还没站上均线 → 先给"预警"：底分型刚在最低点确认那一根
      if (!(lIdx >= 1 && lIdx + 1 <= mLen - 1 && isBottomFractal(main, lIdx, fractalType))) return null;
      // 预警窗口：底分型确认后 ≤ chainWarnFreshBars 根内都算（不设窗口的话只在那一瞬间成立，实盘几乎抓不到）
      const warnFresh = opt.mainWarnFreshBars ?? 3;
      if ((mLen - 1) - (lIdx + 1) > warnFresh) return null;
      warnOnly = true;
    } else return null;
  }

  // 主级别底分型（额外信息；旧口径下是必需条件）
  let fIdx = -1;
  if (lIdx >= 1 && lIdx + 1 <= mLen - 1 && isBottomFractal(main, lIdx, fractalType)) fIdx = lIdx;
  if (mainMode !== 'top5' && fIdx < 0) return null;    // 旧口径：最低点还没拐头 → 见底未确认
  const fRef = fIdx >= 0 ? fIdx : Math.max(1, Math.min(lIdx, mLen - 2));
  const fractalT = main.t[fRef], fractalLow = main.l[fRef];
  const fractal3Lows = [main.l[fRef - 1], main.l[fRef], main.l[fRef + 1]];   // 前/中/后三根的低点
  const fractalClose = main.c[fRef + 1];                    // 底分型第三根收盘 = 成立时刻
  const fractalAge = (mLen - 1) - (fRef + 1);               // 成立后过了几根
  // 触发时刻：确认=站上均线那一根；预警=底分型第三根收盘；旧口径=底分型第三根收盘
  const confirmT = top ? (top.barT + main.ms) : (main.t[fRef + 1] + main.ms);
  if (!top && !warnOnly && fractalAge !== 0) return null;   // 旧口径：只在最新收盘确认
  const stage = top ? 'confirmed' : 'warning';

  // ② 次级别：下上下上下 五笔（顶→底→顶→底→顶→底）
  const subClosed = Math.min(sub.closed ?? sub.t.length, sub.t.length);
  // 次级别端点允许比主级别确认晚 (confirmGraceBars 根主级别K线)：缠论笔要等分型确认，天然滞后
  const graceBars = opt.confirmGraceBars ?? 2;
  const cutoff = confirmT + graceBars * main.ms;
  const pts = (sub.pts ?? []).filter(p => Number.isInteger(p.confirmIdx)
    && p.confirmIdx < subClosed && sub.t[p.confirmIdx] + sub.ms <= cutoff);
  if (pts.length < 6) return null;
  const minStrokes = Math.max(5, opt.minStrokes ?? 5);   // 用户：可以高于五浪，6/7/8 浪都行
  const wave = findFiveWaves(sub, subMinBars, cutoff, minStrokes);
  if (!wave) return null;
  const six = wave.six;
  if (opt.selectedWave && !sameWaveMove(wave, opt.selectedWave)) return null;
  const pattern = six.map(p => (isTop(p) ? 'T' : 'B')).join('');
  if (!/^(TB)+$/.test(pattern)) return null;      // 交替（首笔向下），笔数不限
  const t0 = pivotT(sub, six[0]);
  const t5 = pivotT(sub, six[six.length - 1]);
  if (t0 <= main.t[hIdx] || t0 > tHigh) return null; // 首顶位于主级别高点K线内
  // 五笔末底不再要求与主级别最低点处于同一根K线；仍须在确认时刻前已收盘确认。
  const subBars = [];
  for (let j = 1; j < six.length; j++) {
    const a = pivotIdx(six[j - 1]), b = pivotIdx(six[j]);
    const bars = b - a + 1;
    if (bars < subMinBars) return null;
    if (j % 2 ? !(six[j - 1].price > six[j].price) : !(six[j - 1].price < six[j].price)) return null;
    for (let k = a + 1; k <= b; k++) if (sub.t[k] - sub.t[k - 1] !== sub.ms) return null;
    subBars.push(bars);
  }
  // 三个底（仅作展示；用户口径：**不强制**依次降低，只要笔的方向是 下上下上下）
  const lows = six.filter((p, i) => i % 2 === 1).map(p => sub.l[Math.min(pivotIdx(p), sub.l.length - 1)]);
  const lowsDesc = lows[0] > lows[1] && lows[1] > lows[2];


  return {
    mainKey: main.key, subKey: sub.key, innerKey: null, mainMs: main.ms,
    mainBars, highT: main.t[hIdx], highPrice: main.h[hIdx],
    lowT: main.t[lIdx], lowPrice: main.l[lIdx],
    fractalT, fractalLow, fractalClose, fractalAge, fractalType, fractal3Lows,
    subStrokes: wave.strokes ?? 5, subBars, subMinBars, subFrom: t0, subTo: t5,
    stage, warnOnly,
    mainMode, top: top ? { high: top.high, low5: top.low5, barPct: top.barPct, ma7: top.ma7, ema7: top.ema7, bars: top.bars } : null,
    subPoints: six.map(p => ({ t: sub.t[pivotIdx(p)], price: p.price, type: p.type })),
    subLows: lows, lowsDesc,
    confirmT,
    fractalConfirmedAt: fIdx >= 0 ? main.t[fIdx + 1] + main.ms : null,

  };
}

/** 组装报警 */
export function makeChainAlert(symbol, hit, now, initial = false) {
  const M = label(hit.mainKey), S = label(hit.subKey);
  return {
    kind: 'chain',
    id: 0,
    symbol,
    mode: hit.stage === 'warning' ? 'live' : 'closed',
    stage: hit.stage === 'warning' ? 'chain-warn' : 'chain',
    confirmed: hit.stage !== 'warning',
    side: 'long',
    level: hit.mainKey,                       // 报警级别 = 主级别（图表按它取图）
    levelLabel: M,
    subLevel: hit.subKey, subLevelLabel: S,
    innerLevel: null, innerLevelLabel: null,
    group: `${S}五浪 → ${M}${hit.stage === 'warning' ? '底分型预警' : '底分型/均线确认'} · 两级结构`,
    base: hit.mainKey, mid: hit.subKey, big: null,
    score: 0,
    price: hit.fractalClose,
    candleT: hit.fractalT,
    ts: now,
    initial: !!initial,
    chainBars: hit.mainBars,
    chainSeq: null,
    chainGaps: [],
    chainSubBars: hit.subBars,
    chainSubPoints: hit.subPoints,
    chainFallbackFrom: hit.fallbackFrom ?? null,
    chainFifthBars: null,
    confirmedAt: hit.confirmT,
    closeT: hit.confirmT,
    ...alertTiming(hit.confirmT, now, initial),
    fractalConfirmedAt: hit.fractalConfirmedAt ?? null,
    confirmationKind: hit.top ? 'structure' : 'fractal',
    barT: (hit.confirmT ?? 0) - (hit.mainMs ?? 0),   // 确认那根K线的开盘时间（与顶部结构对齐，供共振判定）
    chainLow: hit.fractalLow,
    chain3Lows: hit.fractal3Lows,
    chainSubStrokes: hit.subStrokes,
    chainMainMode: hit.mainMode,
    mainTop: hit.top ?? null,
    barPct: Number.isFinite(hit.top?.barPct) ? hit.top.barPct : null,
    text: `【两级五浪·${hit.stage === 'warning' ? '预警' : '确认'}】${M} `
      // 主级别收盘K：按「顶部结构」逻辑（五根形态 + 反转点 + 收盘站上 MA7/EMA7）
      + (hit.mainMode === 'top5' && hit.top
        ? `顶部结构成立：高点 ${fmt(hit.top.high)} → 第5根创新低 ${fmt(hit.top.low5)} → 收盘 ${fmt(hit.fractalClose)} `
          + `**站上 MA7 ${fmt(hit.top.ma7)} 与 EMA7 ${fmt(hit.top.ema7)}**（这根就是触发）；`
        : `回调 ${hit.mainBars} 根（高 ${fmt(hit.highPrice)} → 低 ${fmt(hit.lowPrice)}）；`)
      + (hit.fallbackFrom ? `${label(hit.fallbackFrom)}有一笔差1根，降至${S}复核通过，改等${M}确认；` : '')
      + `${S} **${hit.subStrokes} 笔**（下上下上下…允许超过五浪，每笔 ${hit.subBars.join('/')} 根，均 ≥${hit.subMinBars}；各底 ${hit.subLows.map(fmt).join(' → ')}）；`
      + `${M} 回调最低点 ${fmt(hit.fractalLow)}（${hit.mainMode === 'top5' ? '底分型' : '底分型成立'}）→ 提醒`,
  };
}

/** 一次扫描：对配置的每一组级别各判一次，命中且未报过的返回报警数组 */
export function scanChains(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  const chanMin = cfg.beichiMinBars ?? 5;
  const pairs = [...(cfg.chainTriples ?? [])].sort((a, b) => LEVEL_INDEX[a.sub] - LEVEL_INDEX[b.sub]);
  const candidates = [], near = new Map();
  for (const pair of pairs) {
    const sub = chainView(seriesMap[pair.sub], pair.sub, chanMin, now);
    const wave = findFiveWaves(sub, Math.max(5, cfg.chainSubMinBars ?? 5), now);
    if (wave) candidates.push({ pair, wave });
    else {
      const relaxed = chainView(seriesMap[pair.sub], pair.sub, 4, now);
      const almost = findFiveWaves(relaxed, 4, now);
      if (almost && almost.bars.filter(n => n === 4).length === 1
        && almost.bars.every(n => n >= 4)) near.set(pair.sub, almost);
    }
  }
  for (const candidate of selectLargestWaves(candidates)) {
    const t = candidate.pair;
    const main = chainView(seriesMap[t.main], t.main, chanMin, Infinity, false);
    if (!main || main.closed < 1) continue;
    const asOf = main.t[main.closed - 1] + main.ms;
    const sub = chainView(seriesMap[t.sub], t.sub, chanMin, asOf);
    const hit = detectChain(main, sub, null, {
      mainMinBars: cfg.chainMainMinBars ?? 5,
      minStrokes: cfg.chainMinStrokes ?? 5,
      mainMode: cfg.chainMainMode ?? 'top5',
      mainNeedMa: cfg.chainMainNeedMa === true,
      mainWarn: cfg.chainMainWarn !== false,
      mainWarnFreshBars: initial ? (cfg.chainMainWarnFreshBars ?? 3) : 0,
      mainFreshBars: initial ? (cfg.chainMainFreshBars ?? 3) : 0,
      confirmGraceBars: initial ? 2 : 0,
      subMinBars: cfg.chainSubMinBars ?? 5,
      lookback: cfg.chainLookback ?? 20,
      fractalType: cfg.chainFractalType ?? 'any',
      selectedWave: candidate.wave,
    });
    if (!hit) continue;
    const next = pairs[pairs.findIndex(p => p.sub === t.sub) + 1];
    if (next && near.has(next.sub) && sameWaveMove(candidate.wave, near.get(next.sub))) hit.fallbackFrom = next.sub;
    const key = `${symbol}|${t.main}|${t.sub}|${hit.fractalT}|${hit.stage}`;
    if (seen.has(key)) continue;
    seen.set(key, now);
    out.push(makeChainAlert(symbol, hit, now, initial));
  }
  return out;
}
