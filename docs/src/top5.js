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
import { alertTiming } from './alert-timing.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');

/** 视图：K线（含开盘价）+ MA7/EMA7 + 已收盘根数 */
export function top5View(series, key) {
  if (!series || !series.t || series.t.length < 6) return null;   // 五根形态最少要 5 根，留 1 根余量
  let ind = null;
  try { ind = series.ensure(); } catch { ind = null; }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    ma7: ind?.ma7 ?? null, ema7: ind?.ema7 ?? null,
    closed: series.closedCount,
  };
}

/** 安全取值：ma7/ema7 是 Float64Array 等**定型数组**，不能用 Array.isArray 判断 */
const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;

/**
 * 「反包」实体盖住前一根实体。
 *   dir='top'    → 阳包阴（本根收阳，收盘 ≥ 前开、开盘 ≤ 前收）
 *   dir='bottom' → 阴包阳（本根收阴，收盘 ≤ 前开、开盘 ≥ 前收）
 */
export function isEngulf(v, i, strict = true, dir = 'top') {
  if (i < 1) return false;
  if (dir === 'bottom') {
    if (!(v.c[i] < v.o[i])) return false;                // 本根收阴
    if (v.c[i] > v.o[i - 1]) return false;               // 收盘必须跌破前一根开盘
    if (strict && v.o[i] < v.c[i - 1]) return false;     // 严格口径：开盘也不低于前一根收盘
    return true;
  }
  if (!(v.c[i] > v.o[i])) return false;                  // 本根收阳
  if (v.c[i] < v.o[i - 1]) return false;
  if (strict && v.o[i] > v.c[i - 1]) return false;
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
  const lookback = opt.lookback ?? 20;       // 极值点在最近几根里找
  const strictEngulf = opt.strictEngulf !== false;
  const dir = opt.dir ?? 'top';              // 'top' 顶部结构 | 'bottom' 底部结构（完全镜像）
  const bot = dir === 'bottom';
  // 用户 2026-10-15 追加：顶/底分型的确认**再加一条均线条件**，且**收盘成立才算**（不提前提醒）
  //   底部：收盘同时**站上** EMA7 与 MA7 ；顶部：收盘同时**跌破** EMA7 与 MA7
  const needMa = opt.needMa !== false;
  const allowWarn = opt.allowWarn === true;  // 默认 false → 不再提前预警，只报确认
  if (!v) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < minBars) return null;                        // 至少要有 5 根（第5根收完即可预警）

  // ① 第1根：顶部取"最近 lookback 根里的最高"；底部取"最低"
  const from = Math.max(0, n - lookback);
  let i1 = from;
  for (let k = from; k < n; k++) {
    if (bot ? v.l[k] < v.l[i1] : v.h[k] > v.h[i1]) i1 = k;
  }
  const i2 = i1 + 1, i3 = i1 + 2, i4 = i1 + 3, i5 = i1 + 4;
  if (i5 > n - 1) return null;                        // 第5根还没收盘

  // 前五根形态（底部结构为完全镜像：高点↔低点）
  if (bot) {
    if (!(v.l[i2] >= v.l[i1])) return null;           // 第2根不创新低
    if (!(v.l[i3] >= v.l[i1])) return null;           // 第3根不低于第1根
    if (!(v.l[i4] >= v.l[i2])) return null;           // 第4根不低于第2根
    const hi4 = Math.max(v.h[i1], v.h[i2], v.h[i3], v.h[i4]);
    if (!(v.h[i5] > hi4)) return null;                // 第5根高于前四根（创新高）
  } else {
    if (!(v.h[i2] <= v.h[i1])) return null;           // 第2根不创新高
    if (!(v.h[i3] <= v.h[i1])) return null;           // 第3根不超第1根
    if (!(v.h[i4] <= v.h[i2])) return null;           // 第4根不超第2根
    const low4 = Math.min(v.l[i1], v.l[i2], v.l[i3], v.l[i4]);
    if (!(v.l[i5] < low4)) return null;               // 第5根低于前四根
  }

  // ② 结构失效：顶部=价格重新站上第1根高点；底部=重新跌破第1根低点
  const li = n - 1;                                   // 最新收盘那根
  for (let k = i5 + 1; k <= li; k++) {
    if (bot ? v.l[k] < v.l[i1] : v.h[k] > v.h[i1]) return null;
  }

  // 当前这根相对"前面所有根"是否创新极值
  let extPrev = bot ? -Infinity : Infinity;
  for (let k = i1; k < li; k++) {
    if (bot ? v.h[k] > extPrev : v.l[k] < extPrev) extPrev = bot ? v.h[k] : v.l[k];
  }
  // 反转点：从第5根起，第一根满足「创新极值 + 反向收盘」或「反向包住前一根」的K线
  let revIdx = -1;
  for (let k = i5; k <= li; k++) {
    let ext = bot ? -Infinity : Infinity;
    for (let j = i1; j < k; j++) {
      if (bot ? v.h[j] > ext : v.l[j] < ext) ext = bot ? v.h[j] : v.l[j];
    }
    const newExt = bot ? v.h[k] > ext : v.l[k] < ext;
    const revert = bot ? v.c[k] < v.o[k] : v.c[k] > v.o[k];
    if ((newExt && revert) || isEngulf(v, k, strictEngulf, dir)) { revIdx = k; break; }
  }
  if (revIdx < 0 && !allowWarn) return null;           // 确认模式必须已有反转点；预警模式不需要
  const isNewExt = bot ? v.h[li] > extPrev : v.l[li] < extPrev;
  const ma7 = numAt(v.ma7, li);
  const ema7 = numAt(v.ema7, li);
  const close = v.c[li];
  const maOk = !needMa ? true
    : (Number.isFinite(ma7) && Number.isFinite(ema7)
      && (bot ? (close < ma7 && close < ema7) : (close > ma7 && close > ema7)));

  let stage = null, reason = null, confT = null, confIdxOut = li;
  if (!allowWarn) {
    // ★ 用户口径（不提前提醒）：反转点出现后，**等到某一根收盘站上/跌破两条均线**才确认；
    //   且只在"站上均线的那一根"报一次（之后 confIdx 不再是最后一根 → 不重复报）。
    let confIdx = -1;
    if (needMa) {
      for (let k = revIdx; k <= li; k++) {
        const m = numAt(v.ma7, k), e = numAt(v.ema7, k);
        if (m === null || e === null) continue;
        if (bot ? (v.c[k] < m && v.c[k] < e) : (v.c[k] > m && v.c[k] > e)) { confIdx = k; break; }
      }
    } else {
      confIdx = revIdx;                                 // 关掉均线条件 → 反转点那根就报
    }
    const freshBars = opt.freshBars ?? 0;                // 允许确认发生在最近几根内（启动补报用）
    if (confIdx < 0 || (li - confIdx) > freshBars) return null;
    stage = 'confirmed';
    reason = needMa ? 'ma-reclaim' : 'ext-revert';
    confT = v.t[confIdx];
    confIdxOut = confIdx;
  } else {
    const patternOk = (isNewExt && (bot ? v.c[li] < v.o[li] : v.c[li] > v.o[li])) || isEngulf(v, li, strictEngulf, dir);
    if (patternOk && maOk) { stage = 'confirmed'; reason = 'ext-revert'; }
    else if (li === i5) { stage = 'warning'; reason = 'bar5'; }
    else if (!isNewExt) { stage = 'warning'; reason = 'no-new-ext'; }
  }
  if (!stage) return null;

  return {
    level: v.key,
    dir,
    highT: v.t[i1], high: v.h[i1],
    lowT: v.t[i1], low: v.l[i1],
    h2: v.h[i2], h3: v.h[i3], h4: v.h[i4],
    low1: v.l[i1], low2: v.l[i2], low3: v.l[i3], low4v: v.l[i4], low5: v.l[i5],
    bars: n - i1,                                    // 第1根之后已走几根
    lastT: v.t[li], lastClose: v.c[li], lastLow: v.l[li], lastHigh: v.h[li], lastOpen: v.o[li],
    prevOpen: v.o[li - 1], prevClose: v.c[li - 1],
    isNewExt, isNewLow: isNewExt && !bot,
    engulf: isEngulf(v, li, strictEngulf, dir),
    revertBar: bot ? v.c[li] < v.o[li] : v.c[li] > v.o[li],
    revIdx, lastRevT: v.t[revIdx], confT, confIdx: confIdxOut,
    // ★ 用户要求：按"当前上穿均线那一根K线"的单根涨幅排序
    barOpen: v.o[confIdxOut], barClose: v.c[confIdxOut], barHigh: v.h[confIdxOut], barLow: v.l[confIdxOut],
    barPrevClose: confIdxOut > 0 ? v.c[confIdxOut - 1] : null,
    barPct: (confIdxOut > 0 && v.c[confIdxOut - 1]) ? (v.c[confIdxOut] - v.c[confIdxOut - 1]) / v.c[confIdxOut - 1] * 100 : null,
    barBodyPct: v.o[confIdxOut] ? (v.c[confIdxOut] - v.o[confIdxOut]) / v.o[confIdxOut] * 100 : null,
    barT: v.t[confIdxOut],
    ma7, ema7, maOk,
    lowReversal: reason === 'ext-revert', reason, stage,
    breakBars: li - i5,                              // 第5根之后又走了几根
  };
}

