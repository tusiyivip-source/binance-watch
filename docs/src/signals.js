/**
 * 多级别共振信号引擎
 *
 * 逻辑来源（用户需求）：
 *   1. 至少 3 个级别处于「多头排列」；
 *   2. 基准级别（如 3分钟）先「回踩」MA7，随后收盘「上穿/站上 MA7 与 EMA7」；
 *   3. 相邻级别（如 5分钟）同步「上穿均线」确认；
 *   4. 组合中的最大级别（如 2小时）不得「跌破均线」。
 *   该标准对任意 (基准, 相邻, 最大) 级别三元组通用。
 */
import { LEVELS, LEVEL_INDEX, LEVEL_KEYS, STATE, EVENT, DEFAULT_SIGNAL, watchInnerLevels } from './config.js';
import { chanStateAt } from './chan.js';

const LIVE_DROP_TOL = 0.006; // 回踩K线允许收盘略低于 MA7 的幅度

/** 读取某序列在索引 i 处的完整快照 */
function at(series, ind, i) {
  if (i < 0 || i >= series.t.length) return null;
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    i,
    t: series.t[i],
    o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i], v: series.v[i],
    done: series.done[i],
    ma7: num(ind.ma7[i]), ma25: num(ind.ma25[i]), ma99: num(ind.ma99[i]),
    ema7: num(ind.ema7[i]), ema25: num(ind.ema25[i]),
    volMa20: num(ind.volMa20[i]),
  };
}

function findCrossUp(series, ma, idx, maxBack) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const a = ma[i], b = ma[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (series.c[i] > a && series.c[i - 1] <= b) return k;
  }
  return null;
}

function findCrossDown(series, ma, idx, maxBack) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const a = ma[i], b = ma[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (series.c[i] < a && series.c[i - 1] >= b) return k;
  }
  return null;
}

/**
 * 「回到两条均线上方」这个动作发生在几根K线前。
 *
 * 与「分别上穿 MA7 / 上穿 EMA7」不同：只要**此刻收盘同时站上 MA7 与 EMA7**、
 * 而**前一根还在其中至少一条的下方**，就算作一次「上穿两条均线」。
 * 这样即使某一根线是更早穿上去的（中间没再跌破），只要价格刚刚重新站回两条线上方，
 * 依然算作新鲜的触发（用户口径：「次级别满足上穿 EMA7 和 MA7 均线上方」）。
 *
 * @returns {number|null} 0 = 就在当前这根；null = 回看窗口内没有这个动作
 */
function findAboveBothCross(series, ind, idx, maxBack) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const m = ind.ma7[i], e = ind.ema7[i], pm = ind.ma7[i - 1], pe = ind.ema7[i - 1];
    if (!Number.isFinite(m) || !Number.isFinite(e) || !Number.isFinite(pm) || !Number.isFinite(pe)) continue;
    const aboveNow = series.c[i] > m && series.c[i] > e;
    const belowBefore = series.c[i - 1] <= pm || series.c[i - 1] <= pe;
    if (aboveNow && belowBefore) return k;
  }
  return null;
}

/** 回踩：上行走势中，K线最低价触及/逼近 MA7，但收盘未有效跌破 */function findPullback(series, ma, idx, maxBack, tol) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const m = ma[i], pm = ma[i - 1];
    if (!Number.isFinite(m) || !Number.isFinite(pm)) continue;
    const touched = series.l[i] <= m * (1 + tol);
    const held = series.c[i] >= m * (1 - LIVE_DROP_TOL);
    const trendUp = series.c[i - 1] > pm; // 回踩前必须站在 MA7 之上
    if (touched && held && trendUp) {
      return { bars: k, depth: (m - series.l[i]) / m };
    }
  }
  return null;
}

/* ==================== 盯盘通道：1时/2时 MACD + 站上均线 ==================== */

/**
 * 「从最近高点到现在有几根K线」——用户口径的「够笔 ≥5 根」。
 * 最近高点 = 回看 lookback 根里的**最高价**那一根；返回它到当前（含两端）的K线根数。
 * 若当前这根就是最高（还在涨），返回 1（自然不满足 ≥5）。
 */
export function barsFromHigh(series, idx, lookback = 20) {
  const h = series.h;
  let hIdx = idx, best = -Infinity;
  for (let k = Math.max(0, idx - lookback + 1); k <= idx; k++) {
    if (h[k] > best) { best = h[k]; hIdx = k; }
  }
  return {
    bars: idx - hIdx + 1,
    highIdx: hIdx,
    high: best,
    highT: series.t[hIdx],
  };
}

/** MACD 死叉状态：DIF < DEA（以收盘为准） */
export function macdDead(series, idx, fast = 12, slow = 26, signal = 9) {
  if (!series || idx == null || idx < 0) return null;
  const m = series.macd(fast, slow, signal);
  const d = m.dif[idx], e = m.dea[idx];
  if (!Number.isFinite(d) || !Number.isFinite(e)) return null;
  return d < e;
}

/* ==================== 旧：主级别回踩结构（保留函数，已不参与盯盘） ==================== */

/**
 * 主级别：「**有延续预期的最大可视笔**」。
 *
 * 拆成三件事，都是用户口径：
 *   1. **本笔必须是上涨笔**：从最近一个已确认底分型起、到当前正在走的高点（这一笔还没走完）；
 *   2. **有延续预期** = 没有顶背驰：价格虽创新高，但 MACD 红柱面积没有衰减
 *      （`chanStateAt` 给出 divergence.status === 'pending' 就是"将要顶背驰"，那就**不算**延续）；
 *   3. **最大可视笔** = 这一笔的幅度 ≥ 可见范围内（最近 lookback 笔）任何一笔的幅度 × minRatio
 *      —— 也就是图上最显眼的那一笔上涨。
 *
 * @returns {{ok, dir, advance, advancePct, bars, prevMax, isLargest, beichi, fromPrice, toPrice, fromT}|null}
 */
