/** 两级五浪：次级别下上下上下五笔，等待对应主级别底分型收盘确认。 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { isBottomFractal } from './fractal.js';
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
    key, ms: series.ms, t: series.t, h: series.h, l: series.l, c: series.c,
    ema7: ind.ema7, dif: m.dif, dea: m.dea,
    closed, pts,
  };
}

const pivotIdx = p => (p.origIdx ?? p.mi);
const pivotT = (v, p) => v.t[Math.min(pivotIdx(p), v.t.length - 1)] + v.ms;
const isTop = p => p.type === 'top' || p.type === '顶' || p.type === 'T';

// 先识别五浪，再决定等待哪个主级别；不能先过滤未确认的大级别。
export function findFiveWaves(sub, minBars = 5, asOf = Infinity) {
  if (!sub) return null;
  const closed = Math.min(sub.closed ?? sub.t.length, sub.t.length);
  const pts = (sub.pts ?? []).filter(p => Number.isInteger(p.confirmIdx)
    && p.confirmIdx < closed && sub.t[p.confirmIdx] + sub.ms <= asOf);
  // 等待主级别确认期间，后续反弹顶不应挤掉刚完成的第五笔。
  if (pts.length && isTop(pts.at(-1))) pts.pop();
  const six = pts.slice(-6);
  if (six.length !== 6 || six.map(p => isTop(p) ? 'T' : 'B').join('') !== 'TBTBTB') return null;
  const bars = [];
  for (let j = 1; j < 6; j++) {
    const a = pivotIdx(six[j - 1]), b = pivotIdx(six[j]);
    if (b - a + 1 < minBars) return null;
    if (j % 2 ? six[j - 1].price <= six[j].price : six[j - 1].price >= six[j].price) return null;
    for (let k = a + 1; k <= b; k++) if (sub.t[k] - sub.t[k - 1] !== sub.ms) return null;
    bars.push(b - a + 1);
  }
  return { subKey: sub.key, ms: sub.ms, six, bars,
    start: sub.t[pivotIdx(six[0])], end: sub.t[pivotIdx(six[5])],
    high: six[0].price, low: six[5].price };
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

  // ① 主级别回调：高点 → 之后最低点，跨度 ≥ mainMinBars
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

  // ④ 主级别底分型：**回调最低点那一根必须就是底分型的中间那根**（用户口径）
  //    「回调低点 第二根就得是底分型才行」—— 底分型三根K线里的第二根 = 最低点，
  //    也就是：最低点左边一根更高、右边一根也更高（已经拐头），见底才算数。
  //    ⚠ 之前允许在最低点 -1~+3 根范围内找，会把"还没拐头"或"拐头后第3根"也算进来 ✗
  let fIdx = -1;
  if (lIdx >= 1 && lIdx + 1 <= mLen - 1 && isBottomFractal(main, lIdx, fractalType)) fIdx = lIdx;
  if (fIdx < 0) return null;                     // 最低点还没拐头 → 见底未确认
  const fractalT = main.t[fIdx], fractalLow = main.l[fIdx];
  const fractal3Lows = [main.l[fIdx - 1], main.l[fIdx], main.l[fIdx + 1]];   // 前/中/后三根的低点
  const fractalClose = main.c[fIdx + 1];                    // 底分型第三根收盘 = 成立时刻
  const fractalAge = (mLen - 1) - (fIdx + 1);               // 成立后过了几根
  if (fractalAge !== 0) return null;             // 只在最新收盘确认，不补报过期底分型
  const confirmT = main.t[fIdx + 1] + main.ms;

  // ② 次级别：下上下上下 五笔（顶→底→顶→底→顶→底）
  const subClosed = Math.min(sub.closed ?? sub.t.length, sub.t.length);
  const pts = (sub.pts ?? []).filter(p => Number.isInteger(p.confirmIdx)
    && p.confirmIdx < subClosed && sub.t[p.confirmIdx] + sub.ms <= confirmT);
  if (pts.length < 6) return null;
  const wave = findFiveWaves(sub, subMinBars, confirmT);
  if (!wave) return null;
  const six = wave.six;
  if (opt.selectedWave && !sameWaveMove(wave, opt.selectedWave)) return null;
  const pattern = six.map(p => (isTop(p) ? 'T' : 'B')).join('');
  if (pattern !== 'TBTBTB') return null;
  const t0 = pivotT(sub, six[0]);
  const t5 = pivotT(sub, six[5]);
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
  const lows = [six[1], six[3], six[5]].map(p => sub.l[Math.min(pivotIdx(p), sub.l.length - 1)]);
  const lowsDesc = lows[0] > lows[1] && lows[1] > lows[2];


  return {
    mainKey: main.key, subKey: sub.key, innerKey: null,
    mainBars, highT: main.t[hIdx], highPrice: main.h[hIdx],
    lowT: main.t[lIdx], lowPrice: main.l[lIdx],
    fractalT, fractalLow, fractalClose, fractalAge, fractalType, fractal3Lows,
    subStrokes: 5, subBars, subMinBars, subFrom: t0, subTo: t5,
    subPoints: six.map(p => ({ t: sub.t[pivotIdx(p)], price: p.price, type: p.type })),
    subLows: lows, lowsDesc,
    confirmT,

  };
}

/** 组装报警 */
export function makeChainAlert(symbol, hit, now, initial = false) {
  const M = label(hit.mainKey), S = label(hit.subKey);
  return {
    kind: 'chain',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'chain',
    confirmed: true,
    side: 'long',
    level: hit.mainKey,                       // 报警级别 = 主级别（图表按它取图）
    levelLabel: M,
    subLevel: hit.subKey, subLevelLabel: S,
    innerLevel: null, innerLevelLabel: null,
    group: `${S}五浪 → ${M}底分型 · 两级结构`,
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
    chainLow: hit.fractalLow,
    chain3Lows: hit.fractal3Lows,
    text: `【两级五浪·最大有效级别】${M} 回调 ${hit.mainBars} 根（高 ${fmt(hit.highPrice)} → 低 ${fmt(hit.lowPrice)}）；`
      + (hit.fallbackFrom ? `${label(hit.fallbackFrom)}有一笔差1根，降至${S}复核通过，改等${M}确认；` : '')
      + `${S} 下上下上下 五笔（每笔 ${hit.subBars.join('/')} 根，均 ≥${hit.subMinBars}；三底 ${hit.subLows.map(fmt).join(' → ')}）；`
      + `${M} **回调最低点处底分型成立**（三根低点 ${hit.fractal3Lows.map(fmt).join(' / ')} —— 中间那根最低；第三根收盘 ${fmt(hit.fractalClose)}）→ 提前提醒`,
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
      subMinBars: cfg.chainSubMinBars ?? 5,
      lookback: cfg.chainLookback ?? 20,
      fractalType: cfg.chainFractalType ?? 'any',
      selectedWave: candidate.wave,
    });
    if (!hit) continue;
    const next = pairs[pairs.findIndex(p => p.sub === t.sub) + 1];
    if (next && near.has(next.sub) && sameWaveMove(candidate.wave, near.get(next.sub))) hit.fallbackFrom = next.sub;
    const key = `${symbol}|${t.main}|${t.sub}|${hit.fractalT}`;
    if (seen.has(key)) continue;
    seen.set(key, now);
    out.push(makeChainAlert(symbol, hit, now, initial));
  }
  return out;
}
