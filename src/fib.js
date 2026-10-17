/**
 * 斐波那契回调策略（用户 2026-10-16 新定义，替代顶部结构）
 *
 * 用户口径：
 *   「A 代表 10 分钟级别。定义 10 分钟上涨：从 MACD 金叉 到 高点死叉，拉斐波那契数列。
 *     如果 10 分回调笔（也就是从死叉到金叉、或者底分型出现）回调幅度在斐波那契数列里，
 *     对比前 10 分钟涨幅的 50% 以内，都是有效的 —— 这样的提醒给我。」
 *
 * 落成判定（只用已收盘K线）：
 *   ① 上涨段：最近一次 **MACD 金叉**（起点）→ 之后的 **死叉**（终点，高点）
 *        riseLow  = [金叉前1根, 死叉] 的最低点      （斐波那契 100%）
 *        riseHigh = [金叉, 死叉] 的最高点           （斐波那契 0%）
 *        涨幅 rise = riseHigh - riseLow
 *   ② 回调段：死叉之后到"再次金叉"或"底分型第三根收盘"为止
 *        pullLow = 死叉之后的最低点
 *        回调比例 = (riseHigh - pullLow) / rise * 100
 *   ③ 触发：回调结束的信号出现（金叉 / 底分型收盘）且 **回调比例 ≤ maxRetrace（默认50%）**
 *      → 有效回调（强势不破半）→ 提醒
 *
 * 报警只在回调结束那一刻报一次（去重键含死叉时间与触发根时间）。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { macdCrosses } from './wave.js';
import { isBottomFractal } from './fractal.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;

/** 视图：K线 + MACD + 已收盘根数 */
export function fibView(series, key) {
  if (!series || !series.t || series.t.length < 10) return null;
  let ind = null, macd = null;
  try { ind = series.ensure(); macd = series.macd(); } catch { ind = null; macd = null; }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    dif: macd?.dif ?? null, dea: macd?.dea ?? null,
    ema7: ind?.ema7 ?? null,
    closed: series.closedCount,
  };
}

/** 斐波那契回撤位（从高点 0% 往低点 100%，与图一致） */
export function fibLevels(riseHigh, riseLow) {
  const d = riseHigh - riseLow;
  const at = p => riseHigh - d * p / 100;
  return [
    { p: 0, v: at(0) }, { p: 23.6, v: at(23.6) }, { p: 38.2, v: at(38.2) },
    { p: 50, v: at(50) }, { p: 61.8, v: at(61.8) }, { p: 78.6, v: at(78.6) }, { p: 100, v: at(100) },
  ];
}

/**
 * 判定"有效回调"
 * @returns {null|object}
 */
export function detectFibPullback(v, opt = {}) {
  const maxRetrace = opt.maxRetrace ?? 50;      // 回调不超过前段涨幅的百分之多少
  const minRisePct = opt.minRisePct ?? 0;       // 前段涨幅至少多少（%），过滤微小波动
  const lookback = opt.lookback ?? 40;          // 交叉在最近几根里找
  const freshBars = opt.freshBars ?? 1;         // 触发后 ≤N 根内报
  const fractalType = opt.fractalType ?? 'any';
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 12 || !v.dif || !v.dea) return null;

  // ① MACD 交叉（只在已收盘范围内）
  const all = macdCrosses(v).filter(x => x.k < n);
  if (all.length < 2) return null;
  const from = Math.max(1, n - lookback);
  const recent = all.filter(x => x.k >= from);
  if (recent.length < 2) return null;

  // 从后往前找一组「金叉 → 死叉」（金叉在前、死叉在后，且死叉是最新的那个）
  let gi = -1, di = -1;
  for (let k = recent.length - 1; k >= 1; k--) {
    if (recent[k].type === 'D' && recent[k - 1].type === 'G') { gi = recent[k - 1].k; di = recent[k].k; break; }
  }
  if (gi < 0 || di < 0) return null;
  if (di >= n - 1) return null;                 // 死叉那根就是最后一根 → 回调还没开始

  // ② 上涨段幅度
  let riseLow = Infinity, riseHigh = -Infinity;
  for (let k = Math.max(0, gi - 1); k <= di; k++) {
    if (v.l[k] < riseLow) riseLow = v.l[k];
    if (v.h[k] > riseHigh) riseHigh = v.h[k];
  }
  const rise = riseHigh - riseLow;
  if (!(rise > 0)) return null;
  if (minRisePct > 0 && (rise / riseLow) * 100 < minRisePct) return null;

  // ③ 回调段：死叉之后
  let pullLow = Infinity, pullLowIdx = -1;
  for (let k = di + 1; k <= n - 1; k++) if (v.l[k] < pullLow) { pullLow = v.l[k]; pullLowIdx = k; }
  if (pullLowIdx < 0) return null;
  // 创新高 → 这段回调结束、趋势继续，不算回调信号
  for (let k = di + 1; k <= n - 1; k++) if (v.h[k] > riseHigh) return null;
  const retrace = (riseHigh - pullLow) / rise * 100;

  // ④ 触发：回调结束的信号 —— 再次金叉 / 底分型第三根收盘
  let trigIdx = -1, trigBy = null;
  const after = all.filter(x => x.k > di && x.k < n);
  const g2 = after.find(x => x.type === 'G');
  if (g2) { trigIdx = g2.k; trigBy = 'cross'; }
  // 底分型：回调段内最低点那根是底分型中间根，且第三根已收盘
  if (pullLowIdx >= 1 && pullLowIdx + 1 <= n - 1 && isBottomFractal(v, pullLowIdx, fractalType)) {
    const t3 = pullLowIdx + 1;
    if (trigIdx < 0 || t3 < trigIdx) { trigIdx = t3; trigBy = 'fractal'; }
  }
  if (trigIdx < 0) return null;                 // 回调还没结束
  const age = (n - 1) - trigIdx;
  if (age < 0 || age > freshBars) return null;  // 只在刚结束那几根内报

  return {
    level: v.key,
    gi, di, trigIdx, trigBy, age,
    riseLow, riseHigh, rise,
    risePct: (rise / riseLow) * 100,
    pullLow, pullLowIdx, pullLowT: v.t[pullLowIdx],
    retrace,
    crossT: v.t[gi], highT: v.t[di], trigT: v.t[trigIdx],
    low: riseLow, high: riseHigh,
    fib: fibLevels(riseHigh, riseLow),
    valid: retrace <= maxRetrace,
    close: v.c[trigIdx],
    ema7: numAt(v.ema7, trigIdx),
  };
}

