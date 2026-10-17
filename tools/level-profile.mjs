/**
 * 级别诊断：回答"这个标的该用哪个级别"
 *   1. 各周期单根K线振幅（ATR%）—— 决定"操作级别"
 *   2. 各周期笔的干净度（笔幅度/单根振幅的比值 + 笔幅度变异系数）
 *   3. 给出每个标的的建议级别三档（主 / 次 / 内）
 */
import fs from 'node:fs';
import { LEVELS, LEVEL_INDEX } from '../src/config.js';
import { CandleSeries } from '../src/series.js';

const raw = JSON.parse(fs.readFileSync('data/klines-cache.json', 'utf8'));
const LEVEL_KEYS = LEVELS.filter(l => ['5m', '15m', '30m', '1h', '2h', '4h', '6h'].includes(l.key)).map(l => l.key);

const pct = (a, b) => b ? (a / b * 100) : 0;
const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

const rows = [];
for (const [sym, lvls] of Object.entries(raw.symbols)) {
  const map = {};
  for (const lv of LEVELS) {
    map[lv.key] = new CandleSeries(lv);
    if (lv.native && Array.isArray(lvls[lv.key])) {
      map[lv.key].bulkLoad(lvls[lv.key].map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], q: r[6], n: r[7], done: !!r[8] })));
    }
  }
  for (const lv of LEVELS) if (!lv.native) map[lv.key].rebuildFrom(map[lv.from]);

  const stat = {};
  for (const key of LEVEL_KEYS) {
    const s = map[key];
    const n = Math.min(s.closedCount ?? s.t.length, s.t.length);
    if (n < 30) continue;
    const from = Math.max(1, n - 120);
    // 单根振幅（high-low）/close 的中位数
    const ranges = [];
    for (let i = from; i < n; i++) ranges.push(pct(s.h[i] - s.l[i], s.c[i]));
    const barAmp = median(ranges);
    // 笔：用缠论端点
    let strokes = [];
    try {
      const pts = s.ensureChan(5)?.pts ?? [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const ia = a.origIdx ?? a.mi, ib = b.origIdx ?? b.mi;
        if (ia == null || ib == null) continue;
        strokes.push(Math.abs(pct(s.h[ib] - s.l[ia], s.c[ib])));
      }
    } catch { /* 忽略 */ }
    const strokeMed = median(strokes);
    const noise = strokes.length > 3
      ? Math.sqrt(strokes.reduce((acc, x) => acc + (x - strokeMed) ** 2, 0) / strokes.length) / (strokeMed || 1)
      : null;
    stat[key] = {
      barAmp: +barAmp.toFixed(3),
      strokeMed: +strokeMed.toFixed(3),
      strokeCount: strokes.length,
      // 笔幅度 / 单根振幅：理想 4~10（一笔由 5~10 根组成）
      ratio: barAmp > 0 ? +(strokeMed / barAmp).toFixed(1) : null,
      noise: noise == null ? null : +noise.toFixed(2),
    };
  }
  rows.push({ sym, stat });
}

// 汇总：各周期的典型振幅
console.log('================ 各周期典型单根振幅（中位数，%）================');
console.log('周期   单根振幅   笔幅度   笔数   笔/根比值   笔变异系数');
for (const key of LEVEL_KEYS) {
  const vals = rows.map(r => r.stat[key]).filter(Boolean);
  const amp = median(vals.map(v => v.barAmp));
  const st = median(vals.map(v => v.strokeMed));
  const cnt = median(vals.map(v => v.strokeCount));
  const ratio = median(vals.map(v => v.ratio ?? 0));
  const noise = median(vals.map(v => v.noise ?? 0));
  console.log(`${(LEVELS[LEVEL_INDEX[key]].label).padEnd(5)} ${amp.toFixed(2).padStart(8)}%  ${st.toFixed(2).padStart(7)}%  ${String(cnt).padStart(4)}  ${ratio.toFixed(1).padStart(9)}  ${noise.toFixed(2).padStart(10)}`);
}

// 每个标的：建议哪个级别（单根振幅最接近目标值的级别）
console.log('\n================ 每个标的的建议"操作级别"（单根振幅最接近目标）================');
for (const target of [0.8, 1.2, 2.0]) {
  const pick = {};
  for (const r of rows) {
    let best = null, bestDiff = 1e9;
    for (const key of LEVEL_KEYS) {
      const v = r.stat[key];
      if (!v || v.strokeCount < 4) continue;
      const diff = Math.abs(v.barAmp - target);
      if (diff < bestDiff) { bestDiff = diff; best = key; }
    }
    if (best) pick[best] = (pick[best] ?? 0) + 1;
  }
  console.log(`目标振幅 ${target}% → ` + Object.entries(pick).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${LEVELS[LEVEL_INDEX[k]].label}=${v}`).join('  '));
}

// 抽 5 个标的看细节
console.log('\n================ 样本细节（前 5 个标的，各周期笔/根比值）================');
for (const r of rows.slice(0, 5)) {
  const parts = LEVEL_KEYS.map(k => {
    const v = r.stat[k];
    return v ? `${LEVELS[LEVEL_INDEX[k]].label}:${v.barAmp}%/${v.ratio ?? '-'}` : null;
  }).filter(Boolean);
  console.log(`  ${r.sym.padEnd(12)} ` + parts.join('  '));
}
