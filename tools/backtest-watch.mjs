/**
 * 回测：主级别回踩结构信号，进场后 **3 / 4 / 5 根K线** 的收益。
 *
 * 口径：
 *   · 进场价 = 报警那根次级别K线的收盘价（和实盘面板上看到的价格一致）
 *   · 出场价 = **主级别**（报警级别）报警当根之后第 3 / 4 / 5 根K线的收盘价
 *     （同时也算一份次级别口径，两种视角都给出）
 *   · 同时统计这段区间内的**最大不利偏移 MAE**（最低价相对进场价），看回撤风险
 *   · 基线：同一批标的、同一时间窗内**所有K线**的同口径收益，用来判断信号到底有没有优势
 *
 * 数据：默认现拉（Binance REST，限速 400 权重/分钟，不影响在跑的两个实例）；
 *       加 --cache=1 则改用本地K线缓存（窗口只有几小时）。
 *
 * 用法：
 *   node tools/backtest-watch.mjs                     # 前 120 个标的，现拉历史
 *   node tools/backtest-watch.mjs --symbols=60
 *   node tools/backtest-watch.mjs --cache=1           # 只用本地缓存，不发请求
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEVELS, DEFAULT_SIGNAL, watchInnerLevels, APP, PROFILE, EXCLUDE_BASE, EXCLUDE_SYMBOL_RE } from '../src/config.js';
// 回测要长历史：放宽内存里保留的K线根数（实盘仍是 320）
APP.maxCandlesKept = 5000;
import { CandleSeries } from '../src/series.js';
import { evaluateSymbol } from '../src/signals.js';
import { Watcher } from '../src/watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };

const N_SYMBOLS = Number(arg('symbols', 120));
const USE_CACHE = arg('cache', '0') !== '0';
const DAYS = Number(arg('days', 15));   // 回放窗口（天）
const LIVE = arg('live', '0') !== '0';  // 是否模拟「用未收盘那根实时判」
const MIN_BARS = Number(arg('minbars', 45));
const HORIZONS = String(arg('horizons', '3,4,5')).split(',').map(Number).filter(n => n > 0);
const WARM = Number(arg('warm', 60));
const WEIGHT_PER_MIN = Number(arg('weight', 400));
const CACHE = path.join(__dirname, '..', 'data', 'klines-cache.json');
const STORE = path.join(__dirname, '..', 'data', 'backtest-klines-' + DAYS + 'd.json');
const USE_STORE = arg('store', '1') !== '0';

/* ---------------- 限速拉取（共享 IP 额度，务必温和） ---------------- */
let tokens = WEIGHT_PER_MIN, lastRefill = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function take(w) {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(WEIGHT_PER_MIN, tokens + ((now - lastRefill) / 60000) * WEIGHT_PER_MIN);
    lastRefill = now;
    if (tokens >= w) { tokens -= w; return; }
    await sleep(200);
  }
}
async function klinesOnce(symbol, interval, limit, endTime) {
  const weight = limit >= 500 ? 5 : limit >= 100 ? 2 : 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    await take(weight);
    try {
      const u = `${PROFILE.baseUrls[0]}${PROFILE.klinesPath}?symbol=${symbol}&interval=${interval}&limit=${limit}`
        + (endTime ? `&endTime=${endTime}` : '');
      const r = await fetch(u);
      if (r.status === 418 || r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (attempt === 3) throw e; await sleep(1000); }
  }
  return null;
}
/** 向前翻页，凑够 bars 根（币安单次上限 1500 根） */
async function klines(symbol, interval, bars) {
  const out = [];
  let end = undefined;
  while (out.length < bars) {
    const lim = Math.min(1500, bars - out.length);
    const rows = await klinesOnce(symbol, interval, lim, end);
    if (!rows || !rows.length) break;
    out.unshift(...rows);
    end = rows[0][0] - 1;
    if (rows.length < lim) break;
  }
  return out;
}

/** 拉历史所需级别：根数 = 窗口天数 × 每天的根数，上限见 CAP（1m 太占额度所以只留 3000 根） */
const CAP = { '1m': 3000, '3m': 6000, '5m': 6000, '15m': 2000, '30m': 1000, '1h': 500, '2h': 250, '4h': 120 };
const MINS = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240 };
const FETCH = Object.keys(CAP).map(k => [k, Math.round(Math.min(CAP[k], (DAYS * 1440) / MINS[k]))]);

