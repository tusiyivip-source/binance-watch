/**
 * 诊断：当前这一时刻，全市场（缓存里的标的 × 三组级别）里
 * 主级别结构 / 中间级别 / 次级别上穿 各自命中多少、联合命中多少，
 * 并对比两种「跌够N根K线」的口径：
 *   A. 严格口径（现状）：连续 N 根**收盘逐根走低**（c[i] < c[i-1] 一路到底）
 *   B. 段口径：从最近的高点（收盘最高那根）跌到最低点，这一段**K线根数 ≥ N**
 * 用法： node tools/diag-watch.mjs [--symbols=200]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEVELS, DEFAULT_SIGNAL, watchInnerLevels } from '../src/config.js';
import { CandleSeries } from '../src/series.js';
import { pullbackStructure, recentDownRun } from '../src/signals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', 'data', 'klines-cache.json');
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const N = Number(arg('symbols', 200));
const MINBARS = Number(arg('minBars', 5));
const AGE = Number(arg('age', 3));
const INNER_AGE = Number(arg('innerAge', 15));
const LOOKBACK = Number(arg('lookback', 30));

const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const syms = Object.keys(raw.symbols).slice(0, N);

function buildSeries(levels) {
  const map = {};
  for (const lv of LEVELS) {
    map[lv.key] = new CandleSeries(lv);
    if (!lv.native) continue;
    const rows = levels[lv.key];
    if (Array.isArray(rows)) {
      map[lv.key].bulkLoad(rows.map(r => ({
        t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], q: r[6], n: r[7], done: !!r[8],
      })));
    }
  }
  for (const lv of LEVELS) if (!lv.native) map[lv.key].rebuildFrom(map[lv.from]);
  return map;
}

const now = Date.now();
const lastClosed = s => {
  let i = s.t.length - 1;
  while (i > 0 && now < s.t[i] + s.ms) i--;
  return i;
};
const aboveBoth = (s, ind, i) => Number.isFinite(ind.ma7[i]) && Number.isFinite(ind.ema7[i])
  && s.c[i] > ind.ma7[i] && s.c[i] > ind.ema7[i];

/** B 口径：峰→谷 段长度 ≥ minBars，且谷不早于 age 根前；不破左侧上涨段低点 */
function segmentStructure(s, idx, minBars, age, lookback) {
  const c = s.c, l = s.l;
  let hIdx = Math.max(1, idx - lookback), best = -Infinity;
  for (let k = Math.max(1, idx - lookback); k <= idx; k++) if (c[k] > best) { best = c[k]; hIdx = k; }
  let lIdx = hIdx, low = Infinity;
  for (let k = hIdx; k <= idx; k++) if (l[k] < low) { low = l[k]; lIdx = k; }
  const bars = lIdx - hIdx + 1;
  if (bars < minBars) return null;
  if (idx - lIdx > age) return null;
  let uStart = Math.max(0, hIdx - 1);
  while (uStart - 1 >= 0 && c[uStart] > c[uStart - 1]) uStart--;
  const upLen = hIdx - uStart;
  let upLow = Infinity;
  for (let k = uStart; k <= hIdx; k++) if (l[k] < upLow) upLow = l[k];
  return { bars, ago: idx - lIdx, pbLow: low, upLow, upLen, noBreak: low >= upLow, ok: low >= upLow && upLen >= 2 };
}

/** C 口径（摆动段）：最近 lookback 根里的最低点必须在 age 根内，
 *  它之前 lookback 根里的最高点作为回调起点，段长 ≥ minBars；
 *  左侧上涨段低点 = 起点之前 lookback 根内的最低低点。 */
function swingStructure(s, idx, minBars, age, lookback) {
  const l = s.l, h = s.h;
  let lIdx = idx, low = Infinity;
  for (let k = Math.max(1, idx - lookback); k <= idx; k++) if (l[k] < low) { low = l[k]; lIdx = k; }
  if (idx - lIdx > age) return null;
  let hIdx = Math.max(0, lIdx - 1), high = -Infinity;
  for (let k = Math.max(0, lIdx - lookback); k < lIdx; k++) if (h[k] > high) { high = h[k]; hIdx = k; }
  const bars = lIdx - hIdx + 1;
  if (bars < minBars) return null;
  let upLow = Infinity;
  for (let k = Math.max(0, hIdx - lookback); k <= hIdx; k++) if (l[k] < upLow) upLow = l[k];
  return { bars, hIdx, lIdx, ago: idx - lIdx, pbLow: low, upLow, noBreak: low >= upLow, ok: low >= upLow };
}