/** 组装报警 */
export function makeFibAlert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  const band = hit.fib.find(f => f.p >= hit.retrace) ?? hit.fib.at(-1);
  return {
    kind: 'fib',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'fib',
    confirmed: true,
    side: 'long',
    level: hit.level,
    levelLabel: L,
    group: `${L} · 斐波那契回调`,
    base: hit.level, mid: null, big: null,
    score: 70,
    price: hit.close,
    candleT: hit.pullLowT ?? hit.trigT,
    barT: hit.trigT,
    closeT: hit.trigT + (hit.ms ?? 0) || hit.trigT,   // 触发根收盘时刻      // 锚在回调最低点那根（图上圈的就是它）
    ts: now,
    initial: !!initial,
    fibRise: hit.rise,
    fibRisePct: hit.risePct,
    fibHigh: hit.riseHigh,
    fibLow: hit.riseLow,
    fibPullLow: hit.pullLow,
    fibRetrace: hit.retrace,
    fibBand: band?.p ?? null,
    fibTrigger: hit.trigBy,
    text: `【${L}斐波那契回调】上涨段：金叉 ${fmt(hit.riseLow)} → 死叉高点 ${fmt(hit.riseHigh)}`
      + `（涨幅 ${hit.risePct.toFixed(2)}%）；回调到 ${fmt(hit.pullLow)}`
      + ` = **回撤 ${hit.retrace.toFixed(1)}%**（斐波 ${band ? band.p + '%' : '—'} 附近）`
      + `，${hit.retrace <= 50 ? '**≤50% 有效**' : '超过 50%'}`
      + `；回调结束信号：${hit.trigBy === 'cross' ? '再次金叉' : '底分型收盘确认'}`
      + `（第 ${hit.trigIdx + 1} 根，${hit.age === 0 ? '当根' : `已过 ${hit.age} 根`}）`,
  };
}

/** 一次扫描 */
export function scanFib(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  if (!cfg.fibEnabled) return out;
  const levels = cfg.fibLevels ?? ['10m'];
  for (const key of levels) {
    const v = fibView(seriesMap[key], key);
    if (!v) continue;
    let freshBars = initial ? (cfg.fibInitFreshBars ?? 3) : (cfg.fibFreshBars ?? 1);
    if (initial && cfg.fibInitFreshMs) {
      const lvMs = (LEVELS[LEVEL_INDEX[key]]?.minutes ?? 1) * 60_000;
      freshBars = Math.max(1, Math.ceil(cfg.fibInitFreshMs / lvMs));
    }
    const hit = detectFibPullback(v, {
      maxRetrace: cfg.fibMaxRetrace ?? 50,
      minRisePct: cfg.fibMinRisePct ?? 0,
      lookback: cfg.fibLookback ?? 40,
      freshBars,
      fractalType: cfg.fibFractalType ?? 'any',
    });
    if (!hit || !hit.valid) continue;
    const k = `${symbol}|${key}|${hit.highT}|${hit.trigT}`;
    if (seen.has(k)) continue;
    seen.set(k, now);
    out.push(makeFibAlert(symbol, hit, now, initial));
  }
  return out;
}