function buildSeries(rowsByLevel) {
  const map = {};
  for (const lv of LEVELS) map[lv.key] = new CandleSeries(lv);
  for (const [key, rows] of Object.entries(rowsByLevel)) {
    const s = map[key];
    if (!s || !rows) continue;
    s.bulkLoad(rows.map(r => ({
      t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7], n: +r[8] || 0,
      done: r[0] + s.ms <= Date.now(),
    })));
  }
  for (const lv of LEVELS) if (!lv.native) map[lv.key].rebuildFrom(map[lv.from]);
  return map;
}

/* ---------------- 1) 标的清单 ---------------- */
let syms = [];
let cacheRaw = null;
if (USE_CACHE) {
  cacheRaw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  syms = Object.keys(cacheRaw.symbols).slice(0, N_SYMBOLS);
  console.log(`【缓存模式】${syms.length} 个标的（每级别只有约 120 根，回放窗口较短）`);
} else {
  const t = await fetch(`${PROFILE.baseUrls[0]}${PROFILE.tickerPath}`).then(r => r.json());
  // ⚠ ticker/24hr **不返回 contractType**（那在 exchangeInfo 里），用它过滤会一个都不剩
  syms = t.filter(x => x.symbol.endsWith('USDT')
    && !EXCLUDE_BASE.has(x.symbol.replace(/USDT$/, ''))
    && !EXCLUDE_SYMBOL_RE.test(x.symbol))
    .sort((a, b) => (+b.priceChangePercent) - (+a.priceChangePercent))
    .slice(0, N_SYMBOLS).map(x => x.symbol);
  console.log(`现拉 ${syms.length} 个标的的历史（涨幅榜前 ${N_SYMBOLS}，行情共 ${t.length} 条），限速 ${WEIGHT_PER_MIN} 权重/分钟…`);
}

/* ---------------- 2) 逐标的：拉数据 → 逐根回放 → 生成报警 ---------------- */
const cfg = { ...DEFAULT_SIGNAL };
cfg.watchEnabled = true; cfg.signalEnabled = false; cfg.dualEnabled = false;
cfg.filterBeichi = false; cfg.requireStrokeChain = false; cfg.useLiveCandle = false;

const LV_KEYS_USED = [...new Set(cfg.watchLevels ?? [])];   // 只看扫描级别（次级别已去掉）
const AXIS = arg('axis', '10m');   // 逐根回放所用的级别（最小的扫描级别）
const watcher = new Watcher(null, {
  enabled: true, levels: cfg.watchLevels, needFalling: cfg.watchNeedFalling,
  nearPct: cfg.watchNearPct, tieRatio: cfg.watchTieRatio, useLiveCandle: false,
});

const store = USE_STORE && fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : { savedAt: 0, symbols: {} };
const DBG = { judgeCalls: 0 };
const samples = [];   // 每条报警
const baseline = [];  // 基线：所有 (标的, 时间点) 的同口径收益
let done = 0, failed = 0;

