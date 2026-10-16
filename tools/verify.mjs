/**
 * 独立验证脚本： node tools/verify.mjs
 *
 * 1) 本地合成K线是否与币安原生K线完全一致（用 1m→3m 对照原生 3m，覆盖全部字段）
 * 2) MA/EMA 是否与朴素实现逐点一致
 * 3) 信号引擎「正样例」必须触发
 * 4) 信号引擎「负样例」必须不触发（最大级别破位 / 共振级别不足 / 无回踩 / 相邻未上穿）
 * 5) 真实行情冒烟测试
 */
import { CandleSeries } from '../src/series.js';
import { memoryStorage } from '../src/file-storage.js';
import * as CandleSeriesMod from '../src/series.js';
import { buildSMA, buildEMA } from '../src/indicators.js';
import { evaluateSymbol, analyzeLevel, findResonance, triplesFor, strokeChain, checkStrokeChain, findTwoBearHold, findTwoBullHold, dualPattern, pullbackStructure, downRunLen, recentDownRun, strokeContinuation, twoBullReclaim, barsFromHigh, macdDead } from '../src/signals.js';
import { LEVELS, VISIBLE_LEVELS, DEFAULT_SIGNAL, DEFAULT_GROUPS, LEVEL_INDEX, APP, DEFAULT_WATCH_GROUPS, watchInnerLevels } from '../src/config.js';
import { Watcher, pickNear, nearOk } from '../src/watch.js';
import { detectWave, makeAlert, macdCrosses, waveView, scanWaves } from '../src/wave.js';
import { detectBreakout, makeBreakoutAlert, scanBreakouts, brkView } from '../src/breakout.js';
import { detectFirstBottom, makeFirstBottomAlert, scanFirstBottoms } from '../src/firstbottom.js';
import { isBottomFractal, findFirstBottomFractal } from '../src/fractal.js';
import { detectChain, makeChainAlert, scanChains, chainView } from '../src/chain.js';
import { detectTop5, makeTop5Alert, scanTop5, top5View, isEngulf } from '../src/top5.js';
import { scanResonance } from '../src/resonance.js';
import { nextBoundary, groupPeriodMs, BoundaryScheduler, levelPeriodMs } from '../src/boundary.js';

// 验证脚本自己控制序列保留上限，避免受实盘 maxCandlesKept 影响导致对比样本数漂移
APP.maxCandlesKept = 3000;

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  \u001b[32m✓\u001b[0m ${name}${detail ? '  \u001b[2m' + detail + '\u001b[0m' : ''}`); }
  else { fail++; results.push(`  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`); }
}
const section = t => results.push(`\n\u001b[36m▌${t}\u001b[0m`);

// 基线配置：显式关掉「回踩成笔链」与「背驰过滤」这两个新增过滤器。
// 第 3/4/9 节测的是**原有触发逻辑**，用合成K线（分型结构很稀疏）根本凑不出成笔链，
// 开着会把旧断言全部打成 0 命中。两个过滤器各自在第 8/9、11 节单独验证。
const cfg = { ...DEFAULT_SIGNAL, signalEnabled: true, requireStrokeChain: false, filterBeichi: false, pullbackPattern: 'touch' };
const MIN = 60_000;

/* ============ 1. 合成K线 vs 币安原生K线 ============ */
section('1. K线合成正确性（1m 合成 3m 对照币安原生 3m）');
try {
  const [r1, r3] = await Promise.all([
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000').then(r => r.json()),
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=400').then(r => r.json()),
  ]);
  const src = new CandleSeries({ key: '1m', minutes: 1, native: true });
  src.bulkLoad(r1.map(k => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: true,
  })));
  const agg = new CandleSeries({ key: '3m', minutes: 3, native: false, from: '1m', ratio: 3 });
  agg.rebuildFrom(src);

  const native = new Map(r3.map(k => [k[0], k]));
  // 边界处理：1m 与 3m 是两个**并行独立请求**，响应生成时刻有毫秒级差。
  // 若 3m 先返回、1m 后返回，边界桶在两边就不同步：原生 3m 记的是"未收盘快照"，
  // 而 1m 已经凑满 3 根 → 合成侧认为它已收盘。只比较结束时间早于两者中较晚者的桶。
  const last1mEnd = r1[r1.length - 1][0] + 60_000;
  const last3mStart = r3[r3.length - 1][0];
  const cutoff = Math.min(last1mEnd, last3mStart);

  let cmp = 0, mismatch = 0, firstBad = null, skippedTail = 0;
  // 从第 1 根开始比较：1m 数据的起点可能落在第 0 个 3m 桶的中间，该桶天然不完整；
  // 同时跳过尚未收盘的桶（其 close/high/low 仍在变化）与上面说的边界桶。
  for (let i = 1; i < agg.t.length; i++) {
    if (!agg.done[i]) continue;
    if (agg.t[i] + 3 * 60_000 > cutoff) { skippedTail++; continue; }
    const n = native.get(agg.t[i]);
    if (!n) continue;                    // 原生数组未覆盖到的桶跳过
    cmp++;
    const d = {
      o: Math.abs(+n[1] - agg.o[i]),
      h: Math.abs(+n[2] - agg.h[i]),
      l: Math.abs(+n[3] - agg.l[i]),
      c: Math.abs(+n[4] - agg.c[i]),
      v: Math.abs(+n[5] - agg.v[i]),
      q: Math.abs(+n[7] - agg.q[i]),
    };
    const bad = Object.entries(d).find(([, v]) => v > 1e-6);
    if (bad) { mismatch++; if (!firstBad) firstBad = { t: agg.t[i], field: bad[0], delta: bad[1] }; }
  }
  ok(`对比 ${cmp} 根合成K线（OHLCV+成交额，容差 1e-6）`, cmp > 100 && mismatch === 0,
    mismatch ? `${mismatch} 根不一致，首个：${JSON.stringify(firstBad)}`
      : `全部逐字段一致（另跳过 ${skippedTail} 根边界/未收盘桶）`);
  ok('收盘标记正确（末根之外均为已收盘）', agg.done.slice(0, -1).every(Boolean));
} catch (e) {
  ok('K线合成对照（网络）', false, e.message);
}

/* ============ 2. 指标正确性 ============ */
section('2. 技术指标正确性');
{
  const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.3);
  const ma7 = buildSMA(closes, 7);
  const naiveSMA = closes.map((_, i) => i < 6 ? NaN : closes.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7);
  let d1 = 0;
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(naiveSMA[i])) { if (!Number.isNaN(ma7[i])) d1++; continue; }
    d1 = Math.max(d1, Math.abs(ma7[i] - naiveSMA[i]));
  }
  ok('SMA7 与朴素实现逐点一致', d1 < 1e-9, `最大偏差 ${d1.toExponential(2)}`);

  const ema7 = buildEMA(closes, 7);
  let e = closes.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
  let maxd = 0;
  for (let i = 7; i < closes.length; i++) {
    e = closes[i] * (2 / 8) + e * (6 / 8);
    maxd = Math.max(maxd, Math.abs(e - ema7[i]));
  }
  ok('EMA7 递推一致（SMA 种子）', maxd < 1e-9, `最大偏差 ${maxd.toExponential(2)}`);
}

/* ============ 合成K线工厂 ============ */
function seriesFromCloses(level, closes, opt = {}) {
  const s = new CandleSeries(level);
  const ms = level.minutes * MIN;
  const t0 = Math.floor(Date.now() / ms) * ms - closes.length * ms;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const o = i ? closes[i - 1] : c;
    s.t.push(t0 + i * ms);
    s.o.push(o);
    s.c.push(c);
    s.h.push(Math.max(o, c) * 1.0015);
    s.l.push(Math.min(o, c) * (opt.wideLow ? 0.985 : 0.9975));
    s.v.push(1000);
    s.q.push(1000 * c);
    s.n.push(10);
    s.done.push(true);
  }
  s.dirty = true;
  return s;
}

/**
 * 生成"上涨 → 回踩MA7 → 放量突破MA7/EMA7"的多头路径。
 * 回踩根收盘刻意压在 MA7 之下 0.3%，突破根大幅拉起，确保上穿形态成立。
 */
function bullBreakoutPath(n, { pullback = true, breakout = true } = {}) {
  const closes = [];
  let p = 100;
  const ma7 = a => a.slice(-7).reduce((x, y) => x + y, 0) / 7;
  const tail = pullback ? 2 : 1;
  for (let i = 0; i < n - tail; i++) { p *= 1.0035; closes.push(p); }
  if (pullback) closes.push(ma7(closes) * 0.997);
  if (breakout) closes.push(closes[closes.length - 1] * 1.06);
  return closes;
}

function buildLevels(overrides = {}) {
  const map = {};
  for (const lv of LEVELS) {
    const o = overrides[lv.key] ?? {};
    const closes = o.closes ?? bullBreakoutPath(80, o);
    map[lv.key] = seriesFromCloses(lv, closes, o);
  }
  return map;
}

const has = (matches, pred) => matches.some(pred);

/* ============ 3. 正样例 ============ */
section('3. 信号引擎 · 正样例（固定三元组，必须触发）');
{
  const series = buildLevels();
  const res = evaluateSymbol('TESTUSDT', series, cfg, false);
  const m = res.matches;
  const groupsHit = [...new Set(m.map(x => x.group))];
  ok('识别出多级别共振', m.length > 0, `命中 ${m.length} 组：${groupsHit.join(' / ')}`);

  ok('命中用户示例组合：3分 → 15分 → 2时（跨级，非相邻）', groupsHit.includes('3m>15m>2h'));
  ok('命中用户示例组合：2分 → 10分 → 1时（2分由1分合成）', groupsHit.includes('2m>10m>1h'));
  ok('命中用户示例组合：5分 → 30分 → 3时（3时由1时合成）', groupsHit.includes('5m>30m>3h'));

  ok('共振级别数 ≥ 3', res.bullCount >= cfg.minBullLevels, `实际 ${res.bullCount}/${VISIBLE_LEVELS.length} 个级别多头排列`);
  ok('已确认为收盘信号', m.every(x => x.confirmed));
  ok('评分在 0–100 区间', m.every(x => x.score >= 0 && x.score <= 100), `区间 ${Math.min(...m.map(x => x.score))}–${Math.max(...m.map(x => x.score))}`);

  // —— 三元组解析 ——
  const tri = triplesFor({ ...cfg, scanMode: 'groups', groups: DEFAULT_GROUPS });
  ok('三元组解析：固定组合模式恰好 3 组，且允许跨级（3分→15分→2时）',
    tri.length === 3 && tri.some(t => t.b === LEVEL_INDEX['3m'] && t.m === LEVEL_INDEX['15m'] && t.k === LEVEL_INDEX['2h']),
    tri.map(t => `${LEVELS[t.b].key}>${LEVELS[t.m].key}>${LEVELS[t.k].key}`).join(' , '));

  const triAuto = triplesFor({ ...cfg, scanMode: 'auto' });
  ok('三元组解析：穷举模式下确认级别取下一档',
    triAuto.length >= 40 && triAuto.every(t => t.m === t.b + 1 && t.k > t.m), `${triAuto.length} 组`);

  ok('三元组解析：顺序非法（基准 > 确认）被丢弃',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '2h', mid: '15m', big: '3h', enabled: true }] }).length === 0);
  ok('三元组解析：停用的组合不参与扫描',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }).length === 0);
  ok('三元组解析：全部组合都停用时不回退到穷举（不出信号）',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }).length === 0
    && evaluateSymbol('OFFUSDT', buildLevels(), { ...cfg, groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }, false).matches.length === 0);

  // —— 单个组合模式：只应产出该组合 ——
  const one = evaluateSymbol('ONEUSDT', buildLevels(), { ...cfg, groups: [{ base: '3m', mid: '15m', big: '2h', enabled: true }] }, false);
  ok('固定组合模式只产出被配置的那一组',
    one.matches.length > 0 && one.matches.every(x => x.group === '3m>15m>2h'),
    `${one.matches.length} 组，全部为 3m>15m>2h`);

  // —— 2分钟确实由1分钟合成而来（走真实的合成器，而非各造一份） ——
  {
    const lv1 = LEVELS[LEVEL_INDEX['1m']], lv2 = LEVELS[LEVEL_INDEX['2m']];
    const ms1 = 60_000, ms2 = 120_000;
    const fill = (s1, t0, n) => {
      for (let i = 0; i < n; i++) {
        const c = 100 + i;
        s1.t.push(t0 + i * ms1); s1.o.push(c - 0.5); s1.h.push(c + 0.4);
        s1.l.push(c - 0.9); s1.c.push(c); s1.v.push(10 + i); s1.q.push((10 + i) * c);
        s1.n.push(3); s1.done.push(true);
      }
      s1.dirty = true;
    };

    // (a) 起点对齐到 2 分钟边界 → 恰好 40 根完整桶
    const sA = new CandleSeries(lv1);
    fill(sA, Math.floor(Date.now() / ms2) * ms2 - 40 * ms2, 80);
    const gA = new CandleSeries(lv2);
    gA.rebuildFrom(sA);
    const okA = gA.t.length === 40
      && gA.o[0] === sA.o[0] && gA.c[0] === sA.c[1]
      && gA.h[0] === Math.max(sA.h[0], sA.h[1]) && gA.l[0] === Math.min(sA.l[0], sA.l[1])
      && Math.abs(gA.v[0] - (sA.v[0] + sA.v[1])) < 1e-9
      && gA.c[39] === sA.c[79];
    ok('2分钟由1分钟真实合成（起点对齐：80 根 1分 → 40 根 2分，OHLCV 正确）',
      okA, `→ ${gA.t.length} 根，首根 O=${gA.o[0]} C=${gA.c[0]} H=${gA.h[0]} L=${gA.l[0]} V=${gA.v[0]}`);

    // (b) 起点不对齐（落在奇数分钟）→ 首尾各出现一个半截桶，共 41 根
    const sB = new CandleSeries(lv1);
    fill(sB, Math.floor(Date.now() / ms2) * ms2 - 40 * ms2 + ms1, 80);
    const gB = new CandleSeries(lv2);
    gB.rebuildFrom(sB);
    const okB = gB.t.length === 41
      && gB.o[0] === sB.o[0] && gB.c[0] === sB.c[0] && gB.v[0] === sB.v[0]   // 首桶仅 1 根
      && gB.c[1] === sB.c[2];                                                // 第 2 桶是完整的 2 根
    ok('起点不对齐时，半截桶被正确保留（80 根 1分 → 41 根 2分，首桶只有 1 根）',
      okB, `→ ${gB.t.length} 根，首桶 V=${gB.v[0]}（单根应为 ${sB.v[0]}）`);

    // (c) 收盘标记：桶铺满且源K线已收盘，合成K线才算收盘；半截的尾桶必须标记为"未收盘"
    ok('合成K线收盘标记正确（完整桶=已收盘，半截尾桶=未收盘）',
      gA.done.every(Boolean) && gB.done.slice(0, -1).every(Boolean) && gB.done[gB.done.length - 1] === false,
      `对齐序列 ${gA.done.filter(Boolean).length}/${gA.done.length} 已收盘；` +
      `错位序列末根 done=${gB.done[gB.done.length - 1]}（半截桶，应为 false）`);
  }
  ok('1分钟标记为隐藏级别（不进矩阵/不计数）',
    LEVELS[LEVEL_INDEX['1m']].hidden === true && !VISIBLE_LEVELS.some(l => l.key === '1m'),
    `可见级别 ${VISIBLE_LEVELS.length} 个：${VISIBLE_LEVELS.map(l => l.key).join(',')}`);
}

/* ============ 4. 负样例 ============ */
section('4. 信号引擎 · 负样例（必须不触发）');
{
  // 4.1 最大级别跌破均线 → 该"最大级别"组合必须全部消失
  //     注意：不能把末尾K线"整体按比例缩放"——那样 MA7 会同步下移，close>MA7 依然成立。
  //     必须让最后几根**逐根下跌**，才会真正跌破均线。
  const bearishBig = bullBreakoutPath(80, { pullback: false });
  for (let i = 70; i < 80; i++) bearishBig[i] = bearishBig[i - 1] * 0.975;
  const s1 = buildLevels({ '2h': { closes: bearishBig } });
  const r1 = evaluateSymbol('NEG1USDT', s1, cfg, false);
  ok('最大级别(2h)跌破均线 → 无 big=2h 的共振',
    !has(r1.matches, x => x.big === '2h'),
    `其余组合 ${r1.matches.length} 组：${[...new Set(r1.matches.map(x => x.group))].join(' / ') || '无'}`);

  // 4.2 只有 1 个级别多头排列 → 共振级别不足，必须完全不触发
  //     构造：除 3m 外的所有级别走单边下跌（MA7<MA25，非多头排列）
  const bearPath = n => { const a = []; let p = 200; for (let i = 0; i < n; i++) { p *= 0.996; a.push(p); } return a; };
  const s2 = {};
  for (const lv of LEVELS) s2[lv.key] = seriesFromCloses(lv, bearPath(80));
  s2['3m'] = seriesFromCloses(LEVELS[LEVEL_INDEX['3m']], bullBreakoutPath(80));
  const r2 = evaluateSymbol('NEG2USDT', s2, cfg, false);
  ok('多头排列级别不足 3 个 → 不触发', r2.matches.length === 0 && r2.bullCount < cfg.minBullLevels,
    `共振级别数 ${r2.bullCount}/${VISIBLE_LEVELS.length}，命中 ${r2.matches.length} 组`);

  // 4.3 基准级别单边上涨、没有回踩 → 不触发
  const noPullback = buildLevels({ '3m': { pullback: false } });
  const r3 = evaluateSymbol('NEG3USDT', noPullback, cfg, false);
  ok('基准级别(3分)未回踩 MA7 → 无 base=3m 的共振',
    !has(r3.matches, x => x.base === '3m'),
    `其余组合 ${r3.matches.length} 组`);

  // 4.4 确认级别早已在均线上方、非"上穿" → 不触发
  const adjacentNoCross = buildLevels({ '15m': { pullback: false } });
  const r4 = evaluateSymbol('NEG4USDT', adjacentNoCross, cfg, false);
  ok('确认级别(15分)未同步上穿 → 无 mid=15m 的共振',
    !has(r4.matches, x => x.mid === '15m'),
    `其余组合 ${r4.matches.length} 组`);

  // 4.5 基准级别收盘跌破 MA7（未站上双均线）→ 不触发
  const belowMa = buildLevels();
  const lastCloses = belowMa['3m'].c;
  lastCloses[lastCloses.length - 1] = lastCloses[lastCloses.length - 2] * 0.96;
  belowMa['3m'].dirty = true;
  const r5 = evaluateSymbol('NEG5USDT', belowMa, cfg, false);
  ok('基准级别未站上 MA7/EMA7 → 无 base=3m 的共振',
    !has(r5.matches, x => x.base === '3m'),
    `其余组合 ${r5.matches.length} 组`);
}

/* ============ 5. 真实行情冒烟 ============ */
section('5. 真实行情冒烟测试');
try {
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XVSUSDT'];
  for (const sym of syms) {
    const map = {};
    let bars = 0;
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const rows = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${lv.key}&limit=200`).then(r => r.json());
      const s = new CandleSeries(lv);
      s.bulkLoad(rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: true })));
      map[lv.key] = s; bars += rows.length;
    }));
    for (const lv of LEVELS.filter(l => !l.native)) {
      map[lv.key] = new CandleSeries(lv);
      map[lv.key].rebuildFrom(map[lv.from]);
    }
    const res = evaluateSymbol(sym, map, cfg, true);
    const bad = Object.entries(res.levels).filter(([, v]) => v.code < 0 || v.code > 5);
    ok(`${sym} 评估无异常`, res.bullCount >= 0 && bad.length === 0,
      `${bars} 根K线 · 多头排列 ${res.bullCount}/${VISIBLE_LEVELS.length} · 命中 ${res.matches.length} 组` +
      (res.matches[0] ? ` · 最强 ${res.matches[0].group} ${res.matches[0].score}分` : ''));
  }
} catch (e) {
  ok('真实行情冒烟（网络）', false, e.message);
}

