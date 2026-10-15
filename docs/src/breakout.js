/**
 * 均线压制后突破（独立通道，与五浪反弹并列）
 *
 * 用户口径（原话）：「这是一个好的结构，在圆圈（价格上穿均线处）突破均线提示」
 *   ① 主级别**连续 brkMinBars（默认 12）根收盘价都在 EMA7 下方**（均线长期压制 / 贴着均线阴跌）
 *   ② 紧接着一根K线**收盘由下向上穿越 EMA7**（前一根收盘 ≤ EMA7、这一根收盘 > EMA7）→ 报警
 *
 * 与五浪通道完全独立：五浪看"次级别五浪 + 再次金叉 + 上穿EMA7"，本通道只看"长期压制 + 上穿"。
 * 同一（币种 + 级别 + 突破那根K线）只报一次。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 摘出判定所需的最小视图（数组都是引用） */
export function brkView(series, key) {
  if (!series || !series.t || series.t.length < 4) return null;
  const ind = series.ensure();
  return { key, ms: series.ms, t: series.t, h: series.h, l: series.l, c: series.c, ema7: ind.ema7 };
}

/**
 * 判定单级别是否构成「长期压制后上穿 EMA7」
 * @returns {null|object}
 */
export function detectBreakout(v, opt = {}) {
  const minBars = opt.minBars ?? 12;
  if (!v) return null;
  const n = v.t.length;
  if (n < minBars + 1) return null;                 // 至少 minBars 根压制 + 1 根突破
  const i = n - 1;                                  // 最后一根（已收盘）
  const a = v.ema7[i - 1], b = v.ema7[i];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // ② 本根：由下向上穿越 EMA7
  if (!(v.c[i - 1] <= a && v.c[i] > b)) return null;
  // ① 它之前必须连续 ≥minBars 根收盘在 EMA7 下方
  let streak = 0;
  for (let k = i - 1; k >= 0; k--) {
    const e = v.ema7[k];
    if (!Number.isFinite(e) || v.c[k] >= e) break;
    streak++;
  }
  if (streak < minBars) return null;
  // 压制期间的最低点（供展示）
  let low = Infinity, lowT = null;
  for (let k = i - streak; k < i; k++) if (Number.isFinite(v.l[k]) && v.l[k] < low) { low = v.l[k]; lowT = v.t[k]; }
  return {
    level: v.key, barT: v.t[i], close: v.c[i], ema7: b, ema7Prev: a,
    prevClose: v.c[i - 1], streak, low: Number.isFinite(low) ? low : null, lowT,
    abovePct: b ? ((v.c[i] - b) / b) * 100 : null,
  };
}

/** 组装报警（字段与其它通道一致，卡片/图表接口可直接复用） */
export function makeBreakoutAlert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  return {
    kind: 'breakout',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'breakout',
    confirmed: true,
    side: 'long',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 均线压制后突破`,
    base: hit.level, mid: null, big: null,
    score: 0,
    price: hit.close,
    candleT: hit.barT,
    ts: now,
    initial: !!initial,
    ema7: hit.ema7,
    streakBars: hit.streak,
    streakLow: hit.low,
    abovePct: hit.abovePct,
    text: `【均线压制后突破】${L} 连续 ${hit.streak} 根收盘在 EMA7 下方（压制段最低 ${fmt(hit.low)}），`
      + `本根收盘 ${fmt(hit.close)} **上穿 EMA7 ${fmt(hit.ema7)}**（前收 ${fmt(hit.prevClose)}）`
      + (Number.isFinite(hit.abovePct) ? `，站上 ${hit.abovePct.toFixed(2)}%` : '')
      + ' · [已确认]',
  };
}

/** 一次扫描：对配置的级别各判一次，命中且未报过的返回报警数组 */
export function scanBreakouts(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  for (const key of (cfg.brkLevels ?? [])) {
    const v = brkView(seriesMap[key], key);
    const hit = detectBreakout(v, { minBars: cfg.brkMinBars ?? 12 });
    if (!hit) continue;
    const k = `${symbol}|${key}|${hit.barT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeBreakoutAlert(symbol, hit, now, initial));
  }
  return out;
}