for (const sym of syms) {
  let rowsByLevel = {};
  try {
    if (USE_STORE && store?.symbols?.[sym]) {
      rowsByLevel = store.symbols[sym];
    } else if (USE_CACHE) {
      const lv = cacheRaw.symbols[sym] || {};
      for (const [k] of FETCH) if (lv[k]) rowsByLevel[k] = lv[k];
    } else {
      for (const [k, lim] of FETCH) rowsByLevel[k] = await klines(sym, k, lim);
      if (USE_STORE) { store.symbols[sym] = rowsByLevel; }
    }
  } catch { failed++; continue; }
  const map = buildSeries(rowsByLevel);
  if (!map['5m'] || map['5m'].t.length < 100) { failed++; continue; }

  // 回放时间轴 = 5分钟级别（覆盖各组的次级别；2m 组需要 1m 数据，窗口更短另算）
  const axis = map[AXIS];   // 回放轴：默认用快级别（1时）——5分钟会被 320 根上限截成只有 26 小时
  const groups = LV_KEYS_USED.map(k => ({ mid: k, base: k }));   // 基线：所有这些级别各记一份

  // 预先算好每个级别的「未来收益」索引表：t -> 该级别第 k 根后的收盘价
  const fwd = key => {
    const s = map[key];
    const idx = new Map();
    for (let i = 0; i < s.t.length; i++) idx.set(s.t[i], i);
    return { s, idx };
  };
  const fwdCache = new Map();

  for (let ai = WARM; ai < axis.t.length; ai++) {
    const ts = axis.t[ai] + axis.ms;
    const series = {};
    let ok = true;
    for (const lv of LEVELS) {
      const s = map[lv.key];
      if (!s || !s.t.length) { series[lv.key] = new CandleSeries(lv); series[lv.key].done = []; continue; }
      // 截断到 ts
      let n = 0;
      while (n < s.t.length && s.t[n] + s.ms <= ts) n++;
      if (n < MIN_BARS) {
        const empty = new CandleSeries(lv); empty.done = []; series[lv.key] = empty; continue;
      }
      const c = new CandleSeries(lv);
      c.t = s.t.slice(0, n); c.o = s.o.slice(0, n); c.h = s.h.slice(0, n); c.l = s.l.slice(0, n);
      c.c = s.c.slice(0, n); c.v = s.v.slice(0, n); c.q = s.q.slice(0, n); c.n = s.n.slice(0, n);
      c.done = new Array(n).fill(true); c.version = 1;
      series[lv.key] = c;
    }
    let res;
    try { res = evaluateSymbol(sym, series, cfg, LIVE); } catch { continue; }
    if (!res.watch) continue;

    const fired = watcher.update(sym, res.watch, ts, LIVE ? res.watchLive : null);
    // （调试行已移除）

    // —— 基线：每个时间点都记一份（同一批标的、同一时间窗）——
    if (ai % 3 === 0) {
      for (const g of groups) {
        const mv = series[g.mid];
        if (!mv || mv.t.length < 10) continue;
        const i = mv.t.length - 1;
        for (const k of HORIZONS) {
          const j = i + k;
          if (j >= map[g.mid].t.length) continue;
          baseline.push({ mid: g.mid, k, ret: (map[g.mid].c[j] - mv.c[i]) / mv.c[i] * 100 });
        }
      }
    }

    for (const a of fired) {
      const g = { mid: a.level, base: a.level };
      if (!fwdCache.has(g.mid)) fwdCache.set(g.mid, fwd(g.mid));
      if (!fwdCache.has(g.base)) fwdCache.set(g.base, fwd(g.base));
      const entry = a.price;
      if (!(entry > 0)) continue;
      const rec = {
        symbol: sym, group: `分支${a.branch ?? '?'}`, level: a.level ?? g.mid, branch: a.branch,
        mid: g.mid, base: g.base, ts, entry, confirm: a.confirmed,
        stage: a.stage, saveMs: (a.candleT != null && a.level) ? ((a.candleT + (LEVELS.find(l => l.key === a.level)?.minutes ?? 0) * 60000) - ts) : 0,
      };
      const fireLevel = a.level ?? g.base;   // 本次突破的级别（多个级别会各自报警）
      for (const [tag, key] of [['mid', g.mid], ['base', fireLevel]]) {
        if (!fwdCache.has(key)) fwdCache.set(key, fwd(key));   // 任何级别都可能成为触发级别
        const { s, idx } = fwdCache.get(key);
        // 报警时刻所在的那根该级别K线
        let i = -1;
        for (let x = s.t.length - 1; x >= 0; x--) if (s.t[x] <= a.candleT) { i = x; break; }
        rec[tag] = {};
        if (i < 0) continue;
        const lo = [];
        for (const k of HORIZONS) {
          const j = i + k;
          rec[tag][k] = j < s.t.length ? (s.c[j] - entry) / entry * 100 : null;
          if (j < s.t.length) {
            let worst = entry;
            for (let x = i + 1; x <= j; x++) if (s.l[x] < worst) worst = s.l[x];
            lo.push((worst - entry) / entry * 100);
          }
        }
        rec[tag].mae = lo.length ? Math.min(...lo) : null;
      }
      samples.push(rec);
    }
  }
  done++;
  if (done % 10 === 0) console.log(`  进度 ${done}/${syms.length}（报警 ${samples.length} 条）`);
}

/* ---------------- 3) 统计 ---------------- */
const agg = arr => {
  const v = arr.filter(x => Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    avg: +avg.toFixed(3),
    med: +q(0.5).toFixed(3),
    win: +((v.filter(x => x > 0).length / v.length) * 100).toFixed(1),
    p10: +q(0.1).toFixed(2),
    p90: +q(0.9).toFixed(2),
    best: +s[s.length - 1].toFixed(2),
    worst: +s[0].toFixed(2),
  };
};
const show = (title, a) => {
  if (!a) { console.log(`  ${title.padEnd(22)} 样本不足`); return; }
  console.log(`  ${title.padEnd(22)} n=${String(a.n).padStart(4)}  均值 ${String(a.avg).padStart(7)}%  中位 ${String(a.med).padStart(7)}%  胜率 ${String(a.win).padStart(5)}%  p10 ${String(a.p10).padStart(6)}%  p90 ${String(a.p90).padStart(6)}%`);
};

