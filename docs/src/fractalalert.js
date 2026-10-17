/**
 * 底分型即报（用户 2026-10-16 要求）
 *   「怎么能在这个底分型出来就提醒呢」—— 图上圈的是"6时底分型收盘确认"那一根。
 *
 * 口径（最直接、最早）：
 *   ① 在最近 lookback 根已收盘K线里找**最低点那一根**
 *   ② 这一根必须是**底分型的中间那根**（口径 type：any=中间低点最低；standard=中间高低点都最低）
 *   ③ 底分型第三根**已收盘**，且距今 ≤ freshBars 根（默认 2）→ 立刻提醒
 *
 * 不要求：次级别五笔、不要求站上均线、不做任何过滤 —— 分型一出来就报。
 * 报警带 candleT = 底分型中间那根（最低点），前端在K线图上标的就是那根。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { isBottomFractal } from './fractal.js';
import { alertTiming } from './alert-timing.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 视图：K线 + MA7/EMA7 + 已收盘根数 */
export function fracView(series, key) {
  if (!series || !series.t || series.t.length < 6) return null;
  let ind = null;
  let macd = null;
  try { ind = series.ensure(); macd = series.macd(); } catch { ind = null; }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    ma7: ind?.ma7 ?? null, ema7: ind?.ema7 ?? null,
    dif: macd?.dif ?? null, dea: macd?.dea ?? null,
    closed: series.closedCount,
  };
}

const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;
/** 时间显示：MM-dd HH:mm（本地时区） */
const fmtClock = ms => (Number.isFinite(ms)
  ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');

/**
 * 判定"底分型刚刚收盘确认"
 * @returns {null|object}
 */
export function detectFractalAlert(v, opt = {}) {
  const lookback = opt.lookback ?? 20;
  const freshBars = opt.freshBars ?? 2;
  const type = opt.type ?? 'any';
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 6) return null;

  // ① 最近 lookback 根里的最低点
  const from = Math.max(0, n - lookback);
  let lIdx = from;
  for (let k = from; k < n; k++) if (v.l[k] < v.l[lIdx]) lIdx = k;
  // ② 必须够三根（左右各一根）
  if (lIdx < 1 || lIdx + 1 > n - 1) return null;
  // ③ 这一根是底分型的中间根
  if (!isBottomFractal(v, lIdx, type)) return null;
  // ④ 第三根刚收盘（距今 ≤ freshBars 根）
  const age = (n - 1) - (lIdx + 1);
  if (age < 0 || age > freshBars) return null;

  const ma7 = numAt(v.ma7, lIdx + 1), ema7 = numAt(v.ema7, lIdx + 1);
  const close = v.c[lIdx + 1];
  // ★ 用户 2026-10-17：把底分型按 MACD 相对零轴分成两类
  //   取**最低点那根**的 DIF/DEA（分型自身所处的位置）：
  //     两者都 > 0 → 零轴上方（强势回调中见底）
  //     两者都 < 0 → 零轴下方（下跌趋势中见底）
  //     跨零轴     → 归到 DIF 所在的一侧，并在文案里标注"混"
  const difLow = numAt(v.dif, lIdx), deaLow = numAt(v.dea, lIdx);
  let zeroSide = null;
  if (Number.isFinite(difLow) && Number.isFinite(deaLow)) {
    if (difLow > 0 && deaLow > 0) zeroSide = 'above';
    else if (difLow < 0 && deaLow < 0) zeroSide = 'below';
    else zeroSide = difLow >= 0 ? 'above' : 'below';
  }
  const zeroMixed = Number.isFinite(difLow) && Number.isFinite(deaLow)
    && (difLow > 0 ? deaLow <= 0 : deaLow >= 0);   // 跨零轴
  return {
    level: v.key,
    lowIdx: lIdx,
    lowT: v.t[lIdx], low: v.l[lIdx],
    threeLows: [v.l[lIdx - 1], v.l[lIdx], v.l[lIdx + 1]],
    confirmT: v.t[lIdx + 1] + v.ms, close,
    age, type,
    zeroSide, zeroMixed, difLow, deaLow,
    ma7, ema7,
    aboveMa: Number.isFinite(ma7) && Number.isFinite(ema7) ? (close > ma7 && close > ema7) : null,
  };
}

