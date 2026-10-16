import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChain, chainView, makeChainAlert, scanChains, findFiveWaves, sameWaveMove, selectLargestWaves } from '../src/chain.js';
import { DEFAULT_SIGNAL } from '../src/config.js';
import { CandleSeries } from '../src/series.js';

function fixture() {
  const view = (n, ms) => ({ ms, t: Array.from({length:n}, (_,i)=>i*ms),
    h: Array(n).fill(100), l: Array(n).fill(50), c: Array(n).fill(75),
    dif: Array(n).fill(1), dea: Array(n).fill(0), closed:n });
  const main = view(6,600); main.key='1h';
  main.h=[110,100,90,80,60,70]; main.l=[100,80,70,60,40,50];
  const sub = view(36,100); sub.key='10m';
  const prices=[110,80,95,60,85,40];
  sub.pts=[1,6,11,16,21,26].map((origIdx,i)=>({origIdx,confirmIdx:origIdx+1,
    type:i%2?'bottom':'top',price:prices[i]}));
  sub.pts.forEach(p=>{sub[p.type==='top'?'h':'l'][p.origIdx]=p.price;});
  const inner=view(360,10); inner.key='2m';
  let sign=1;
  for(let i=0;i<360;i++){if([25,65,105,165,215].includes(i))sign=-sign;inner.dif[i]=sign;}
  return {main,sub,inner};
}
const detect = f => detectChain(f.main,f.sub,f.inner);
test('10分钟缺1根时用5分钟复核，并仅等待30分钟底分型',()=>{
  const knots=[[0,100],[1,110],[6,80],[11,95],[14,60],[19,85],[24,40],[31,70]];
  function series(key,ms,ratio){
    const t=[],h=[],l=[],c=[];
    for(let i=0;i<=31*ratio;i++){
      const x=i/ratio,j=Math.max(1,knots.findIndex(p=>p[0]>=x));
      const a=knots[j-1],b=knots[j],p=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);
      t.push(i*ms);h.push(p+0.1);l.push(p-0.1);c.push(p);
    }
    return {key,ms,t,h,l,c,closedCount:t.length,ensure:()=>({ema7:[]}),macd:()=>({dif:[],dea:[]})};
  }
  const sub5=series('5m',100,2),sub10=series('10m',200,1);
  const main={key:'30m',ms:600,t:Array.from({length:10},(_,i)=>i*600),
    h:[115,105,100,95,90,85,75,65,45,60],l:[100,90,85,80,75,70,60,50,39.9,45],
    c:Array(10).fill(55),closedCount:10,ensure:()=>({ema7:[]}),macd:()=>({dif:[],dea:[]})};
  const map=new Proxy({'5m':sub5,'10m':sub10,'30m':main},{get(o,k){assert.ok(k in o,`不得继续等待 ${String(k)}`);return o[k];}});
  const cfg={...DEFAULT_SIGNAL,chainTriples:[{sub:'5m',main:'30m'},{sub:'10m',main:'1h'}]};
  const alerts=scanChains('TESTUSDT',map,cfg,new Map(),6400);
  assert.equal(alerts.length,1);assert.equal(alerts[0].level,'30m');
  assert.equal(alerts[0].subLevel,'5m');assert.equal(alerts[0].chainFallbackFrom,'10m');
});
test('同段15分和30分五浪取30分，主级别随之选3小时',()=>{
  const base={start:0,end:3600000,high:100,low:80};
  const small={pair:{sub:'15m',main:'2h'},wave:{...base,ms:900000}};
  const large={pair:{sub:'30m',main:'3h'},wave:{...base,ms:1800000}};
  assert.deepEqual(selectLargestWaves([small,large]),[large]);
});
test('大级别主分型未确认也优先等待，不提前退回小级别报警',()=>{
  const base={start:0,end:3600000,high:100,low:80};
  const selected=selectLargestWaves([
    {pair:{sub:'15m',main:'2h'},wave:{...base,ms:900000},confirmed:true},
    {pair:{sub:'30m',main:'3h'},wave:{...base,ms:1800000},confirmed:false},
  ]);
  assert.equal(selected.length,1);assert.equal(selected[0].confirmed,false);
});
test('时间不同或端点价格不同的回调不能跨级别合并',()=>{
  const a={start:0,end:3600000,ms:900000,high:100,low:80};
  assert.equal(sameWaveMove(a,{...a,low:70}),false);
  assert.equal(sameWaveMove(a,{...a,start:900000}),false);
  assert.equal(selectLargestWaves([{wave:a},{wave:{...a,low:70,ms:1800000}}]).length,2);
});
test('一笔4根只构成降档候选，不直接当作原级别五浪',()=>{
  const f=fixture();f.sub.pts[1].origIdx=4;
  assert.equal(findFiveWaves(f.sub,5),null);
  const near=findFiveWaves(f.sub,4);assert.ok(near);
  assert.deepEqual(near.bars,[4,8,6,6,6]);
});
test('后续反弹形成顶端点不会挤掉完成的第五笔',()=>{
  const f=fixture();f.sub.pts.push({origIdx:31,confirmIdx:32,type:'top',price:70});
  const hit=detect(f);assert.ok(hit);assert.equal(hit.subPoints.at(-1).t,2600);
});
test('五浪、每笔至少5根、主级别底分型收盘同时成立',()=>{
  const f=fixture(), h=detect(f); assert.ok(h); assert.deepEqual(h.subBars,[6,6,6,6,6]);
  const alert=makeChainAlert('TESTUSDT',h,3600);
  assert.equal(alert.confirmedAt,3600); assert.match(alert.text,/每笔 6\/6\/6\/6\/6/);
  assert.equal(alert.chainSubPoints.length,6);
  assert.deepEqual(alert.chainSubPoints.map(p=>p.t),[100,600,1100,1600,2100,2600]);
  assert.deepEqual(alert.chainSubPoints.map(p=>p.price),[110,80,95,60,85,40]);
});
test('次级别端点间含首尾5根通过，4根拒绝',()=>{
  const f=fixture();f.sub.pts[1].origIdx=5; assert.ok(detect(f));
  f.sub.pts[1].origIdx=4;assert.equal(detect(f),null);
});
test('主级别确认K线未收盘不提醒',()=>{
  const f=fixture();f.main.closed=5;assert.equal(detect(f),null);
});
test('未收盘次级别分型不能用于第五笔',()=>{
  const f=fixture();f.sub.closed=27;assert.equal(detect(f),null);
});
test('主级别确认时刻之后的次级别确认不能回填',()=>{
  const f=fixture();f.sub.pts[5].confirmIdx=36;f.sub.t.push(3600);f.sub.closed=37;
  assert.equal(detect(f),null);
});
test('底分型已过去一根主级别K线不补报',()=>{
  const f=fixture();f.main.t.push(3600);f.main.h.push(80);f.main.l.push(60);f.main.c.push(70);f.main.closed++;
  assert.equal(detect(f),null);
});
test('第三周期末段不足5根不影响两级结构',()=>{
  const f=fixture();for(let i=215;i<267;i++)f.inner.dif[i]=1;
  assert.ok(detect(f));
});
test('第三周期K线缺口不影响两级结构',()=>{
  const f=fixture();f.inner.t[100]+=1;assert.ok(detect(f));
});
test('笔方向必须与实际高低价格一致',()=>{
  const f=fixture();f.sub.pts[1].price=120;assert.equal(detect(f),null);
});
test('五笔末底无需与主级别低点在同一根K线',()=>{
  const f=fixture();f.sub.pts[5].origIdx=31;f.sub.pts[5].confirmIdx=32;
  assert.ok(detect(f));
});
test('内部0至4次MACD交叉不因次数不足被拒绝，文案不误称五浪完成',()=>{
  for(let count=0;count<5;count++){
    const f=fixture();let sign=1;
    const flips=[25,65,105,165].slice(0,count);
    f.inner.dif=f.inner.dif.map((_,i)=>{if(flips.includes(i))sign=-sign;return sign;});
    const h=detect(f);assert.ok(h,`cross count ${count}`);
    assert.equal(h.innerKey,null);
    assert.doesNotMatch(makeChainAlert('TESTUSDT',h,3600).text,/MACD|三级/);
  }
});
test('第三周期交叉间隔不影响两级结构',()=>{
  const f=fixture();f.inner.dif=f.inner.dif.map((_,i)=>i>=25&&i<28?-1:1);
  assert.ok(detect(f));
});
test('10分钟五笔与1小时底分型可独立触发，不读取6小时或其他周期',()=>{
  const f=fixture();
  for(let i=6;i<8;i++){f.main.t.push(i*600);f.main.h.push(80);f.main.l.push(60);f.main.c.push(70);}
  const knots=[{origIdx:0,price:100},...f.sub.pts,{origIdx:35,price:70}];
  for(let i=0;i<36;i++){
    const j=Math.max(1,knots.findIndex(p=>p.origIdx>=i)),a=knots[j-1],b=knots[j];
    const price=a.price+(b.price-a.price)*(i-a.origIdx)/(b.origIdx-a.origIdx);
    f.sub.h[i]=price+0.1;f.sub.l[i]=price-0.1;f.sub.c[i]=price;
  }
  const wrap=v=>({...v,closedCount:v.closed,ensure:()=>({ema7:[]}),macd:()=>({dif:[],dea:[]})});
  const map=new Proxy({'1h':wrap(f.main),'10m':wrap(f.sub)},{get(o,k){assert.ok(k in o,`不得读取第三周期 ${String(k)}`);return o[k];}});
  const cfg={...DEFAULT_SIGNAL,chainTriples:[{main:'1h',sub:'10m'}]};
  const seen=new Map(),alerts=scanChains('TESTUSDT',map,cfg,seen,3600);
  assert.equal(alerts.length,1);assert.equal(alerts[0].innerLevel,null);
  assert.equal(scanChains('TESTUSDT',map,cfg,seen,3601).length,0);
});
test('形成中K线与未来数据不能改变已收盘视图中的笔',()=>{
  const s=new CandleSeries({key:'10m',minutes:10});
  for(let i=0;i<60;i++){const p=100+20*Math.sin(i/4);s.upsert({t:i*s.ms,o:p,h:p+1,l:p-1,c:p,v:1,q:1,n:1,done:i<59});}
  const a=chainView(s,'10m',5,50*s.ms);
  s.upsert({t:59*s.ms,o:500,h:1000,l:0,c:500,v:1,q:1,n:1,done:false});
  const b=chainView(s,'10m',5,50*s.ms);
  assert.equal(a.closed,50);assert.deepEqual(a.pts,b.pts);
});