console.log('watcher 统计:', JSON.stringify(watcher.stats));
{ const sv = samples.map(s => s.saveMs).filter(x => Number.isFinite(x) && x > 0).sort((a,b)=>a-b);
  if (sv.length) { const q = p => sv[Math.min(sv.length-1, Math.floor(sv.length*p))];
    console.log(`\n提前量（相对该级别K线收盘）：中位 ${(q(0.5)/60000).toFixed(1)} 分钟，p90 ${(q(0.9)/60000).toFixed(1)} 分钟，最大 ${(sv[sv.length-1]/60000).toFixed(1)} 分钟（${sv.length} 条比收盘更早）`);
  } else console.log('\n没有一条比K线收盘更早（说明未启用实时判）'); }
console.log(`\n拉取成功 ${done} 个标的（失败 ${failed}），共 ${samples.length} 条报警样本，基线样本 ${baseline.length} 条\n`);
// 把抓到的历史存盘：下次加 --store=1（默认）就是秒级重跑，不再重复消耗权重
if (USE_STORE && !USE_CACHE) {
  try { fs.writeFileSync(STORE, JSON.stringify({ v: 1, savedAt: Date.now(), symbols: store.symbols })); console.log(`（历史已存 ${STORE}，下次重跑不再拉数据）\n`); }
  catch (e) { console.log('（历史存盘失败：' + e.message + '）\n'); }
}
console.log('══ 进场后收益（进场价 = 报警那根次级别收盘价）══');
for (const tag of ['mid', 'base']) {
  const label = '按报警级别K线（1时或2时）';
  console.log(`\n【${label}】`);
  for (const k of HORIZONS) show(`+${k} 根`, agg(samples.map(s => s[tag]?.[k])));
  for (const st of ['warning']) {
    const arr = samples.filter(s => s.stage === st);
    if (arr.length) { const a5 = agg(arr.map(s => s[tag]?.[5])); console.log(`    · ${st === 'warning' ? '预警' : '确认'} n=${arr.length}` + (a5 ? `  +5根 均值 ${a5.avg}% 胜率 ${a5.win}%` : '')); }
  }
  show('区间最大不利 MAE', agg(samples.map(s => s[tag]?.mae)));
}
console.log('\n【基线：同批标的、同一时间窗，随便进的同口径收益】');
for (const k of HORIZONS) show(`+${k} 根`, agg(baseline.filter(b => b.k === k).map(b => b.ret)));

console.log('\n══ 分组统计（按主级别 +5 根）══');
const byGroup = new Map();
for (const s of samples) {
  if (!byGroup.has(s.group)) byGroup.set(s.group, []);
  byGroup.get(s.group).push(s);
}
for (const [g, arr] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const a5 = agg(arr.map(x => x.base?.[5]));
  console.log(`  ${g.padEnd(14)} n=${String(arr.length).padStart(4)}` + (a5 ? `  +5根 均值 ${String(a5.avg).padStart(7)}%  中位 ${String(a5.med).padStart(7)}%  胜率 ${String(a5.win).padStart(5)}%` : '  样本不足'));
}

console.log('\n══ 按「主级别那一笔的幅度」分档（按主级别 +5 根）══');
const buckets = [[null, 1, '<1%'], [1, 3, '1~3%'], [3, 8, '3~8%'], [8, null, '>8%']];
for (const [lo, hi, name] of buckets) {
  const arr = samples.filter(s => Number.isFinite(s.strokePct)
    && (lo == null || s.strokePct >= lo) && (hi == null || s.strokePct < hi));
  const a5 = agg(arr.map(x => x.base?.[5]));
  const a3 = agg(arr.map(x => x.mid?.[3]));
  if (!a5) { console.log(`  ${name.padEnd(10)} 样本不足`); continue; }
  console.log(`  ${name.padEnd(10)} n=${String(a5.n).padStart(4)}  +3根 均值 ${String(a3.avg).padStart(7)}%  +5根 均值 ${String(a5.avg).padStart(7)}%  中位 ${String(a5.med).padStart(7)}%  胜率 ${String(a5.win).padStart(5)}%`);
}
const sp = samples.map(s => s.strokePct).filter(Number.isFinite).sort((a, b) => a - b);
if (sp.length) {
  const q = p => sp[Math.min(sp.length - 1, Math.floor(sp.length * p))];
  console.log(`  主级别这一笔的幅度：中位 ${q(0.5).toFixed(2)}%  p10 ${q(0.1).toFixed(2)}%  p90 ${q(0.9).toFixed(2)}%`);
}














