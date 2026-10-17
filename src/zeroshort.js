/**
 * 做空方向（用户 2026-10-17）
 *   「做空为 最小级别不上穿，双阳不穿和三阳不穿都提醒」
 *
 * 口径（与做多完全镜像）：
 *   ① 大级别：连续**阳线** ≥ zeroBigYinMin 根（双阳/三阳），且收盘**仍在 MA7 下方**（不穿上去）
 *   ② 最小级别：DIF **未能上穿零轴** —— 最近 failBars 根内 DIF 一直在零轴下方，
 *      其中出现过一次"向零轴靠近"，然后**转下**（dif 开始走低）→ 判定反弹被压回
 *   ③ 两者同时成立 → 做空提醒
 */

/**
 * 大级别结构（支持方向）
 * @param {object} v 视图（o/h/l/c/ma7/ema7/closed）
 * @param {object} opt { minYin, needBothMa, dir }
 */
export function bigLevelStateDir(v, opt = {}) {
  const minBars = opt.minYin ?? 2;
  const needBoth = opt.needBothMa === true;
  const dir = opt.dir ?? 'long';
  const long = dir === 'long';
  if (!v) return { bars: 0, ma7: null, ema7: null, okMa: null, ok: false, dir };
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < 2) return { bars: 0, ma7: null, ema7: null, okMa: null, ok: false, dir };
  let bars = 0;
  for (let i = n - 1; i >= 0; i--) {
    const o = v.o[i], cc = v.c[i];
    if (!Number.isFinite(o) || !Number.isFinite(cc)) break;
    const isYin = cc < o, isYang = cc > o;
    // 做多数连阴，做空数连阳
    if (long ? isYin : isYang) bars++;
    else break;
  }
  const last = n - 1;
  const ma7 = v.ma7 && Number.isFinite(v.ma7[last]) ? v.ma7[last] : null;
  const ema7 = v.ema7 && Number.isFinite(v.ema7[last]) ? v.ema7[last] : null;
  const close = v.c[last];
  let okMa = null;
  if (Number.isFinite(ma7) && Number.isFinite(ema7)) {
    okMa = long
      ? (needBoth ? (close > ma7 && close > ema7) : (close > ma7))
      : (needBoth ? (close < ma7 && close < ema7) : (close < ma7));
  } else if (Number.isFinite(ma7)) {
    okMa = long ? (close > ma7) : (close < ma7);
  }
  const ok = bars >= minBars && okMa === true;
  return { bars, ma7, ema7, okMa, ok, dir, close };
}

/**
 * 最小级别：DIF 未能上穿零轴（做空触发）
 *   条件：最近 failBars 根 DIF 全部 < 0（从未上穿），出现过向零轴靠近（后一根比前一根高），
 *         且当前这根开始转下（dif[k] < dif[k-1]）
 */
export function detectFailedUpCross(v, opt = {}) {
  const freshBars = opt.freshBars ?? 1;
  const failBars = Math.max(2, opt.failBars ?? 4);
  if (!v || !v.dif) return null;
  const n = Number.isFinite(v.closed) ? Math.min(v.closed, v.t.length) : v.t.length;
  if (n < failBars + 2) return null;
  const k = n - 1;                       // 当前收盘根
  if ((n - 1) - k > freshBars) return null;

  const get = i => (v.dif && i >= 0 && i < v.dif.length && Number.isFinite(v.dif[i])) ? v.dif[i] : null;
  const dNow = get(k), dPrev = get(k - 1);
  if (dNow == null || dPrev == null) return null;
  if (!(dNow < 0 && dPrev < 0)) return null;      // 都在零轴下方
  if (!(dNow < dPrev)) return null;               // 当前转下
  // 最近 failBars 根都必须 < 0（没上穿过）
  for (let i = k - failBars + 1; i <= k; i++) {
    const d = get(i);
    if (d == null || d >= 0) return null;
  }
  // 窗口内 DIF 必须真的向零轴靠近过：最高点要爬回"最低点到零轴"距离的一半以上
  const win = [];
  for (let i = k - failBars + 1; i <= k; i++) { const d = get(i); if (d != null) win.push(d); }
  if (win.length < 3) return null;
  const lo = Math.min(...win), hi = Math.max(...win);
  if (!(hi > lo)) return null;
  const recovery = (hi - lo) / (0 - lo);          // 回抽幅度 / 到零轴的总距离
  if (!(recovery >= (opt.minRecovery ?? 0.5))) return null;

  const ma7 = v.ma7 && Number.isFinite(v.ma7[k]) ? v.ma7[k] : null;
  const ema7 = v.ema7 && Number.isFinite(v.ema7[k]) ? v.ema7[k] : null;
  const aboveMa = (Number.isFinite(ma7) && Number.isFinite(ema7)) ? (v.c[k] > ma7 && v.c[k] > ema7) : null;
  return {
    level: v.key, idx: k, t: v.t[k], closeT: v.t[k] + v.ms,
    close: v.c[k], dif: dNow, prevDif: dPrev,
    dea: v.dea && Number.isFinite(v.dea[k]) ? v.dea[k] : null,
    age: 0, aboveMa, failed: true,
  };
}
