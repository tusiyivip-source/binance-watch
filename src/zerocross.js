/**
 * 最小级别 · 上穿零轴确认（用户 2026-10-17）
 *   「目前不需要底分型确认，而是最小级别上穿零轴后确认」
 *
 * 口径：
 *   ① 取该标的**最小级别**（自适应阶梯里的 inner：1分/3分/5分/15分 视 L0 而定）
 *   ② 该级别 **DIF 从零轴下方上穿到上方**（dif[k-1] <= 0 && dif[k] > 0）
 *   ③ 上穿发生在最近 freshBars 根内 → 提醒
 *   可选：要求同时 DEA 也在零轴上方（needDea）→ 更严格
 *
 * 报警级别用该标的的基础级别 L0（图上画 L0 的K线），文案里注明最小级别与 DIF 数值。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
const fmtClock = ms => (Number.isFinite(ms)
  ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');
const numAt = (a, i) => (a && i >= 0 && i < a.length && Number.isFinite(a[i])) ? a[i] : null;

/** 视图：K线 + MACD + 均线 */
export function zeroView(series, key) {
  if (!series || !series.t || series.t.length < 30) return null;
  let ind = null, macd = null;
  try { ind = series.ensure(); macd = series.macd(); } catch { return null; }
  return {
    key, ms: series.ms, t: series.t, o: series.o, h: series.h, l: series.l, c: series.c,
    dif: macd?.dif ?? null, dea: macd?.dea ?? null,
    ma7: ind?.ma7 ?? null, ema7: ind?.ema7 ?? null,
    closed: series.closedCount,
  };
}

/**
 * 找"最小级别 DIF 上穿零轴"
 * @returns {null|object}
 */
export function detectZeroCross(v, opt = {}) {
  const freshBars = opt.freshBars ?? 1;
  const needDea = opt.needDea === true;
  const maxAge = opt.maxAgeBars ?? 3;          // 允许上穿发生在最近几根（补载用）
  if (!v || !v.dif) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 30) return null;

  // 从最后往前找最近一次上穿
  let k = -1;
  for (let i = n - 1; i >= Math.max(1, n - 1 - maxAge); i--) {
    const d0 = numAt(v.dif, i - 1), d1 = numAt(v.dif, i);
    if (d0 == null || d1 == null) continue;
    if (d0 <= 0 && d1 > 0) { k = i; break; }
  }
  if (k < 0) return null;
  const age = (n - 1) - k;
  if (age > freshBars) return null;

  const difNow = numAt(v.dif, k);
  const deaNow = numAt(v.dea, k);
  if (needDea && !(Number.isFinite(deaNow) && deaNow > 0)) return null;

  return {
    level: v.key,
    idx: k, t: v.t[k], closeT: v.t[k] + v.ms,
    close: v.c[k], dif: difNow, dea: deaNow,
    prevDif: numAt(v.dif, k - 1),
    age,
    aboveMa: (() => {
      const m = numAt(v.ma7, k), e = numAt(v.ema7, k);
      return (Number.isFinite(m) && Number.isFinite(e)) ? (v.c[k] > m && v.c[k] > e) : null;
    })(),
  };
}

/** 组装报警 */
export function makeZeroAlert(symbol, hit, baseKey, now, initial = false) {
  const Z = label(hit.level), B = baseKey ? label(baseKey) : '-';
  return {
    kind: 'zero',
    id: 0,
    symbol,
    mode: 'closed',
    stage: 'zero-cross',
    confirmed: true,
    side: 'long',
    level: hit.level,          // 报警级别 = 最小级别（图上画它）
    levelLabel: Z,
    baseLevel: baseKey, baseLevelLabel: B,
    group: `${Z} DIF 上穿零轴 · ${B}标的`,
    base: hit.level, mid: null, big: null,
    score: 75,
    price: hit.close,
    candleT: hit.t,
    at: now, ts: now,
    initial: !!initial,
    closeT: hit.closeT,
    barT: hit.t,
    lowBarT: hit.t,
    zeroDif: hit.dif,
    zeroDea: hit.dea,
    zeroPrevDif: hit.prevDif,
    zeroAge: hit.age,
    text: `【${Z} DIF 上穿零轴】DIF ${fmt(hit.prevDif)} → ${fmt(hit.dif)}（DEA ${fmt(hit.dea)}）；`
      + `${fmtClock(hit.closeT)} 收盘确认（${hit.age === 0 ? '当根' : `已过 ${hit.age} 根`}）；`
      + `标的操作级别 ${B}`
      + (hit.aboveMa === true ? ' · 该根已站上 MA7/EMA7' : hit.aboveMa === false ? ' · 仍在均线下方' : ''),
  };
}

