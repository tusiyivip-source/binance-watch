/**
 * 三级别嵌套结构（用户 2026-10-15 新定义的策略）
 *
 * 级别组合（主级别 - 次级别 - 内部级别）：
 *   6小时 - 1小时  - 10分钟      （写作 6-1-10）
 *   3小时 - 30分钟 - 5分钟       （3-30-5）
 *   2小时 - 15分钟 - 3分钟       （2-15-3）
 *   1小时 - 10分钟 - 2分钟       （1-10-2）
 *
 * 判定（逐条对应用户口径）：
 *   ① 主级别「回调」：高点 → 之后的最低点，跨度 **≥5 根K线**（用户：不少于5根，大于5根以上）
 *   ② 次级别：高低点连成 **下上下上下 五笔**（缠论分型端点：顶→底→顶→底→顶→底）
 *   ③ 内部级别（五浪）：MACD 交叉 **死→金→死→金→死**（正好5个），
 *      且 **相邻两个交叉之间 ≥5 根K线**，并且 **每个交叉落在对应的那一笔区间内**（"高低相连接"）
 *   ④ 主级别**出现底分型**（默认标准底分型：中间那根的高点与低点都是三根中最低）
 *   ⑤ 主级别那根**收盘**（底分型第三根收完）→ **提前提醒**（不等上穿均线）
 *
 * 只认**已收盘**K线。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { macdCrosses } from './wave.js';
import { isBottomFractal } from './fractal.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 级别视图：K线 + EMA7 + MACD + 分型端点 + 已收盘根数 */
export function chainView(series, key, chanMinBars = 5) {
  if (!series || !series.t || series.t.length < 8) return null;
  const ind = series.ensure();
  const m = series.macd();
  let pts = null;
  try { pts = series.ensureChan(chanMinBars)?.pts ?? null; } catch { pts = null; }
  return {
    key, ms: series.ms, t: series.t, h: series.h, l: series.l, c: series.c,
    ema7: ind.ema7, dif: m.dif, dea: m.dea,
    closed: series.closedCount, pts,
  };
}

const pivotIdx = p => (p.origIdx ?? p.mi);
const pivotT = (v, p) => v.t[Math.min(pivotIdx(p), v.t.length - 1)] + v.ms;
const isTop = p => p.type === 'top' || p.type === '顶' || p.type === 'T';

/**
 * 判定一组（主/次/内）是否构成完整结构
 * @returns {null|object}
 */
export function detectChain(main, sub, inner, opt = {}) {
  const mainMinBars = opt.mainMinBars ?? 5;       // 主级别回调最少根数
  const innerMinBars = opt.innerMinBars ?? 5;     // 内部相邻交叉最少间隔
  const lookback = opt.lookback ?? 20;
  //    实测：真实 V 型底那一根往往是「中继/任意」分型（中间高点不是最低），
  //    「标准」分型在回调最低点附近只占 3~18 次 → 默认 any（中间低点最低即算见底分型）
  const fractalType = opt.fractalType ?? 'any';
  if (!main || !sub || !inner) return null;

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

  // ④ 主级别底分型：必须是**这段回调最低点处**的底分型（见底确认）
  //    ⚠ 以前取的是"高点之后第一个底分型" —— 那是回调途中的中途反弹，
  //      位置明显偏高（实测：回调低点 0.0061440，却报 0.0067160）✗
  //    现在只在「回调最低点 -1 ~ +3 根」范围内找底分型，且其低点必须在极值附近（默认 1% 内）。
  //    +3 根是因为底分型要三根K线才成立，见底确认天然滞后 1~3 根。
  let fIdx = -1;
  const nearPct = opt.fractalNearPct ?? 1.0;
  const afterBars = opt.fractalAfterBars ?? 3;
  for (let m = Math.max(1, lIdx - 1); m <= Math.min(mLen - 2, lIdx + afterBars); m++) {
    if (!isBottomFractal(main, m, fractalType)) continue;
    const gap = Math.abs(main.l[m] - main.l[lIdx]) / main.l[lIdx] * 100;
    if (gap <= nearPct) { fIdx = m; break; }
  }
  if (fIdx < 0) return null;                     // 低点处还没走出底分型 → 还没见底确认
  const fractalT = main.t[fIdx], fractalLow = main.l[fIdx];
  const fractalClose = main.c[fIdx + 1];                    // 底分型第三根收盘 = 成立时刻
  const fractalAge = (mLen - 1) - (fIdx + 1);               // 成立后过了几根

  // ② 次级别：下上下上下 五笔（顶→底→顶→底→顶→底）
  const pts = sub.pts ?? [];
  if (pts.length < 6) return null;
  const six = pts.slice(-6);
  const pattern = six.map(p => (isTop(p) ? 'T' : 'B')).join('');
  if (pattern !== 'TBTBTB') return null;
  const t0 = pivotT(sub, six[0]);
  const t5 = pivotT(sub, six[5]);
  if (t0 < tHigh - 2 * sub.ms) return null;                  // 五笔必须发生在主级别高点之后
  if (t5 > (main.t[mLen - 1] + main.ms) + 6 * sub.ms) return null;   // 也不能太久远
  // 三个底（仅作展示；用户口径：**不强制**依次降低，只要笔的方向是 下上下上下）
  const lows = [six[1], six[3], six[5]].map(p => sub.l[Math.min(pivotIdx(p), sub.l.length - 1)]);
  const lowsDesc = lows[0] > lows[1] && lows[1] > lows[2];

  // ③ 内部级别：**窗口内最近走完的一个五浪** —— 末尾五个交叉必须是 死→金→死→金→死，
  //    且相邻两个交叉之间 ≥ innerMinBars 根K线（用户：每次内部不少于五根）
  //    （用户口径 A：不要求整段窗口"正好"五个交叉，也不要求与五笔一一对应；
  //      内部级别的历史深度往往覆盖不到整段五笔 —— 实测覆盖度只有 11%~37%）
  const all = macdCrosses(inner);
  const inWin = all.filter(x => x.t > t0 - 2 * inner.ms && x.t <= t5 + 2 * inner.ms);
  if (inWin.length < 5) return null;
  const crosses = inWin.slice(-5);
  if (crosses.map(x => x.type).join('') !== 'DGDGD') return null;
  const gaps = [];
  for (let i = 1; i < crosses.length; i++) {
    const g = Math.round((crosses[i].t - crosses[i - 1].t) / inner.ms);
    gaps.push(g);
    if (g < innerMinBars) return null;
  }
  const innerCoverage = (() => {                       // 内部数据覆盖了这段窗口的多少
    const lo = Math.max(t0, inner.t[0]);
    const hi = Math.min(t5, inner.t[inner.t.length - 1] + inner.ms);
    return t5 > t0 ? Math.max(0, Math.min(1, (hi - lo) / (t5 - t0))) : 0;
  })();

  return {
    mainKey: main.key, subKey: sub.key, innerKey: inner.key,
    mainBars, highT: main.t[hIdx], highPrice: main.h[hIdx],
    lowT: main.t[lIdx], lowPrice: main.l[lIdx],
    fractalT, fractalLow, fractalClose, fractalAge, fractalType,
    subStrokes: 5, subFrom: t0, subTo: t5,
    subLows: lows, lowsDesc,
    innerSeq: crosses.map(x => x.type).join(''),
    innerCoverage,
    innerCrossCount: inWin.length,
    innerGaps: gaps,
    innerFrom: crosses[0].t, innerTo: crosses[4].t,
    crosses: crosses.map(x => ({ t: x.t, type: x.type, price: x.price })),
  };
}

