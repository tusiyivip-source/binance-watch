/**
 * 共振报警（用户 2026-10-16 要求）：
 *   「共振报警 要在左侧K线图表显示」
 *
 * 口径（来自实盘实测）：
 *   两级五浪链先报出（结构对了）→ 顶部结构在**同一标的、同一级别**上收盘确认（转势确认了）
 *   两者相隔 ≤ res2WindowBars 根（实测 9/9 个样本都是 **1 根**）
 *
 * 这条信号的价值：链给提前量，顶部结构给过滤（把"结构对但没转"的假信号筛掉）。
 *
 * 输出 kind = 'res2'，带两个时间点（链的时间 + 确认的时间），报警级别 = 主级别，
 * 因此可以在「报警级别K线」视图里直接画出来。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';
import { alertTiming } from './alert-timing.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
const levelMs = k => (LEVELS[LEVEL_INDEX[k]]?.minutes ?? 1) * 60_000;

/**
 * 在一批"本轮新报警"里找共振对。
 * @param {Array} fired  本轮新产生的报警（chain / top5 混杂）
 * @param {Map}   seen   去重表
 * @param {object} cfg
 * @param {number} now
 * @returns {Array} 共振报警
 */
export function scanResonance(fired, seen, cfg, now = Date.now()) {
  const out = [];
  if (!fired || fired.length < 2) return out;
  const win = Math.max(1, cfg.res2WindowBars ?? 3);
  const chains = fired.filter(a => a.kind === 'chain' && Number.isFinite(a.barT ?? a.signalT));
  const tops = fired.filter(a => a.kind === 'top5' && a.topStage !== 'warning' && Number.isFinite(a.barT ?? a.signalT));
  for (const c of chains) {
    const cT = c.barT ?? c.signalT;
    for (const t of tops) {
      if (t.symbol !== c.symbol) continue;
      if (t.level !== c.level) continue;                       // 同一级别才算同级共振
      const tT = t.barT ?? t.signalT;
      const gapBars = Math.round((tT - cT) / levelMs(c.level));
      const abs = Math.abs(gapBars);
      if (abs > win) continue;                                 // 相隔太远不算
      const key = `${c.symbol}|${c.level}|${Math.min(cT, tT)}|${Math.max(cT, tT)}`;
      if (seen.has(key)) continue;
      seen.set(key, now);
      out.push(makeResonanceAlert(c, t, gapBars, now));
    }
  }
  return out;
}

function makeResonanceAlert(c, t, gapBars, now) {
  const L = label(c.level);
  const after = gapBars >= 0;
  const pct = Number.isFinite(t.barPct) ? t.barPct : (Number.isFinite(c.barPct) ? c.barPct : null);
  return {
    kind: 'res2',
    id: 0,
    symbol: c.symbol,
    mode: 'closed',
    stage: 'resonance',
    confirmed: true,
    side: 'long',
    level: c.level,
    levelLabel: L,
    subLevel: c.subLevel,
    subLevelLabel: c.subLevelLabel,
    innerLevel: null,
    innerLevelLabel: null,
    group: `${L} · 双确认共振`,
    base: c.level, mid: c.subLevel, big: null,
    score: 100,
    price: t.price ?? c.price,
    candleT: after ? (t.barT ?? t.signalT) : (c.barT ?? c.signalT),
    ts: now,
    initial: !!(c.initial || t.initial),
    ...alertTiming(Math.max(c.barT ?? c.signalT, t.barT ?? t.signalT) + levelMs(c.level), now, !!(c.initial && t.initial)),
    confirmationKind: 'resonance',
    chainT: c.barT ?? c.signalT,
    topT: t.barT ?? t.signalT,
    gapBars,
    chainRef: c.id,
    topRef: t.id,
    chainSubStrokes: c.chainSubStrokes ?? null,
    resPct: pct,
    barPct: pct,
    topStage: t.topStage,
    text: `【双确认共振】${L} ${c.symbol}：**两级五浪链**先报出（${c.subLevelLabel ?? ''} `
      + `${c.chainSubStrokes ?? '?'} 笔结构成立）→ **顶部结构**`
      + (gapBars === 0
        ? '在**同一根K线**上收盘确认（收盘站上 MA7 与 EMA7）'
        : `在${after ? '之后' : '之前'} ${Math.abs(gapBars)} 根K线收盘确认（收盘站上 MA7 与 EMA7）`)
      + (pct !== null ? `；确认根涨幅 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''),
  };
}
