/**
 * 用真实K线缓存对「主级别回踩结构」盯盘做走查（walk-forward）。
 *
 * 不联网：直接吃 data/klines-cache.json（每级别只留 120 根，所以每组只能复盘
 * 该组次级别最近约 80 根K线的时间窗）。按时间戳把每个级别截断到「当时最后一根
 * 已收盘K线」，再跑 evaluateSymbol + Watcher，统计各条件的命中率与报警样例。
 *
 * 用法：
 *   node tools/probe-watch.mjs
 *   node tools/probe-watch.mjs --symbols=200
 *   node tools/probe-watch.mjs --watchMinBars=4 --watchPullbackAge=5 --watchMinUpBars=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEVELS, DEFAULT_SIGNAL, watchInnerLevels } from '../src/config.js';
import { CandleSeries } from '../src/series.js';
import { evaluateSymbol } from '../src/signals.js';
import { Watcher, checkWatchSetup } from '../src/watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', 'data', 'klines-cache.json');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const N_SYMBOLS = Number(arg('symbols', 200));
const MIN_BARS = Number(arg('minbars', 40));   // 每个级别至少要多少根才算「数据可用」（analyzeLevel 要求 40）
const OVERRIDES = {};
if (arg('watchInnerAll', null) != null) OVERRIDES.watchInnerAll = arg('watchInnerAll', '0') !== '0';
for (const k of ['watchMinBars', 'watchMinUpBars', 'watchPullbackAge', 'watchInnerAge', 'watchBaseCrossLookback', 'watchBreakTolerance', 'watchMaxBars', 'watchSwingLookback']) {
  const v = arg(k, null);
  if (v != null) OVERRIDES[k] = Number(v);
}
for (const k of ['watchMidTrend', 'watchInnerMode']) {
  const v = arg(k, null);
  if (v != null) OVERRIDES[k] = String(v);
}

const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const syms = Object.keys(raw.symbols).slice(0, N_SYMBOLS);
console.log(`缓存 ${Object.keys(raw.symbols).length} 个标的，取前 ${syms.length} 个；参数覆盖 ${JSON.stringify(OVERRIDES)}`);

/** 缓存里的原生级别 -> CandleSeries，并合成 2m / 10m / 3h */
function buildSeries(levels) {
  const map = {};
  for (const lv of LEVELS) {
    map[lv.key] = new CandleSeries(lv);
    if (!lv.native) continue;
    const rows = levels[lv.key];
    if (!Array.isArray(rows)) continue;
    map[lv.key].mergeLoad(rows.map(r => ({
      t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], q: r[6], n: r[7], done: !!r[8],
    })));
  }
  for (const lv of LEVELS) {
    if (lv.native) continue;
    const src = map[lv.from];
    if (src && src.t.length) map[lv.key].rebuildFrom(src);
  }
  return map;
}

/** 截断到「ts 时刻最后一根已收盘K线」；不足 minBars 根返回 null（模拟当时数据不够） */
function truncated(src, ts, minBars = 0) {
  const s = new CandleSeries(src.level);
  let n = 0;
  while (n < src.t.length && src.t[n] + src.ms <= ts) n++;
  if (n < Math.max(1, minBars)) return null;
  s.t = src.t.slice(0, n); s.o = src.o.slice(0, n); s.h = src.h.slice(0, n);
  s.l = src.l.slice(0, n); s.c = src.c.slice(0, n); s.v = src.v.slice(0, n);
  s.q = src.q.slice(0, n); s.n = src.n.slice(0, n); s.done = new Array(n).fill(true);
  s.version = 1;
  return s;
}

const cfg = {
  ...DEFAULT_SIGNAL,
  ...OVERRIDES,
  watchEnabled: true,
  signalEnabled: false, dualEnabled: false,
  filterBeichi: false, requireStrokeChain: false, useLiveCandle: false,
};

const watcher = new Watcher(null, cfg.watchGroups.map(g => ({ ...g })));
watcher.setConfig({
  watchEnabled: true,
  watchBaseCrossLookback: cfg.watchBaseCrossLookback,
  watchRequireBigAbove: cfg.watchRequireBigAbove,
  watchUseLiveCandle: false,
  watchMaxBars: cfg.watchMaxBars,
  watchMidTrend: cfg.watchMidTrend,
  watchInnerMode: cfg.watchInnerMode,
  watchInnerAll: cfg.watchInnerAll,
});

