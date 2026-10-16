/**
 * 1小时顶部结构（用户 2026-10-15 新定义的第 2 条策略）
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

/** 视图：K线 + 已收盘根数 */
export function top5View(series, key) {
  if (!series || !series.t || series.t.length < 8) return null;
  return { key, ms: series.ms, t: series.t, h: series.h, l: series.l, c: series.c, closed: series.closedCount };
}

/**
 * 判定是否构成「1小时顶部结构」
 * @returns {null|object}
 */
export function detectTop5(v, opt = {}) {
  const minBars = opt.minBars ?? 6;          // 高点向下至少几根（用户："大于5根"）
  const lookback = opt.lookback ?? 20;       // 高点在最近几根里找
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < minBars + 1) return null;

  // ① 第1根：最近 lookback 根（已收盘）里的最高点
  const from = Math.max(0, n - lookback);
  let i1 = from;
  for (let k = from; k < n; k++) if (v.h[k] > v.h[i1]) i1 = k;
  // ⑥ 高点向下 ≥ minBars 根（第5根必须已经收盘）
  const bars = n - i1;                        // 高点之后的根数
  if (bars < minBars) return null;
  const i2 = i1 + 1, i3 = i1 + 2, i4 = i1 + 3, i5 = i1 + 4;
  if (i5 > n - 1) return null;

  // ② 第2根不创新高
  if (!(v.h[i2] <= v.h[i1])) return null;
  // ③ 第3根不能新高超过第1根
  if (!(v.h[i3] <= v.h[i1])) return null;
  // ④ 第4根高点不超过第2根
  if (!(v.h[i4] <= v.h[i2])) return null;
  // ⑤ 第5根价格低于前四根（创这段新低）
  const low4 = Math.min(v.l[i1], v.l[i2], v.l[i3], v.l[i4]);
  if (!(v.l[i5] < low4)) return null;

  return {
    level: v.key,
    highT: v.t[i1], high: v.h[i1],
    h2: v.h[i2], h3: v.h[i3], h4: v.h[i4],
    low1: v.l[i1], low2: v.l[i2], low3: v.l[i3], low4v: v.l[i4], low5: v.l[i5],
    bars,                                    // 高点向下已走几根
    lastT: v.t[n - 1], lastClose: v.c[n - 1],
    breakBars: n - i5,                       // 第5根之后又走了几根
  };
}

/** 组装报警 */
export function makeTop5Alert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  return {
    kind: 'top5',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'top5',
    confirmed: true,
    side: 'short',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 顶部结构`,
    base: hit.level, mid: null, big: null,
    score: 0,
    price: hit.lastClose,
    candleT: hit.highT,
    ts: now,
    initial: !!initial,
    topBars: hit.bars,
    topHigh: hit.high,
    topH2: hit.h2,
    topH4: hit.h4,
    topLow5: hit.low5,
    text: `【1小时顶部结构】${L} 高点 ${fmt(hit.high)}（第1根）→ 第2根不创新高 ${fmt(hit.h2)}`
      + ` → 第3根 ${fmt(hit.h3)}（不超第1根）→ 第4根 ${fmt(hit.h4)}（不超第2根）`
      + ` → 第5根创新低 ${fmt(hit.low5)}（低于前四根最低 ${fmt(Math.min(hit.low1, hit.low2, hit.low3, hit.low4v))}）；`
      + `高点向下已走 ${hit.bars} 根${hit.breakBars > 0 ? `（第5根后又走 ${hit.breakBars} 根）` : ''}`
      + ` · 现价 ${fmt(hit.lastClose)}`,
  };
}

/** 一次扫描（默认只看 1小时） */
export function scanTop5(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  for (const key of (cfg.top5Levels ?? ['1h'])) {
    const v = top5View(seriesMap[key], key);
    const hit = detectTop5(v, { minBars: cfg.top5MinBars ?? 6, lookback: cfg.top5Lookback ?? 20 });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.highT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeTop5Alert(symbol, hit, now, initial));
  }
  return out;
}
