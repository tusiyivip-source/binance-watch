/**
 * 按标的自动选级别（用户 2026-10-17 批准）
 *
 * 依据（tools/level-profile.mjs 实测）：
 *   · 各周期单根振幅中位数：5分0.25 / 15分0.53 / 30分0.85 / 1时1.30 / 2时1.70 / 4时2.47 / 6时3.24（%）
 *   · 单个标的的振幅差异远大于级别之间的差异 → 所以"每个标的用适合自己的级别"比"所有币同一个级别"合理
 *
 * 规则：
 *   ① 基础级别 L0 = 各候选周期里「单根振幅最接近 target（默认 1.2%）」的那一档
 *   ② 次级别 = L0 ÷ 4~6，内部级别 = 次级别 ÷ 4~6（不要 30 倍的跨度）
 *   ③ 上级别 = L0 × 2（只用于"不反向"确认）
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

/** 候选基础级别（覆盖这批标的的绝大多数） */
export const BASE_CANDIDATES = ['15m', '30m', '1h', '2h', '4h'];

/** 固定的"主 → 次 → 内 → 上"四档映射（比例都在 4~6 倍） */
export const LADDER = {
  '15m': { base: '15m', sub: '3m', inner: '1m', higher: '30m' },
  '30m': { base: '30m', sub: '5m', inner: '1m', higher: '1h' },
  '1h': { base: '1h', sub: '15m', inner: '3m', higher: '2h' },
  '2h': { base: '2h', sub: '30m', inner: '5m', higher: '4h' },
  '4h': { base: '4h', sub: '1h', inner: '15m', higher: '6h' },
};

/** 单根振幅中位数（%）：用最近 lookback 根的 (high-low)/close */
export function barAmpOf(series, lookback = 120) {
  if (!series || !series.t || !series.t.length) return 0;
  const n = Number.isFinite(series.closedCount) ? Math.min(series.closedCount, series.t.length) : series.t.length;
  const from = Math.max(0, n - lookback);
  const arr = [];
  for (let i = from; i < n; i++) {
    const c = series.c[i];
    if (!c) continue;
    const amp = (series.h[i] - series.l[i]) / c * 100;
    if (Number.isFinite(amp) && amp > 0) arr.push(amp);
  }
  if (!arr.length) return 0;
  arr.sort((a, b) => a - b);
  return arr[(arr.length / 2) | 0];
}

/**
 * 为单个标的选基础级别
 * @returns {{base:string, sub:string, inner:string, higher:string, amp:number, all:object}}
 */
export function pickLadder(seriesMap, cfg = {}) {
  const cands = cfg.adaptiveLevels ?? BASE_CANDIDATES;
  const target = cfg.adaptiveTargetAmp ?? 1.2;
  const amps = {};
  let best = null, bestDiff = Infinity;
  for (const key of cands) {
    const s = seriesMap[key];
    if (!s) continue;
    const amp = barAmpOf(s);
    if (!amp) continue;
    amps[key] = +amp.toFixed(3);
    const d = Math.abs(amp - target);
    if (d < bestDiff) { bestDiff = d; best = key; }
  }
  if (!best) best = cfg.adaptiveFallbackBase ?? '30m';
  const lv = LADDER[best] ?? LADDER['30m'];
  return { ...lv, amp: amps[best] ?? 0, all: amps };
}

/**
 * 把自适应级别写进一份 cfg 副本，供各策略直接使用
 * （不改任何策略的函数签名，只在引擎里替换 cfg）
 */
export function adaptCfg(st, cfg) {
  if (cfg.adaptiveEnabled === false) return cfg;
  const lv = pickLadder(st.series ?? {}, cfg);
  st.resolvedLevel = lv;   // 方便在 /api/stats 或详情里查看该标的用了哪一档
  const out = { ...cfg };
  // 底分型：只看该标的的 L0；内部/上级别按阶梯
  out.fracLevels = [lv.base];
  out.fracInnerMap = { [lv.base]: lv.inner };
  out.fracHigherMap = { [lv.base]: lv.higher };
  // 两级五浪：L0 ← 次级别
  out.chainTriples = [{ main: lv.base, sub: lv.sub }];
  // 浅回调结构：L0 ← 次级别
  out.pbPairs = [{ main: lv.base, sub: lv.sub }];
  out._adaptive = lv;
  return out;
}

export const levelLabel = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