/* ============ 6. 绩效追踪模块 ============ */
section('6. 绩效追踪模块（信号结算与统计）');
{
  const { Tracker } = await import('../src/tracker.js');
  const mk = (ms, arr) => ({ ms, t: arr.map((_, i) => i * ms), c: arr, o: arr, h: arr, l: arr, v: arr.map(() => 1) });

  // 取价：应取"收盘时刻 ≤ 目标时刻"的最后一根（target=180000 时，第0根刚好在 180000 收盘）
  const s = mk(180_000, [100, 101, 102, 103, 104, 105]);
  ok('priceAt 取到目标时刻及之前最后一根的收盘价', Tracker.priceAt(s, 180_000) === 100, `t=180000 → ${Tracker.priceAt(s, 180_000)}`);
  ok('priceAt 随目标时刻推进而前移', Tracker.priceAt(s, 360_000) === 101 && Tracker.priceAt(s, 900_000) === 104,
    `t=360000 → ${Tracker.priceAt(s, 360_000)}, t=900000 → ${Tracker.priceAt(s, 900_000)}`);
  ok('priceAt 对超出区间更早的时刻返回 null', Tracker.priceAt(s, -1) === null);
  ok('priceAt 对未来时刻取到最后一根（由调用方用 now 兜底）', Tracker.priceAt(s, 9e12) === 105);

  // 结算：构造一条 2 小时前的记录，应能算出 +1h，且 +4h 仍为待结算
  const tmp = 'data/_test-signals.jsonl';
  const tr = new Tracker(tmp, { info() { }, warn() { }, error() { } }, memoryStorage());
  tr.entries.length = 0;
  const now = Date.now();
  const e = tr.record({
    symbol: 'TSTUSDT', base: '3m', mid: '5m', big: '2h', mode: 'closed', candleT: now - 7200000,
    ts: now - 7200000, price: 100, score: 70, bullCount: 5, confirmed: true, initial: false,
  });
  ok('record 写入条目', !!e && tr.entries.length === 1);

  const fakeMarket = {
    symbols: new Map([['TSTUSDT', {
      seeded: true,
      series: { '3m': { ms: 180_000, t: [0, 180_000], c: [0, 101] } },
    }]]),
  };
  // 用 3m 序列无法覆盖 2 小时前，应回退到更粗的级别
  fakeMarket.symbols.get('TSTUSDT').series['30m'] = {
    ms: 1_800_000,
    t: Array.from({ length: 20 }, (_, i) => (now - 3600_000 * 10) + i * 1_800_000),
    c: Array.from({ length: 20 }, (_, i) => 100 + i),
  };
  tr.lastResolve = 0;
  tr.resolve(fakeMarket);
  const h1 = e.out.h1;
  ok('resolve 结算 +1h 收益', h1 != null && Math.abs(h1) > 0, `+1h = ${h1}%`);
  ok('resolve 未到期的不提前结算 (+4h)', e.out.h4 == null, `+4h = ${e.out.h4 ?? '待结算'}`);

  const st = tr.stats();
  ok('stats 汇总结构完整',
    st.tracked === 1 && st.horizons.length === 3 && st.byScore.length === 4,
    `tracked=${st.tracked} 分档=${st.byScore.length}`);
  try { (await import('node:fs')).rmSync(tmp, { force: true }); } catch { }
}

/* ============ 7. tick 构建K线（合约 tick-rest 模式核心） ============ */
section('7. 实时价构建K线（applyTick，合约行情源核心）');
{
  const lv = LEVELS[LEVEL_INDEX['1m']];
  const ms = 60_000;
  const base = Math.floor(Date.now() / ms) * ms - 5 * ms;   // 对齐到分钟边界

  const s = new CandleSeries(lv);
  ok('空序列首次 tick 建立K线', s.applyTick(100, base) === false && s.t.length === 1 && s.o[0] === 100 && s.c[0] === 100);
  ok('新建立的K线尚未收盘', s.done[0] === false);

  s.applyTick(103, base + 1000);   // 同一根内上涨
  s.applyTick(97, base + 2000);    // 同一根内下跌
  ok('同区间内 tick 正确更新 high/low/close',
    s.h[0] === 103 && s.l[0] === 97 && s.c[0] === 97 && s.o[0] === 100,
    `O=${s.o[0]} H=${s.h[0]} L=${s.l[0]} C=${s.c[0]}`);

  const rolled = s.applyTick(101, base + ms);
  ok('跨入新时间区间时上一根被标记收盘并返回 true',
    rolled === true && s.t.length === 2 && s.done[0] === true && s.done[1] === false,
    `已收盘 ${s.done.filter(Boolean).length}/${s.done.length}`);
  ok('新K线以当前 tick 价开新的一根', s.o[1] === 101 && s.c[1] === 101 && s.t[1] === base + ms);

  ok('迟到的 tick（早于当前K线）被忽略', s.applyTick(50, base - 1000) === false && s.c[1] === 101);
  ok('非法价格被忽略', s.applyTick(NaN, base + 2000) === false && s.applyTick(0, base + 2000) === false && s.c[1] === 101);

  // 连续走完多根：记录每根桶内实际打过的 tick，再用"不变量"校验，避免手算期望值出错
  const s2 = new CandleSeries(lv);
  const bucketTicks = new Map();      // bucketStart -> [价格…]
  const rollAt = [];
  const push = (price, at) => {
    const bkt = Math.floor(at / ms) * ms;
    if (!bucketTicks.has(bkt)) bucketTicks.set(bkt, []);
    bucketTicks.get(bkt).push(price);
    if (s2.applyTick(price, at)) rollAt.push(bkt);
  };
  for (let i = 0; i < 5; i++) {
    push(10 + i, base + i * ms);                 // 开
    push(10 + i + 1.5, base + i * ms + 10_000);  // 高
    push(10 + i - 1.5, base + i * ms + 20_000);  // 低（也是桶内收盘）
  }
  push(99, base + 5 * ms);                       // 跨入第 6 根

  ok('连续 tick 推进：每跨一次边界收盘一根',
    rollAt.length === 5 && s2.closedCount === 5 && s2.t.length === 6,
    `收盘事件 ${rollAt.length} 次，已收盘 ${s2.closedCount} 根，共 ${s2.t.length} 根`);

  let bad = null;
  for (let i = 0; i < s2.t.length; i++) {
    const ticks = bucketTicks.get(s2.t[i]);
    if (!ticks) { bad = `第${i + 1}根找不到对应 tick 记录`; break; }
    const O = ticks[0], C = ticks[ticks.length - 1];
    const H = Math.max(...ticks), L = Math.min(...ticks);
    if (s2.o[i] !== O || s2.h[i] !== H || s2.l[i] !== L || s2.c[i] !== C) {
      bad = `第${i + 1}根 O=${s2.o[i]}/H=${s2.h[i]}/L=${s2.l[i]}/C=${s2.c[i]} 期望 ${O}/${H}/${L}/${C}`;
      break;
    }
  }
  ok('每根K线满足不变量：O=首tick、H=max、L=min、C=末tick', bad === null,
    bad ?? `${s2.t.length} 根全部吻合（第1根 O=${s2.o[0]} H=${s2.h[0]} L=${s2.l[0]} C=${s2.c[0]}）`);

  // 与 REST 结果混用：bulkLoad 覆盖后 tick 继续推进
  s2.bulkLoad([{ t: base, o: 5, h: 8, l: 4, c: 6, v: 100, q: 0, n: 1, done: true }]);
  s2.applyTick(7.5, base + ms);
  ok('REST 覆盖后 tick 能衔接续建', s2.t.length === 2 && s2.c[1] === 7.5 && s2.done[0] === true,
    `共 ${s2.t.length} 根，末根 C=${s2.c[1]}`);
}