const groups = DEFAULT_SIGNAL.watchGroups.filter(g => g.enabled !== false);
const stat = new Map(groups.map(g => [g.mid, {
  midA: 0, midB: 0, midC: 0, inner: 0, innerC: 0, base: 0,
  C_all: 0, C_mid_nobreak: 0,
  midA_short_fail: 0, midA_noBreak_fail: 0, midA_age_fail: 0,
  inner_fail_reason: { noRun: 0, notAbove: 0 },
  n: 0,
}]));
let usable = 0;

for (const sym of syms) {
  const map = buildSeries(raw.symbols[sym]);
  const idx = {};
  let ok = true;
  for (const lv of LEVELS) {
    const s = map[lv.key];
    const i = s.t.length ? lastClosed(s) : -1;
    if (i < 35) { ok = false; break; }
    idx[lv.key] = i;
  }
  if (!ok) continue;
  usable++;

  for (const g of groups) {
    const st = stat.get(g.mid);
    st.n++;
    const midS = map[g.mid], midI = midS.ensure(), mi = idx[g.mid];
    const A = pullbackStructure(midS, mi, { minBars: MINBARS, age: AGE, minUpBars: 2 });
    const B = segmentStructure(midS, mi, MINBARS, AGE, LOOKBACK);
    const C = swingStructure(midS, mi, MINBARS, AGE, LOOKBACK);
    if (A?.ok) st.midA++;
    if (B?.ok) st.midB++;
    if (C?.ok) st.midC++;
    if (C?.ok && C.noBreak) st.C_mid_nobreak++;
    if (!A) {
      const loose = recentDownRun(midS, mi, 3, 0);
      if (loose && loose.bars < MINBARS) st.midA_short_fail++;
    } else {
      if (!A.noBreak) st.midA_noBreak_fail++;
      if (A.ago > AGE) st.midA_age_fail++;
    }

    const inner = watchInnerLevels(g);
    let innerOk = true, innerOkC = true;
    for (const k of inner) {
      const s = map[k], i = idx[k];
      const run = recentDownRun(s, i, MINBARS, INNER_AGE);
      const ind = s.ensure();
      const a = aboveBoth(s, ind, i);
      if (!run) { st.inner_fail_reason.noRun++; innerOk = false; }
      else if (!a) { st.inner_fail_reason.notAbove++; innerOk = false; }
      // C 口径：摆动段 + 站上两条均线
      const sw = swingStructure(s, i, MINBARS, INNER_AGE, LOOKBACK);
      if (!(sw && a)) innerOkC = false;
    }
    const bS = map[g.base], bI = bS.ensure(), bi = idx[g.base];
    const baseOk = aboveBoth(bS, bI, bi);
    if (innerOk) st.inner++;
    if (innerOkC) st.innerC++;
    if (baseOk) st.base++;
    if (C?.ok && C.noBreak && innerOkC && baseOk) st.C_all++;
  }
}

console.log(`缓存标的 ${Object.keys(raw.symbols).length}，可用 ${usable}（每级别 ≥35 根已收盘）`);
console.log(`参数：跌够 ${MINBARS} 根 / 主级别 age=${AGE} / 中间级别 age=${INNER_AGE} / 段口径回看=${LOOKBACK}\n`);
console.log('组(主级别)        标的   ①严格A  ①段B   ①摆动C  ②严格  ②摆动  ③次级别  C∧②C∧③');
for (const g of groups) {
  const s = stat.get(g.mid);
  const pad = (v, w = 7) => String(v).padStart(w);
  console.log(`${(g.base + '>' + g.mid + '>' + g.big).padEnd(14)}${String(s.n).padStart(5)}`
    + pad(s.midA) + pad(s.midB) + pad(s.midC) + pad(s.inner) + pad(s.innerC) + pad(s.base) + pad(s.C_all));
  console.log(`    A口径失败：回调不足${MINBARS}根 ${s.midA_short_fail}｜破前低 ${s.midA_noBreak_fail}｜结束太久 ${s.midA_age_fail}`
    + `　|　C口径里破前低被卡 ${s.midC - s.C_mid_nobreak} 个`);
  console.log(`    ②失败明细（按级别计）：最近${INNER_AGE}根内没有${MINBARS}根连续走低 ${s.inner_fail_reason.noRun} 次｜有走低但没站上两条均线 ${s.inner_fail_reason.notAbove} 次`);
}