const t0 = Date.now();
const groups = cfg.watchGroups.filter(g => g.enabled !== false);
const per = new Map(groups.map(g => [g.mid, {
  evals: 0, midOk: 0, midNoBreakFail: 0, midShortUp: 0, innerOk: 0, cross: 0, fired: 0,
  firstTs: Infinity, lastTs: 0, bars: new Map(),
}]));
const alerts = [];
const timing = { barsSinceLow: [], crossLag: [], movePct: [], lagToArm: [], lagArmToFire: [], barsFromBaseLow: [], runFromBaseLow: [] };
let setups = 0;
const breakPct = [];
let nullBase = 0;

for (const sym of syms) {
  const full = buildSeries(raw.symbols[sym]);
  if (!full['5m'].t.length) continue;

  for (const g of groups) {
    const need = new Set([g.base, g.mid, g.big, ...watchInnerLevels(g)].filter(Boolean));
    const axis = full[g.base];
    const st = per.get(g.mid);
    for (let i = MIN_BARS; i < axis.t.length; i++) {
      const ts = axis.t[i] + axis.ms;
      const series = {};
      let ok = true;
      for (const key of need) {
        const s = truncated(full[key], ts, MIN_BARS);
        // 最大级别只作参考，缓存里历史短（3h 只有 40 根）→ 缺了不算失败
        if (!s) { if (key === g.big) continue; ok = false; break; }
        series[key] = s;
      }
      if (!ok) { nullBase++; continue; }
      for (const lv of LEVELS) {
        if (series[lv.key]) continue;
        const empty = new CandleSeries(lv);
        empty.done = [];
        series[lv.key] = empty;     // 非本组级别给空序列：analyzeLevel 会返回 null
      }

      let res;
      try { res = evaluateSymbol(sym, series, cfg, false); } catch { continue; }
      if (!res.watch) continue;
      st.evals++;
      if (ts < st.firstTs) st.firstTs = ts;
      if (ts > st.lastTs) st.lastTs = ts;

      for (const a of watcher.update(sym, res.watch, ts, null)) {
        const sa = per.get(a.mid);
        if (sa) sa.fired++;
        // —— 及时性度量：报警时次级别已经走了几根、价格离回调低点多远 ——
        const bs = series[a.base];
        if (bs && a.midLowT != null) {
          let n = 0;
          for (let k = 0; k < bs.t.length; k++) if (bs.t[k] >= a.midLowT && bs.t[k] <= a.candleT) n++;
          timing.barsSinceLow.push(n);
          timing.crossLag.push(a.baseCrossBars ?? -1);
          if (a.midPbLow > 0 && a.price > 0) timing.movePct.push((a.price - a.midPbLow) / a.midPbLow * 100);
          // 滞后拆分：低点 → 结构成立(预备) 花了多久；预备 → 触发 花了多久（都换算成次级别K线根数）
          timing.lagToArm.push((a.armedAt - a.midLowT) / bs.ms);
          timing.lagArmToFire.push((a.candleT - a.armedAt) / bs.ms);
          // 真正有意义的及时性：报警时**次级别自己**离开它的低点走了几根、涨了多少
          let bi = -1;
          for (let k = bs.t.length - 1; k >= 0; k--) if (bs.t[k] === a.candleT) { bi = k; break; }
          if (bi >= 1) {
            let lo = Infinity, loIdx = bi;
            for (let k = Math.max(0, bi - 12); k <= bi; k++) if (bs.l[k] < lo) { lo = bs.l[k]; loIdx = k; }
            timing.barsFromBaseLow.push(bi - loIdx);
            if (lo > 0) timing.runFromBaseLow.push((a.price - lo) / lo * 100);
          }
        }
        if (alerts.length < 40) alerts.push(a);
      }

      const mid = res.watch[g.mid], base = res.watch[g.base];
      if (!mid || !base) continue;
      const setup = checkWatchSetup(g, res.watch, {
        requireBigAbove: cfg.watchRequireBigAbove,
        maxBars: cfg.watchMaxBars,
        midTrend: cfg.watchMidTrend,
        innerMode: cfg.watchInnerMode,
        innerAll: cfg.watchInnerAll,
      });
      const midOk = setup.midOk;
      const innerOk = setup.innerOk;
      const cross = watcher._baseCross(base);
      if (mid.pullback && !mid.pullback.noBreak) st.midNoBreakFail++;
      if (mid.pullback && mid.pullback.upLen < (cfg.watchMinUpBars ?? 2)) st.midShortUp++;
      if (midOk) {
        st.midOk++;
        if (mid.pullback) st.bars.set(mid.pullback.bars, (st.bars.get(mid.pullback.bars) || 0) + 1);
        if (Number.isFinite(mid.pullback?.breakPct)) breakPct.push(mid.pullback.breakPct);
      }
      if (innerOk) st.innerOk++;
      if (midOk && innerOk) setups++;
      if (cross) st.cross++;
    }
  }
}