export function strokeContinuation(series, idx, opt = {}) {
  const minBars = opt.minBars ?? 5;
  const lookback = opt.lookback ?? 8;
  const minRatio = opt.minRatio ?? 1.0;
  const chan = series.ensureChan(minBars);
  if (!chan) return null;
  const st = chanStateAt(chan, series, idx, {
    ratio: opt.beichiRatio ?? 1.0,
    minProgress: opt.beichiMinProgress ?? 0.3,
  });
  if (!st?.ok) return null;

  const cur = st.cur;
  const isUp = st.dir === 'up';
  const advance = cur.advance;
  const bars = cur.toIdx - cur.fromIdx + 1;
  const beichi = st.divergence?.status === 'pending';

  // 可见范围内每一笔的幅度（涨跌笔都算，"最大可视笔"就是比它们都大）
  let prevMax = 0, prevMaxDir = null;
  const i = Math.max(0, Math.min(idx, chan.n - 1));
  const cnt = chan.confirmCount[i];
  for (let k = cnt - 1, n = 0; k >= 1 && n < lookback; k--, n++) {
    const a = chan.pts[k - 1], b = chan.pts[k];
    const span = Math.abs(b.price - a.price);
    if (span > prevMax) { prevMax = span; prevMaxDir = b.type === 'top' ? 'up' : 'down'; }
  }
  const isLargest = advance >= prevMax * minRatio;
  const fromPrice = cur.fromPrice;
  return {
    ok: isUp && !beichi && isLargest && advance > 0,
    dir: st.dir,
    advance,
    advancePct: fromPrice > 0 ? (advance / fromPrice) * 100 : null,
    bars,
    prevMax,
    prevMaxDir,
    ratio: prevMax > 0 ? advance / prevMax : null,
    isLargest,
    beichi,
    fromPrice,
    toPrice: cur.toPrice,
    fromT: series.t[cur.fromIdx],
    toT: series.t[cur.toIdx],
  };
}

/**
 * 次级别：「**两根阳线站上均线**」。
 *   · 连续两根阳K（收盘 > 开盘）
 *   · **第二根**收盘同时站上 MA7 与 EMA7
 *   · 默认要求这是一次"收复"：第一根还没站上（收盘在至少一条均线下方）——
 *     否则强势单边里每一组两连阳都会触发，信号会泛滥
 */
export function twoBullReclaim(series, ind, idx, opt = {}) {
  if (idx < 2) return null;
  const i2 = idx, i1 = idx - 1;
  if (!(series.c[i1] > series.o[i1]) || !(series.c[i2] > series.o[i2])) return null;   // 两根都是阳K
  const m2 = ind.ma7[i2], e2 = ind.ema7[i2];
  if (!Number.isFinite(m2) || !Number.isFinite(e2)) return null;
  if (!(series.c[i2] > m2 && series.c[i2] > e2)) return null;                          // 第二根收盘站上两条线
  const m1 = ind.ma7[i1], e1 = ind.ema7[i1];
  const belowFirst = (Number.isFinite(m1) && series.c[i1] <= m1) || (Number.isFinite(e1) && series.c[i1] <= e1);
  if (opt.needReclaim !== false && !belowFirst) return null;
  return {
    ok: true, bars: 2,
    close1: series.c[i1], close2: series.c[i2],
    ma7: m2, ema7: e2,
    belowFirst,
    candleT: series.t[i2],
    // 第二根收盘相对两条均线高多少（%）
    distMa7Pct: m2 > 0 ? ((series.c[i2] - m2) / m2) * 100 : null,
    distEma7Pct: e2 > 0 ? ((series.c[i2] - e2) / e2) * 100 : null,
  };
}

/**
 * 截至 idx 的「连续收盘走低」根数。
 * 返回 n 表示 c[idx] < c[idx-1] < … < c[idx-n+1]，即这段下跌一共 n 根K线（最少 1）。
 */
export function downRunLen(c, idx) {
  let n = 1;
  while (idx - n >= 0 && c[idx - n + 1] < c[idx - n]) n++;
  return n;
}

/**
 * 最近一段「连续收盘走低且 ≥ minBars 根」的K线。
 * @param {number} age 允许这段回调在最近 age 根K线内**结束**（0 = 最后一根仍在下跌中）
 * @returns {{bars:number,start:number,end:number,ago:number}|null}
 *   bars = 这段下跌的K线根数，start/end = 起止下标，ago = 距离最后一根几根前结束
 */
export function recentDownRun(series, idx, minBars, age = 0) {
  const c = series.c;
  for (let j = idx; j >= Math.max(1, idx - age); j--) {
    const n = downRunLen(c, j);
    if (n >= minBars) return { bars: n, start: j - n + 1, end: j, ago: idx - j };
  }
  return null;
}

/**
 * 主级别「回踩结构」——用户口径：
 *
 *   ① 回调段：从**回调起点（高点）**跌到**回调低点（谷）**的这一段K线，根数 ≥ minBars；
 *      谷 = 最近 age+1 根里最低的那根（age 就是「回调低点必须有多新」）；
 *   ② 左侧上涨段：回调起点之前那段上涨的低点 = 起点前 lookback 根内的**最低低点**（这波上涨的起点）；
 *   ③ 不破前低：回调段的**最低价** ≥ 左侧上涨段的**最低价** × (1 - tolerance)。
 *
 * ⚠ 口径为什么不是「连续 N 根收盘价逐根走低」：
 *   真实回调里几乎必然夹着 1~2 根小阳线，要求**逐根递减**连 5 根，实测命中率 ≈ 0
 *   （106 个标的里 ① 只命中 0~1 个、且与 ② 几乎互斥 → 整条通道不出信号）。
 *   用户口径的原话是「主级别跌够5根K线以上 / 左侧这一笔回调的这笔5根K线以上」，
 *   说的是**这一段回调有 5 根以上K线**（"这一笔"），而不是每一根都比前一根低。
 *   改成摆动段口径后 ① 命中 5~27 个，语义与「这一笔回调」严格一致。
 *
 * @returns {object|null} ok = 结构成立（段够长 + 上涨段够长 + 不破前低）
 */
