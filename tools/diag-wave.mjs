/**
 * 对某标的/级别做「五浪判定逐条体检」，把每一步的通过与否打出来。
 *   node tools/diag-wave.mjs WALUSDT 15m 3m
 */
import fs from 'node:fs';
import { LEVELS, DEFAULT_SIGNAL, LEVEL_INDEX } from '../src/config.js';
import { CandleSeries } from '../src/series.js';
import { detectWave, waveView, macdCrosses } from '../src/wave.js';

const [SYM = 'WALUSDT', MAIN = '15m', SUB = '3m'] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(new URL('../data/klines-cache.json', import.meta.url), 'utf8'));
const lvls = raw.symbols[SYM];
if (!lvls) { console.log('缓存里没有', SYM); process.exit(1); }

const map = {};
for (const lv of LEVELS) {
  map[lv.key] = new CandleSeries(lv);
  if (lv.native && Array.isArray(lvls[lv.key])) {
    map[lv.key].bulkLoad(lvls[lv.key].map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], q: r[6], n: r[7], done: !!r[8] })));
  }
}
for (const lv of LEVELS) if (!lv.native) map[lv.key].rebuildFrom(map[lv.from]);

const cfg = DEFAULT_SIGNAL;
const main = waveView(map[MAIN], MAIN);
const sub = waveView(map[SUB], SUB);
const fmt = v => Number.isFinite(v) ? v.toPrecision(8) : '—';
const T = t => new Date(t).toLocaleString('zh-CN', { hour12: false });

console.log(`\n=== ${SYM} · 主级别 ${MAIN} ← 次级别 ${SUB} · 逐条体检 ===`);
console.log(`主级别K线 ${main.t.length} 根，次级别K线 ${sub.t.length} 根`);

// ① 主级别一笔下（高点→最低点）
const n = main.t.length, i = n - 1, lookback = cfg.waveHighLookback ?? 20, minBars = cfg.waveMinBars ?? 5;
const from = Math.max(0, i - lookback + 1);
let lIdx = from, hIdx = from;
for (let k = from; k <= i; k++) if (main.l[k] < main.l[lIdx]) lIdx = k;
for (let k = from; k <= lIdx; k++) if (main.h[k] > main.h[hIdx]) hIdx = k;
const bars = lIdx - hIdx + 1;
const tHigh = main.t[hIdx] + main.ms, tLow = main.t[lIdx] + main.ms;
console.log(`\n① 一笔下：高点 ${T(main.t[hIdx])} @${fmt(main.h[hIdx])} → 低点 ${T(main.t[lIdx])} @${fmt(main.l[lIdx])}，跨度 ${bars} 根`);
console.log(`   ${bars >= minBars ? '✓ 通过' : '✗ 不通过'}（要求 ≥${minBars} 根）`);
console.log(`   ${lIdx < i ? '✓ 低点不是最后一根（已有反弹）' : '✗ 低点就是最后一根'}`);

// ② 次级别窗口内交叉
const all = macdCrosses(sub);
const inWin = all.filter(x => x.t > tHigh && x.t <= tLow);
const seq = inWin.map(x => x.type).join('');
console.log(`\n② 次级别 MACD 交叉（窗口 = 高点收盘 → 低点收盘）`);
inWin.forEach((x, k) => console.log(`   ${k + 1}. ${x.type === 'D' ? '死叉' : '金叉'} @ ${T(x.t)} 价 ${fmt(x.price)}`));
console.log(`   窗口内共 ${inWin.length} 个交叉，序列 ${seq}`);
console.log(`   ${inWin.length === 5 ? '✓ 正好五个' : '✗ 不是正好五个（规则①要求正好 5 个）'}`);
console.log(`   ${seq === 'DGDGD' ? '✓ 序列为 死→金→死→金→死' : '✗ 序列不是 死→金→死→金→死'}`);

// ②b 三波低点
const deads = inWin.filter(x => x.type === 'D');
if (deads.length === 3) {
  let lastK = 0;
  for (let j = 0; j < sub.t.length; j++) if (sub.t[j] + sub.ms <= tLow) lastK = j;
  const segLow = (a, b) => { let m = Infinity; for (let k = Math.max(1, a); k <= b && k < sub.l.length; k++) if (sub.l[k] < m) m = sub.l[k]; return m; };
  const w1 = segLow(deads[0].k + 1, deads[1].k), w3 = segLow(deads[1].k + 1, deads[2].k), w5 = segLow(deads[2].k + 1, lastK);
  console.log(`\n②b 三波低点：${fmt(w1)} → ${fmt(w3)} → ${fmt(w5)}`);
  console.log(`   ${(w1 > w3 && w3 > w5) ? '✓ 逐个降低' : '✗ 没有逐个降低'}`);
} else {
  console.log(`\n②b 三波低点：✗ 死叉数 = ${deads.length}（需要 3 个）`);
}

// ③ 低点之后的「再次金叉」
const gold = all.find(x => x.type === 'G' && x.t > tLow);
console.log(`\n③ 低点之后的再次金叉：${gold ? '✓ ' + T(gold.t) + ' 价 ' + fmt(gold.price) : '✗ 没有'}`);

// ④ 主级别 2 根内上穿 EMA7
const win = cfg.waveCrossWindow ?? 2;
if (gold) {
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
  console.log(`\n④ 金叉后 ${win} 根主级别K线内由下向上穿 EMA7：${hit >= 0 ? '✓ 第 ' + (hit + 1) + ' 根 收 ' + fmt(main.c[hit]) + ' > EMA7 ' + fmt(main.ema7[hit]) : '✗ 没有'}`);
} else {
  console.log('\n④ 上穿 EMA7：—（没有再次金叉，无法判定）');
}

// 汇总：调用真正的检测器
const hit = detectWave(main, sub, { minBars, lookback, crossWindow: win });
console.log(`\n★ 检测器结论：${hit ? '命中 → ' + hit.mainKey + '←' + hit.subKey + ' 三波低点 ' + hit.waveLows.map(fmt).join(' → ') : '不命中（上面有 ✗ 的项就是原因）'}`);
console.log(`\n最近 6 根主级别K线：`);
for (let j = n - 6; j < n; j++) {
  console.log(`   ${T(main.t[j])} O${fmt(main.c[j] === main.c[j] ? main['c'][j] : 0)} 收 ${fmt(main.c[j])} EMA7 ${fmt(main.ema7[j])} ${main.c[j] > main.ema7[j] ? '（在均线上方）' : '（在均线下方）'}`);
}
