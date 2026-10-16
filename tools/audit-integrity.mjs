// Read-only audit: deployment bytes, local API evidence, and Binance closed candles.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { LEVELS } from '../src/config.js';
import { CandleSeries, parseKline } from '../src/series.js';
import { chainView, detectChain } from '../src/chain.js';

const dir = path.resolve('data/integrity-audit');
fs.mkdirSync(dir, { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const normalized = b => b.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
const report = { at: new Date().toISOString(), scope: 'Local system / GitHub Pages / Binance futures REST (not blockchain)', checks: [], signals: [], errors: [] };
const save = () => fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
const get = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw Error(`${r.status} ${url}`);
  return r.json();
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
report.head = git('rev-parse', 'HEAD');
report.remote = git('ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0];
const files = git('ls-files').split('\n');
const js = files.filter(f => /\.(m?js)$/.test(f) && !f.includes('/vendor/'));
const syntaxFailures = js.filter(f => spawnSync(process.execPath, ['--check', f]).status !== 0);
report.checks.push({ name: 'tracked JavaScript syntax', total: js.length, failures: syntaxFailures });
const assets = files.filter(f => f.startsWith('docs/src/') || ['docs/app.js','docs/chart.js','docs/style.css','docs/index.html','docs/vendor/lightweight-charts.js'].includes(f));
for (const file of assets) {
  const local = fs.readFileSync(file);
  const source = file.startsWith('docs/src/') ? file.slice(5) : file === 'docs/index.html' ? null : 'public/' + file.slice(5);
  try {
    const r = await fetch('https://tusiyivip-source.github.io/binance-watch/' + file.slice(5) + '?audit=' + report.head, { signal: AbortSignal.timeout(20000) });
    const remote = Buffer.from(await r.arrayBuffer());
    report.checks.push({ name: file, status: r.status, sha256: hash(local), onlineSha256: hash(remote), bytesMatch: hash(local) === hash(remote), onlineMatches: r.ok && normalized(local) === normalized(remote), sourceMatches: source ? normalized(local) === normalized(fs.readFileSync(source)) : null });
  } catch (e) { report.errors.push({ file, error: e.message }); }
}
const base = 'http://127.0.0.1:8860';
const [stats, cfg, alerts] = await Promise.all(['/api/stats','/api/config','/api/alerts'].map(p => get(base + p)));
fs.writeFileSync(path.join(dir,'system-evidence.json'), JSON.stringify({stats,cfg,alerts},null,2));
report.runtime = { symbols: stats.market.symbols, readinessFieldPresent: 'seededSymbols' in stats.market, alertCount: alerts.length, chainEnabled: cfg.chainEnabled, pairs: cfg.chainTriples, fractalType: cfg.chainFractalType };
const eq = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= Math.max(Math.abs(a),Math.abs(b),1e-12)*1e-8;
const rawCache = new Map();
async function candles(symbol, key, end) {
  const lv = LEVELS.find(l => l.key === key);
  const native = lv.native ? lv : LEVELS.find(l => l.key === lv.from);
  const limit = Math.min(1000, 320 * (lv.ratio ?? 1));
  const cacheKey = `${symbol}-${key}-${end}`;
  if (rawCache.has(cacheKey)) return rawCache.get(cacheKey);
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${native.key}&endTime=${end-1}&limit=${limit}`;
  const raw = await get(url);
  fs.writeFileSync(path.join(dir,cacheKey+'.json'),JSON.stringify({url,raw}));
  const source = new CandleSeries(native);
  // Keep enough source bars to independently reconstruct 320 derived bars.
  if (!lv.native) source.trim = () => {};
  source.bulkLoad(raw.map(r => parseKline(r,native.minutes*60000)));
  let series = source;
  if (!lv.native) { series = new CandleSeries(lv); series.rebuildFrom(source); }
  rawCache.set(cacheKey,series);
  await new Promise(r => setTimeout(r,200));
  return series;
}
for (const a of alerts.filter(a => a.kind === 'chain')) {
  const result = { id:a.id,symbol:a.symbol,main:a.level,sub:a.subLevel,confirmedAt:a.confirmedAt,detectedAt:a.ts,delaySeconds:(a.ts-a.confirmedAt)/1000,checks:{} };
  try {
    const main = await candles(a.symbol,a.level,a.confirmedAt);
    const sub = await candles(a.symbol,a.subLevel,a.confirmedAt);
    const idx = main.t.indexOf(a.candleT);
    result.checks.confirmationTime = idx >= 1 && main.t[idx+1]+main.ms === a.confirmedAt && a.ts >= a.confirmedAt;
    result.checks.mainLow = eq(main.l[idx],a.chainLow);
    result.checks.threeLows = a.chain3Lows.every((x,i)=>eq(x,main.l[idx-1+i]));
    result.checks.closePrice = eq(main.c[idx+1],a.price);
    result.recordedPrice = a.price;
    result.exchangeClose = main.c[idx+1];
    result.priceDifferencePercent = (a.price/main.c[idx+1]-1)*100;
    result.checks.bottomLow = main.l[idx] < main.l[idx-1] && main.l[idx] < main.l[idx+1];
    result.rawThreeBars = [idx-1,idx,idx+1].map(i=>({t:main.t[i],high:main.h[i],low:main.l[i],close:main.c[i]}));
    result.points = a.chainSubPoints.map(p => { const i=sub.t.indexOf(p.t); return {...p,rawPrice:i<0?null:p.type==='top'?sub.h[i]:sub.l[i],matches:i>=0&&eq(p.price,p.type==='top'?sub.h[i]:sub.l[i])}; });
    result.checks.sixEndpointPrices = result.points.length===6 && result.points.every(p=>p.matches);
    result.checks.strokeCounts = a.chainSubPoints.slice(1).every((p,i)=>{const n=(p.t-a.chainSubPoints[i].t)/sub.ms+1;return n>=5&&n===a.chainSubBars[i];});
    result.checks.alternatingDirection = a.chainSubPoints.slice(1).every((p,i)=>i%2?p.price>a.chainSubPoints[i].price:p.price<a.chainSubPoints[i].price);
    const hit = detectChain(chainView(main,a.level,5,Infinity,false),chainView(sub,a.subLevel,5,a.confirmedAt),null,{ mainMinBars:cfg.chainMainMinBars,subMinBars:cfg.chainSubMinBars,lookback:cfg.chainLookback,fractalType:cfg.chainFractalType });
    result.replay = { found:!!hit, samePoints:!!hit&&JSON.stringify(hit.subPoints)===JSON.stringify(a.chainSubPoints), mainBars:hit?.mainBars };
    const from = Math.max(0,main.t.length-(cfg.chainLookback??20));
    let high=from,low=from;
    for(let i=from;i<main.t.length;i++)if(main.h[i]>main.h[high])high=i;
    low=high;for(let i=high;i<main.t.length;i++)if(main.l[i]<main.l[low])low=i;
    result.replayWindow={highT:main.t[high],high:main.h[high],lowT:main.t[low],low:main.l[low],mainBars:low-high+1,firstStrokeT:a.chainSubPoints[0].t};
    result.status = Object.values(result.checks).every(Boolean) && result.replay.found && result.replay.samePoints ? 'PASS' : 'MISMATCH';
  } catch(e) { result.status='UNVERIFIED'; result.error=e.message; }
  report.signals.push(result);save();
  console.log(JSON.stringify({symbol:result.symbol,main:result.main,status:result.status,checks:result.checks,replay:result.replay,error:result.error}));
}
report.summary = { assets:assets.length,assetMismatches:report.checks.filter(c=>c.onlineMatches===false||c.sourceMatches===false).length,syntaxFailures:syntaxFailures.length,signals:report.signals.length,passed:report.signals.filter(s=>s.status==='PASS').length,mismatched:report.signals.filter(s=>s.status==='MISMATCH').length,unverified:report.signals.filter(s=>s.status==='UNVERIFIED').length };
save();console.log(JSON.stringify(report.summary));
