/**
 * 主级别浅回调 · 次级别回踩结构（用户 2026-10-17）
 *
 * 用户口径：
 *   「一个主级别 可能回调一根阴线或者十字星，但是次级别死叉回踩 五根以上的K线（阴阳不限），
 *     内部结构够笔，然后这个次级别底分型站上，主级别不能跌破均线 —— 这是做多。
 *     反之做空也是相反。」
 *
 * 做多（dir='long'）：
 *   主级别 M：
 *     ① 最后一根收盘是**阴线或十字星**（浅回调：只回调一根）
 *     ② 收盘**不跌破均线**（默认 MA7；可要求同时站上 MA7 与 EMA7）
 *   次级别 S：
 *     ③ 从最近一次 **MACD 死叉** 开始的回踩，已走 **≥ minBars(5) 根**（阴阳不限）
 *     ④ 回踩段的**笔数 ≥ minStrokes(3)**（内部结构够笔，用缠论端点）
 *     ⑤ 回踩段最低点出现**底分型**，且最新收盘**站上**该底分型的确认根收盘
 *   触发：⑤ 成立的那一根收盘 → 提醒
 *
 * 做空（dir='short'）完全镜像：阳线/十字星 + 跌破均线 + 金叉后的上涨 ≥5 根 + 顶分型 + 收盘跌回其下。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { macdCrosses } from './wave.js';
import { isBottomFractal } from './fractal.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;
const fmtClock = ms => (Number.isFinite(ms)
  ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');

/** 视图：K线 + MA7/EMA7 + MACD + 缠论端点 + 已收盘根数 */
export function pbView(series, key, chanMinBars = 5) {
  if (!series || !series.t || series.t.length < 10) return null;
  let ind = null, macd = null, pts = null;
  try {
    ind = series.ensure();
    macd = series.macd();
    pts = series.ensureChan(chanMinBars)?.pts ?? null;
  } catch { /* 指标未就绪 */ }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    ma7: ind?.ma7 ?? null, ema7: ind?.ema7 ?? null,
    dif: macd?.dif ?? null, dea: macd?.dea ?? null,
    closed: series.closedCount,
    pts,
  };
}

const isTop = p => p.type === 'top' || p.type === '顶' || p.type === 'T';
const pivotIdx = p => (p.origIdx ?? p.mi);
const pivotT = (v, p) => v.t[Math.min(pivotIdx(p), v.t.length - 1)] + v.ms;

/**
 * 判定一组（主级别 + 次级别）
 * @returns {null|object}
 */
