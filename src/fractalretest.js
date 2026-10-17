/**
 * 底分型「回踩不破」提醒（用户 2026-10-17）
 *   「出现底分型后 可以是第三根或者第四第五根 回踩不破左侧底分型 提醒我」
 *
 * 口径：
 *   ① 先有一个已收盘确认的底分型（最低点 L 在中间那根，确认根 = 中间+1）
 *   ② 之后的**第 3 / 4 / 5 根**（= 中间根之后的第 2/3/4 根）出现**回踩**：
 *        回踩定义：收盘低于前一根，或最低价低于前一根（向下的动作）
 *   ③ 回踩过程中 **不破底分型低点**（最低价 > L，且收盘 > L）
 *   ④ 在这样的那一根上提醒（越早越好，第 3 根优先）
 *
 * 每「底分型低点 + 回踩根」只报一次。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { isBottomFractal } from './fractal.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
const fmtClock = ms => (Number.isFinite(ms)
  ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');
const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;

/**
 * 找"底分型之后第 3/4/5 根回踩不破"的形态
 * @returns {null|object}
 */
export function detectFractalRetest(v, opt = {}) {
  const lookback = opt.lookback ?? 20;
  const type = opt.type ?? 'any';
  const bars = Math.max(1, Math.min(3, opt.retestBars ?? 3));   // 允许第 3/4/5 根
  const freshBars = opt.freshBars ?? 1;                          // 命中后 ≤N 根内报
  const maxBreakPct = opt.maxBreakPct ?? 0;                      // 允许破低点的容差（%），0=一点都不许破
  const nearPct = opt.nearPct ?? 3;                              // 回踩必须靠近低点：最低价距低点 ≤ nearPct%
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 8) return null;

  // ① 找最近一个底分型（中间根 = 最低点）
  const from = Math.max(1, n - lookback);
  let lIdx = -1;
  for (let k = from; k < n - 1; k++) {
    if (!isBottomFractal(v, k, type)) continue;
    // 只认"最近 lookback 内最低点那一根"作为分型中心，避免抓到半路的
    let isLowest = true;
    for (let j = from; j < n; j++) if (v.l[j] < v.l[k]) { isLowest = false; break; }
    if (isLowest) { lIdx = k; break; }
  }
  if (lIdx < 1 || lIdx + 1 > n - 1) return null;
  const L = v.l[lIdx];
  const confirmIdx = lIdx + 1;

  // ② 检查第 3/4/5 根（= 中间根之后第 2/3/4 根）
  const limit = Math.min(n - 1, lIdx + 1 + bars);
  let hitIdx = -1;
  const pulls = [];
  for (let k = lIdx + 2; k <= limit; k++) {
    const prevC = v.c[k - 1], prevL = v.l[k - 1];
    const isPullback = v.c[k] < prevC || v.l[k] < prevL;
    const gapNow = (v.l[k] - L) / L * 100;
    const isNear = gapNow <= nearPct;                            // 必须真的踩到低点附近
    if (!isNear) continue;                                       // 还在高处飘 → 不算回踩
    const holdLow = v.l[k] > L * (1 - maxBreakPct / 100);
    const holdClose = v.c[k] > L * (1 - maxBreakPct / 100);
    if (!isPullback) continue;
    pulls.push({ i: k, low: v.l[k], close: v.c[k], hold: holdLow && holdClose });
    if (holdLow && holdClose) { if (hitIdx < 0) hitIdx = k; }
    else break;      // 破了就不再往下看（这个分型作废）
  }
  if (hitIdx < 0) return null;
  const age = (n - 1) - hitIdx;
  if (age < 0 || age > freshBars) return null;

  const ordinal = hitIdx - lIdx + 1;          // 分型中间根算第 2 根 → 回踩根是第 3/4/5 根
  const difLow = numAt(v.dif, lIdx), deaLow = numAt(v.dea, lIdx);
  let zeroSide = null;
  if (Number.isFinite(difLow) && Number.isFinite(deaLow)) {
    if (difLow > 0 && deaLow > 0) zeroSide = 'above';
    else if (difLow < 0 && deaLow < 0) zeroSide = 'below';
    else zeroSide = difLow >= 0 ? 'above' : 'below';
  }
  return {
    level: v.key,
    lowIdx: lIdx, lowT: v.t[lIdx], low: L,
    confirmT: v.t[confirmIdx] + v.ms,
    retestIdx: hitIdx, retestT: v.t[hitIdx],
    retestLow: v.l[hitIdx], retestClose: v.c[hitIdx],
    ordinal, pulls,
    gapPct: (v.l[hitIdx] - L) / L * 100,     // 回踩最低点离分型低点还有多远（>0 = 没破）
    age, type,
    zeroSide, difLow, deaLow,
  };
}