export function pullbackStructure(series, idx, opt = {}) {
  const minBars = opt.minBars ?? 5;
  const age = opt.age ?? 3;
  const tol = opt.tolerance ?? 0;
  const minUp = opt.minUpBars ?? 1;
  const lookback = opt.lookback ?? 20;
  const maxBars = opt.maxBars ?? 0;      // 0 = 回调长度**不限制**（只要求 ≥ minBars，用户口径：6/7/8/9/10…都行）

  const l = series.l, h = series.h, t = series.t;

  // —— 回调低点（谷）：**最近 age 根里**最低的那根 ——
  //    注意窗口只能是最近 age 根，不能是整个 lookback：
  //    在一个上涨的序列里，「最近 20 根的最低点」是 20 根前那根（最老的），
  //    永远不满足「低点足够新」，结构就永远判不过（实测命中率≈0，正是这个坑）。
  let lIdx = idx, pbLow = Infinity;
  for (let k = Math.max(1, idx - age); k <= idx; k++) {
    if (l[k] < pbLow) { pbLow = l[k]; lIdx = k; }
  }
  if (!Number.isFinite(pbLow)) return null;
  const ago = idx - lIdx;

  // —— 回调起点（峰）：在「低点之前 peakWin 根」里找最高的那根 ——
  //    · 上限不限制时（maxBars=0）peakWin = lookback（回调最多回看 20 根）
  //    · 有上限时 peakWin = maxBars-1，段长天然 ≤ maxBars，结构在**回调低点那根**就成立
  //      （若在整个 lookback 里找峰，下跌腿里那根峰在很远处 → 段长超上限 → 结构要等窗口
  //        滑动好几根才成立，这正是「提醒太晚」的根因之一）
  const peakWin = maxBars > 0 ? Math.max(1, maxBars - 1) : Math.max(1, lookback);
  let hIdx = Math.max(0, lIdx - 1), peak = -Infinity;
  for (let k = Math.max(0, lIdx - peakWin); k < lIdx; k++) {
    if (h[k] > peak) { peak = h[k]; hIdx = k; }
  }
  const bars = lIdx - hIdx + 1;      // 这一段回调共有几根K线（含起跌那根与最低那根）
  if (bars < minBars || (maxBars > 0 && bars > maxBars)) return null;

  // —— 左侧上涨段的低点：起点之前 lookback 根内的最低低点（这波上涨的起点）——
  let uStart = Math.max(0, hIdx - 1), upLow = Infinity;
  for (let k = Math.max(0, hIdx - lookback); k < hIdx; k++) {
    if (l[k] < upLow) { upLow = l[k]; uStart = k; }
  }
  if (!Number.isFinite(upLow)) return null;
  const upLen = hIdx - uStart;

  const noBreak = pbLow >= upLow * (1 - tol);
  return {
    bars, start: hIdx, end: lIdx, ago,
    startT: t[hIdx], endT: t[lIdx],
    upStart: uStart, upEnd: hIdx, upLen,
    pbLow, upLow,
    // 回调低点相对左侧上涨段低点的偏离（%）：>0 表示还在前低上方
    breakPct: upLow > 0 ? ((pbLow - upLow) / upLow) * 100 : null,
    noBreak,
    ok: noBreak && upLen >= minUp,
  };
}

/**
 * 回踩形态「两根阴K不破均线」：
 *   · 最近 `bars` 根K线**都是阴线**（收盘 < 开盘）
 *   · 每根的**收盘价**都没有跌破 MA7，也没有跌破 EMA7（**影线允许插破**）
 *
 * 含义：上涨途中**极浅的回调** —— 连收盘都没能把价格压到均线下方，
 * 说明抛压已经枯竭，是「跌无可跌」的典型形态。
 *
 * 注意与 findPullback 的区别：那个要求「最低价触及均线」（影线碰到才算回踩），
 * 这个要求「收盘始终没离开均线上方」（价格压根没破位）。
 */
export function findTwoBearHold(series, ind, idx, bars = 2, requireBear = true) {
  if (idx < bars) return null;
  let lowest = Infinity, top = -Infinity;
  for (let k = 1; k <= bars; k++) {
    const i = idx - k;
    const m = ind.ma7[i], e = ind.ema7[i];
    if (!Number.isFinite(m) || !Number.isFinite(e)) return null;
    if (requireBear && !(series.c[i] < series.o[i])) return null;   // 大级别可选是否要求阴K
    if (series.c[i] < m || series.c[i] < e) return null;            // 收盘不得跌破两条均线
    if (series.l[i] < lowest) lowest = series.l[i];
    if (series.h[i] > top) top = series.h[i];
  }
  return {
    bars,
    top,
    low: lowest,
    depth: top > 0 ? (top - lowest) / top : 0,
    // 影线插破的幅度（0 = 完全没有插破；>0 表示最低价曾到均线下方）
    pierce: null,
  };
}

/**
 * 形态「双阳不穿破均线」（做空）—— findTwoBearHold 的镜像：
 *   · 最近 `bars` 根K线**都是阳线**（收盘 > 开盘）
 *   · 每根的**收盘价**都没有涨破 MA7，也没有涨破 EMA7（**影线允许刺破**）
 *
 * 含义：下跌途中**极浅的反弹** —— 连收盘都顶不回均线上方，说明买盘枯竭。
 */
export function findTwoBullHold(series, ind, idx, bars = 2) {
  if (idx < bars) return null;
  let highest = -Infinity, bottom = Infinity;
  for (let k = 1; k <= bars; k++) {
    const i = idx - k;
    const m = ind.ma7[i], e = ind.ema7[i];
    if (!Number.isFinite(m) || !Number.isFinite(e)) return null;
    if (!(series.c[i] > series.o[i])) return null;           // 必须是阳K
    if (series.c[i] > m || series.c[i] > e) return null;     // 收盘不得涨破两条均线
    if (series.h[i] > highest) highest = series.h[i];
    if (series.l[i] < bottom) bottom = series.l[i];
  }
  return { bars, top: highest, low: bottom, depth: highest > 0 ? (highest - bottom) / highest : 0 };
}

/**
 * 双阴不破 / 双阳不穿 的**完整判定**。
 *
 * 相比直接调用 findTwoBearHold，这里修正了两处：
 *
 *   1. **K线窗口含刚收盘的那根**：形态是 idx、idx-1，而不是 idx-1、idx-2。
 *      原来那样会在收盘之后**晚一整根K线**才发现形态（1时级别上就是晚 1 小时）。
 *      实现上用 idx+1 调用（那两个函数的窗口是 idx'-1 … idx'-bars），即可把窗口右移到 idx。
 *
 *   2. **增加两条前置条件**（用户要求）：
 *      · 均线方向：做多要求 MA7 向上，做空要求 MA7 向下
 *      · 前置趋势：形态出现之前，价格必须已在均线同侧持续 N 根
 *
 * @param {number} dir 1 = 做多（双阴不破）, -1 = 做空（双阳不穿）
 */