export function detectPullback(main, sub, opt = {}) {
  const dir = opt.dir ?? 'long';
  const long = dir === 'long';
  const minBars = opt.minBars ?? 5;            // 次级别回踩至少几根
  const minStrokes = opt.minStrokes ?? 3;      // 回踩段至少几笔
  const dojiPct = opt.dojiPct ?? 0.15;         // 十字星定义：实体 ≤ 此百分比
  const needBothMa = opt.needBothMa === true;  // 是否要求同时站上 MA7+EMA7
  if (!main || !sub) return null;

  const mLen = Number.isFinite(main.closed) ? Math.min(main.closed, main.t.length) : main.t.length;
  if (mLen < 3) return null;
  const mLast = mLen - 1;
  const mO = main.o[mLast], mC = main.c[mLast];
  if (!Number.isFinite(mO) || !Number.isFinite(mC)) return null;

  // ① 主级别：一根阴线或十字星（浅回调）
  const body = Math.abs(mC - mO) / mC * 100;
  const isDoji = body <= dojiPct;
  const isShallowBar = long ? (mC <= mO || isDoji) : (mC >= mO || isDoji);
  if (!isShallowBar) { if (opt.dbg) opt.dbg.push('主级别不是阴线/十字星'); return null; }

  // ② 主级别不跌破均线
  const ma7 = numAt(main.ma7, mLast), ema7 = numAt(main.ema7, mLast);
  if (needBothMa) {
    if (!(Number.isFinite(ma7) && Number.isFinite(ema7))) return null;
    if (long ? !(mC > ma7 && mC > ema7) : !(mC < ma7 && mC < ema7)) return null;
  } else {
    if (Number.isFinite(ma7) && (long ? mC <= ma7 : mC >= ma7)) { if (opt.dbg) opt.dbg.push('主级别跌破/站上均线'); return null; }
  }

  // ③ 次级别：最近的死叉（做多）/ 金叉（做空）之后的回踩
  const sLen = Number.isFinite(sub.closed) ? Math.min(sub.closed, sub.t.length) : sub.t.length;
  if (sLen < minBars + 2) return null;
  const all = macdCrosses(sub).filter(x => x.k < sLen);
  const wantType = long ? 'D' : 'G';
  let crossIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].type === wantType) {
      // 找"仍处于该方向"的最近一次：之后不能出现反向交叉
      const after = all.slice(i + 1).some(x => x.type !== wantType && x.k > all[i].k);
      if (!after) { crossIdx = all[i].k; break; }
    }
  }
  if (crossIdx < 0) { if (opt.dbg) opt.dbg.push('没有符合条件的死叉/金叉'); return null; }
  const pullBars = sLen - crossIdx;                 // 回踩已走几根
  if (pullBars < minBars) { if (opt.dbg) opt.dbg.push('回踩不足 minBars'); return null; }

  // ④ 回踩段的笔数够不够
  const pts = (sub.pts ?? []).filter(p => Number.isInteger(p.confirmIdx) && p.confirmIdx < sLen);
  const segPts = pts.filter(p => pivotT(sub, p) >= sub.t[crossIdx]);
  const segStrokes = Math.max(0, segPts.length - 1);

  // ⑤ 回踩段最低点（做多）/ 最高点（做空）出现分型 + 收盘站上/跌回
  let extIdx = crossIdx;
  for (let k = crossIdx; k < sLen; k++) {
    if (long ? sub.l[k] < sub.l[extIdx] : sub.h[k] > sub.h[extIdx]) extIdx = k;
  }
  if (extIdx < 1 || extIdx + 1 > sLen - 1) { if (opt.dbg) opt.dbg.push('极值位置不合法'); return null; }
  const fresh = opt.freshBars ?? 1;
  const confIdx = extIdx + 1;
  if ((sLen - 1) - confIdx > fresh) { if (opt.dbg) opt.dbg.push('分型确认太早（超出 fresh 窗口）'); return null; }    // 只在分型刚确认那几根内报

  const fractalOk = long
    ? isBottomFractal(sub, extIdx, opt.fractalType ?? 'any')
    : isTopFractal(sub, extIdx);
  if (!fractalOk) { if (opt.dbg) opt.dbg.push('极值处不是分型'); return null; }

  const sLast = sLen - 1;
  const sClose = sub.c[sLast];
  const confClose = sub.c[confIdx];
  // 站上：做多要求最新收盘 ≥ 分型确认根收盘；做空反之
  if (long ? !(sClose >= confClose) : !(sClose <= confClose)) { if (opt.dbg) opt.dbg.push('收盘没站上确认根收盘'); return null; }

  // 笔数不够 → 不算（内部结构够笔）
  if (segStrokes < minStrokes) { if (opt.dbg) opt.dbg.push('笔数不足'); return null; }

  return {
    dir, level: main.key, subKey: sub.key,
    mainBarT: main.t[mLast], mainO: mO, mainC: mC, isDoji, body,
    ma7, ema7,
    crossIdx, crossT: sub.t[crossIdx] + sub.ms,
    pullBars, segStrokes,
    lowIdx: extIdx, low: long ? sub.l[extIdx] : sub.h[extIdx],
    lowT: sub.t[extIdx],
    confIdx, confT: sub.t[confIdx] + sub.ms, confClose,
    subClose: sClose, subLastT: sub.t[sLast] + sub.ms,
    strokes: segStrokes,
  };
}