/** 一次扫描：只扫该标的的"最小级别"（由自适应阶梯决定） */
export function scanZeroCrosses(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const out = [];
  if (!cfg.zeroEnabled) return out;
  const innerKey = cfg._adaptive?.inner ?? cfg.zeroLevel ?? '1m';
  const baseKey = cfg._adaptive?.base ?? null;
  const v = zeroView(seriesMap[innerKey], innerKey);
  if (!v) return out;

  // 大级别结构：双阴/三阴 回踩不破均线（用户 2026-10-17）
  let big = null;
  if (cfg.zeroBigLevel !== false) {
    const bigKey = cfg._adaptive?.base ?? null;
    const bigV = bigKey ? zeroView(seriesMap[bigKey], bigKey) : null;
    if (bigV) {
      big = bigLevelState(bigV, {
        minYin: cfg.zeroBigYinMin ?? 2,
        needBothMa: cfg.zeroBigNeedBothMa === true,
      });
      big.level = bigKey;
      if (cfg.zeroRequireBigYin && !big.ok) return out;
    }
  }
  const hit = detectZeroCross(v, {
    freshBars: initial ? (cfg.zeroInitFreshBars ?? 2) : (cfg.zeroFreshBars ?? 0),
    needDea: cfg.zeroNeedDea === true,
    maxAgeBars: cfg.zeroMaxAgeBars ?? 3,
  });
  if (!hit) return out;
  const k = `${symbol}|${innerKey}|${hit.t}`;
  if (seen.has(k)) return out;
  seen.set(k, now);
  const a = makeZeroAlert(symbol, hit, baseKey, now, initial);
  if (big) {
    a.bigYinBars = big.yinBars;
    a.bigAboveMa = big.aboveMa;
    a.bigMa7 = big.ma7;
    a.bigEma7 = big.ema7;
    a.bigLevelKey = big.level;
    a.bigOk = big.ok;
    const bl = label(big.level ?? '');
    const yinTxt = big.yinBars >= 3 ? '三阴' : big.yinBars === 2 ? '双阴' : big.yinBars + ' 连阴';
    a.text += '；大级别 ' + bl + ' ' + yinTxt
      + '，收盘 ' + fmt(a.price)
      + (big.aboveMa === true ? ' 未跌破 MA7 ' : ' 已跌破 MA7 ')
      + (Number.isFinite(big.ma7) ? fmt(big.ma7) : '-')
      + (big.ok ? ' → 回踩不破均线成立' : ' → 不满足（需双阴/三阴且不破均线）');
  }
  out.push(a);
  return out;
}

/**
 * 大级别结构（用户 2026-10-17：双阴/三阴 回踩不破均线）
 *   连阴根数：从最后一根往前数 close < open 的根数（1/2/3+）
 *   不破均线：最后一根收盘 > MA7（做多语境）；needBothMa 时还要 > EMA7
 */
export function bigLevelState(v, opt = {}) {
  const minYin = opt.minYin ?? 2;
  const needBoth = opt.needBothMa === true;
  if (!v) return { yinBars: 0, ma7: null, ema7: null, aboveMa: null, ok: false };
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 2) return { yinBars: 0, ma7: null, ema7: null, aboveMa: null, ok: false };
  let yinBars = 0;
  for (let i = n - 1; i >= 0; i--) {
    const o = v.o[i], cc = v.c[i];
    if (!Number.isFinite(o) || !Number.isFinite(cc)) break;
    if (cc < o) yinBars++;
    else break;
  }
  const last = n - 1;
  const ma7 = numAt(v.ma7, last), ema7 = numAt(v.ema7, last);
  const close = v.c[last];
  let aboveMa = null;
  if (Number.isFinite(ma7) && Number.isFinite(ema7)) {
    aboveMa = needBoth ? (close > ma7 && close > ema7) : (close > ma7);
  } else if (Number.isFinite(ma7)) {
    aboveMa = close > ma7;
  }
  const ok = yinBars >= minYin && aboveMa === true;
  return { yinBars, ma7, ema7, aboveMa, ok, close };
}