const pct = (n, d) => `${n} (${(n / Math.max(1, d) * 100).toFixed(2)}%)`;
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s   变量不足跳过的组点 ${nullBase}`);
let totalFired = 0, totalEvals = 0;
for (const g of groups) {
  const s = per.get(g.mid);
  totalFired += s.fired; totalEvals += s.evals;
  const spanH = Number.isFinite(s.firstTs) ? ((s.lastTs - s.firstTs) / 3600_000).toFixed(1) : '0';
  console.log(`\n【${watchInnerLevels(g).join('/')} 中间级别，主级别 ${g.mid}，次级别 ${g.base}】评估点 ${s.evals}（回放跨度约 ${spanH} 小时）`);
  console.log(`  ① 主级别结构成立   : ${pct(s.midOk, s.evals)}`);
  console.log(`     其中被「破前低」卡掉 ${s.midNoBreakFail} 次，被「左侧上涨段太短」卡掉 ${s.midShortUp} 次`);
  console.log(`  ② 中间级别全部成立 : ${pct(s.innerOk, s.evals)}`);
  console.log(`  ③ 次级别上穿成立   : ${pct(s.cross, s.evals)}`);
  console.log(`  ★ 实际报警         : ${s.fired} 条`);
  console.log(`  回调根数分布       : ${[...s.bars.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}根x${v}`).join(' ')}`);
}
if (breakPct.length) {
  const arr = breakPct.slice().sort((a, b) => a - b);
  const q = p => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2);
  console.log(`\n回调低点相对左侧上涨段低点偏离%: p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}（样本 ${arr.length}）`);
}
console.log(`\n① 且 ② 同时成立的组点（= 预备次数，尚未要求③）: ${setups}`);
console.log(`★ 合计报警 ${totalFired} 条 / ${totalEvals} 组点；状态机 armed/fired/reset/preview: ${watcher.stats.armed}/${watcher.stats.fired}/${watcher.stats.reset}/${watcher.stats.preview}`);
if (timing.barsSinceLow.length) {
  const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
  const bs = timing.barsSinceLow, mv = timing.movePct, cl = timing.crossLag;
  const hist = new Map();
  for (const v of bs) hist.set(v, (hist.get(v) || 0) + 1);
  console.log(`\n【及时性】报警时次级别已经走了几根（自回调低点起算）：`
    + [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}根x${v}`).join(' '));
  console.log(`  中位数 ${q(bs, 0.5)} 根 / p90 ${q(bs, 0.9)} 根；`
    + `触发时刻的「上穿新鲜度」中位数 ${q(cl, 0.5)} 根；`
    + `报警价离回调低点已涨 中位数 ${q(mv, 0.5).toFixed(2)}% / p90 ${q(mv, 0.9).toFixed(2)}%`);
  console.log(`  滞后拆分（次级别K线根数）：回调低点→结构①②成立 中位数 ${q(timing.lagToArm, 0.5).toFixed(1)} 根；`
    + `结构成立→触发 中位数 ${q(timing.lagArmToFire, 0.5).toFixed(1)} 根`);
  console.log(`  ★ 真实及时性：报警时**次级别自己**离开它的低点 中位数 ${q(timing.barsFromBaseLow, 0.5)} 根 / p90 ${q(timing.barsFromBaseLow, 0.9)} 根，`
    + `已涨 中位数 ${q(timing.runFromBaseLow, 0.5).toFixed(2)}% / p90 ${q(timing.runFromBaseLow, 0.9).toFixed(2)}%`);
}
console.log('\n报警样例:');
for (const a of alerts.slice(0, 12)) {
  console.log(`  ${a.symbol.padEnd(14)} ${a.group.padEnd(12)} ${new Date(a.ts).toISOString().slice(5, 16)}  ${a.text}`);
}