function isTopFractal(v, idx) {
  if (idx < 1 || idx + 1 >= v.t.length) return false;
  return v.h[idx] > v.h[idx - 1] && v.h[idx] > v.h[idx + 1];
}

/** 组装报警 */
export function makePullbackAlert(symbol, hit, now, initial = false) {
  const M = label(hit.level), S = label(hit.subKey);
  const long = hit.dir === 'long';
  return {
    kind: 'pullback',
    id: 0,
    symbol,
    mode: 'closed',
    stage: long ? 'pullback-long' : 'pullback-short',
    confirmed: true,
    side: long ? 'long' : 'short',
    level: hit.level,
    levelLabel: M,
    subLevel: hit.subKey, subLevelLabel: S,
    group: `${M} 浅回调 → ${S} 回踩${hit.segStrokes}笔 → 分型站上 · ${long ? '做多' : '做空'}`,
    base: hit.level, mid: hit.subKey, big: null,
    score: 85,
    price: hit.subClose,
    candleT: hit.lowT,
    at: now,
    ts: now,
    initial: !!initial,
    closeT: hit.subLastT,
    lowBarT: hit.lowT,
    barT: hit.confT,
    pbPullBars: hit.pullBars,
    pbStrokes: hit.segStrokes,
    pbCrossT: hit.crossT,
    pbLow: hit.low,
    pbMainC: hit.mainC,
    pbIsDoji: hit.isDoji,
    pbMa7: Number.isFinite(hit.ma7) ? hit.ma7 : null,
    text: `【${M}浅回调 · ${S}回踩结构 · ${long ? '做多' : '做空'}】`
      + `${M} 最后一根${hit.isDoji ? '十字星' : long ? '阴线' : '阳线'}（收 ${fmt(hit.mainC)}，实体 ${hit.body.toFixed(2)}%），`
      + `${Number.isFinite(hit.ma7) ? `收盘 ${long ? '未跌破' : '未站上'}均线 MA7 ${fmt(hit.ma7)}；` : ''}`
      + `${S} 从 ${fmtClock(hit.crossT)} 的 MACD ${long ? '死叉' : '金叉'}开始回踩 ${hit.pullBars} 根（≥${5}），`
      + `内部 ${hit.segStrokes} 笔（≥3）；`
      + `${long ? '底' : '顶'}分型在 ${fmtClock(hit.lowT)} 成立（${fmt(hit.low)}），`
      + `收盘 ${fmt(hit.subClose)} ${long ? '站上' : '跌回'}确认根收盘 ${fmt(hit.confClose)} → 结构成立`,
  };
}

/** 一次扫描：配置的每一组级别对各判一次 */
export function scanPullbacks(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  if (!cfg.pbEnabled) return out;
  const pairs = cfg.pbPairs ?? [{ main: '10m', sub: '3m' }];
  const dirs = cfg.pbDirs ?? ['long'];
  for (const pair of pairs) {
    for (const dir of dirs) {
      const main = pbView(seriesMap[pair.main], pair.main, cfg.pbChanMinBars ?? 5);
      const sub = pbView(seriesMap[pair.sub], pair.sub, cfg.pbChanMinBars ?? 5);
      const hit = detectPullback(main, sub, {
        dir,
        minBars: cfg.pbMinBars ?? 5,
        minStrokes: cfg.pbMinStrokes ?? 3,
        dojiPct: cfg.pbDojiPct ?? 0.15,
        needBothMa: cfg.pbNeedBothMa === true,
        freshBars: initial ? (cfg.pbInitFreshBars ?? 2) : (cfg.pbFreshBars ?? 0),
        fractalType: cfg.pbFractalType ?? 'any',
      });
      if (!hit) continue;
      const k = `${symbol}|${pair.main}|${pair.sub}|${dir}|${hit.lowT}|${hit.confT}`;
      if (seen.has(k)) continue;
      seen.set(k, now);
      out.push(makePullbackAlert(symbol, hit, now, initial));
    }
  }
  return out;
}
