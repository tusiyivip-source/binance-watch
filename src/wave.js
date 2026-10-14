/**
 * 五浪反弹通道（用户 v5 新策略，**完全独立于盯盘通道**）
 *
 * 监控 4 组（主级别 ← 次级别）：15分←3分、30分←5分、1时←10分、2时←15分
 *
 * 口径（用户原话逐条落地）：
 *   ① 主级别「一笔下」：**不靠缠论** —— 在最近 waveHighLookback 根里找「高点 → 之后的最低点」，
 *      高点到低点跨度 ≥ waveMinBars（默认 5）根K线即可；高点不要求是顶分型。
 *   ② 这笔下跌的**时间窗内**，次级别的 MACD 交叉必须依次是 `死→金→死→金→死`
 *      （窗口末尾 5 个交叉正好是这串，且最后一个必须是死叉）—— 即「五浪」。
 *   ③ 必须**先见到这笔下跌的最低点**，之后才出现「再次金叉」（次级别 DIF 上穿 DEA）。
 *   ④ 该金叉之后 **waveCrossWindow（默认 2）根主级别收盘K线内**，主级别出现
 *      **由下向上穿越 EMA7**（前一根收盘 ≤ EMA7、这一根收盘 > EMA7）→ 报警。
 *
 * 一个「币种 + 主级别 + 这笔下跌的最低点」只报一次。
 *
 * 纯逻辑模块，不依赖任何 Node 内置，浏览器版同样可用。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);

/** 把一个级别的原始序列摘成判定所需的最小视图（数组都是引用，不复制） */
export function waveView(series, key) {
  if (!series || !series.t || series.t.length < 8) return null;
  const ind = series.ensure();
  const m = series.macd();
  return {
    key,
    ms: series.ms,
    minutes: LEVELS[LEVEL_INDEX[key]]?.minutes ?? 0,
    t: series.t, h: series.h, l: series.l, c: series.c,
    ema7: ind.ema7,
    dif: m.dif, dea: m.dea,
    barIdx: series.t.length - 1,
  };
}

/** 收集某级别全部 MACD 交叉事件（金叉 G / 死叉 D），时间是**该根K线的收盘时刻** */
export function macdCrosses(v, fromT = null, toT = null) {
  const out = [];
  if (!v) return out;
  for (let k = 1; k < v.t.length; k++) {
    const d0 = v.dif[k - 1] - v.dea[k - 1];
    const d1 = v.dif[k] - v.dea[k];
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) continue;
    let type = null;
    if (d0 <= 0 && d1 > 0) type = 'G';
    else if (d0 >= 0 && d1 < 0) type = 'D';
    if (!type) continue;
    const t = v.t[k] + v.ms;                 // 收盘时刻
    if (fromT != null && t <= fromT) continue;
    if (toT != null && t > toT) continue;
    out.push({ k, t, type, price: v.c[k] });
  }
  return out;
}

/**
 * 判定一组（主级别 main + 次级别 sub）是否构成「五浪完成 + 再次金叉 + 主级别 2 根内上穿 EMA7」
 * @returns {null | object} 命中时返回明细
 */
export function detectWave(main, sub, opt = {}) {
  const minBars = opt.minBars ?? 5;
  const lookback = opt.lookback ?? 20;
  const win = opt.crossWindow ?? 2;
  if (!main || !sub) return null;
  const n = main.t.length;
  if (n < minBars + 2) return null;

  // ① 主级别：最近窗口内的「高点 → 之后的最低点」
  const i = n - 1;
  const from = Math.max(0, i - lookback + 1);
  let lIdx = from, hIdx = from;
  for (let k = from; k <= i; k++) if (main.l[k] < main.l[lIdx]) lIdx = k;
  for (let k = from; k <= lIdx; k++) if (main.h[k] > main.h[hIdx]) hIdx = k;
  const bars = lIdx - hIdx + 1;
  if (bars < minBars) return null;                 // 高点到低点不足 waveMinBars 根
  if (lIdx >= i) return null;                      // 低点就是最后一根 → 还没反弹
  const tHigh = main.t[hIdx] + main.ms;            // 高点的收盘时刻
  const tLow = main.t[lIdx] + main.ms;             // 低点的收盘时刻

  // ② 次级别：下跌窗内必须**正好**五个交叉，且依次是 死→金→死→金→死
  //    （用户口径收紧：多一个交叉就不算标准的五浪，避免把来回抖动的行情当成五浪）
  const all = macdCrosses(sub);
  const inWin = all.filter(x => x.t > tHigh && x.t <= tLow);
  if (inWin.length !== 5) return null;
  const seq = inWin.map(x => x.type).join('');
  if (seq !== 'DGDGD') return null;

  // ②b 价格结构：三波下跌（三次死叉）的低点必须**逐个降低**，第 5 浪创下这段最低点
  //     —— 这才是教科书式的五浪下跌；只数 MACD 交叉不看价格会被"下跌中继"骗。
  const deads = inWin.filter(x => x.type === 'D');           // 正好 3 个（见上）
  if (deads.length !== 3) return null;
  const lastK = Math.max(...inWin.map(x => x.k));
  const lastKInWindow = (() => {                             // 窗口内次级别最后一根
    let k = lastK;
    for (let j = 0; j < sub.t.length; j++) if (sub.t[j] + sub.ms <= tLow) k = j;
    return k;
  })();
  const segLow = (fromK, toK) => {
    let m = Infinity;
    for (let k = Math.max(1, fromK); k <= toK && k < sub.l.length; k++) if (sub.l[k] < m) m = sub.l[k];
    return m;
  };
  const w1Low = segLow(deads[0].k + 1, deads[1].k);
  const w3Low = segLow(deads[1].k + 1, deads[2].k);
  const w5Low = segLow(deads[2].k + 1, lastKInWindow);
  if (!Number.isFinite(w1Low) || !Number.isFinite(w3Low) || !Number.isFinite(w5Low)) return null;
  if (!(w1Low > w3Low && w3Low > w5Low)) return null;        // 低点必须逐个降低（第 5 浪创新低）

  // ③ 先见最低点，之后才出现「再次金叉」
  const gold = all.find(x => x.type === 'G' && x.t > tLow);
  if (!gold) return null;

  // ④ 该金叉之后 win 根主级别收盘K线内，由下向上穿越 EMA7
  const deadline = gold.t + win * main.ms;
  let hit = -1;
  for (let j = 1; j < n; j++) {
    const closeT = main.t[j] + main.ms;
    if (closeT < gold.t) continue;
    if (closeT > deadline) break;
    const a = main.ema7[j - 1], b = main.ema7[j];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (main.c[j - 1] <= a && main.c[j] > b) { hit = j; break; }
  }
  if (hit < 0) return null;

  return {
    mainKey: main.key, subKey: sub.key,
    highT: main.t[hIdx], highPrice: main.h[hIdx],
    lowT: main.t[lIdx], lowPrice: main.l[lIdx],
    bars,
    crosses: inWin.map(x => ({ t: x.t, type: x.type, price: x.price })),
    waveLows: [w1Low, w3Low, w5Low],                       // 三波低点（逐个降低）
    goldT: gold.t, goldPrice: gold.price,
    crossBarT: main.t[hit], crossClose: main.c[hit], crossEma7: main.ema7[hit],
    lagBars: Math.round((main.t[hit] + main.ms - gold.t) / main.ms),
  };
}

