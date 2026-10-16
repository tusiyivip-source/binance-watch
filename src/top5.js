/**
 * 顶部结构（用户 2026-10-15 新定义的第 2 条策略；级别：15分/30分/1时/2时/3时/6时）
 *
 * 用户原话逐条落地（级别：1小时）：
 *   「当1小时高点 第二根K线不创新高为准后 向下的大于5根K线以上
 *     前三根K线 第二根一定不能比第一根K高点高 第二根K可以收任意形态
 *     第三根形态随意 但是不能新高超过第一根
 *     第四根可以任意形态 价格高点不能超过第二根K
 *     第五根K价格要低于前四根K」
 *
 * 落成判定（以"这段高点"为第1根，只用**已收盘**K线）：
 *   ① 第1根 = 这段的最高点（lookback 内最高）
 *   ② 第2根：高点 ≤ 第1根高点（不创新高）—— 收盘形态不限
 *   ③ 第3根：高点 ≤ 第1根高点（不能新高超过第一根）—— 形态不限
 *   ④ 第4根：高点 ≤ **第2根**高点 —— 形态不限
 *   ⑤ 第5根：低点 < 前四根的最低点（价格低于前四根）
 *   ⑥ 高点向下 ≥ top5MinBars 根（用户："大于5根K线以上" → 默认 6）
 *
 * 全部满足 → 报警（同一段高点只报一次）。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 视图：K线（含开盘价）+ 已收盘根数 */
export function top5View(series, key) {
  if (!series || !series.t || series.t.length < 6) return null;   // 五根形态最少要 5 根，留 1 根余量
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    closed: series.closedCount,
  };
}

/** 「反包」= 阳包阴：本根为阳线，且实体盖住前一根实体（开盘 ≤ 前收，收盘 ≥ 前开） */
export function isEngulf(v, i, strict = true) {
  if (i < 1) return false;
  const bull = v.c[i] > v.o[i];
  if (!bull) return false;
  if (v.c[i] < v.o[i - 1]) return false;                 // 收盘必须盖过前一根开盘
  if (strict && v.o[i] > v.c[i - 1]) return false;       // 严格口径：开盘也不高于前一根收盘
  return true;
}

/**
 * 判定「1小时顶部结构」的两阶段状态
 *   ① 前五根形态（第1根高点 → 第2根不创新高 → 第3根不超第1根 → 第4根不超第2根 → 第5根创新低）
 *   ② 之后可以一直跌到第 N 根：
 *        - 第5根创新低            → stage='warning'（先预警）
 *        - 后续某根**没创新低**    → stage='warning'（止跌，等反包）
 *        - 任一根**反包**(阳包阴)  → stage='confirmed'（确认提醒）
 *        - 继续创新低             → 不提醒（还在跌）
 * @returns {null|object}
 */
export function detectTop5(v, opt = {}) {
  const minBars = opt.minBars ?? 5;          // 结构至少要走到第5根
  const lookback = opt.lookback ?? 20;       // 高点在最近几根里找
  const strictEngulf = opt.strictEngulf !== false;
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < minBars) return null;                        // 至少要有 5 根（第5根收完即可预警）

  // ① 第1根：最近 lookback 根（已收盘）里的最高点
  const from = Math.max(0, n - lookback);
  let i1 = from;
  for (let k = from; k < n; k++) if (v.h[k] > v.h[i1]) i1 = k;
  const i2 = i1 + 1, i3 = i1 + 2, i4 = i1 + 3, i5 = i1 + 4;
  if (i5 > n - 1) return null;                        // 第5根还没收盘

  // 前五根形态
  if (!(v.h[i2] <= v.h[i1])) return null;             // 第2根不创新高
  if (!(v.h[i3] <= v.h[i1])) return null;             // 第3根不超第1根
  if (!(v.h[i4] <= v.h[i2])) return null;             // 第4根不超第2根
  const low4 = Math.min(v.l[i1], v.l[i2], v.l[i3], v.l[i4]);
  if (!(v.l[i5] < low4)) return null;                 // 第5根低于前四根

  // ② 结构失效：价格重新站上第1根高点
  const li = n - 1;                                   // 最新收盘那根
  for (let k = i5 + 1; k <= li; k++) if (v.h[k] > v.h[i1]) return null;

  // 当前这根相对"前面所有根"是否创新低
  let minPrev = Infinity;
  for (let k = i1; k < li; k++) if (v.l[k] < minPrev) minPrev = v.l[k];
  const isNewLow = v.l[li] < minPrev;
  const bullBar = v.c[li] > v.o[li];                   // 本根收阳
  const engulf = isEngulf(v, li, strictEngulf);        // 本根阳包阴（实体盖住前一根）
  // 低点反包（用户口径）：**创新低那根只要收阳，那根就是低点** ——
  //   新低可以出现在第 N 根、也可以是第 N+1 根，只要那根"收阳"就算低点反包成立。
  const lowReversal = isNewLow && bullBar;

  let stage = null, reason = null;
  if (lowReversal) { stage = 'confirmed'; reason = 'low-bull'; }      // 创新低 + 收阳 → 低点就是这根
  else if (engulf) { stage = 'confirmed'; reason = 'engulf'; }        // 不创新低但阳包阴 → 反包确认
  else if (li === i5) { stage = 'warning'; reason = 'bar5'; }         // 第5根创新低 → 先预警
  else if (!isNewLow) { stage = 'warning'; reason = 'no-new-low'; }   // 某根没创新低 → 预警（等反包）
  if (!stage) return null;                            // 继续收阴创新低 → 不提醒

  return {
    level: v.key,
    highT: v.t[i1], high: v.h[i1],
    h2: v.h[i2], h3: v.h[i3], h4: v.h[i4],
    low1: v.l[i1], low2: v.l[i2], low3: v.l[i3], low4v: v.l[i4], low5: v.l[i5],
    bars: n - i1,                                    // 高点向下已走几根
    lastT: v.t[li], lastClose: v.c[li], lastLow: v.l[li], lastOpen: v.o[li],
    prevOpen: v.o[li - 1], prevClose: v.c[li - 1],
    isNewLow, engulf, bullBar, lowReversal, reason, stage,
    breakBars: li - i5,                              // 第5根之后又走了几根
  };
}