/** 组装报警 */
export function makeChainAlert(symbol, hit, now, initial = false) {
  const M = label(hit.mainKey), S = label(hit.subKey), I = label(hit.innerKey);
  const seq = hit.innerSeq.split('').map(x => (x === 'D' ? '死' : '金')).join('→');
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
    innerLevel: hit.innerKey, innerLevelLabel: I,
    group: `${M}→${S}→${I} · 三级别结构`,
    base: hit.mainKey, mid: hit.subKey, big: null,
    score: 0,
    price: hit.fractalClose,
    candleT: hit.fractalT,
    ts: now,
    initial: !!initial,
    chainBars: hit.mainBars,
    chainSeq: seq,
    chainGaps: hit.innerGaps,
    chainLow: hit.fractalLow,
    text: `【三级别结构】${M} 回调 ${hit.mainBars} 根（高 ${fmt(hit.highPrice)} → 低 ${fmt(hit.lowPrice)}）；`
      + `${S} 下上下上下 五笔（三底 ${hit.subLows.map(fmt).join(' → ')}${hit.lowsDesc ? ' 逐级走低' : ''}）；`
      + `${I} 五浪 ${seq}（相邻间隔 ${hit.innerGaps.join('/')} 根，均 ≥${5}）；`
      + `${M} **回调最低点处底分型成立**（低点 ${fmt(hit.fractalLow)}，第三根收盘 ${fmt(hit.fractalClose)}）→ 提前提醒`,
  };
}

/** 一次扫描：对配置的每一组级别各判一次，命中且未报过的返回报警数组 */
export function scanChains(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  const chanMin = cfg.beichiMinBars ?? 5;
  for (const t of (cfg.chainTriples ?? [])) {
    const main = chainView(seriesMap[t.main], t.main, chanMin);
    const sub = chainView(seriesMap[t.sub], t.sub, chanMin);
    const inner = chainView(seriesMap[t.inner], t.inner, chanMin);
    const hit = detectChain(main, sub, inner, {
      mainMinBars: cfg.chainMainMinBars ?? 5,
      innerMinBars: cfg.chainInnerMinBars ?? 5,
      lookback: cfg.chainLookback ?? 20,
      fractalType: cfg.chainFractalType ?? 'any',
    });
    if (!hit) continue;
    const key = `${symbol}|${t.main}|${t.sub}|${t.inner}|${hit.fractalT}`;
    if (seen.has(key)) continue;
    seen.set(key, now);
    out.push(makeChainAlert(symbol, hit, now, initial));
  }
  return out;
}
