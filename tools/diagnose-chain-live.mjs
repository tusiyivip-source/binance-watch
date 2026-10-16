import fs from 'node:fs';
import { chainView } from '../src/chain.js';
import { macdCrosses } from '../src/wave.js';
import { isBottomFractal } from '../src/fractal.js';

const root='http://127.0.0.1:8860';
const cfg=await (await fetch(root+'/api/config')).json();
const snap=await (await fetch(root+'/api/snapshot')).json();
const source=fs.readFileSync(new URL('../src/chain.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('export function detectChain'),source.indexOf('/** 组装报警 */'));
const reasons={};
const traced=fn.split('\n').map((line,i)=>{
  if(!line.includes('return null;')) return line;
  const reason=`${i+1}: ${line.trim()}`;reasons[i+1]=reason;
  return line.replaceAll('return null;',`return {reject:${i+1}};`);
}).join('\n').replace('export function','function');
const run=new Function('macdCrosses','isBottomFractal','pivotIdx','pivotT','isTop',traced+'; return detectChain;')(
  macdCrosses,isBottomFractal,p=>p.origIdx??p.mi,(v,p)=>v.t[p.origIdx??p.mi]+v.ms,p=>p.type==='top');
const charts=[];
if(process.argv.includes('--cached'))charts.push(...JSON.parse(fs.readFileSync(new URL('../data/chain-diagnostic-charts.json',import.meta.url),'utf8')));
else {
  for(const symbol of snap.symbols){
    const r=await fetch(root+'/api/chart?bars=400&symbol='+encodeURIComponent(symbol));
    if(!r.ok)throw new Error('chart '+symbol+' '+r.status);
    charts.push(await r.json());
  }
  fs.writeFileSync(new URL('../data/chain-diagnostic-charts.json',import.meta.url),JSON.stringify(charts));
}
const result={at:new Date().toISOString(),symbols:charts.length,groups:{},examples:[]};
for(const chart of charts){
  const map={};
  for(const v of chart.levels.filter(Boolean))map[v.key]={...v,t:v.candles.map(x=>x[0]),h:v.candles.map(x=>x[2]),l:v.candles.map(x=>x[3]),c:v.candles.map(x=>x[4]),closedCount:v.lastClosedIndex+1,ensure:()=>({ema7:v.ema7}),macd:()=>({dif:v.macd.dif.map(x=>x??NaN),dea:v.macd.dea.map(x=>x??NaN)})};
  for(const g of cfg.chainTriples){
    const key=[g.main,g.sub,g.inner].join('/');const counts=result.groups[key]??={};
    const main=chainView(map[g.main],g.main,5,Infinity,false);
    const asOf=main?.t[main.closed-1]+(main?.ms??0);
    const sub=chainView(map[g.sub],g.sub,5,asOf);
    const inner=chainView(map[g.inner],g.inner,5,asOf,false);
    const hit=run(main,sub,inner,{mainMinBars:cfg.chainMainMinBars,subMinBars:cfg.chainSubMinBars,innerMinBars:cfg.chainInnerMinBars,lookback:cfg.chainLookback,fractalType:cfg.chainFractalType});
    const reason=hit?.reject?reasons[hit.reject]:'PASS';counts[reason]=(counts[reason]??0)+1;
    if(hit?.reject>=45||!hit?.reject)result.examples.push({symbol:chart.symbol,group:key,reason,subBars:sub?.closed,innerBars:inner?.closed,lastMainClose:asOf});
  }
}
fs.writeFileSync(new URL('../data/chain-diagnostic-report.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,examples:result.examples.slice(0,15)},null,2));