/** 组装报警 */
export function makeRetestAlert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  return {
    kind: 'frac',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'retest',
    confirmed: true,
    side: 'long',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 底分型回踩不破`,
    base: hit.level, mid: null, big: null,
    score: 80,
    price: hit.retestClose,
    candleT: hit.lowT,                        // 图表锚在底分型低点
    at: now,
    ts: now,
    initial: !!initial,
    closeT: hit.retestT + (hit.confirmT - hit.lowT) / 2,   // 回踩那根的收盘
    lowBarT: hit.lowT,
    fracLow: hit.low,
    fracAge: hit.age,
    fracType: hit.type,
    zeroSide: hit.zeroSide,
    zeroMixed: false,
    difLow: Number.isFinite(hit.difLow) ? hit.difLow : null,
    deaLow: Number.isFinite(hit.deaLow) ? hit.deaLow : null,
    retestOrdinal: hit.ordinal,
    retestLow: hit.retestLow,
    retestGapPct: hit.gapPct,
    text: `【${L}底分型·回踩不破·第${hit.ordinal}根】底分型低点 ${fmt(hit.low)}`
      + `（${fmtClock(hit.lowT)} 那根，MACD 低点处 DIF ${fmt(hit.difLow)} / DEA ${fmt(hit.deaLow)}`
      + `${hit.zeroSide === 'above' ? '，零轴上方' : hit.zeroSide === 'below' ? '，零轴下方' : ''}）；`
      + `第 ${hit.ordinal} 根回踩到 ${fmt(hit.retestLow)}（**未破低点，高出 ${hit.gapPct.toFixed(2)}%**），`
      + `收 ${fmt(hit.retestClose)}（${fmtClock(hit.retestT)} 收盘）→ 回踩不破成立`,
  };
}

/** 一次扫描：配置的每个级别各判一次回踩不破 */
export function scanFractalRetests(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  if (!cfg.fracRetestEnabled) return out;
  const levels = cfg.fracLevels ?? ['30m', '1h', '2h', '3h', '6h'];
  for (const key of levels) {
    const series = seriesMap[key];
    if (!series) continue;
    // 复用 frac 的视图（含 dif/dea/ma7）
    const v = (() => {
      try {
        const ind = series.ensure(); const m = series.macd();
        return { key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
          ma7: ind?.ma7 ?? null, ema7: ind?.ema7 ?? null, dif: m?.dif ?? null, dea: m?.dea ?? null,
          closed: series.closedCount };
      } catch { return null; }
    })();
    if (!v) continue;
    let freshBars = initial ? (cfg.fracRetestInitFreshBars ?? 0) : (cfg.fracRetestFreshBars ?? 1);
    if (initial && cfg.fracInitFreshMs) {
      const lvMs = (LEVELS[LEVEL_INDEX[key]]?.minutes ?? 1) * 60_000;
      freshBars = Math.max(1, Math.ceil(cfg.fracInitFreshMs / lvMs));
    }
    const hit = detectFractalRetest(v, {
      lookback: cfg.fracLookback ?? 20,
      type: cfg.fracType ?? 'any',
      retestBars: cfg.fracRetestBars ?? 3,
      freshBars,
      maxBreakPct: cfg.fracRetestBreakPct ?? 0,
      nearPct: cfg.fracRetestNearPct ?? 3,
    });
    if (!hit) continue;
    const k = `${symbol}|${key}|retest|${hit.lowT}|${hit.retestIdx}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeRetestAlert(symbol, hit, now, initial));
  }
  return out;
}
