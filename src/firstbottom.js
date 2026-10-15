/**
 * 五浪首底预警（独立通道，最早的那一声）
 *
 * 用户口径：
 *   「找到五浪第一次底分型 提醒我」+ 追加限定「高点到低点 不低于 5 根K线」
 *
 * 做法（全部在主级别上，且只看**已收盘**K线）：
 *   ① 最近 fbLookback 根里找「高点」，要求 高点 → 之后的低点 跨度 ≥ fbMinBars(默认5) 根；
 *   ② 在高点之后，取**第一个缠论确认的底分型**（分型确认即报警，不等五浪走完、不等上穿 EMA7）；
 *   ③ 只报"刚刚确认"的那个（距最后一根收盘 ≤ fbFreshBars 根），避免启动时把历史底分型刷一遍。
 *
 * 与五浪反弹（kind=wave）并列，kind=wavefirst；同一（币种+级别+底分型时间）只报一次。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 视图：K线 + 已收盘根数 + 缠论分型（ensureChan 在 engine 里本来就因背驰过滤算过，取缓存不额外花销） */
export function fbView(series, key, chanMinBars = 5) {
  if (!series || !series.t || series.t.length < 6) return null;
  let pts = null;
  try { pts = series.ensureChan(chanMinBars)?.pts ?? null; } catch { pts = null; }
  return {
    key, ms: series.ms, t: series.t, h: series.h, l: series.l, c: series.c,
    closed: series.closedCount, pts,
  };
}

/** 判定：高点之后第一个底分型（**分型确认**即算，用的就是 chan 的 confirmIdx） */
export function detectFirstBottom(v, opt = {}) {
  const minBars = opt.minBars ?? 5;
  const lookback = opt.lookback ?? 20;
  const freshBars = opt.freshBars ?? 2;
  const minDropPct = opt.minDropPct ?? 0;      // 高点到该底分型至少要跌多少 %（0=不限）
  if (!v || !Array.isArray(v.pts) || !v.pts.length) return null;
  const last = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (last < minBars + 1) return null;

  // ① 高点：最近 lookback 根（已收盘范围内）的最高点
  const from = Math.max(0, last - lookback);
  let hIdx = from;
  for (let k = from; k < last; k++) if (v.h[k] > v.h[hIdx]) hIdx = k;
  const tHigh = v.t[hIdx] + v.ms;                     // 高点收盘时刻
  const highPrice = v.h[hIdx];

  // ② 高点之后、且**已经确认**的第一个底分型
  //    ⚠ chan.pts 的元素形如 { mi, type, price, origIdx, confirmIdx }，**没有 t**：
  //      origIdx = 该分型所在的原始K线下标，confirmIdx = 它被确认（成笔）的那根K线。
  const isBottom = p => p.type === 'bottom' || p.type === '底' || p.type === 'B';
  const bottoms = v.pts.filter(p => {
    const idx = p.origIdx ?? p.mi;
    const cIdx = p.confirmIdx ?? idx;
    return isBottom(p) && idx > hIdx && cIdx <= last - 1;      // 只用已确认的
  });
  if (!bottoms.length) return null;
  const first = bottoms[0];
  const idx = first.origIdx ?? first.mi;
  const cIdx = first.confirmIdx ?? idx;

  // ③ 高点到该底分型的跨度（按主级别K线根数）≥ fbMinBars
  const bars = idx - hIdx + 1;
  if (bars < minBars) return null;

  // ④ 只报“刚刚确认”的：确认时间距最后一根收盘不超过 freshBars 根
  const ageBars = (last - 1) - cIdx;
  if (ageBars > freshBars) return null;

  // ⑤ 跌幅门槛：高点到这个底分型必须真的跌下来（否则满屏都是「跌 0.3% 后的底分型」）
  const dropPct = highPrice ? ((highPrice - first.price) / highPrice) * 100 : 0;
  if (minDropPct > 0 && dropPct < minDropPct) return null;

  let lowSince = Infinity;
  for (let k = hIdx; k < last; k++) if (v.l[k] < lowSince) lowSince = v.l[k];
  return {
    level: v.key, highT: v.t[hIdx], highPrice,
    pivotT: v.t[idx], pivotPrice: first.price,
    confirmT: v.t[Math.min(cIdx, v.t.length - 1)] + v.ms,
    bars, ageBars, dropPct, lowSince: Number.isFinite(lowSince) ? lowSince : null,
  };
}

/** 组装报警 */
export function makeFirstBottomAlert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  return {
    kind: 'wavefirst',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'first-bottom',
    confirmed: true,
    side: 'long',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 五浪首底`,
    base: hit.level, mid: null, big: null,
    score: 0,
    price: hit.pivotPrice,
    candleT: hit.pivotT,
    ts: now,
    initial: !!initial,
    fbHigh: hit.highPrice,
    fbHighT: hit.highT,
    fbBars: hit.bars,
    fbDropPct: hit.dropPct,
    fbAgeBars: hit.ageBars,
    text: `【五浪首底预警】${L} 高点 ${fmt(hit.highPrice)} → **第一个底分型 ${fmt(hit.pivotPrice)}**`
      + `（跨度 ${hit.bars} 根 ≥5，自高点跌 ${Number(hit.dropPct).toFixed(2)}%，分型确认于 ${hit.ageBars} 根前）；`
      + `这可能是五浪下跌的第 1 浪结束 —— **提前预警，不等五浪走完**`,
  };
}

/** 一次扫描 */
export function scanFirstBottoms(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  const chanMin = cfg.beichiMinBars ?? 5;
  for (const key of (cfg.fbLevels ?? [])) {
    const v = fbView(seriesMap[key], key, chanMin);
    const hit = detectFirstBottom(v, {
      minBars: cfg.fbMinBars ?? 5,
      lookback: cfg.fbLookback ?? 20,
      freshBars: cfg.fbFreshBars ?? 2,
      minDropPct: cfg.fbMinDropPct ?? 0,
    });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.pivotT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeFirstBottomAlert(symbol, hit, now, initial));
  }
  return out;
}