export function dualPattern(series, ind, idx, cfg, dir) {
  const bars = cfg.dualBars ?? 2;
  const shape = dir > 0
    ? findTwoBearHold(series, ind, idx + 1, bars, true)
    : findTwoBullHold(series, ind, idx + 1, bars);
  if (!shape) return null;

  // 均线方向
  if (cfg.dualRequireMaSlope) {
    const a = ind.ma7[idx], b = ind.ma7[idx - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (dir > 0 ? !(a > b) : !(a < b)) return null;
  }

  // 前置趋势：形态的 bars 根之前，再往前 prev 根都必须在均线同侧
  const prev = cfg.dualPrevBars ?? 0;
  for (let k = 0; k < prev; k++) {
    const i = idx - bars - k;
    if (i < 0) return null;
    const m = ind.ma7[i];
    if (!Number.isFinite(m)) return null;
    if (dir > 0 ? !(series.c[i] > m) : !(series.c[i] < m)) return null;
  }
  return shape;
}

/**
 * 分析单个级别。
 * @param {import('./series.js').CandleSeries} series
 * @param {'closed'|'live'} mode closed=只用已收盘K线（不重绘）；live=含正在形成的K线（预警）
 */
export function analyzeLevel(series, cfg, mode) {
  const n = series.t.length;
  if (n < 40) return null;
  const ind = series.ensure();
  // —— 收盘判定用【时间戳】，不依赖 REST 回报的 done 标记 ——
  //    tick-rest 模式下 done 要等滚动补K线拉回来才知道，而高等级别（1时/2时/3时）的
  //    补K线周期很长，导致 K线早已收盘却迟迟不判定、报警被拖到几十分钟后。
  //    实测：15分级别 412ms，而 30分/1时 最慢 1200 秒（20 分钟）。
  //    其实收盘时刻看时钟就知道（1时K线就是整点收盘），根本不用问币安。
  const nowMs = Date.now();
  let ci = n - 1;
  while (ci > 0 && nowMs < series.t[ci] + series.ms) ci--;
  const idx = mode === 'live' ? n - 1 : ci;
  if (idx < 30 || ci < 25) return null;

  const cur = at(series, ind, idx);
  const prev = at(series, ind, idx - 1);
  if (!cur || !prev || cur.ma7 == null || cur.ma25 == null || prev.ma7 == null) return null;

  const ma7Up = cur.ma7 > prev.ma7;
  let code;
  if (cur.c > cur.ma7 && cur.ma7 > cur.ma25) code = STATE.BULL_ALIGN;
  else if (cur.c > cur.ma7) code = STATE.BULL;
  else if (cur.c < cur.ma7 && cur.ma7 > cur.ma25) code = STATE.WEAK;
  else if (cur.c < cur.ma7 && cur.ma7 <= cur.ma25) code = STATE.BEAR_ALIGN;
  else code = STATE.NEUTRAL;

  const crossUp7In = findCrossUp(series, ind.ma7, idx, 20);
  const crossUpEma7In = findCrossUp(series, ind.ema7, idx, 20);
  const crossDown7In = findCrossDown(series, ind.ma7, idx, 20);
  // 盯盘触发用：最近一次「从至少一条均线下方回到两条均线上方」发生在几根前
  const aboveBothCrossIn = findAboveBothCross(series, ind, idx, 20);
  const pb = findPullback(series, ind.ma7, idx, 20, cfg.pullbackTolerance);
  // 回踩形态「两根阴K不破均线」+ 触发「收盘同时站上 MA7 与 EMA7」
  const twoBear = findTwoBearHold(series, ind, idx, cfg.pullbackBars ?? 2);
  const aboveBoth = cur.ema7 != null && cur.c > cur.ma7 && cur.c > cur.ema7;
  // 盯盘用：连续 N 根收盘不破均线（不要求阴K）+ 收盘同时跌破两条均线
  const holdMa = findTwoBearHold(series, ind, idx, cfg.pullbackBars ?? 2, false) !== null;
  // 盯盘专用：按 watchMinBars / watchPullbackAge 计算回踩结构（见 pullbackStructure）
  // 独立提醒用：按 dualBars 计算的双阴 / 双阳形态
  const twoBearD = dualPattern(series, ind, idx, cfg, 1);
  const twoBullD = dualPattern(series, ind, idx, cfg, -1);
  const candleT = series.t[idx];

  // 盯盘通道（1时/2时 MACD + 站上均线）不看这些字段了；
  // MACD 与「最近高点几根」在 evaluateSymbol 里按级别现算（只算 1时/2时，省开销）。
  const belowBoth = cur.ema7 != null && cur.c < cur.ma7 && cur.c < cur.ema7;

  // —— 缠论背驰（只在启用过滤时才算，避免无谓开销） ——
  let chanState = null;
  if (cfg.filterBeichi) {
    chanState = series.beichiState(idx, {
      minBars: cfg.beichiMinBars ?? 5,
      ratio: cfg.beichiRatio ?? 1.0,
      minProgress: cfg.beichiMinProgress ?? 0.3,
    });
  }
  // —— 笔状态（只在「回踩成笔链」启用时才算；盯盘通道已改成连续走低口径，不再需要笔）——
  let stroke = null;
  if (cfg.requireStrokeChain) stroke = series.strokeInfo(idx, cfg.beichiMinBars ?? 5);

  return {
    key: series.key,
    code,
    close: cur.c,
    ma7: cur.ma7, ma25: cur.ma25, ma99: cur.ma99,
    ema7: cur.ema7, ema25: cur.ema25,
    ma7Up,
    above7: cur.c > cur.ma7,
    aboveEma7: cur.ema7 != null ? cur.c > cur.ema7 : null,
    bull: cur.c > cur.ma7 && cur.ma7 > cur.ma25,
    bullAlign: cur.c > cur.ma7 && cur.ma7 > cur.ma25 && ma7Up,
    bearAlign: cur.c < cur.ma7 && cur.ma7 < cur.ma25,
    crossUp7In,
    crossUpEma7In,
    crossDown7In,
    aboveBothCrossIn,
    pullbackIn: pb ? pb.bars : null,
    twoBear, aboveBoth, holdMa, belowBoth, barIdx: idx,
    twoBearD, twoBullD, candleT,
    live: mode === 'live',
    strokeOk: !!(stroke && stroke.down && stroke.down.bars >= 4),
    strokeBars: stroke?.down?.bars ?? null,
    twoBearBars: twoBear ? twoBear.bars : null,
    twoBearDepth: twoBear ? twoBear.depth : null,
    pullbackDepth: pb ? pb.depth : null,
    distMa7Pct: ((cur.c - cur.ma7) / cur.ma7) * 100,
    distEma7Pct: cur.ema7 ? ((cur.c - cur.ema7) / cur.ema7) * 100 : null,
    volRatio: cur.volMa20 ? cur.v / cur.volMa20 : null,
    candleT: cur.t,
    candleDone: cur.done,
    ts: cur.t + series.ms,
    chanState,
    stroke,
  };
}

/** 级别事件码（前端色块上的小标记） */
function eventOf(lv, cfg) {
  if (!lv) return EVENT.NONE;
  const cross = lv.crossUp7In != null && lv.crossUp7In <= cfg.triggerLookback;
  const pb = lv.pullbackIn != null && lv.pullbackIn <= cfg.pullbackLookback;
  if (cross && pb) return EVENT.PULLBACK_CROSS;
  if (cross) return EVENT.CROSS_UP;
  if (pb) return EVENT.PULLBACK;
  if (lv.crossDown7In != null && lv.crossDown7In <= 3) return EVENT.CROSS_DOWN;
  return EVENT.NONE;
}

function countBull(views, cfg) {
  let c = 0;
  for (const k of LEVEL_KEYS) {
    const v = views[k];
    if (!v) continue;
    if (cfg.countRule === 'above' ? v.bull : v.bullAlign) c++;
  }
  return c;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 「笔延续链」——从基准级别到确认级别之间（不含确认级别）的全部级别。
 *
 * 例：5m>30m>3h → 5m、10m、15m；3m>15m>2h → 3m、5m、10m；2m>10m>1h → 2m、3m、5m。
 * 含义：一个能撑起 30分 级别延续的回调，必须深/长到让 **5分、10分、15分全部成笔**。
 * 只让最小级别成笔的浅回调，撑不起大级别的延续。
 */
export function strokeChain(baseIdx, midIdx) {
  const out = [];
  for (let i = baseIdx; i < midIdx; i++) out.push(LEVELS[i].key);
  return out;
}

/**
 * 判断「回踩成笔链」是否成立。
 * @returns {{ok:boolean, need:string[], got:string[], missing:string[], topT:number|null, level:string|null}}
 *   topT  = 基准级别最近一个已确认顶分型的时间（回调的起点）
 *   level = **笔延续级别**：从基准级别连续成笔能到达的最高级别
 */
export function checkStrokeChain(views, baseIdx, midIdx, cfg) {
  const need = strokeChain(baseIdx, midIdx);
  const base = views[LEVELS[baseIdx].key];
  // 锚点用「基准级别最近一个**向下笔的起点**」，而不是「最近一个已确认顶分型」：
  // 突破之后若再形成新的顶分型，后者会往后移，导致基准级别自己反而判不过。
  // 向下笔起点一旦这支笔完成就不再变化，是稳定的回调起点。
  const topT = base?.stroke?.down?.topT ?? base?.stroke?.top?.t ?? null;
  const got = [], missing = [];
  let level = null;
  let contiguous = true;
  for (const key of need) {
    const v = views[key];
    const down = v?.stroke?.down;
    // 「在基准级别回调起点之后完成过向下笔」才算这个级别被这波回调带动成笔
    const hit = !!(down && topT != null && down.botT > topT);
    const aboveOk = cfg.chainRequireAboveMa ? !!v?.above7 : true;
    if (hit && aboveOk) {
      got.push(key);
      if (contiguous) level = key;
    } else {
      missing.push(key);
      contiguous = false;
    }
  }
  const ok = topT != null ? missing.length === 0 : false;
  return { ok, need, got, missing, topT, level: ok ? level : (got.length ? level : null) };
}

/**
 * 该级别此刻是否「将要出现背驰笔」。
 * 判定：当前这一笔还没走完，但价格已越过前一同向笔的极值，
 *      而截至当下的 MACD 柱面积已小于前一同向笔 —— 动能衰竭，大概率以背驰收尾。
 */
function isBeichi(v) {
  const st = v?.chanState;
  return !!(st && st.ok && st.divergence && st.divergence.status === 'pending');
}

/**
 * 解析要扫描的「基准 → 确认 → 最大」三元组。
 *  groups 模式：只扫描用户配置的固定组合（允许跨级，如 3分→15分→2时）
 *  auto   模式：基准为 baseMin..baseMax，确认为基准的下一档，最大为任意更高档（兼容旧行为）
 */
let _triCache = null, _triKey = '';
export function triplesFor(cfg) {
  const key = cfg.scanMode + '|' + JSON.stringify(cfg.groups ?? []) + '|' + cfg.baseMinIdx + '|' + cfg.baseMaxIdx;
  if (key === _triKey && _triCache) return _triCache;
  const out = [];
  if (cfg.scanMode !== 'auto') {
    for (const g of cfg.groups ?? []) {
      if (!g || g.enabled === false) continue;
      const b = LEVEL_INDEX[g.base], m = LEVEL_INDEX[g.mid], k = LEVEL_INDEX[g.big];
      if (b == null || m == null || k == null) continue;
      if (!(b < m && m < k)) continue;             // 必须是 基准 < 确认 < 最大
      if (out.some(t => t.b === b && t.m === m && t.k === k)) continue;
      out.push({ b, m, k });
    }
    if (out.length) { _triKey = key; _triCache = out; return out; }
    // 用户把所有组合都停用了 → 不出信号（不静默回退到穷举）
    _triKey = key; _triCache = out; return out;
  }
  const bStart = Math.max(0, cfg.baseMinIdx ?? 0);
  const bEnd = Math.min(cfg.baseMaxIdx ?? LEVELS.length - 3, LEVELS.length - 3);
  for (let b = bStart; b <= bEnd; b++) {
    for (let k = b + 2; k < LEVELS.length; k++) out.push({ b, m: b + 1, k });
  }
  _triKey = key; _triCache = out;
  return out;
}

/**
 * 扫描配置的全部 (基准, 确认, 最大) 三元组，返回按评分降序的命中列表。
 */
export function findResonance(views, cfg, mode) {
  const bullCount = countBull(views, cfg);
  if (bullCount < cfg.minBullLevels) return { bullCount, matches: [], beichiBlocked: 0, strokeBlocked: 0 };

  const matches = [];
  let beichiBlocked = 0;
  let strokeBlocked = 0;
  for (const { b, m: midIdx, k: bigIdx } of triplesFor(cfg)) {
    const baseLv = LEVELS[b], midLv = LEVELS[midIdx], bigLv = LEVELS[bigIdx];
    const base = views[baseLv.key];
    if (!base) continue;

    // —— 基准级别触发条件 ——
    if (cfg.requireBaseBull && !base.bull) continue;
    if (cfg.requireEma7 && base.aboveEma7 !== true) continue;

    // 这里有两种「回踩形态」，二选一：
    //
    //  touch（默认旧行为）：价格回踩到**最低价触及 MA7**，收盘站住 → 之后才发生「上穿 MA7」事件
    //
    //  twoBearHold：**两根阴K下跌，但收盘始终没有跌破 MA7 与 EMA7**（影线允许插破），
    //               随后当前K线收盘同时站上两条均线即触发。
    //               这是「极浅回调 + 抛压枯竭」＝ 跌无可跌的形态；因为价格压根没离开均线上方，
    //               所以不存在「上穿 MA7」这个事件，触发条件改用「收盘同时站上两条均线」。
    if (cfg.pullbackPattern === 'twoBearHold') {
      if (!base.twoBear) continue;
      if (!base.aboveBoth) continue;
    } else {
      if (base.pullbackIn == null || base.pullbackIn > cfg.pullbackLookback) continue;
      if (base.crossUp7In == null || base.crossUp7In > cfg.triggerLookback) continue;
      // 上穿必须发生在回踩之后（或同一根K线）
      if (base.pullbackIn < base.crossUp7In) continue;
    }

    const mid = views[midLv.key];
    if (!mid) continue;
    if (!mid.bull) continue;

    // —— 确认级别上穿 ——
    if (cfg.requireAdjacentCross) {
      if (mid.crossUp7In == null || mid.crossUp7In > cfg.adjacentLookback) continue;
    }

    // —— 缠论背驰过滤：确认级别「将要出现背驰笔」→ 判定上涨衰竭，放弃本组信号 ——
    if (cfg.filterBeichi) {
      const scope = cfg.beichiScope ?? 'mid';
      if (isBeichi(mid) || (scope === 'mid+big' && isBeichi(views[bigLv.key]))) { beichiBlocked++; continue; }
    }

    // —— 回踩成笔链：基准 → 确认级别之间的所有级别都必须被这波回调带动成笔 ——
    let chain = null;
    if (cfg.requireStrokeChain) {
      chain = checkStrokeChain(views, b, midIdx, cfg);
      if (!chain.ok) { strokeBlocked++; continue; }
    }

    // —— 最大级别不得跌破均线 ——
    {
      const big = views[bigLv.key];
      if (!big) continue;
      const line = cfg.bigMa === 'ema7' ? big.ema7 : big.ma7;
      if (line == null) continue;
      if (big.close < line * (1 + cfg.bigTolerance)) continue;
      if (big.bearAlign) continue;
      if (big.close < big.ma25) continue; // 结构性支撑仍在

      // —— 评分 ——
      const volScore = clamp(((base.volRatio ?? 1) - 1) * 10, 0, 8);
      const bigSlope = big.ma7Up ? 5 : 0;
      const pbQuality = clamp(5 - (base.pullbackDepth ?? 0) * 200, 0, 5);
      let score =
        Math.min(bullCount, 13) * 3 +
        bigIdx * 1.2 +
        Math.max(0, 9 - b) * 1.2 +
        Math.max(0, cfg.adjacentLookback - mid.crossUp7In) * 2 +
        Math.max(0, cfg.triggerLookback - base.crossUp7In) * 3 +
        volScore + bigSlope + pbQuality;
      score = Math.round(clamp(score, 0, 100));

      matches.push({
        symbol: views.__symbol,
        mode,
        confirmed: mode === 'closed',
        group: `${baseLv.key}>${midLv.key}>${bigLv.key}`,
        base: baseLv.key,
        baseIdx: b,
        mid: midLv.key,
        midIdx,
        big: bigLv.key,
        bigIdx,
        bullCount,
        score,
        // 笔延续链信息（供界面展示「笔延续级别」）
        strokeChain: chain ? { need: chain.need, got: chain.got, level: chain.level, topT: chain.topT } : null,
        price: base.close,
        baseClose: base.close,
        baseMa7: base.ma7,
        baseEma7: base.ema7,
        bigLine: line,
        bigLineName: cfg.bigMa,
        distBaseMa7Pct: base.distMa7Pct,
        pullbackBars: base.pullbackIn,
        baseCrossBars: base.crossUp7In,
        midCrossBars: mid.crossUp7In,
        volRatio: base.volRatio,
        candleT: base.candleT,
        ts: Date.now(),
        levels: {
          base: pickLevel(base),
          mid: pickLevel(mid),
          big: pickLevel(big),
        },
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return { bullCount, matches, beichiBlocked, strokeBlocked };
}
/**
 * 盯盘视图（1时/2时 MACD 规则）：MACD 死叉状态 + 自最近高点根数 + 均线位置。
 * live=true 表示这是「正在形成的那根K线」（用于未收盘预警）。
 * @param {object} v analyzeLevel 的结果
 * @param {object} series 该级别的 CandleSeries（取 MACD 与最高价用）
 * @param {object} cfg 配置（MACD 参数、回看根数）
 */
function watchView(v, series, cfg) {
  const i = v.barIdx;
  const m = macdValues(series, i, cfg);
  const macdDead = m ? m.dif < m.dea : null;
  const gold = macdGoldCrossIn(series, i, cfg);
  const nearPct = cfg.watchNearPct ?? 0.3;
  // ⚠ 用户口径：贴近零轴看的是 **MACD 的均线（信号线 DEA）**，不是快线 DIF
  const distPct = (m && v.close > 0) ? Math.abs(m.dea) / v.close * 100 : null;
  const difPct = (m && v.close > 0) ? Math.abs(m.dif) / v.close * 100 : null;
  return {
    key: v.key,
    minutes: (LEVELS[LEVEL_INDEX[v.key]]?.minutes) ?? null,
    barIdx: i,
    dif: m?.dif ?? null,                         // MACD 快线（>0 = 还在零轴上方）
    dea: m?.dea ?? null,
    macdDead,                                    // DIF < DEA
    macdGoldIn: gold,                            // DIF 上穿 DEA 发生在几根前（null = 最近没金叉）
    distPct,                                     // 「离零轴」相对距离：|DEA（MACD均线）| / 收盘价
    difPct,                                      // 快线同样的口径（仅展示）
    nearZero: m != null && distPct != null && m.dea > 0 && distPct <= nearPct,  // MACD均线(DEA) 靠近零轴且未跌破
    aboveZero: m ? m.dea > 0 : null,          // 以 MACD 均线为准
    difAboveZero: m ? m.dif > 0 : null,
    aboveEma7: v.aboveEma7,
    close: v.close, ma7: v.ma7, ma25: v.ma25, ema7: v.ema7,
    above7: v.above7, ma7Up: v.ma7Up, bull: v.bull,
    candleT: v.candleT, live: !!v.live,
  };
}

/** DIF 上穿 DEA 发生在几根前（最近 lookback 根内才算「刚金叉」） */
function macdGoldCrossIn(series, i, cfg) {
  if (!series || i == null || i < 1) return null;
  const m = series.macd(cfg.macdFast ?? 12, cfg.macdSlow ?? 26, cfg.macdSignal ?? 9);
  const lim = cfg.watchConfirmLookback ?? 2;
  for (let k = 0; k <= lim && i - k - 1 >= 0; k++) {
    const a = i - k - 1, b = i - k;
    if (!Number.isFinite(m.dif[a]) || !Number.isFinite(m.dea[a])) break;
    if (m.dif[a] <= m.dea[a] && m.dif[b] > m.dea[b]) return k;
  }
  return null;
}

function macdValues(series, i, cfg) {
  if (!series || i == null || i < 0) return null;
  const m = series.macd(cfg.macdFast ?? 12, cfg.macdSlow ?? 26, cfg.macdSignal ?? 9);
  const d = m.dif[i], e = m.dea[i];
  if (!Number.isFinite(d) || !Number.isFinite(e)) return null;
  return { dif: d, dea: e };
}

function pickLevel(v) {
  return {
    key: v.key, code: v.code, close: v.close, ma7: v.ma7, ma25: v.ma25,
    ema7: v.ema7, above7: v.above7, bull: v.bull, ma7Up: v.ma7Up,
    distMa7Pct: v.distMa7Pct, crossUp7In: v.crossUp7In, pullbackIn: v.pullbackIn,
  };
}

/** 生成中文提示文案 */
export function describe(sig) {
  const L = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
  const tag = sig.confirmed ? '已确认' : '预警(未收盘)';
  const chain = sig.strokeChain;
  const chainTxt = chain && chain.need?.length
    ? ` · 回踩已带动 ${chain.need.map(L).join('/')} 全部成笔（笔延续至 ${L(chain.level ?? chain.need[chain.need.length - 1])}）`
    : '';
  return `${L(sig.base)}回踩后上穿MA7/EMA7，${L(sig.mid)}同步上穿均线，${L(sig.big)}站稳${sig.bigLineName === 'ema7' ? 'EMA7' : 'MA7'}不破`
    + `${chainTxt} · ${sig.bullCount}个级别多头排列 · [${tag}]`;
}

/** 「够笔」计数：某级别从 t0 到现在（不含未收盘那根）一共有几根K线 */
export function barsSince(series, t0) {
  if (!series || !series.t || t0 == null) return null;
  const t = series.t;
  let i = t.length - 1;
  if (i >= 0 && series.done && series.done[i] === false) i--;   // 不含正在形成的那根
  let n = 0;
  for (; i >= 0 && t[i] >= t0; i--) n++;
  return n;
}

/**
 * 对一个币种做完整评估。
 * @returns {{bullCount:number, aboveCount:number, levels:object, best:object|null, matches:object[]}}
 */
export function evaluateSymbol(symbol, seriesMap, cfg, includeLive = true) {
  const closedViews = {};
  const liveViews = {};
  for (const lv of LEVELS) {
    const s = seriesMap[lv.key];
    closedViews[lv.key] = analyzeLevel(s, cfg, 'closed');
    if (includeLive && !s.done[s.t.length - 1]) liveViews[lv.key] = analyzeLevel(s, cfg, 'live');
    else liveViews[lv.key] = closedViews[lv.key];
  }
  closedViews.__symbol = symbol;
  liveViews.__symbol = symbol;

  const closedRes = findResonance(closedViews, cfg, 'closed');
  const liveRes = findResonance(liveViews, cfg, 'live');

  // 已确认信号优先；同一组合若已确认则丢弃对应的预警
  const confirmedKeys = new Set(closedRes.matches.map(m => m.group));
  const matched = [
    ...closedRes.matches,
    ...liveRes.matches.filter(m => !confirmedKeys.has(m.group)),
  ];
  matched.sort((a, b) => b.score - a.score);
  const aboveCount = LEVEL_KEYS.reduce((n, k) => {
    const v = closedViews[k];
    return n + (v && v.above7 ? 1 : 0);
  }, 0);

  const levels = {};
  for (const k of LEVEL_KEYS) {
    const v = closedViews[k];
    if (!v) { levels[k] = { code: STATE.NODATA, event: EVENT.NONE }; continue; }
    levels[k] = {
      code: v.code,
      event: eventOf(v, cfg),
      ma7: v.ma7, ema7: v.ema7, ma25: v.ma25,
      close: v.close,
      distMa7Pct: v.distMa7Pct,
      ma7Up: v.ma7Up,
      volRatio: v.volRatio,
    };
  }

  // 盯盘视图：只取对应表里用到的级别，避免无谓开销
  const watch = {};
  const watchLive = {};
  if (cfg.watchEnabled) {
    const mains = cfg.watchLevels ?? [];
    const subs = Object.values(cfg.watchSubMap ?? {});
    for (const k of new Set([...mains, ...subs])) {
      const v = closedViews[k];
      if (v) watch[k] = watchView(v, seriesMap[k], cfg);
    }
    // 扫描级别 + 次级别：把「正在形成的那根K线」也带上
    //   · 扫描级别 → 预警可以在K线收完之前就发（否则 4时 级别最多要等 4 小时）
    //   · 次级别   → 确认可以提前到金叉/突破发生的那一刻
    for (const k of new Set([...mains, ...subs])) {
      const lv = liveViews[k];
      if (lv) watchLive[k] = watchView(lv, seriesMap[k], cfg);
    }
  }

  // 独立提醒视图：双阴不破 / 双阳不穿
  const dual = {};
  if (cfg.dualEnabled) {
    for (const k of (cfg.dualLevels ?? [])) {
      const v = closedViews[k];
      if (!v) continue;
      dual[k] = {
        bear: v.twoBearD, bull: v.twoBullD,
        close: v.close, ma7: v.ma7, ema7: v.ema7, candleT: v.candleT,
      };
    }
  }

  return {
    symbol,
    watch,
    watchLive,
    dual,
    bullCount: Math.max(closedRes.bullCount, liveRes.bullCount),
    aboveCount,
    levels,
    best: matched[0] ?? null,
    matchCount: matched.length,
    matches: matched.slice(0, 8),
    beichiBlocked: closedRes.beichiBlocked + liveRes.beichiBlocked,
    strokeBlocked: (closedRes.strokeBlocked ?? 0) + (liveRes.strokeBlocked ?? 0),
  };
}

export const defaultSignalConfig = () => ({ ...DEFAULT_SIGNAL });

/** 供回测使用：把 ma7/ma25/ema7 数组与K线一起滑窗评估 */
export function analyzeLevelAtIndex(series, ind, idx, cfg) {
  const n = series.t.length;
  if (idx < 30 || idx >= n) return null;
  const cur = at(series, ind, idx);
  const prev = at(series, ind, idx - 1);
  if (!cur || !prev || cur.ma7 == null || cur.ma25 == null || prev.ma7 == null) return null;
  const ma7Up = cur.ma7 > prev.ma7;
  let code;
  if (cur.c > cur.ma7 && cur.ma7 > cur.ma25) code = STATE.BULL_ALIGN;
  else if (cur.c > cur.ma7) code = STATE.BULL;
  else if (cur.c < cur.ma7 && cur.ma7 > cur.ma25) code = STATE.WEAK;
  else if (cur.c < cur.ma7 && cur.ma7 <= cur.ma25) code = STATE.BEAR_ALIGN;
  else code = STATE.NEUTRAL;
  const pb = findPullback(series, ind.ma7, idx, 20, cfg.pullbackTolerance);
  const twoBear = findTwoBearHold(series, ind, idx, cfg.pullbackBars ?? 2);
  const aboveBoth = cur.ema7 != null && cur.c > cur.ma7 && cur.c > cur.ema7;
  // 盯盘用：连续 N 根收盘不破均线（不要求阴K）+ 收盘同时跌破两条均线
  const holdMa = findTwoBearHold(series, ind, idx, cfg.pullbackBars ?? 2, false) !== null;
  // 盯盘专用：按 watchMinBars / watchPullbackAge 计算回踩结构（见 pullbackStructure）
  // 独立提醒用：按 dualBars 计算的双阴 / 双阳形态
  const twoBearD = dualPattern(series, ind, idx, cfg, 1);
  const twoBullD = dualPattern(series, ind, idx, cfg, -1);
  const candleT = series.t[idx];

  // 盯盘通道（1时/2时 MACD + 站上均线）不看这些字段了；
  // MACD 与「最近高点几根」在 evaluateSymbol 里按级别现算（只算 1时/2时，省开销）。
  const belowBoth = cur.ema7 != null && cur.c < cur.ma7 && cur.c < cur.ema7;
  let chanState = null;
  if (cfg.filterBeichi) {
    chanState = series.beichiState(idx, {
      minBars: cfg.beichiMinBars ?? 5,
      ratio: cfg.beichiRatio ?? 1.0,
      minProgress: cfg.beichiMinProgress ?? 0.3,
    });
  }
  // —— 笔状态（只在「回踩成笔链」启用时才算；盯盘通道已改成连续走低口径，不再需要笔）——
  let stroke = null;
  if (cfg.requireStrokeChain) stroke = series.strokeInfo(idx, cfg.beichiMinBars ?? 5);
  return {
    key: series.key, code, close: cur.c, ma7: cur.ma7, ma25: cur.ma25, ema7: cur.ema7,
    ma7Up,
    above7: cur.c > cur.ma7,
    aboveEma7: cur.ema7 != null ? cur.c > cur.ema7 : null,
    bull: cur.c > cur.ma7 && cur.ma7 > cur.ma25,
    bullAlign: cur.c > cur.ma7 && cur.ma7 > cur.ma25 && ma7Up,
    bearAlign: cur.c < cur.ma7 && cur.ma7 < cur.ma25,
    crossUp7In: findCrossUp(series, ind.ma7, idx, 20),
    crossUpEma7In: findCrossUp(series, ind.ema7, idx, 20),
    aboveBothCrossIn: findAboveBothCross(series, ind, idx, 20),
    crossDown7In: findCrossDown(series, ind.ma7, idx, 20),
    pullbackIn: pb ? pb.bars : null,
    twoBear, aboveBoth, holdMa, belowBoth, barIdx: idx,
    twoBearD, twoBullD, candleT,
    live: false,
    strokeOk: !!(stroke && stroke.down && stroke.down.bars >= 4),
    strokeBars: stroke?.down?.bars ?? null,
    twoBearBars: twoBear ? twoBear.bars : null,
    twoBearDepth: twoBear ? twoBear.depth : null,
    pullbackDepth: pb ? pb.depth : null,
    distMa7Pct: ((cur.c - cur.ma7) / cur.ma7) * 100,
    volRatio: cur.volMa20 ? cur.v / cur.volMa20 : null,
    candleT: cur.t,
    candleDone: true,
    ts: cur.t,
    chanState,
    stroke,
  };
}