/**
 * 一次扫描：对 4 组各判一次，命中且未报过的返回报警数组。
 * @param {string} symbol
 * @param {Map|object} seriesMap 级别 key → CandleSeries
 * @param {object} cfg 全局配置
 * @param {Map} seen 去重表（调用方持有）
 * @param {number} now
 * @param {boolean} initial 存量扫描标记
 */
export function scanWaves(symbol, seriesMap, cfg, seen, now = Date.now(), initial = false) {
  const pairs = cfg.wavePairs ?? [];
  const out = [];
  for (const p of pairs) {
    const main = waveView(seriesMap[p.main], p.main);
    const sub = waveView(seriesMap[p.sub], p.sub);
    const hit = detectWave(main, sub, {
      minBars: cfg.waveMinBars ?? 5,
      lookback: cfg.waveHighLookback ?? 20,
      crossWindow: cfg.waveCrossWindow ?? 2,
    });
    if (!hit) continue;
    const key = `${symbol}|${p.main}|${hit.lowT}`;
    if (seen.has(key)) continue;
    seen.set(key, now);
    out.push(makeAlert(symbol, hit, now, initial));
  }
  return out;
}

/** 组装报警对象（字段与其它通道保持一致，右侧卡片 / 图表接口可直接复用） */
export function makeAlert(symbol, hit, now, initial = false) {
  const L = label(hit.mainKey), S = label(hit.subKey);
  const seq = hit.crosses.map(x => (x.type === 'D' ? '死' : '金')).join('→');
  const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(4) : v.toPrecision(6)) : '—');
  return {
    kind: 'wave',
    id: 0,                                  // 由 engine 填
    symbol,
    mode: 'closed',
    stage: 'wave',
    confirmed: true,
    side: 'long',
    level: hit.mainKey,                     // 报警级别 = 主级别（图表接口按这个取图）
    levelLabel: L,
    subLevel: hit.subKey,
    subLevelLabel: S,
    group: `${L}←${S} · 五浪反弹`,
    base: hit.mainKey, mid: null, big: null,
    score: 0,
    price: hit.crossClose,
    candleT: hit.crossBarT,
    ts: now,
    initial: !!initial,
    ema7: hit.crossEma7,
    waveHighT: hit.highT,
    waveHigh: hit.highPrice,
    waveLowT: hit.lowT,
    waveLow: hit.lowPrice,
    waveBars: hit.bars,
    waveSeq: seq,
    waveGoldT: hit.goldT,
    waveLagBars: hit.lagBars,
    text: `【五浪反弹】${L} 一笔下 ${hit.bars} 根（高点 ${fmt(hit.highPrice)} → 低点 ${fmt(hit.lowPrice)}）；`
      + `${S} 标准五浪（${seq}，三波低点 ${(hit.waveLows ?? []).map(fmt).join(' → ')} 逐个降低）`
      + ` + 再次金叉（${hit.lagBars} 根主级别K线前后）；`
      + `${L} 收盘 ${fmt(hit.crossClose)} 上穿 EMA7 ${fmt(hit.crossEma7)}`
      + (hit.lagBars <= 2 ? `（金叉后第 ${Math.max(1, hit.lagBars)} 根内）` : '')
      + ' · [已确认]',
  };
}
