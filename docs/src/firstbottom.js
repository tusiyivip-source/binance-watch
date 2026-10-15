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
import { findFirstBottomFractal, isBottomFractal } from './fractal.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 视图：K线 + 已收盘根数 + 缠论分型（ensureChan 在 engine 里本来就因背驰过滤算过，取缓存不额外花销） */
export function fbView(series, key, chanMinBars = 5) {
  if (!series || !series.t || series.t.length < 6) return null;
  const pts = null;   // 现在直接用 K 线底分型，不再依赖缠论笔端点
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
  if (!v) return null;
  const last = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (last < minBars + 1) return null;

  // ① 高点：最近 lookback 根（已收盘范围内）的最高点
  const from = Math.max(0, last - lookback);
  let hIdx = from;
  for (let k = from; k < last; k++) if (v.h[k] > v.h[hIdx]) hIdx = k;
  const tHigh = v.t[hIdx] + v.ms;                     // 高点收盘时刻
  const highPrice = v.h[hIdx];

  // ② 高点之后的**第一个底分型**（按用户给的分类图：默认"标准底分型"——
  //    中间那根的高点与低点都是三根中最低的）。
  //    ⚠ 底分型由三根K线组成，第三根一收盘就成立 —— 比"缠论成笔"确认更早，
  //      这正是"提醒要早"的关键。
  const type = opt.type ?? 'standard';
  //    从「高点数够 minBars 根」的位置开始找 —— 第一个满足**跨度要求**的底分型，
  //    而不是"最早那个底分型，跨度不够就放弃"（那会把很多正常信号误杀）。
  const cIdx = findFirstBottomFractal(v, hIdx + minBars - 1, type, last - 1);
  if (cIdx < 0) return null;
  const idx = cIdx;                                  // 底分型的中间那根
  const first = { price: v.l[idx] };

  // ③ 高点到该底分型的跨度（按主级别K线根数）≥ fbMinBars
  const bars = idx - hIdx + 1;
  if (bars < minBars) return null;

  // ④ 只报“刚刚确认”的：确认时间距最后一根收盘不超过 freshBars 根
  const ageBars = (last - 1) - (cIdx + 1);      // 底分型第三根收盘距现在几根
  if (ageBars > freshBars) return null;

  // ⑤ 跌幅门槛：高点到这个底分型必须真的跌下来（否则满屏都是「跌 0.3% 后的底分型」）
  const dropPct = highPrice ? ((highPrice - first.price) / highPrice) * 100 : 0;
  if (minDropPct > 0 && dropPct < minDropPct) return null;

  let lowSince = Infinity;
  for (let k = hIdx; k < last; k++) if (v.l[k] < lowSince) lowSince = v.l[k];
  return {
    level: v.key, highT: v.t[hIdx], highPrice,
    pivotT: v.t[idx], pivotPrice: v.l[idx],
    confirmT: v.t[Math.min(cIdx + 1, v.t.length - 1)] + v.ms,   // 第三根收盘 = 成立时刻
    bars, ageBars, dropPct, type, fractalType: type,
    lowSince: Number.isFinite(lowSince) ? lowSince : null,
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
    fbFractalType: hit.fractalType,
    fbDropPct: hit.dropPct,
    fbAgeBars: hit.ageBars,
    text: `【五浪首底预警】${L} 高点 ${fmt(hit.highPrice)} → **第一个底分型 ${fmt(hit.pivotPrice)}**`
      + `（${hit.fractalType === 'standard' ? '标准底分型' : hit.fractalType === 'relay' ? '中继底分型' : hit.fractalType === 'weakest' ? '最弱底分型' : '底分型'}，跨度 ${hit.bars} 根 ≥5，自高点跌 ${Number(hit.dropPct).toFixed(2)}%，成立后 ${hit.ageBars} 根内）；`
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
      type: cfg.fbType ?? 'standard',
    });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.pivotT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeFirstBottomAlert(symbol, hit, now, initial));
  }
  return out;
}