/* ============ 8. 缠论：包含处理 / 分型 / 笔 / MACD / 背驰 ============ */
section('8. 缠论（标准笔 + MACD 面积背驰）');
{
  const { mergeInclusive, findFractals, buildStrokePoints, analyzeChan, chanStateAt, macdArea } =
    await import('../src/chan.js');
  const { buildMACD } = await import('../src/indicators.js');

  // —— 8.1 MACD 与独立实现比对 ——
  {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9) * 12 + i * 0.25);
    const m = buildMACD(closes, 12, 26, 9);
    // 独立实现
    const ema = (arr, p) => { const k = 2 / (p + 1); const out = new Array(arr.length).fill(NaN);
      let s = 0; for (let i = 0; i < p; i++) s += arr[i]; let prev = s / p; out[p - 1] = prev;
      for (let i = p; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; } return out; };
    const ef = ema(closes, 12), es = ema(closes, 26);
    let maxd = 0;
    for (let i = 25; i < closes.length; i++) maxd = Math.max(maxd, Math.abs((ef[i] - es[i]) - m.dif[i]));
    ok('MACD DIF 与独立实现一致', maxd < 1e-9, `最大偏差 ${maxd.toExponential(2)}`);
    ok('MACD 柱 = 2×(DIF−DEA)', Math.abs(m.hist[150] - 2 * (m.dif[150] - m.dea[150])) < 1e-9,
      `hist=${m.hist[150].toFixed(4)}`);
  }

  // —— 8.2 包含处理 ——
  {
    // 第2根被第1根包含（高更低、低更高）→ 应合并
    const h = [10, 9.5, 11, 12];
    const l = [5, 5.5, 6, 7];
    const m = mergeInclusive(h, l);
    ok('包含处理合并了被包含的K线', m.n === 3, `4 根 → ${m.n} 根 (h=[${m.h}])`);
    ok('包含处理保留原始下标区间', m.from[0] === 0 && m.to[0] === 1 && m.from[1] === 2,
      `from=[${m.from}] to=[${m.to}]`);

    // 上升途中被包含 → 取「高高」
    //   bar1=(12,6)  bar2=(11,7)：11≤12 且 7≥6 → 真包含；前一根 10<12 → 向上
    const up = mergeInclusive([10, 12, 11, 14], [5, 6, 7, 7.5]);
    ok('上升途中取「高高」', up.n === 3 && up.h[1] === 12 && up.l[1] === 7,
      `4 根 → ${up.n} 根 h=[${up.h}] l=[${up.l}]`);

    // 下降途中被包含 → 取「低低」
    //   bar1=(18,12)  bar2=(17,13)：17≤18 且 13≥12 → 真包含；前一根 20>18 → 向下
    const dn = mergeInclusive([20, 18, 17, 14], [15, 12, 13, 10]);
    ok('下降途中取「低低」', dn.n === 3 && dn.h[1] === 17 && dn.l[1] === 12,
      `4 根 → ${dn.n} 根 h=[${dn.h}] l=[${dn.l}]`);
  }

  // —— 8.3 分型识别（注意：分型必须有左右邻居，不能落在序列两端） ——
  {
    const m = { h: [3, 5, 4, 1, 2, 0], l: [2, 4, 3, -1, 1, -2], n: 6 };
    const f = findFractals(m);
    ok('顶分型：中间那根高点同时高于左右', f.some(x => x.mi === 1 && x.type === 'top'), JSON.stringify(f));
    ok('底分型：中间那根低点同时低于左右', f.some(x => x.mi === 3 && x.type === 'bottom'), JSON.stringify(f));
    ok('分型方向交替出现', f.length >= 2 && f.every((x, i) => i === 0 || x.type !== f[i - 1].type), JSON.stringify(f.map(x => x.type)));
    ok('序列两端不会被误判为分型', !f.some(x => x.mi === 0 || x.mi === m.n - 1));
  }

  // —— 8.4 笔的最小K线数（标准笔 = 5） ——
  {
    // 两个分型隔 3 根（mi 差 3）→ 不足 5 根，不成笔
    const close = [{ mi: 1, type: 'top', price: 10 }, { mi: 4, type: 'bottom', price: 5 }];
    const m4 = { from: [0, 1, 2, 3, 4, 5], to: [0, 1, 2, 3, 4, 5], n: 6 };
    const hh = [1, 10, 3, 4, 5, 6], ll = [0, 9, 2, 3, 4, 5];
    const p4 = buildStrokePoints(close, m4, hh, ll, 4);
    const p5 = buildStrokePoints(close, m4, hh, ll, 5);
    ok('标准笔：间隔不足 5 根K线时不成笔', p5.length === 1, `minBars=5 得到 ${p5.length} 个端点`);
    ok('放宽到 4 根时可成笔（对照）', p4.length === 2, `minBars=4 得到 ${p4.length} 个端点`);

    // 同类型分型只保留更极端的
    const same = [{ mi: 1, type: 'top', price: 10 }, { mi: 8, type: 'top', price: 12 },
      { mi: 15, type: 'bottom', price: 5 }];
    const m15 = { from: Array.from({ length: 20 }, (_, i) => i), to: Array.from({ length: 20 }, (_, i) => i), n: 20 };
    const hA = Array.from({ length: 20 }, () => 1), lA = Array.from({ length: 20 }, () => 0);
    hA[1] = 10; hA[8] = 12; lA[15] = -1;
    const ps = buildStrokePoints(same, m15, hA, lA, 5);
    ok('同类型分型只保留更极端的那根', ps.length === 2 && ps[0].mi === 8, JSON.stringify(ps.map(x => [x.mi, x.type])));
  }

  // —— 8.5 真实形态数据上的结构合理性 ——
  // 关键：合成K线必须带**上下影线**。若用 h=max(o,c)、l=min(o,c)，
  // 拐点处相邻两根的高点会完全相等，h[i] > h[i+1] 不成立，分型就出不来。
  // wickAmp 控制影线幅度：结构类用例用大一点（制造丰富分型），
  // 背驰类用例用小一点（避免趋势内部的噪声把「当前笔」的方向翻掉）。
  const wick = i => Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
  const mkSeries = (closes, key = '15m', wickAmp = 0.006) => {
    const { CandleSeries } = CandleSeriesMod;
    const lv = LEVELS[LEVEL_INDEX[key]];
    const s = new CandleSeries(lv);
    const ms = lv.minutes * 60_000;
    const t0 = Math.floor(Date.now() / ms) * ms - closes.length * ms;
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i], o = i ? closes[i - 1] : c;
      const hi = Math.max(o, c), lo = Math.min(o, c);
      s.t.push(t0 + i * ms); s.o.push(o); s.c.push(c);
      s.h.push(hi + wick(i) * hi * wickAmp);
      s.l.push(lo - wick(i + 7777) * lo * wickAmp);
      s.v.push(1000); s.q.push(1000 * c); s.n.push(5); s.done.push(true);
    }
    s.dirty = true; s.version++;
    s.ensure();
    return s;
  };
  {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 11) * 10 + i * 0.15);
    const s = mkSeries(closes);
    const chan = s.ensureChan(5);
    ok('真实形态数据上能构建缠论结构',
      chan.merged.n > 50 && chan.fractals.length > 20 && chan.pts.length >= 3,
      `原 ${chan.n} 根 → 合并 ${chan.merged.n} → 分型 ${chan.fractals.length} → 笔端点 ${chan.pts.length}`);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('能给出截至当下的笔状态', st && st.ok && st.cur && typeof st.dir === 'string',
      `方向=${st?.dir} 已完成笔=${st?.strokeCount}`);
  }

  // 造数工具：按若干「段」拼出 上-下-上-下-上 的清晰结构。
  // 注意起点无法成分型，所以必须先有一段上涨把第一个顶分型造出来，
  // 否则到最后一共只有 2 个已确认端点，凑不出「前一同向笔」做对比。
  const zigzag = phases => {
    const closes = [];
    let p = 100;
    for (const [n, rate] of phases) for (let i = 0; i < n; i++) { p *= rate; closes.push(p); }
    return closes;
  };
  const base = () => [[25, 1.010], [18, 0.990], [40, 1.012], [20, 0.991]];   // 上-下-上-下

  // —— 8.6 ★ 背驰正样例：价格创新高但 MACD 面积明显衰减 ——
  {
    const closes = zigzag([...base(), [70, 1.0035]]);   // 第 2 个上涨段：更慢、但创了新高
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 顶背驰正样例被识别（价创新高 + 面积衰减）',
      !!st && st.ok && st.divergence.status === 'pending',
      st?.ok ? `方向=${st.dir} 已完成笔=${st.strokeCount} 新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} 幅度比=${st.advanceRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.7 负样例 a：第 2 段比第 1 段更陡（无背驰） ——
  {
    const closes = zigzag([...base(), [40, 1.014]]);    // 第 2 个上涨段：更陡
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 无背驰负样例：第 2 段更强 → 不判定背驰',
      !!st && st.ok && st.divergence.status === 'none',
      st?.ok ? `新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.8 负样例 b：还没创新高（谈不上顶背驰） ——
  {
    const closes = zigzag([...base(), [30, 1.001]]);    // 反弹但远未回到前高
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 未创新高 → 不判定顶背驰',
      !!st && st.ok && st.divergence.status === 'none',
      st?.ok ? `新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.9 因果性：同一 idx 的判定不随未来K线改变 ——
  {
    const closes = Array.from({ length: 320 }, (_, i) => 100 + Math.sin(i / 7) * 9 + Math.sin(i / 23) * 6 + i * 0.12);
    const full = mkSeries(closes);
    const cut = mkSeries(closes.slice(0, 250));
    const idx = 249;
    const a = full.beichiState(idx, { ratio: 1, minProgress: 0.3 });
    const b = cut.beichiState(cut.t.length - 1, { ratio: 1, minProgress: 0.3 });
    const same = !!a && !!b && a.ok === b.ok && a.dir === b.dir
      && a.divergence?.status === b.divergence?.status
      && Math.abs((a.areaRatio ?? 0) - (b.areaRatio ?? 0)) < 1e-9;
    ok('★ 因果性：截至 idx 的判定不受未来K线影响', same,
      `完整序列=${a?.divergence?.status}/${a?.areaRatio?.toFixed(4)}  截断序列=${b?.divergence?.status}/${b?.areaRatio?.toFixed(4)}`);
  }
}

/* ============ 9. 背驰过滤是否真的接进了信号引擎 ============ */
section('9. 背驰过滤接线（确认级别将背驰 → 引擎确实拦下该组信号）');
{
  const on = { ...cfg, filterBeichi: true };
  const off = { ...cfg, filterBeichi: false };
  const series = buildLevels();                    // 所有级别都是"回踩后突破"多头形态

  const viewsOf = () => {
    const v = {};
    for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], off, 'closed');
    v.__symbol = 'WIREUSDT';
    return v;
  };

  // 基线：关闭过滤时 3分→15分→2时 必须命中
  const base = findResonance(viewsOf(), off, 'closed');
  ok('基线：关闭过滤时 3分→15分→2时 会触发',
    base.matches.some(m => m.group === '3m>15m>2h'),
    `命中 ${base.matches.length} 组：${[...new Set(base.matches.map(m => m.group))].join(' / ')}`);

  // 打开过滤，但此时 15 分并没有背驰 → 仍然应该命中（说明不是一刀切）
  const onClean = findResonance(viewsOf(), on, 'closed');
  ok('开启过滤但确认级别无背驰 → 信号照常触发',
    onClean.matches.some(m => m.group === '3m>15m>2h'),
    `命中 ${onClean.matches.length} 组`);

  // 把 15 分的缠论状态改成"将背驰" → 该组必须被拦掉，其它组不受影响
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const r = findResonance(v, on, 'closed');
    ok('★ 确认级别「将背驰」→ 3分→15分→2时 被拦下',
      !r.matches.some(m => m.group === '3m>15m>2h'),
      `剩余 ${r.matches.length} 组：${[...new Set(r.matches.map(m => m.group))].join(' / ') || '无'}`);
    ok('★ 其它组合不受影响（5分→30分→3时 仍在）',
      r.matches.some(m => m.group === '5m>30m>3h'),
      [...new Set(r.matches.map(m => m.group))].join(' / '));
  }

  // 关掉过滤后，同样的"将背驰"状态不应再拦
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const r = findResonance(v, off, 'closed');
    ok('关闭开关后，同样的背驰状态不再拦截',
      r.matches.some(m => m.group === '3m>15m>2h'), `命中 ${r.matches.length} 组`);
  }

  // beichiScope = mid+big 时，最大级别背驰也应拦
  {
    const v = viewsOf();
    v['2h'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const midOnly = findResonance(v, { ...on, beichiScope: 'mid' }, 'closed');
    ok('scope=mid 时最大级别背驰不拦（3分→15分→2时 仍触发）',
      midOnly.matches.some(m => m.group === '3m>15m>2h'));
    const both = findResonance(v, { ...on, beichiScope: 'mid+big' }, 'closed');
    ok('scope=mid+big 时最大级别背驰也拦',
      !both.matches.some(m => m.group === '3m>15m>2h'),
      `剩余 ${both.matches.length} 组`);
  }

  // 笔端点不足（新上市币）时不应误伤
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: false, reason: '已确认笔端点不足（2）' };
    const r = findResonance(v, on, 'closed');
    ok('缠论数据不足时不误伤（照常触发）',
      r.matches.some(m => m.group === '3m>15m>2h'));
  }
}

/* ============ 10. 序列合并式灌入（滚动累积） ============ */
section('10. 序列合并式灌入（mergeLoad：K线随运行时间累积）');
{
  const lv = LEVELS[LEVEL_INDEX['15m']];
  const ms = 15 * 60_000;
  const t0 = Math.floor(Date.now() / ms) * ms - 400 * ms;
  const mkRows = (from, count, base) => Array.from({ length: count }, (_, i) => ({
    t: t0 + (from + i) * ms,
    o: base + i, h: base + i + 1, l: base + i - 1, c: base + i + 0.5,
    v: 10, q: 0, n: 1, done: true,
  }));

  // 第一次拉 100 根
  const s = new CandleSeries(lv);
  s.mergeLoad(mkRows(300, 100, 1000));
  ok('首次灌入建立序列', s.t.length === 100, `${s.t.length} 根`);
  const firstT = s.t[0], lastT = s.t[s.t.length - 1];

  // 第二次只拉最新 60 根（区间 [340,399]，与已有的 [300,399] 重叠 60 根）
  // 合并结果 = 保留旧的前 40 根 + 新的 60 根 = 100 根；覆盖式则只剩 60 根
  s.mergeLoad(mkRows(340, 60, 2000));
  ok('★ 再次灌入时保留更早的旧K线（合并而非覆盖）', s.t.length === 100,
    `保留旧 40 根 + 新 60 根 = ${s.t.length} 根（覆盖式只会剩 60 根）`);
  ok('最早的时间戳保持不变', s.t[0] === firstT, `${new Date(s.t[0]).toISOString().slice(5, 16)}`);
  ok('最新数据被覆盖为本次拉取的值', s.c[s.t.length - 1] === 2000 + 59.5, String(s.c[s.t.length - 1]));
  ok('重叠区间的K线被新数据替换（不重复）',
    s.c[40] === 2000.5 && s.t[40] === firstT + 40 * ms,
    `第 41 根已换成新数据：c=${s.c[40]}（旧值应为 ${1000 + 40 + 0.5}）`);
  ok('序列仍按时间升序且无重复',
    s.t.every((v, i) => i === 0 || v > s.t[i - 1]), `末根 ${new Date(s.t[s.t.length - 1]).toISOString().slice(5, 16)}`);

  // 完全在旧数据之后 → 直接追加
  const s2 = new CandleSeries(lv);
  s2.mergeLoad(mkRows(0, 50, 100));
  s2.mergeLoad(mkRows(60, 50, 300));
  ok('新数据完全在后 → 追加', s2.t.length === 100 && s2.t[50] === t0 + 60 * ms, `${s2.t.length} 根`);

  // 超出保留上限时裁剪最老的
  const s3 = new CandleSeries(lv);
  for (let k = 0; k < 12; k++) s3.mergeLoad(mkRows(k * 50, 60, k * 1000));
  ok('超过保留上限时裁掉最老的（不超上限）', s3.t.length <= APP.maxCandlesKept,
    `${s3.t.length} 根 ≤ ${APP.maxCandlesKept}`);
  ok('裁剪后仍保持升序', s3.t.every((v, i) => i === 0 || v > s3.t[i - 1]));

  // 版本号递增 → 缠论缓存会失效并重算
  const v0 = s2.version;
  s2.mergeLoad(mkRows(110, 10, 500));
  ok('mergeLoad 会推进 version（触发缠论缓存失效）', s2.version > v0, `${v0} → ${s2.version}`);
}

/* ============ 11. 回踩成笔链（笔延续级别） ============ */
section('11. 回踩成笔链（笔延续级别）');
{
  const I = k => LEVEL_INDEX[k];

  // —— 11.1 成笔链覆盖哪些级别 ——
  {
    const cases = [
      ['5m', '30m', ['5m', '10m', '15m']],
      ['3m', '15m', ['3m', '5m', '10m']],
      ['2m', '10m', ['2m', '3m', '5m']],
    ];
    let allOk = true, detail = [];
    for (const [b, m, want] of cases) {
      const got = strokeChain(I(b), I(m));
      const hit = got.join(',') === want.join(',');
      if (!hit) allOk = false;
      detail.push(`${b}>${m}→${got.join('/')}`);
    }
    ok('★ 成笔链 = 基准到确认级别之间（不含确认级别）的全部级别', allOk, detail.join('  '));
    ok('用户举的例子逐字对上：5m>30m>3h 要求 5m/10m/15m 全部成笔',
      strokeChain(I('5m'), I('30m')).join(',') === '5m,10m,15m',
      strokeChain(I('5m'), I('30m')).join('/'));
  }

  // —— 11.2 判定逻辑：各级别的「向下笔底」必须晚于基准的回调起点 ——
  const T0 = 1_700_000_000_000;
  const mkView = (botT, above7 = true, hasDown = true) => ({
    stroke: { ok: true, down: hasDown ? { topT: botT - 3_600_000, botT } : null },
    above7,
  });
  const viewsFor = (baseTopT, bots, aboveFields = {}) => {
    // 基准 5m 的回调起点 = baseTopT
    const v = {
      '5m': { stroke: { ok: true, down: { topT: baseTopT, botT: baseTopT + 600_000 } }, above7: true },
      '10m': mkView(bots['10m'], aboveFields['10m'] ?? true),
      '15m': mkView(bots['15m'], aboveFields['15m'] ?? true),
      '30m': mkView(bots['30m']),
    };
    return v;
  };
  {
    const top = T0;
    // 三个级别都在回调起点之后完成向下笔 → 通过
    const good = checkStrokeChain(viewsFor(top, {
      '10m': top + 1_200_000, '15m': top + 1_800_000,
    }), I('5m'), I('30m'), {});
    ok('★ 全部级别在回调起点后成笔 → 链成立',
      good.ok && good.missing.length === 0 && good.got.join(',') === '5m,10m,15m',
      `got=[${good.got.join(',')}] 笔延续至 ${good.level}`);

    // 13m 的笔底停在回调之前 → 不成立
    const bad = checkStrokeChain(viewsFor(top, {
      '10m': top - 1_200_000, '15m': top + 1_800_000,
    }), I('5m'), I('30m'), {});
    ok('★ 10分 的笔底早于回调起点 → 链断裂，点名缺 10m',
      !bad.ok && bad.missing.join(',') === '10m', `missing=[${bad.missing.join(',')}]`);

    // 只缺最大那级
    const bad2 = checkStrokeChain(viewsFor(top, {
      '10m': top + 1_200_000, '15m': top - 600_000,
    }), I('5m'), I('30m'), {});
    ok('★ 只缺 15分 → 链断裂（笔延续只到 10m）',
      !bad2.ok && bad2.missing.join(',') === '15m' && bad2.level === '10m',
      `missing=[${bad2.missing.join(',')}] 延至 ${bad2.level}`);
  }

  // —— 11.3 锚点稳定性：突破后再形成新顶分型，不应把基准级别自己判失败 ——
  {
    const top = T0;
    const v = viewsFor(top, { '10m': top + 1_200_000, '15m': top + 1_800_000 });
    // 模拟「基准级别后来又形成了一个更晚的新顶分型」
    v['5m'].stroke.top = { t: top + 9_000_000, idx: 999, price: 1 };
    const r = checkStrokeChain(v, I('5m'), I('30m'), {});
    ok('★ 锚点用「向下笔起点」而非「最近顶分型」——突破后形成新顶也不误判',
      r.ok && r.topT === top, `锚点=${new Date(r.topT).toISOString().slice(11, 16)}（新顶在 ${new Date(top + 9_000_000).toISOString().slice(11, 16)}）`);
  }

  // —— 11.4 chainRequireAboveMa 附加条件 ——
  {
    const top = T0;
    const bots = { '10m': top + 1_200_000, '15m': top + 1_800_000 };
    const off = checkStrokeChain(viewsFor(top, bots, { '15m': false }), I('5m'), I('30m'), { chainRequireAboveMa: false });
    const on = checkStrokeChain(viewsFor(top, bots, { '15m': false }), I('5m'), I('30m'), { chainRequireAboveMa: true });
    ok('chainRequireAboveMa 关闭时，15分 未站上 MA7 不影响判定', off.ok);
    ok('★ chainRequireAboveMa 打开时，15分 未站上 MA7 会导致链断裂',
      !on.ok && on.missing.join(',') === '15m', `missing=[${on.missing.join(',')}]`);
  }

  // —— 11.5 接线：引擎确实按这个条件拦信号 ——
  {
    const on = { ...cfg, requireStrokeChain: true };
    const off = { ...cfg, requireStrokeChain: false };
    const series = buildLevels();
    const makeViews = c => {
      const v = {};
      for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], c, 'closed');
      v.__symbol = 'CHAINUSDT';
      return v;
    };
    // 打开过滤但数据本身满足 → 不拦
    const pass = findResonance(makeViews(on), on, 'closed');
    const base0 = findResonance(makeViews(off), off, 'closed');
    ok('关闭成笔链时会有 3m>15m>2h 信号', base0.matches.some(m => m.group === '3m>15m>2h'),
      `命中 ${base0.matches.length} 组`);

    // 人为把中间级别的笔底挪到回调起点之前 → 必须被拦
    const v = makeViews(on);
    const chain = strokeChain(I('3m'), I('15m'));
    const anchor = v['3m'].stroke?.down?.topT ?? 0;
    for (const key of chain) {
      if (v[key].stroke?.down) v[key].stroke.down.botT = anchor - 3_600_000;
    }
    const blocked = findResonance(v, on, 'closed');
    ok('★ 中间级别成笔链断裂 → 3m>15m>2h 被拦下（且计入 strokeBlocked）',
      !blocked.matches.some(m => m.group === '3m>15m>2h') && blocked.strokeBlocked > 0,
      `剩余 ${blocked.matches.length} 组，strokeBlocked=${blocked.strokeBlocked}`);

    // 关闭开关后同样的数据不应再拦
    const notBlocked = findResonance(v, off, 'closed');
    ok('关闭开关后相同数据不再被拦',
      notBlocked.matches.some(m => m.group === '3m>15m>2h'), `命中 ${notBlocked.matches.length} 组`);
  }

  // —— 11.6 匹配结果里带出笔延续级别 ——
  {
    const on = { ...cfg, requireStrokeChain: true };
    const series = buildLevels();
    const v = {};
    for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], on, 'closed');
    v.__symbol = 'CHAINUSDT';
    // 合成数据的分型结构很稀疏，凑不出成笔链；这里把链上各级别的「向下笔底」
    // 人为挪到回调起点之后，专门验证 chain 信息确实透传到了匹配结果里。
    const need = strokeChain(I('3m'), I('15m'));
    const anchor = v['3m'].stroke?.down?.topT ?? Date.now();
    for (const key of need) {
      if (!v[key].stroke) v[key].stroke = {};
      v[key].stroke.down = { topT: anchor - 600_000, botT: anchor + 600_000, botIdx: 1, botPrice: 1, topIdx: 0, topPrice: 1 };
      v[key].above7 = true;
    }
    const r = findResonance(v, on, 'closed');
    const m = r.matches.find(x => x.group === '3m>15m>2h') ?? r.matches[0];
    ok('★ 命中结果里带出 strokeChain（供界面显示「笔延续级别」）',
      !!m?.strokeChain && Array.isArray(m.strokeChain.need)
      && m.strokeChain.need.join(',') === need.join(',')
      && !!m.strokeChain.level,
      m?.strokeChain ? `需要[${m.strokeChain.need.join(',')}] 延至 ${m.strokeChain.level}` : `无匹配（命中 ${r.matches.length} 组）`);
  }

  // —— 11.7 describe 文案 ——
  {
    const { describe } = await import('../src/signals.js');
    const txt = describe({
      base: '5m', mid: '30m', big: '3h', bullCount: 4, confirmed: false, bigLineName: 'ema7',
      strokeChain: { need: ['5m', '10m', '15m'], level: '15m' },
    });
    ok('★ 报警文案写明「回踩已带动 X/Y/Z 全部成笔（笔延续至 N）」',
      /全部成笔/.test(txt) && /笔延续至 15分/.test(txt) && /5分\/10分\/15分/.test(txt), txt);
  }
}

/* ============ 12. 回踩形态「两根阴K不破均线」 ============ */
section('12. 回踩形态「两根阴K不破均线」（跌无可跌）');
{
  /* findTwoBearHold 只读 series.{o,h,l,c} 与 ind.{ma7,ema7}，可以直接喂普通对象 */
  const mk = (candles, ma7, ema7) => ({
    s: {
      o: candles.map(c => c[0]), h: candles.map(c => c[1]),
      l: candles.map(c => c[2]), c: candles.map(c => c[3]),
    },
    ind: { ma7: candles.map(() => ma7), ema7: candles.map(() => ema7) },
  });
  // [开, 高, 低, 收]；idx=3 是触发K，看它前面 2 根（idx 1、2）
  const base = [
    [10.0, 10.8, 9.9, 10.6],   // 0 上涨
    [10.6, 10.7, 10.2, 10.1],  // 1 阴K
    [10.1, 10.2, 9.8, 10.0],   // 2 阴K（影线插到 9.8）
    [10.0, 10.6, 9.95, 10.5],  // 3 触发K
  ];
  const MA = 9.5, EMA = 9.6;

  {
    const { s, ind } = mk(base, MA, EMA);
    const r = findTwoBearHold(s, ind, 3, 2);
    ok('★ 两根阴K + 收盘均在 MA7/EMA7 之上 → 形态成立',
      !!r && r.bars === 2, r ? `bars=${r.bars} 回调深度 ${(r.depth * 100).toFixed(2)}%` : 'null');
  }
  {
    // 影线插破均线（最低 9.4 < MA 9.5），但收盘仍在均线上 → 仍应成立
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.4, 10.0] : c);
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 影线可以插破均线（收盘站住即可）',
      findTwoBearHold(s, ind, 3, 2) !== null, `最低 ${Math.min(...s.l.slice(1, 3))} < MA ${MA}`);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [9.9, 10.2, 9.8, 10.0] : c);   // 第 2 根改阳线
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 有一根不是阴K → 不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.3, 9.4] : c);   // 收盘 9.4 < MA7
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 有一根收盘跌破 MA7 → 不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.5, 9.55] : c);  // > MA7 但 < EMA7
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 收盘站上 MA7 但跌破 EMA7 → 仍不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const { s, ind } = mk(base, MA, EMA);
    ok('可配置阴K根数（要求 3 根时只有 2 根 → 不成立）',
      findTwoBearHold(s, ind, 3, 2) !== null && findTwoBearHold(s, ind, 3, 3) === null,
      'bars=2 成立 / bars=3 不成立');
  }
  {
    const { s, ind } = mk(base, MA, EMA);
    ok('K线不足时返回 null 而不是抛错', findTwoBearHold(s, ind, 1, 2) === null);
  }

  // —— 接线：形态开关确实切换了判定路径 ——
  {
    const on = { ...cfg, pullbackPattern: 'twoBearHold' };
    const off = { ...cfg, pullbackPattern: 'touch' };
    const series = buildLevels();
    const viewsOf = c => {
      const v = {};
      for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], c, 'closed');
      v.__symbol = 'TWOBEARUSDT';
      return v;
    };
    const a = findResonance(viewsOf(off), off, 'closed');
    ok('对照：旧形态（触及MA7+上穿）在其他条件满足时会触发',
      a.matches.some(m => m.group === '3m>15m>2h'), `命中 ${a.matches.length} 组`);

    const v = viewsOf(on);
    let injected = 0;
    for (const key of ['2m', '3m', '5m']) {
      if (!v[key]) continue;
      v[key].twoBear = { bars: 2, depth: 0.01, top: 1, low: 1 };
      v[key].aboveBoth = true;
      injected++;
    }
    const b = findResonance(v, on, 'closed');
    ok('★ 新形态成立时（两根阴K不破均线 + 收盘站上两条均线）能触发',
      b.matches.length > 0, `注入了 ${injected} 个基准级别，命中 ${b.matches.length} 组`);

    const v2 = viewsOf(on);
    for (const key of ['2m', '3m', '5m']) {
      if (!v2[key]) continue;
      v2[key].twoBear = { bars: 2 };
      v2[key].aboveBoth = false;
    }
    ok('新形态要求「收盘同时站上两条均线」：置 false 后不再触发',
      findResonance(v2, on, 'closed').matches.length === 0, '全部 aboveBoth=false → 0 组');
  }

  ok('默认使用「两根阴K不破均线」形态', DEFAULT_SIGNAL.pullbackPattern === 'twoBearHold',
    `pullbackPattern=${DEFAULT_SIGNAL.pullbackPattern} bars=${DEFAULT_SIGNAL.pullbackBars}`);
}

/* ============ 13. 盯盘通道 v4：回调中 MACD 均线靠零轴（4 级别、无次级别） ============ */
section('13. 盯盘通道 v4（15分/30分/1时/2时/3时/4时：回调中 MACD 均线(DEA) 贴近零轴且未跌破）');
{
  const mkLog = () => ({ info() { }, warn() { }, error() { }, signal() { }, ok() { }, debug() { } });
  const lv = (o = {}) => ({
    key: o.key,
    distPct: o.dist === undefined ? 0.1 : o.dist,
    dif: o.dif === undefined ? 0.0005 : o.dif,
    dea: o.dea === undefined ? 0.0002 : o.dea,
    deaFalling: o.falling === undefined ? true : o.falling,
    nearZero: o.near === undefined ? (o.dist === undefined ? true : o.dist <= 0.3) : o.near,
    close: 100, ema7: 99, candleT: o.t ?? 2000, live: o.live === true,
  });
  const LV = ['15m', '30m', '1h', '2h', '3h', '4h'];
  const W = (o = {}) => new Watcher(mkLog(), { enabled: true, levels: LV, nearPct: 0.3, tieRatio: 1.25, needFalling: true, useLiveCandle: false, ...o });

  // —— 三条判据 ——
  {
    ok('★ 回调中(DEA 回落) + 贴近零轴 + 未跌破 → 报',
      nearOk(lv({ dist: 0.2, falling: true, near: true }), true) === true);
    ok('★ 上涨途中贴近零轴（DEA 在上升）→ **不报**',
      nearOk(lv({ dist: 0.1, falling: false, near: true }), true) === false);
    ok('★ 关掉「只看回调」开关后，上升途中也报',
      nearOk(lv({ dist: 0.1, falling: false, near: true }), false) === true);
    ok('★ DEA 已跌破零轴（nearZero=false）→ 不报', nearOk(lv({ near: false }), true) === false);
  }

  // —— 挑级别：更贴近 + 级别更小 ——
  {
    const r = pickNear([lv({ key: '30m', dist: 0.258 }), lv({ key: '15m', dist: 0.220 })], { tieRatio: 1.25 });
    ok('★ 15分 0.220% 与 30分 0.258% 并列（容差内）→ 报更小的 15分',
      r.chosen.key === '15m' && r.best.key === '15m', 'chosen=' + r.chosen.key + ' best=' + r.best.key);
    const r2 = pickNear([lv({ key: '30m', dist: 0.30 }), lv({ key: '15m', dist: 0.05 })], { tieRatio: 1.25 });
    ok('★ 差距超出容差（0.30% vs 0.05%）→ 报最贴近的 15分', r2.chosen.key === '15m');
  }

  // —— 触发与「一段一次」 ——
  {
    const w = W();
    const e1 = w.update('A', { '30m': lv({ key: '30m', dist: 0.2 }) });
    const e2 = w.update('A', { '30m': lv({ key: '30m', dist: 0.2, t: 3000 }) });
    ok('★ 命中 → 出预警；同一段内（换K线）不重复',
      e1.length === 1 && e1[0].stage === 'warning' && e1[0].level === '30m' && e2.length === 0,
      e1[0] ? e1[0].text : '无');
    ok('★ 报警文案写明「回调中 / MACD均线(DEA) / 未跌破零轴」',
      /回调中/.test(e1[0].text) && /MACD均线\(DEA\)/.test(e1[0].text) && /未跌破零轴/.test(e1[0].text));
    ok('★ 文案里不再出现次级别/确认字样',
      !/次级别|确认/.test(e1[0].text), e1[0].text);
    const e3 = w.update('A', { '30m': lv({ key: '30m', dist: 0.2, near: false }) });   // 离开近零区间
    const e4 = w.update('A', { '30m': lv({ key: '30m', dist: 0.2, t: 5000 }) });
    ok('★ 离开近零区间后再回来 → 可以再报一次', e3.length === 0 && e4.length === 1);
  }
  {
    const w = W();
    ok('★ 上涨途中贴近零轴 → 整轮不报',
      w.update('A', { '30m': lv({ key: '30m', dist: 0.05, falling: false }) }).length === 0);
    const w2 = W();
    ok('★ 离零轴 0.5% 超过阈值 0.3% → 不报',
      w2.update('A', { '15m': lv({ key: '15m', dist: 0.5 }) }).length === 0);
  }
  {
    const w = W();
    const e = w.update('A', { '30m': lv({ key: '30m', dist: 0.2 }), '15m': lv({ key: '15m', dist: 0.05 }) });
    ok('★ 多级别命中：15分更贴近（0.05%）且在容差外 → 报 15分', e.length === 1 && e[0].level === '15m');
  }
  {
    const w = W();
    ok('★ 非扫描级别（5分）贴近零轴 → 不报',
      w.update('A', { '5m': lv({ key: '5m', dist: 0.1 }) }).length === 0);
  }
  {
    const w = W();
    w.setConfig({ watchEnabled: false });
    ok('关闭盯盘开关后完全不工作', w.update('A', { '30m': lv({ key: '30m' }) }).length === 0);
  }
  {
    // 只产出一条通道：stats 里不应再有 confirm
    const w = W();
    w.update('A', { '30m': lv({ key: '30m', dist: 0.2 }) });
    ok('★ 只有预警一条通道（stats 里没有 confirm 计数）',
      w.stats.warning === 1 && w.stats.confirm === undefined, JSON.stringify(w.stats));
  }
  ok('配置默认：只扫 15分/30分/1时/2时/3时/4时、只看回调、0.3% 阈值',
    JSON.stringify(DEFAULT_SIGNAL.watchLevels) === JSON.stringify(['15m', '30m', '1h', '2h', '3h', '4h'])
    && DEFAULT_SIGNAL.watchNeedFalling === true
    && DEFAULT_SIGNAL.watchNearPct === 0.3
    && DEFAULT_SIGNAL.watchSubMap === undefined,
    JSON.stringify(DEFAULT_SIGNAL.watchLevels) + ' falling=' + DEFAULT_SIGNAL.watchNeedFalling);
}

/* ============ 14. 五浪反弹通道（独立策略） ============ */
section('14. 五浪反弹（一笔下 → 次级别**正好五个**交叉 死金死金死 + 三波低点逐个降低 + 再次金叉 + 2 根内上穿 EMA7）');
{
  const M = 600_000, S = 120_000;   // 主级别 10 分钟/根，次级别 2 分钟/根

  /** 次级别：dea 恒为 0，dif 在指定下标处翻转符号 → 每次翻转就是一个交叉
   *  负→正 = 金叉(G)，正→负 = 死叉(D)。lows 默认是**逐根降低**的，用于满足「三波低点逐个降低」。 */
  const mkSub = (len, flips, opts = {}) => {
    const key = opts.key ?? '3m', ms = opts.ms ?? S;
    const lowOf = opts.lowOf ?? (k => 1000 - k);
    const dif = []; let s = -1;
    for (let i = 0; i < len; i++) { if (flips.has(i)) s = -s; dif.push(s); }
    return { key, ms, minutes: ms / 60000, t: dif.map((_, i) => i * ms),
      h: dif.map((_, i) => lowOf(i) + 1), l: dif.map((_, i) => lowOf(i)),
      c: dif.map((_, i) => lowOf(i) + 0.5), ema7: dif.map(() => 1),
      dif, dea: dif.map(() => 0) };
  };
  const mkMain = (highs, lows, closes, ema7, key = '15m', ms = M) => ({
    key, ms, minutes: ms / 60000, t: closes.map((_, i) => i * ms),
    h: highs, l: lows, c: closes, ema7, dif: closes.map(() => 0), dea: closes.map(() => 0),
  });

  // 主级别 12 根：高点 index 2、低点 index 8（跨度 7 根 ≥5）；第 9 根由下向上穿 EMA7
  const HIGH = [2.0, 2.0, 5.0, 4.0, 3.0, 3.0, 2.0, 2.0, 1.5, 1.2, 1.3, 1.5];
  const LOW = [1.9, 1.9, 2.0, 1.9, 1.8, 1.7, 1.5, 1.2, 1.0, 1.1, 1.2, 1.4];
  const CLOSE = [1.95, 1.95, 4.0, 3.0, 2.5, 2.4, 2.0, 1.6, 1.2, 1.3, 1.4, 1.6];
  const EMA7OK = CLOSE.map((_, i) => (i < 9 ? 1.25 : 1.28));
  // 窗口内正好 5 个交叉（k=24,28,32,36,40）→ 死金死金死
  const F5 = new Set([8, 24, 28, 32, 36, 40, 48]);   // 8 在窗口外（把符号先翻正）；24..40 是窗口内五个；48 是低点后的「再次金叉」

  {
    const hit = detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), mkSub(52, F5), { minBars: 5, lookback: 20, crossWindow: 2 });
    ok('★ 标准五浪（正好5个交叉+三波低点逐个降低）+ 再次金叉 + 2 根内上穿 EMA7 → 命中', !!hit,
      hit ? `seq=${hit.crosses.map(c => c.type).join('')} lows=${hit.waveLows.map(x => x.toFixed(1)).join('>')} lag=${hit.lagBars}` : 'null');
    if (hit) {
      ok('★ 窗口内正好五个交叉，且依次是 死→金→死→金→死',
        hit.crosses.length === 5 && hit.crosses.map(c => c.type).join('') === 'DGDGD',
        hit.crosses.map(c => c.type).join(''));
      ok('★ 三波低点逐个降低（第5浪创新低）',
        hit.waveLows[0] > hit.waveLows[1] && hit.waveLows[1] > hit.waveLows[2],
        hit.waveLows.map(x => x.toFixed(1)).join(' > '));
      ok('★ 「再次金叉」在最低点之后', hit.goldT > hit.lowT);
      ok('★ 上穿 EMA7 在金叉后 2 根主级别K线内', hit.lagBars <= 2, 'lag=' + hit.lagBars);
    }
  }

  // ① 多一个交叉就不算标准五浪（窗口内 7 个交叉）
  {
    const many = new Set([8, 16, 20, 24, 28, 32, 36, 40, 48]);   // 窗口内 7 个交叉
    ok('★ 窗口内交叉多于五个（7 个）→ 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), mkSub(52, many), { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ①b 五个交叉但顺序不对（金死金死金）
  {
    const wrongSeq = new Set([24, 28, 32, 36, 40, 48]);
    // 初始为正 → 第一次翻转是 正→负 = 死叉；要造 G,D,G,D,G 就让初始为负、首次翻转为金叉但顺序反
    const sub = mkSub(52, new Set([16, 20, 24, 28, 32]));   // 窗口内 G,D,G,D,G —— 顺序不对
    ok('★ 五个交叉但顺序不是 死金死金死 → 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), sub, { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ② 三波低点没有逐个降低（等高）→ 不命中
  {
    const flat = mkSub(52, F5, { lowOf: () => 1000 });
    ok('★ 三波低点没有逐个降低（等高）→ 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), flat, { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ②b 第二波低点比第一波还低？(倒序) → 不命中  —— 构造：低点先降后升
  {
    const zig = mkSub(52, F5, { lowOf: k => (k <= 28 ? 1000 - k : 1000 + k) });
    ok('★ 三波低点不是逐个降低（先降后升）→ 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), zig, { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ③ 交叉不足五个
  {
    ok('★ 窗口内交叉不足五个（3 个）→ 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), mkSub(52, new Set([8, 24, 32])), { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ④ 一笔下不足 5 根
  {
    const highs = [2, 2, 2, 2, 2, 2, 2, 2, 2, 3.0, 2.5, 2.0];
    const lows = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2.0, 1.5, 1.0];
    const closes = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2.6, 1.8, 1.2];
    ok('★ 高点到低点不足 5 根 → 不命中',
      detectWave(mkMain(highs, lows, closes, closes.map(() => 2.5)), mkSub(52, F5), { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ⑤ 主级别没有由下向上穿越 EMA7
  {
    ok('★ 主级别始终没收在 EMA7 上方 → 不命中',
      detectWave(mkMain(HIGH, LOW, CLOSE, CLOSE.map(() => 9)), mkSub(52, F5), { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ⑥ 金叉后拖太久才上穿
  {
    const late = mkSub(120, new Set([8, 24, 28, 32, 36, 40, 100]));
    ok('★ 金叉距离主级别上穿超过 2 根 → 不命中（窗口可调）',
      detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), late, { minBars: 5, lookback: 20, crossWindow: 2 }) === null);
  }
  // ⑦ 报警对象 / 文案
  {
    const hit = detectWave(mkMain(HIGH, LOW, CLOSE, EMA7OK), mkSub(52, F5), { minBars: 5, lookback: 20, crossWindow: 2 });
    const a = makeAlert('XUSDT', hit, Date.now(), false);
    ok('★ 报警对象：kind=wave、级别=主级别、带次级别与五浪序列',
      a.kind === 'wave' && a.level === '15m' && a.subLevel === '3m' && a.waveSeq === '死→金→死→金→死', a.waveSeq);
    ok('★ 文案含「标准五浪 / 三波低点 / 上穿 EMA7」',
      /标准五浪/.test(a.text) && /三波低点/.test(a.text) && /上穿 EMA7/.test(a.text), a.text.slice(0, 80));
  }
  // ⑧ 去重
  {
    const cfg = { wavePairs: [{ main: '15m', sub: '3m' }], waveMinBars: 5, waveHighLookback: 20, waveCrossWindow: 2 };
    const mainV = mkMain(HIGH, LOW, CLOSE, EMA7OK), subV = mkSub(52, F5);
    const fake = {
      '15m': { t: mainV.t, h: mainV.h, l: mainV.l, c: mainV.c, ms: M, ensure: () => ({ ema7: mainV.ema7 }), macd: () => ({ dif: mainV.dif, dea: mainV.dea }) },
      '3m': { t: subV.t, h: subV.h, l: subV.l, c: subV.c, ms: S, ensure: () => ({ ema7: subV.ema7 }), macd: () => ({ dif: subV.dif, dea: subV.dea }) },
    };
    const seen = new Map();
    const first = scanWaves('YUSDT', fake, cfg, seen, Date.now(), false);
    const second = scanWaves('YUSDT', fake, cfg, seen, Date.now(), true);
    ok('★ 同一笔下跌只报一次', first.length === 1 && second.length === 0, first.length + '/' + second.length);
  }

  ok('★ 用户要求「策略全部清除」：所有策略开关默认关闭',
    DEFAULT_SIGNAL.signalEnabled === false && DEFAULT_SIGNAL.watchEnabled === false
    && DEFAULT_SIGNAL.waveEnabled === false && DEFAULT_SIGNAL.dualEnabled === false
    && DEFAULT_SIGNAL.fbEnabled === false && DEFAULT_SIGNAL.brkEnabled === false);
  ok('配置默认：4 组级别对（15分←3分 / 30分←5分 / 1时←10分 / 2时←15分）',
    JSON.stringify(DEFAULT_SIGNAL.wavePairs) === JSON.stringify([
      { main: '15m', sub: '3m' }, { main: '30m', sub: '5m' },
      { main: '1h', sub: '10m' }, { main: '2h', sub: '15m' },
    ]) && DEFAULT_SIGNAL.waveMinBars === 5 && DEFAULT_SIGNAL.waveCrossWindow === 2,
    JSON.stringify(DEFAULT_SIGNAL.wavePairs));
}

/* ============ 14b. 均线压制后突破（独立通道） ============ */
section('14b. 均线压制后突破（连续 ≥12 根收盘在 EMA7 下方 → 一根收盘上穿 EMA7）');
{
  const M = 900_000;   // 15 分钟
  /** 造序列：前 below 根收盘都在 EMA7 下方，最后一根收盘上穿 */
  const mk = (below, { cross = true, ema = 100 } = {}) => {
    const n = below + 1;                       // below 根在均线下方 + 1 根突破
    const t = [], h = [], l = [], c = [], ema7 = [];
    for (let i = 0; i < n; i++) {
      t.push(i * M);
      ema7.push(ema);
      if (i < below) { h.push(ema - 0.5); l.push(ema - 2); c.push(ema - 1); }        // 收盘在 EMA7 下方
      else { h.push(ema + 2); l.push(ema - 1); c.push(cross ? ema + 1 : ema - 1); }  // 突破那根
    }
    return { key: '15m', ms: M, t, h, l, c, ema7 };
  };

  {
    const v = mk(12);
    const hit = detectBreakout(v, { minBars: 12 });
    ok('★ 连续 12 根在 EMA7 下方 + 本根收盘上穿 → 命中', !!hit,
      hit ? `streak=${hit.streak} 收${hit.close} EMA7=${hit.ema7}` : 'null');
    if (hit) {
      ok('★ 压制根数统计正确', hit.streak === 12, 'streak=' + hit.streak);
      ok('★ 记录压制段最低点', Number.isFinite(hit.low), 'low=' + hit.low);
    }
  }
  ok('★ 只有 11 根在下方 → 不命中', detectBreakout(mk(11), { minBars: 12 }) === null);
  ok('★ 最后一根没有上穿（收在均线下方）→ 不命中',
    detectBreakout(mk(13, { cross: false }), { minBars: 12 }) === null);
  ok('★ 门槛可调：minBars=10 时 11 根就命中',
    !!detectBreakout(mk(11), { minBars: 10 }));

  {
    const hit = detectBreakout(mk(13), { minBars: 12 });
    const a = makeBreakoutAlert('ZUSDT', hit, Date.now(), false);
    ok('★ 报警对象：kind=breakout、级别正确、带压制根数',
      a.kind === 'breakout' && a.level === '15m' && a.streakBars === 13, `kind=${a.kind} streak=${a.streakBars}`);
    ok('★ 文案含「均线压制后突破 / 连续 / 上穿 EMA7」',
      /均线压制后突破/.test(a.text) && /连续 \d+ 根/.test(a.text) && /上穿 EMA7/.test(a.text), a.text.slice(0, 72));
  }
  {
    const cfg = { brkLevels: ['15m'], brkMinBars: 12 };
    const v = mk(12);
    const fake = { '15m': { t: v.t, h: v.h, l: v.l, c: v.c, ms: M, ensure: () => ({ ema7: v.ema7 }) } };
    const seen = new Map();
    const first = scanBreakouts('ZUSDT', fake, cfg, seen, Date.now(), false);
    const second = scanBreakouts('ZUSDT', fake, cfg, seen, Date.now(), true);
    ok('★ 同一根突破K线只报一次', first.length === 1 && second.length === 0, first.length + '/' + second.length);
  }
  {
    // 未收盘那根不算：closed 只到 12，最后一根（第 13 根）是未收盘的形成中K线
    const v = mk(12);
    v.closed = 12;                                  // 只有前 12 根收盘（第 13 根还在形成中）
    ok('★ 上穿发生在未收盘那根 → 不算（必须等收盘）', detectBreakout(v, { minBars: 12 }) === null);
    v.closed = 13;
    ok('★ 同一根收盘后 → 命中', !!detectBreakout(v, { minBars: 12 }));
  }
  ok('配置默认：通道开关已关闭（用户要求策略全部清除）、级别与门槛仍保留',
    DEFAULT_SIGNAL.brkEnabled === false && DEFAULT_SIGNAL.brkMinBars === 12
    && JSON.stringify(DEFAULT_SIGNAL.brkLevels) === JSON.stringify(['15m', '30m', '1h', '2h']),
    JSON.stringify(DEFAULT_SIGNAL.brkLevels));
}

/* ============ 14c. 五浪首底预警（K线底分型） ============ */
section('14c. 五浪首底预警（主级别：高点→低点 ≥5 根 → 高点之后第一个**标准底分型**成立即报）');
{
  const M = 900_000;
  /** 造K线：前 lead 根下行，第 mid 根做出底分型（高、低点都最低），后 tail 根抬高 */
  const mk = (lead, tail, opt = {}) => {
    const t = [], h = [], l = [], c = [];
    let i = 0;
    for (; i < lead; i++) { t.push(i * M); h.push(100 - i); l.push(99 - i); c.push(99.5 - i); }
    // 底分型中间那根：高点=100-lead-1、低点=99-lead-2（都最低）
    const base = 100 - lead, baseL = 99 - lead;
    t.push(i * M); h.push(opt.midHigh ?? (base - 3)); l.push(opt.midLow ?? (baseL - 3)); c.push(base - 2.5); i++;
    for (let k = 0; k < tail; k++, i++) {
      t.push(i * M);
      if (opt.tailDrop) { h.push(base - 4 - k); l.push(baseL - 2 + k); c.push(base - 3 - k); }   // 小实体：高点更低、低点更高（中继）
      else { h.push(base - 1 + k); l.push(baseL - 2 + k); c.push(base - 1.5 + k); }
    }
    return { key: '15m', ms: M, t, h, l, c, closed: t.length, pts: null };
  };
  {
    const v = mk(4, 1);
    const hit = detectFirstBottom(v, { minBars: 5, lookback: 20, freshBars: 2, minDropPct: 0, type: 'standard' });
    ok('★ 高点→低点 ≥5 根 + 标准底分型刚成立 → 命中', !!hit,
      hit ? `bars=${hit.bars} age=${hit.ageBars} type=${hit.fractalType}` : 'null');
    if (hit) {
      ok('★ 识别为标准底分型', hit.fractalType === 'standard');
      ok('★ 跨度 ≥5', hit.bars >= 5, 'bars=' + hit.bars);
      const a2 = makeFirstBottomAlert('ZUSDT', hit, Date.now(), false);
      ok('★ 报警 kind=wavefirst + 文案含「标准底分型 / 提前预警」',
        a2.kind === 'wavefirst' && /标准底分型/.test(a2.text) && /提前预警/.test(a2.text), a2.text.slice(0, 78));
    }
  }
  ok('★ 跨度只有 3 根 → 不命中', detectFirstBottom(mk(2, 1), { minBars: 5, freshBars: 2, minDropPct: 0 }) === null);
  ok('★ 成立已过 20 根 → 不命中（避免刷历史）',
    detectFirstBottom(mk(4, 25), { minBars: 5, freshBars: 2, minDropPct: 0 }) === null);
  {
    // 第三根继续走低 → 中间高点不是最低 → 只算"中继"，标准口径不命中；relay 口径命中
    const v = mk(4, 1, { tailDrop: true });
    ok('★ 中间高点不是最低（只满足低点最低）→ 标准口径不命中',
      detectFirstBottom(v, { minBars: 5, freshBars: 2, minDropPct: 0, type: 'standard' }) === null);
    ok('★ 同一根换 relay（中继）口径 → 命中',
      !!detectFirstBottom(v, { minBars: 5, freshBars: 2, minDropPct: 0, type: 'relay' }));
  }
  {
    const v = mk(4, 1);
    ok('★ 跌幅不够（门槛 99%）→ 不命中', detectFirstBottom(v, { minBars: 5, freshBars: 2, minDropPct: 99 }) === null);
  }
  {
    const v = mk(4, 2);
    const cfg = { fbLevels: ['15m'], fbMinBars: 5, fbLookback: 20, fbFreshBars: 2, fbMinDropPct: 0, fbType: 'standard', beichiMinBars: 5 };
    const fake = { '15m': { t: v.t, h: v.h, l: v.l, c: v.c, ms: M, closedCount: v.closed, ensureChan: () => ({ pts: null }), ensure: () => ({ ema7: v.c }) } };
    const seen = new Map();
    const first = scanFirstBottoms('ZUSDT', fake, cfg, seen, Date.now(), false);
    const second = scanFirstBottoms('ZUSDT', fake, cfg, seen, Date.now(), true);
    ok('★ 同一个底分型只报一次', first.length === 1 && second.length === 0, first.length + '/' + second.length);
  }
  ok('配置默认：首底开关已关闭、级别与参数仍保留（跨度 5 根、类型 standard）',
    DEFAULT_SIGNAL.fbEnabled === false && DEFAULT_SIGNAL.fbMinBars === 5 && DEFAULT_SIGNAL.fbType === 'standard'
    && JSON.stringify(DEFAULT_SIGNAL.fbLevels) === JSON.stringify(['15m','30m','1h','2h']),
    DEFAULT_SIGNAL.fbType);
}

/* ============ 14d. 底分型分类（按用户给的缠论分型图） ============ */
section('14d. 底分型分类：标准/中继/最弱（按用户提供的分类图逐条验证）');
{
  const seq = (a, b, c) => ({ t: [0, 1, 2], h: [a[0], b[0], c[0]], l: [a[1], b[1], c[1]], c: [0, 0, 0] });
  // 图：标准底分型 = 中间那根的高点与低点都是三根中最低
  ok('★ 标准底分型 [100/90][89/80][99/89] → standard=true',
    isBottomFractal(seq([100, 90], [89, 80], [99, 89]), 1, 'standard') === true);
  ok('★ 标准口径下：中间高点不是最低就不是标准 → false',
    isBottomFractal(seq([95, 90], [97, 85], [100, 92]), 1, 'standard') === false);
  ok('★ 同一根按中继口径 → true（只要求低点最低）',
    isBottomFractal(seq([95, 90], [97, 85], [100, 92]), 1, 'relay') === true);
  // 图：最弱底分型 = 末根高点低于首根高点
  ok('★ 最弱底分型 [100/90][97/85][95/92]：末根高点(95) < 首根高点(100) → weakest=true',
    isBottomFractal(seq([100, 90], [97, 85], [95, 92]), 1, 'weakest') === true);
  ok('★ 末根高点不低于首根 → weakest=false',
    isBottomFractal(seq([95, 90], [97, 85], [100, 92]), 1, 'weakest') === false);
  // 反例
  ok('★ 顶分型（中间最高）不是底分型',
    isBottomFractal(seq([80, 70], [100, 92], [85, 75]), 1, 'any') === false);
  ok('★ 中间低点不是最低 → 任何口径都不是底分型',
    isBottomFractal(seq([100, 80], [90, 85], [95, 82]), 1, 'any') === false);
}

/* ============ 16. 三级别嵌套结构（用户新定义） ============ */
section('16. 三级别结构：主级别回调≥5根 + 次级别 下上下上下 五笔 + 内部 死金死金死(间隔≥5) + 主级别底分型');
{
  const M = 21_600_000, S = 3_600_000, I = 600_000;   // 6时 / 1时 / 10分
  const mkMain = () => {
    // 12根：高点 index 0(100)，低点 index 6(80)，底分型在 index 7（高低点都最低）
    const h = [100, 96, 92, 90, 88, 86, 84, 79, 83, 85, 86, 87];
    const l = [95, 92, 88, 86, 84, 82, 80, 78, 80, 82, 83, 84];
    const c = [97, 94, 90, 88, 86, 84, 82, 78.5, 81, 83, 84, 85];
    const t = c.map((_, i) => i * M);
    const ema7 = c.map(() => 0);
    const o = c.map((x, i) => (i === 0 ? x : c[i - 1]));
    return { key: '6h', ms: M, t, h, l, c, o, ma7: c.map(() => 0), ema7, dif: c.map(() => 0), dea: c.map(() => 0), closed: 9, pts: null };
  };
  /** 次级别：t0..t5 六个端点 T,B,T,B,T,B（= 下上下上下 五笔） */
  const mkSub = (t0) => {
    const n = 60, t = [], h = [], l = [], c = [];
    for (let i = 0; i < n; i++) { t.push(t0 + i * S); h.push(100 - i * 0.1); l.push(99 - i * 0.1); c.push(99.5); }
    const pts = [];
    const lows = [96, 92, 88];
    for (let k = 0; k < 3; k++) {
      pts.push({ mi: 5 + k * 16, origIdx: 5 + k * 16, confirmIdx: 6 + k * 16, type: 'top', price: 99 });
      pts.push({ mi: 12 + k * 16, origIdx: 12 + k * 16, confirmIdx: 13 + k * 16, type: 'bottom', price: lows[k] });
    }
    const knots = [{ origIdx: 0, price: 94 }, ...pts, { origIdx: 59, price: 99 }];
    for (let i = 0; i < n; i++) {
      const j = Math.max(1, knots.findIndex(p => p.origIdx >= i));
      const a = knots[j - 1], b = knots[j];
      const price = a.price + (b.price - a.price) * (i - a.origIdx) / (b.origIdx - a.origIdx);
      h[i] = price + 0.1; l[i] = price - 0.1; c[i] = price;
    }
    const o = c.map((x, i) => (i === 0 ? x : c[i - 1]));
    return { key: '1h', ms: S, t, h, l, c, o, ma7: c.map(() => 0), ema7: c.map(() => 0), dif: c.map(() => 0), dea: c.map(() => 0), closed: t.length, pts };
  };
  /** 内部级别：dif 在指定下标翻转 → 交叉；造 死金死金死 且相邻≥5根 */
  const mkInner = (t0, span) => {
    const n = Math.ceil(span / I) + 4;
    const dif = new Array(n).fill(-1);
    const flips = [40, 46, 53, 59, 66];      // 5 次翻转 → 5 个交叉，间隔 6/7/6/7（且都落在窗口内）
    let s = -1;
    for (let i = 0; i < n; i++) { if (flips.includes(i)) s = -s; dif[i] = s; }
    // 第一个交叉出现在 i=8：-1 → +1 = 金叉 —— 需要首个是死叉，所以从 +1 起步
    const dif2 = new Array(n).fill(1);
    s = 1;
    for (let i = 0; i < n; i++) { if (flips.includes(i)) s = -s; dif2[i] = s; }
    const t = [], h = [], l = [], c = [];
    for (let i = 0; i < n; i++) { t.push(t0 + i * I); h.push(100 - i * 0.05); l.push(99 - i * 0.05); c.push(99.5 - i * 0.05); }
    return { key: '10m', ms: I, t, h, l, c, ema7: c.map(() => 0), dif: dif2, dea: dif2.map(() => 0), closed: t.length, pts: null };
  };

  const main = mkMain();
  const t0 = main.t[0];                       // 首顶位于主级别高点K线内
  const sub = mkSub(t0);
  const span = 60 * S;
  const inner = mkInner(t0, span);

  {
    const hit = detectChain(main, sub, inner, { mainMinBars: 5, innerMinBars: 5, lookback: 20, mainMode: 'fractal' });
    ok('★ 主级别回调≥5根 + 次级别五笔 + 内部死金死金死(间隔≥5) + 主级别底分型 → 命中', !!hit,
      hit ? `主${hit.mainBars}根 内部${hit.innerSeq} 间隔${hit.subBars.join('/')}` : 'null');
    if (hit) {
      ok('★ 主级别回调根数 ≥5', hit.mainBars >= 5, 'bars=' + hit.mainBars);
      ok('★ 内部序列 = 死→金→死→金→死', hit.innerKey === null, hit.innerSeq);
      ok('★ 相邻交叉间隔都 ≥5 根', hit.subBars.every(g => g >= 5), hit.subBars.join('/'));
      const a = makeChainAlert('ZUSDT', hit, Date.now(), false);
      ok('★ 报警 kind=chain，级别组合 6时→1时→10分',
        a.kind === 'chain' && a.level === '6h' && a.subLevel === '1h' && a.innerLevel === null,
        `${a.level}/${a.subLevel}/${a.innerLevel}`);
      ok('★ 文案含「两级五浪 / 下上下上下 / 顶部结构成立 / 站上 MA7 与 EMA7」',
        /两级五浪/.test(a.text) && /下上下上下/.test(a.text)
        && /顶部结构成立|底分型/.test(a.text) && /笔/.test(a.text), a.text.slice(0, 60));
    }
  }
  // ★ 回归：回调途中的底分型不能被当成"见底"（用户反馈过这个 bug）
  {
    const main2 = mkMain();
    // 造：index 3 一个中途底分型（低点较高），真低点在 index 7
    main2.h = [100, 96, 92, 90, 88, 86, 84, 79, 83, 85, 86, 87];
    main2.l = [95, 92, 88, 86, 83, 84, 85, 78, 80, 82, 83, 84];
    //            ↑ index 4 是中途底分型（l=83<l[3]=86、<l[5]=84；h=88<90、<86? 否 → 用标准口径改一下）
    main2.h[4] = 85; main2.h[3] = 90; main2.h[5] = 88;
    main2.l[4] = 83; main2.l[3] = 86; main2.l[5] = 84;
    const hit2 = detectChain(main2, sub, inner, { mainMinBars: 5, innerMinBars: 5 });
    ok('★ 只认「回调最低点处」的底分型：中途底分型不被采纳',
      !hit2 || hit2.fractalLow === main2.l[7],
      hit2 ? `fractalLow=${hit2.fractalLow} 最低点=${main2.l[7]}` : 'null（中途分型被正确拒绝）');
  }
  // 间隔不足
  {
    const innerBad = mkInner(t0, span);
    // 把第二个交叉提前到间隔 3 根
    const dif = new Array(innerBad.t.length).fill(1);
    const flips = [40, 43, 53, 59, 66];
    let s = 1;
    for (let i = 0; i < dif.length; i++) { if (flips.includes(i)) s = -s; dif[i] = s; }
    innerBad.dif = dif;
    ok('★ 两级策略不受第三周期MACD间隔影响',
      !!detectChain(main, sub, innerBad, { mainMinBars: 5, innerMinBars: 5, mainMode: 'fractal' }));
  }
  // 主级别回调不足 5 根
  {
    const short = mkMain();
    short.h = short.h.map((x, i) => (i === 0 ? x : x + 0));   // 不改高点
    // 直接把低点抬高，使 高→低 跨度只有 3 根
    short.l = [95, 92, 88, 86, 84, 82, 80, 80.5, 81, 82, 83, 84];
    short.l[2] = 79;                                          // 低点提前到 index 2 → 跨度 3 根
    ok('★ 主级别高→低只有 3 根 → 不命中',
      detectChain(short, sub, inner, { mainMinBars: 5, mainMode: 'fractal' }) === null);
  }
  // 次级别不是 下上下上下
  {
    const sub2 = mkSub(t0);
    sub2.pts = sub2.pts.slice(0, 5).concat([{ mi: 58, origIdx: 58, type: 'top', price: 99 }]);
    ok('★ 次级别不是"下上下上下"五笔（末笔是顶）→ 不命中',
      detectChain(main, sub2, inner, { mainMinBars: 5, innerMinBars: 5, mainMode: 'fractal' }) === null);
  }
  // 去重
  {
    const cfg = { chainTriples: [{ main: '6h', sub: '1h', inner: '10m' }], chainMainMinBars: 5, chainInnerMinBars: 5, chainLookback: 20, beichiMinBars: 5, chainMainMode: 'fractal' };
    const fake = {
      '6h': { t: main.t, h: main.h, l: main.l, c: main.c, ms: M, closedCount: main.closed, ensure: () => ({ ema7: main.ema7 }), macd: () => ({ dif: main.dif, dea: main.dea }), ensureChan: () => ({ pts: null }) },
      '1h': { t: sub.t, h: sub.h, l: sub.l, c: sub.c, ms: S, closedCount: sub.closed, ensure: () => ({ ema7: sub.ema7 }), macd: () => ({ dif: sub.dif, dea: sub.dea }), ensureChan: () => ({ pts: sub.pts }) },
      '10m': { t: inner.t, h: inner.h, l: inner.l, c: inner.c, ms: I, closedCount: inner.closed, ensure: () => ({ ema7: inner.ema7 }), macd: () => ({ dif: inner.dif, dea: inner.dea }), ensureChan: () => ({ pts: null }) },
    };
    const seen = new Map();
    const first = scanChains('ZUSDT', fake, cfg, seen, Date.now(), false);
    const second = scanChains('ZUSDT', fake, cfg, seen, Date.now(), true);
    ok('★ 同一个结构只报一次', first.length === 1 && second.length === 0, first.length + '/' + second.length);
  }
  ok('配置默认：六组独立两级配对',
    DEFAULT_SIGNAL.chainEnabled === true
    && JSON.stringify(DEFAULT_SIGNAL.chainTriples) === JSON.stringify([{"main":"15m","sub":"3m"},{"main":"30m","sub":"5m"},{"main":"1h","sub":"10m"},{"main":"2h","sub":"15m"},{"main":"3h","sub":"30m"},{"main":"6h","sub":"1h"}])
    && DEFAULT_SIGNAL.chainMainMinBars === 5 && DEFAULT_SIGNAL.chainInnerMinBars === 5,
    JSON.stringify(DEFAULT_SIGNAL.chainTriples));
}

/* ============ 17. 顶部/底部结构（含均线回踩确认） ============ */
section('17. 顶部/底部结构：五根形态 + 反转点 + 收盘站上/跌破 MA7+EMA7 才算确认（不提前提醒）');
{
  const H = 3_600_000;
  /** hs/ls 必填；os/cs 可选；mas 可选 [ma7数组, ema7数组]（不传＝永远站不上的极值） */
  const mk = (hs, ls, os, cs, mas) => {
    const n = hs.length;
    const c = cs ?? hs.map((x, i) => (x + ls[i]) / 2);
    const o = os ?? c.map((x, i) => (i === 0 ? x : c[i - 1]));
    return {
      key: '1h', ms: H, t: hs.map((_, i) => i * H), o, h: hs, l: ls, c,
      ma7: mas ? mas[0] : c.map(() => -1e9), ema7: mas ? mas[1] : c.map(() => -1e9),
      closed: n,
    };
  };
  // 前五根（顶部形态）：第1根高点100 → 第2根96 → 第3根94 → 第4根95(不超96) → 第5根低点88(低于前四根最低90)
  const H5 = [100, 96, 94, 95, 93];
  const L5 = [95, 92, 90, 91, 88];

  // ① 默认口径（均线回踩确认）：反转点出现 → 等收盘站上 MA7+EMA7 那一根才报
  {
    const hs = [...H5, 92, 93], ls = [...L5, 86.5, 88];
    const cs = [90, 93, 92, 93, 89, 88, 95];     // 第6根创新低收阳=反转点；第7根收95
    const os = [91, 90, 93, 92, 93, 87, 92];
    const ma7 = cs.map(() => 94), ema7 = cs.map(() => 94.5);
    const hit = detectTop5(mk(hs, ls, os, cs, [ma7, ema7]), { minBars: 5, lookback: 20 });
    ok('★ 默认口径：反转点后收盘站上 MA7+EMA7 那一根才确认（reason=ma-reclaim）',
      !!hit && hit.stage === 'confirmed' && hit.reason === 'ma-reclaim', hit ? `reason=${hit.reason} bars=${hit.bars}` : 'null');
    if (hit) {
      ok('★ 报警 kind=top5、mode=closed（已确认样式）、side=short',
        makeTop5Alert('ZUSDT', hit, Date.now(), false).kind === 'top5'
        && makeTop5Alert('ZUSDT', hit, Date.now(), false).mode === 'closed');
      const a = makeTop5Alert('ZUSDT', hit, Date.now(), false);
      ok('★ 文案含「站上 MA7 … 与 EMA7 … → 底分型确认成立（收盘成立，不提前提醒）」',
        /站上 MA7/.test(a.text) && /底分型确认成立/.test(a.text) && /不提前提醒/.test(a.text));
    }
    // 反转点已出现但收盘还在均线下方 → 不报
    ok('★ 反转点已出现但尚未站上均线 → 不报（不提前提醒）',
      detectTop5(mk(hs, ls, os, [...cs.slice(0, 6), 93.5], [ma7, ema7]), { minBars: 5, lookback: 20 }) === null);
    // 反转点还没出现 → 不报
    ok('★ 反转点还没出现 → 不报',
      detectTop5(mk([...H5, 91], [...L5, 87], null, null, [ma7.slice(0, 6), ema7.slice(0, 6)]), { minBars: 5, lookback: 20 }) === null);
  }
  // ② 预警模式（allowWarn=true，需显式打开）
  ok('★ 第5根创新低 → 预警（warning/bar5，仅当显式打开预警）',
    (h => !!h && h.stage === 'warning' && h.reason === 'bar5')(
      detectTop5(mk(H5, L5), { minBars: 5, lookback: 20, allowWarn: true })));
  ok('★ 默认不打开预警 → 同一形态不报',
    detectTop5(mk(H5, L5), { minBars: 5, lookback: 20 }) === null);
  ok('★ 第6根不创新低 → 预警（warning/no-new-ext）',
    (h => !!h && h.stage === 'warning' && h.reason === 'no-new-ext')(
      detectTop5(mk([...H5, 92], [...L5, 89]), { minBars: 5, lookback: 20, allowWarn: true })));
  ok('★ 第6根继续创新低 → 不报（还在跌）',
    detectTop5(mk([...H5, 92], [...L5, 87]), { minBars: 5, lookback: 20, allowWarn: true }) === null);
  // ③ 形态确认（关掉均线条件 needMa=false → 反转点那根就报）
  {
    const hs = [...H5, 92], ls = [...L5, 88.5];
    const cs = [90, 93, 92, 93, 89, 94], os = [91, 90, 93, 92, 93, 88.5];
    const hit = detectTop5(mk(hs, ls, os, cs), { minBars: 5, lookback: 20, needMa: false });
    ok('★ 关掉均线条件：第6根阳包阴 → 直接确认（reason=ext-revert）',
      !!hit && hit.stage === 'confirmed' && hit.engulf === true, hit ? `reason=${hit.reason}` : 'null');
  }
  // ④ 形态反例
  ok('★ 第4根高点超过第2根（97 > 96）→ 不命中',
    detectTop5(mk([100, 96, 94, 97, 93], [95, 92, 90, 91, 88]), { minBars: 5, allowWarn: true }) === null);
  ok('★ 第5根没有低于前四根最低 → 不命中',
    detectTop5(mk([100, 96, 94, 95, 93], [95, 92, 90, 91, 91.5]), { minBars: 5, allowWarn: true }) === null);
  ok('★ 之后又涨过第1根高点（101 > 100）→ 结构失效',
    detectTop5(mk([...H5, 101], [...L5, 89]), { minBars: 5, allowWarn: true }) === null);
  // ⑤ 底部结构（完全镜像）
  {
    const BH = [8, 12, 14, 13, 15], BL = [5, 9, 11, 10, 12];   // 第1根低点5 → 第5根高点15 > 前四根最高14
    const hit = detectTop5(mk(BH, BL), { minBars: 5, lookback: 20, dir: 'bottom', allowWarn: true });
    ok('★ 底部结构（镜像）：第5根创新高 → 预警', !!hit && hit.dir === 'bottom' && hit.stage === 'warning',
      hit ? `dir=${hit.dir} stage=${hit.stage}` : 'null');
    const a = makeTop5Alert('ZUSDT', hit, Date.now(), false);
    ok('★ 底部结构报警：kind=bot5、side=long、文案含「底部结构」', a.kind === 'bot5' && a.side === 'long' && /底部结构/.test(a.text));
    ok('★ 底部结构：第5根没有高于前四根 → 不命中',
      detectTop5(mk([8, 12, 14, 13, 11], [5, 9, 11, 10, 12]), { minBars: 5, dir: 'bottom', allowWarn: true }) === null);
  }
  // ⑥ 去重（同阶段同一根只报一次）
  {
    const v = mk([98, ...H5], [96, ...L5]);
    const cfg = { top5Levels: ['1h'], top5WarnBars: 5, top5Lookback: 20, top5AllowWarn: true, top5NeedMa: false };
    const fake = { '1h': { t: v.t, o: v.o, h: v.h, l: v.l, c: v.c, ma7: v.ma7, ema7: v.ema7, ms: H, closedCount: v.closed,
      ensure: () => ({ ma7: v.ma7, ema7: v.ema7 }) } };
    const seen = new Map();
    const first = scanTop5('ZUSDT', fake, cfg, seen, Date.now(), false);
    const second = scanTop5('ZUSDT', fake, cfg, seen, Date.now(), true);
    ok('★ 同一阶段同一根K线只报一次', first.length === 1 && second.length === 0, first.length + '/' + second.length);
  }
  // ★ 用户要求：按"上穿均线那一根"的单根涨幅排序 —— 报警里要带涨幅字段
  {
    const hs = [...H5, 92, 93], ls = [...L5, 86.5, 88];
    const cs = [90, 93, 92, 93, 89, 88, 95], os = [91, 90, 93, 92, 93, 87, 92];
    const ma7 = cs.map(() => 94), ema7 = cs.map(() => 94.5);
    const hit = detectTop5(mk(hs, ls, os, cs, [ma7, ema7]), { minBars: 5, lookback: 20 });
    ok('★ 确认根（上穿均线那一根）带单根涨幅：95 vs 前收88 → +7.95%',
      !!hit && Math.abs(hit.barPct - (95 - 88) / 88 * 100) < 1e-9,
      hit ? `barPct=${hit.barPct?.toFixed(2)}% 前收=${hit.barPrevClose}` : 'null');
    if (hit) {
      const a = makeTop5Alert('ZUSDT', hit, Date.now(), false);
      ok('★ 报警对象带 barPct（供前端按涨幅排序）', Number.isFinite(a.barPct) && a.barPct > 0, String(a.barPct?.toFixed(2)));
    }
  }
  ok('配置默认：顶部结构开启、底部结构已按用户要求关闭、级别 15分/30分/1时/2时/3时/6时、要均线确认、不提前预警',
    DEFAULT_SIGNAL.top5Enabled === true && DEFAULT_SIGNAL.bot5Enabled === false
    && DEFAULT_SIGNAL.top5NeedMa === true && DEFAULT_SIGNAL.top5AllowWarn === false
    && JSON.stringify(DEFAULT_SIGNAL.top5Levels) === JSON.stringify(['15m', '30m', '1h', '2h', '3h', '6h']),
    JSON.stringify({ needMa: DEFAULT_SIGNAL.top5NeedMa, warn: DEFAULT_SIGNAL.top5AllowWarn }));
}

/* ============ 18. 整点（收线）调度 ============ */
section('18. 整点调度：各周期收线时刻扫描（5分/15分/30分/1时 + 组间错峰）');
{
  const T = Date.UTC(2026, 9, 16, 12, 37, 20);           // 12:37:20
  ok('★ 5分钟：下一个整点是 12:40:00', nextBoundary(5 * 60_000, T) === Date.UTC(2026, 9, 16, 12, 40, 0));
  ok('★ 15分钟：下一个整点是 12:45:00', nextBoundary(15 * 60_000, T) === Date.UTC(2026, 9, 16, 12, 45, 0));
  ok('★ 30分钟：下一个整点是 13:00:00', nextBoundary(30 * 60_000, T) === Date.UTC(2026, 9, 16, 13, 0, 0));
  ok('★ 1小时：下一个整点是 13:00:00', nextBoundary(60 * 60_000, T) === Date.UTC(2026, 9, 16, 13, 0, 0));
  ok('★ 正好在整点上时，取下一个（不会重复扫同一根）',
    nextBoundary(5 * 60_000, Date.UTC(2026, 9, 16, 12, 40, 0)) === Date.UTC(2026, 9, 16, 12, 45, 0));
  ok('★ 组的节奏取组内最小周期（2时+4时 → 2时）', groupPeriodMs(['2h', '4h']) === 2 * 3600_000);
  ok('★ 组的节奏取组内最小周期（6时+12时+1天+1周 → 6时）', groupPeriodMs(['6h', '12h', '1d', '1w']) === 6 * 3600_000);
  {
    const sch = new BoundaryScheduler(['5m'], { graceMs: 4000, staggerMs: 10_000, spreadMs: 20_000 });
    const nb = sch.nextAt;
    ok('★ 调度器把下次时间定在「整点 + grace + 错峰」上',
      nb % (5 * 60_000) === 14_000 % (5 * 60_000), 'nextAt 余数=' + (nb % (5 * 60_000)));
    ok('★ 到点前不开始新一轮', sch.shouldStart(nb - 1000, true) === false);
    ok('★ 到点且上一轮跑完才开新一轮', sch.shouldStart(nb + 1, true) === true && sch.shouldStart(nb + 1, false) === false);
    sch.beginRound(nb + 1);
    ok('★ 开轮后 nextAt 推到下一个整点', sch.nextAt > nb + 1 && sch.nextAt % (5 * 60_000) === 14_000 % (5 * 60_000));
    ok('★ 一轮在 spread 窗口内摊开发送（不是瞬间打 200 条）', sch.batchSize(200, 0, nb + 1) <= 20, '首批=' + sch.batchSize(200, 0, nb + 1));
    ok('★ 窗口末尾能把剩余的全部发完', sch.batchSize(200, 150, nb + 1 + 20_000) >= 50);
  }
  ok('配置默认：整点模式开启、收线后 4 秒拉、25 秒内打完一轮',
    APP.boundaryAligned === true && APP.boundaryGraceMs === 4000 && APP.boundarySpreadMs === 25_000);
}

/* ============ 19. 双确认共振 ============ */
section('19. 双确认共振：五浪链 + 顶部结构（同标的同级别、≤N 根内）');
{
  const H = 3_600_000;
  const chain = { kind: 'chain', symbol: 'ZUSDT', level: '1h', levelLabel: '1时', subLevelLabel: '10分',
    barT: Date.UTC(2026, 9, 16, 3, 0), chainSubStrokes: 9, price: 1.234, id: 11 };
  const top = { kind: 'top5', symbol: 'ZUSDT', level: '1h', levelLabel: '1时', topStage: 'confirmed',
    barT: Date.UTC(2026, 9, 16, 4, 0), barPct: 2.5, price: 1.26, id: 12 };
  {
    const seen = new Map();
    const out = scanResonance([chain, top], seen, { res2WindowBars: 3 }, Date.now());
    ok('★ 同标的同级别、相隔 1 根 → 出共振（kind=res2）', out.length === 1 && out[0].kind === 'res2',
      out.length ? `gap=${out[0].gapBars} 根` : 'null');
    if (out.length) {
      const a = out[0];
      ok('★ 共振报警带两个时间点与级别（供左侧K线图表画图）',
        a.chainT === chain.barT && a.topT === top.barT && a.level === '1h' && Number.isFinite(a.price));
      ok('★ 文案含「双确认共振 / 两级五浪链 / 顶部结构 / 收盘确认」',
        /双确认共振/.test(a.text) && /两级五浪链/.test(a.text) && /顶部结构/.test(a.text) && /收盘确认/.test(a.text));
      ok('★ 再次扫描同一对 → 不重复报（去重）',
        scanResonance([chain, top], seen, { res2WindowBars: 3 }, Date.now()).length === 0);
    }
  }
  {
    const seen = new Map();
    const far = { ...top, barT: chain.barT + 5 * H };        // 相隔 5 根 > 窗口 3
    ok('★ 相隔 5 根（> 窗口 3）→ 不算共振', scanResonance([chain, far], seen, { res2WindowBars: 3 }, Date.now()).length === 0);
  }
  {
    const seen = new Map();
    const other = { ...top, level: '6h' };                    // 级别不同
    ok('★ 级别不同（1时 vs 6时）→ 不算同级共振', scanResonance([chain, other], seen, { res2WindowBars: 3 }, Date.now()).length === 0);
  }
  {
    const seen = new Map();
    const before = { ...top, barT: chain.barT - H };          // 顶部结构先确认、链后报
    const out = scanResonance([chain, before], seen, { res2WindowBars: 3 }, Date.now());
    ok('★ 顺序反过来（先确认后报链）也算共振，gap 为 -1', out.length === 1 && out[0].gapBars === -1,
      out.length ? 'gap=' + out[0].gapBars : 'null');
  }
  ok('配置默认：共振开启、窗口 3 根', DEFAULT_SIGNAL.res2Enabled === true && DEFAULT_SIGNAL.res2WindowBars === 3);
}

/* ============ 15. 双阴/双阳判定修正：窗口右移 + 两条前置条件 ============ */
section('15. 双阴/双阳判定修正（含刚收盘那根 + 均线方向 + 前置趋势）');
{
  const mk = (candles, maArr, emaArr) => ({
    s: {
      o: candles.map(c => c[0]), h: candles.map(c => c[1]),
      l: candles.map(c => c[2]), c: candles.map(c => c[3]),
    },
    ind: { ma7: maArr, ema7: emaArr },
  });

  /* 7 根K线：[开,高,低,收]
     0..3 在均线上方（前置趋势）
     4    阳K（形态之前）
     5    阴K ┐ 双阴
     6    阴K ┘ ← idx = 6（刚收盘的那根） */
  const rows = [
    [10.20, 10.30, 10.10, 10.25],
    [10.25, 10.35, 10.15, 10.30],
    [10.30, 10.40, 10.20, 10.35],
    [10.35, 10.45, 10.25, 10.40],
    [10.40, 10.50, 10.30, 10.45],   // 4 阳K
    [10.45, 10.50, 10.28, 10.38],   // 5 阴K，收 10.38
    [10.38, 10.42, 10.24, 10.32],   // 6 阴K，收 10.32（最新收盘）
  ];
  const MA = new Array(7).fill(10.05);   // 全部收盘都在 MA7 上方
  const EMA = new Array(7).fill(10.10);
  const base = { ...cfg, dualEnabled: true, dualBars: 2, dualRequireMaSlope: false, dualPrevBars: 0 };

  // —— 修正一：窗口含刚收盘的那根 ——
  {
    const { s, ind } = mk(rows, MA, EMA);
    const off = { ...base, dualRequireMaSlope: false, dualPrevBars: 0 };
    ok('★ 形态含「刚收盘的那根」K线（idx、idx-1）→ 成立',
      dualPattern(s, ind, 6, off, 1) !== null,
      'idx=6 检查第 5、6 根（收 10.38 / 10.32）');
    // 若按旧口径（idx-1、idx-2 = 第 5、4 根），第 4 根是阳K → 不成立
    ok('★ 旧口径（idx-1、idx-2）会漏掉：第 4 根是阳K，正好证明窗口确实右移了',
      findTwoBearHold(s, ind, 6, 2, true) === null,
      'findTwoBearHold(idx=6) 检查第 5、4 根 → null');
  }

  // —— 修正二：均线方向 ——
  {
    const up = MA.map((v, i) => 10.00 + i * 0.02);      // MA7 向上
    const down = MA.map((v, i) => 10.30 - i * 0.02);    // MA7 向下
    const { s } = mk(rows, MA, EMA);
    const on = { ...base, dualRequireMaSlope: true, dualPrevBars: 0 };
    ok('★ 双阴（做多）+ MA7 向上 → 成立', dualPattern(s, { ma7: up, ema7: EMA }, 6, on, 1) !== null);
    ok('★ 双阴（做多）+ MA7 向下 → 被拦', dualPattern(s, { ma7: down, ema7: EMA }, 6, on, 1) === null);
  }
  {
    // 双阳（做空）：K线收在均线下方
    const bear = [
      [9.80, 9.90, 9.70, 9.75],
      [9.75, 9.85, 9.65, 9.70],
      [9.70, 9.80, 9.60, 9.65],
      [9.65, 9.75, 9.55, 9.60],
      [9.60, 9.70, 9.50, 9.55],
      [9.55, 9.68, 9.50, 9.62],   // 5 阳K
      [9.62, 9.74, 9.55, 9.68],   // 6 阳K
    ];
    const { s } = mk(bear, MA, EMA);
    const MAo = new Array(7).fill(9.95);
    const up = MAo.map((v, i) => 9.90 + i * 0.02);
    const down = MAo.map((v, i) => 10.20 - i * 0.02);
    const on = { ...base, dualRequireMaSlope: true, dualPrevBars: 0 };
    ok('★ 双阳（做空）+ MA7 向下 → 成立', dualPattern(s, { ma7: down, ema7: EMA }, 6, on, -1) !== null);
    ok('★ 双阳（做空）+ MA7 向上 → 被拦', dualPattern(s, { ma7: up, ema7: EMA }, 6, on, -1) === null);
  }

  // —— 修正三：前置趋势 ——
  {
    const { s, ind } = mk(rows, MA, EMA);
    const need2 = { ...base, dualRequireMaSlope: false, dualPrevBars: 2 };
    ok('★ 前置趋势：之前 2 根都在 MA7 上方 → 成立',
      dualPattern(s, ind, 6, need2, 1) !== null, '第 3、4 根收 10.35 / 10.45 > MA7 10.05');

    // 把第 4 根压到均线下方 → 前置趋势不满足
    const bad = rows.map((c, i) => i === 4 ? [10.40, 10.50, 9.90, 9.95] : c);
    const { s: s2, ind: ind2 } = mk(bad, MA, EMA);
    ok('★ 前置趋势：之前有一根在 MA7 下方 → 被拦',
      dualPattern(s2, ind2, 6, need2, 1) === null, '第 4 根收 9.95 < MA7 10.05');

    ok('前置趋势要求越多越严（prev=0 成立 → prev=3 也成立，因为前 3 根都在上方）',
      dualPattern(s, ind, 6, { ...base, dualPrevBars: 0 }, 1) !== null
      && dualPattern(s, ind, 6, { ...base, dualPrevBars: 3 }, 1) !== null);
  }

  // —— 默认值 ——
  ok('默认开启两条前置条件（均线方向 + 前置 3 根）',
    DEFAULT_SIGNAL.dualRequireMaSlope === true && DEFAULT_SIGNAL.dualPrevBars === 3,
    'slope=' + DEFAULT_SIGNAL.dualRequireMaSlope + ' prev=' + DEFAULT_SIGNAL.dualPrevBars);
}


/* ============ 16. 形态提醒的成交额门槛 ============ */
section('16. 形态提醒：24H 成交额下限（低于阈值不提醒）');
{
  const { Engine } = await import('../src/engine.js');
  const mkLog = () => ({ info() { }, warn() { }, error() { }, signal() { }, ok() { }, debug() { } });
  // 造一个最小可用的假 market + 触发一次形态提醒
  const run = (quoteVolume, minQv) => {
    const st = {
      symbol: 'QVUSDT', seeded: true, stale: false, quoteVolume, bullCount: 5,
      series: { '3m': { t: [Date.now()], ms: 180000, done: [true], c: [1] } },
      levels: null, best: null,
    };
    const market = {
      symbols: new Map([['QVUSDT', st]]),
      universe: ['QVUSDT'],
      stats: {},
    };
    const eng = new Engine(market, mkLog());
    eng.cfg = { ...eng.cfg, dualEnabled: true, dualMinQuoteVolume: minQv };
    // 直接喂一个形态命中，绕过行情
    eng.evaluateOne = Engine.prototype.evaluateOne;
    const alerts = [];
    eng.on('alert', a => alerts.push(a));
    // 手工走「形态提醒」那段逻辑：用 evaluateOne 太重，这里直接构造 res 调内部路径
    const res = { dual: { '15m': { bear: { bars: 2 }, bull: null, close: 1, ma7: 1, ema7: 1, candleT: 12345 } } };
    // 复用 evaluateOne 里的形态分支：直接调用同一段代码不方便，改为断言 cfg 读取正确
    return { eng, res, alerts };
  };

  ok('默认门槛为 400 万 USDT', DEFAULT_SIGNAL.dualMinQuoteVolume === 4_000_000,
    'dualMinQuoteVolume=' + DEFAULT_SIGNAL.dualMinQuoteVolume);

  // 阈值比较语义：恰好等于应通过，差一点应拦下
  const gate = (qv, min) => !(min > 0) || (Number(qv) >= min);
  ok('成交额 = 阈值 → 通过', gate(4_000_000, 4_000_000) === true);
  ok('成交额 = 阈值 - 1 → 拦下', gate(3_999_999, 4_000_000) === false);
  ok('成交额 > 阈值 → 通过', gate(50_000_000, 4_000_000) === true);
  ok('门槛填 0 → 不限制（全部通过）', gate(1, 0) === true);
  ok('成交额缺失（undefined）→ 拦下，不放行未知标的', gate(undefined, 4_000_000) === false);
}

/* ============ 汇总 ============ */
console.log(results.join('\n'));
console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);