/** 组装报警（dir: top 顶部结构 / bottom 底部结构；stage: warning 预警 / confirmed 确认） */
export function makeTop5Alert(symbol, hit, now, initial = false) {
  const L = label(hit.level);
  const bot = hit.dir === 'bottom';
  const warn = hit.stage === 'warning';
  const f = fmt;
  const common = bot
    ? `${L} 低点 ${f(hit.low)}（第1根）→ 第2根不创新低 ${f(hit.low2)} → 第3根 ${f(hit.low3)}`
      + ` → 第4根 ${f(hit.low4v)} → 第5根创新高 ${f(hit.lastHigh)}；低点向上已走 ${hit.bars} 根`
    : `${L} 高点 ${f(hit.high)}（第1根）→ 第2根不创新高 ${f(hit.h2)} → 第3根 ${f(hit.h3)}`
      + ` → 第4根 ${f(hit.h4)} → 第5根创新低 ${f(hit.low5)}；高点向下已走 ${hit.bars} 根`;
  const maTxt = (Number.isFinite(hit.ma7) && Number.isFinite(hit.ema7))
    ? `；**收盘 ${f(hit.lastClose)} ${bot ? '跌破' : '站上'} MA7 ${f(hit.ma7)} 与 EMA7 ${f(hit.ema7)}**`
    : '';
  const body = warn
    ? `${common}${hit.breakBars > 0 ? `（第5根后又走 ${hit.breakBars} 根，本根未创${bot ? '新高' : '新低'} ${f(bot ? hit.lastHigh : hit.lastLow)}）` : `（第5根刚创${bot ? '新高' : '新低'}）`}；`
      + `**等${bot ? '阴包阳' : '阳包阴'}确认**（本根收 ${f(hit.lastClose)}）`
    : hit.reason === 'ma-reclaim'
      ? `${common}；反转点在 ${new Date(hit.lastRevT).toLocaleString('zh-CN', { hour12: false })}${maTxt}`
        + ` → **结构收盘确认成立**（均线条件成立，不是三根K线分型的确认时刻）`
      : hit.reason === 'ext-revert'
        ? `${common}；本根**创${bot ? '新高' : '新低'} ${f(bot ? hit.lastHigh : hit.lastLow)} 但收${bot ? '阴' : '阳'}**`
          + `（开 ${f(hit.lastOpen)} → 收 ${f(hit.lastClose)}） → **${bot ? '高点' : '低点'}反包成立（这根就是${bot ? '高点' : '低点'}）**${maTxt}`
        : `${common}；本根**反包（${bot ? '阴包阳' : '阳包阴'}）**：开 ${f(hit.lastOpen)} ${bot ? '≥' : '≤'} 前收 ${f(hit.prevClose)}、`
          + `收 ${f(hit.lastClose)} ${bot ? '≤' : '≥'} 前开 ${f(hit.prevOpen)}${maTxt}`;
  return {
    kind: bot ? 'bot5' : 'top5',
    id: 0,
    symbol,
    mode: warn ? 'live' : 'closed',
    stage: warn ? 'warning' : 'confirmed',
    confirmed: !warn,
    side: bot ? 'long' : 'short',
    level: hit.level,
    levelLabel: L,
    group: `${L} · ${bot ? '底部结构' : '顶部结构'}${warn ? '·预警' : '·反包确认'}`,
    base: hit.level, mid: null, big: null,
    score: 0,
    price: hit.lastClose,
    candleT: hit.lastT,
    ts: now,
    initial: !!initial,
    ...alertTiming((hit.barT ?? hit.lastT) + (LEVELS[LEVEL_INDEX[hit.level]]?.minutes ?? 1) * 60_000, now, initial),
    confirmationKind: 'structure',
    topBars: hit.bars,
    topHigh: hit.high,
    topH2: hit.h2,
    topH4: hit.h4,
    topLow5: hit.low5,
    topStage: hit.stage,
    topEngulf: !!hit.engulf,
    topDir: hit.dir,
    barT: hit.barT ?? null,
    barPct: Number.isFinite(hit.barPct) ? hit.barPct : null,
    barBodyPct: Number.isFinite(hit.barBodyPct) ? hit.barBodyPct : null,
    barOpen: Number.isFinite(hit.barOpen) ? hit.barOpen : null,
    barClose: Number.isFinite(hit.barClose) ? hit.barClose : null,
    text: `【${bot ? '底部结构' : '顶部结构'}·${warn ? '预警' : '反包确认'}】${body}`,
  };
}

/** 一次扫描：按配置的级别，分别扫「顶部结构」与「底部结构」两方向 */
export function scanTop5(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  const dirs = [];
  if (cfg.top5Enabled !== false) dirs.push('top');
  if (cfg.bot5Enabled) dirs.push('bottom');
  if (!dirs.length) return out;
  for (const key of (cfg.top5Levels ?? ['1h'])) {
    const v = top5View(seriesMap[key], key);
    for (const dir of dirs) {
      const hit = detectTop5(v, {
        minBars: cfg.top5WarnBars ?? 5,
        needMa: cfg.top5NeedMa !== false,
        allowWarn: cfg.top5AllowWarn === true,
        freshBars: initial ? (cfg.top5FreshBars ?? 3) : 0,
        lookback: cfg.top5Lookback ?? 20,
        strictEngulf: cfg.top5StrictEngulf !== false,
        dir,
      });
      if (!hit) continue;
      const k = `${symbol}|${key}|${dir}|${hit.highT}|${hit.stage}|${hit.confT ?? hit.lastT}`;
      if (seen.has(k)) continue;
      seen.set(k, now);
      out.push(makeTop5Alert(symbol, hit, now, initial));
    }
  }
  return out;
}