/** 组装报警（stage: warning=预警 / confirmed=反包确认） */
export function makeTop5Alert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  const warn = hit.stage === 'warning';
  const common = `${L} 高点 ${fmt(hit.high)}（第1根）→ 第2根不创新高 ${fmt(hit.h2)}`
    + ` → 第3根 ${fmt(hit.h3)} → 第4根 ${fmt(hit.h4)} → 第5根创新低 ${fmt(hit.low5)}；`
    + `高点向下已走 ${hit.bars} 根`;
  const body = warn
    ? `${common}${hit.breakBars > 0 ? `（第5根后又走 ${hit.breakBars} 根，本根未创新低 ${fmt(hit.lastLow)}）` : '（第5根刚创新低）'}；`
      + `**等反包确认**（本根收 ${fmt(hit.lastClose)}）`
    : (hit.reason === 'low-bull'
      ? `${common}；本根**创新低 ${fmt(hit.lastLow)} 但收阳**（开 ${fmt(hit.lastOpen)} → 收 ${fmt(hit.lastClose)}）`
        + ` → **低点反包成立（这根就是低点）**`
      : `${common}；本根**反包（阳包阴）**：开 ${fmt(hit.lastOpen)} ≤ 前收 ${fmt(hit.prevClose)}、`
        + `收 ${fmt(hit.lastClose)} ≥ 前开 ${fmt(hit.prevOpen)} → **止跌反包成立**`);
  return {
    kind: 'top5',
    id: 0,
    symbol,
    mode: warn ? 'live' : 'closed',              // 预警=未确认样式，确认=已确认样式
    stage: warn ? 'warning' : 'confirmed',
    confirmed: !warn,
    side: 'short',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 顶部结构${warn ? '·预警' : '·反包确认'}`,
    base: hit.level, mid: null, big: null,
    score: 0,
    price: hit.lastClose,
    candleT: warn ? hit.lastT : hit.lastT,
    ts: now,
    initial: !!initial,
    topBars: hit.bars,
    topHigh: hit.high,
    topH2: hit.h2,
    topH4: hit.h4,
    topLow5: hit.low5,
    topStage: hit.stage,
    topEngulf: !!hit.engulf,
    text: `【顶部结构·${warn ? '预警' : '反包确认'}】${body}`,
  };
}

/** 一次扫描（默认只看 1小时） */
export function scanTop5(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  for (const key of (cfg.top5Levels ?? ['1h'])) {
    const v = top5View(seriesMap[key], key);
    const hit = detectTop5(v, { minBars: cfg.top5WarnBars ?? 5, lookback: cfg.top5Lookback ?? 20, strictEngulf: cfg.top5StrictEngulf !== false });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.highT}|${hit.stage}|${hit.lastT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeTop5Alert(symbol, hit, now, initial));
  }
  return out;
}