/** 组装报警 */
export function makeFractalAlert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  return {
    kind: 'frac',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'fractal',
    confirmed: true,
    side: 'long',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 底分型即报${hit.zeroSide === 'above' ? '（零轴上）' : hit.zeroSide === 'below' ? '（零轴下）' : ''}`,
    base: hit.level, mid: null, big: null,
    score: 50,
    price: hit.close,
    // ★ 用户 2026-10-17：分成「MACD 零轴上方 / 零轴下方」两类
    zeroSide: hit.zeroSide,        // 'above' | 'below' | null
    zeroMixed: !!hit.zeroMixed,
    difLow: Number.isFinite(hit.difLow) ? hit.difLow : null,
    deaLow: Number.isFinite(hit.deaLow) ? hit.deaLow : null,
    candleT: hit.lowT,                  // ★ 报警锚在"底分型中间那根"（最低点）
    ts: now,
    initial: !!initial,
    ...alertTiming(hit.confirmT, now, initial),
    fractalConfirmedAt: hit.confirmT,
    confirmationKind: 'fractal',
    fracLow: hit.low,
    fracLows: hit.threeLows,
    fracAge: hit.age,
    fracType: hit.type,
    aboveMa: hit.aboveMa,
    // ★ 准确时间字段：底分型低点那根 / 收盘确认那一根
    barT: hit.confirmT,                    // 收盘确认那一根的时间（= 第三根收盘时刻）
    closeT: hit.confirmT,                  // 第三根**收盘**时刻（准确的"收盘确认时间"）
    lowBarT: hit.lowT,                     // 最低点那根的开盘时刻
    text: `【${L}底分型·${hit.zeroSide === 'above' ? '零轴上方' : hit.zeroSide === 'below' ? '零轴下方' : '零轴未知'}】`
      + `低点 ${fmt(hit.low)}（三根低点 ${hit.threeLows.map(fmt).join(' / ')}`
      + `${hit.type === 'standard' ? '，中间那根高低点都最低' : '，中间那根最低'}）；`
      + `MACD 低点处 DIF ${fmt(hit.difLow)} / DEA ${fmt(hit.deaLow)}`
      + `${hit.zeroSide === 'above' ? '（都在零轴上方 = 强势回调中见底）' : hit.zeroSide === 'below' ? '（都在零轴下方 = 下跌趋势中见底）' : ''}`
      + `${hit.zeroMixed ? '，注意两者跨零轴' : ''}；`
      + `${L} 第三根收盘 ${fmt(hit.close)} 确认`
      + `（**${fmtClock(hit.confirmT)} 收盘**${hit.age > 0 ? `，已过 ${hit.age} 根` : '，当根'}）`
      + `；最低点那根区间 ${fmtClock(hit.lowT)}~${fmtClock(hit.lowT + (hit.confirmT - hit.lowT) / 2)}`
      + (hit.aboveMa === true ? ' · 同时站上 MA7/EMA7' : hit.aboveMa === false ? ' · 仍在均线下方' : ''),
  };
}

/** 一次扫描：配置的每个级别各判一次 */
export function scanFractalAlerts(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  if (!cfg.fracEnabled) return out;
  const levels = cfg.fracLevels ?? ['30m', '1h', '2h', '3h', '6h'];
  for (const key of levels) {
    const v = fracView(seriesMap[key], key);
    // 实时：第三根收盘后 ≤ fracFreshBars 根内报（默认 0 = 当根就报）
    // 启动补报：用**时间窗口** fracInitFreshMs 换算成该级别的根数，避免大级别把窗口吃光
    let freshBars = initial ? (cfg.fracInitFreshBars ?? 0) : (cfg.fracFreshBars ?? 0);
    if (initial && cfg.fracInitFreshMs) {
      // 时间窗口优先（各按自己周期换算）——否则大级别会被"根数窗口"吃光
      const lvMs = (LEVELS[LEVEL_INDEX[key]]?.minutes ?? 1) * 60_000;
      freshBars = Math.max(1, Math.ceil(cfg.fracInitFreshMs / lvMs));
    }
    const hit = detectFractalAlert(v, {
      lookback: cfg.fracLookback ?? 20,
      freshBars,
      type: cfg.fracType ?? 'any',
    });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.lowT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeFractalAlert(symbol, hit, now, initial));
  }
  return out;
}
