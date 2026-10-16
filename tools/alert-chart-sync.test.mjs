import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { scanResonance } from '../src/resonance.js';

function engine() {
  const e=Object.create(Engine.prototype);
  e.market={symbols:new Map([['TEST',{symbol:'TEST'}]])};
  e.alertChartSnapshots=new Map();
  e.levelPayload=(st,key)=>({key,ms:key==='1h'?3600000:600000,candles:[[0,1,2,0,1,1]]});
  e.alerts=[
    {id:1,kind:'frac',symbol:'TEST',level:'1h',ts:1,initial:false},
    {id:2,kind:'res2',symbol:'TEST',level:'1h',mid:'10m',ts:2,initial:false},
    {id:3,kind:'chain',symbol:'TEST',level:'6h',mid:'1h',ts:3,initial:true},
  ];return e;
}
test('resonance uses main-level chart, never its sublevel',()=>{
  const d=engine().alertCharts(100,24,'res2');
  assert.equal(d.items[0].key,'1h');assert.equal(d.items[0].alertId,2);
});
test('historical alerts are excluded before applying latest limit',()=>{
  const d=engine().alertCharts(100,1,null,{includeHistorical:false});
  assert.equal(d.items[0].alertId,2);assert.equal(d.total,2);
});
test('sidebar selection retrieves exact alert even outside latest limit',()=>{
  const d=engine().alertCharts(320,1,null,{alertId:'1',includeHistorical:false});
  assert.equal(d.items[0].alertId,1);
});
test('level and channel filters apply before limit',()=>{
  const d=engine().alertCharts(100,1,'frac',{level:'1h',includeHistorical:false});
  assert.equal(d.items[0].alertId,1);assert.equal(d.total,1);
});
test('removed symbol still has its captured main chart',()=>{
  const e=engine();e.alertChartSnapshots.set('2|TEST|2',{key:'1h',candles:[[0,1,2,0,1,1]]});e.market.symbols.clear();
  const d=e.alertCharts(100,24,'res2');assert.equal(d.items[0].snapshotOnly,true);assert.equal(d.items[0].key,'1h');
});
test('old resonance remains historical with original event time',()=>{
  const c={kind:'chain',symbol:'TEST',level:'1h',subLevel:'10m',barT:3600000,initial:true};
  const t={kind:'top5',symbol:'TEST',level:'1h',barT:7200000,initial:true};
  const a=scanResonance([c,t],new Map(),{res2WindowBars:3},20000000)[0];
  assert.equal(a.confirmedAt,10800000);assert.equal(a.initial,true);assert.equal(a.confirmationKind,'resonance');
});
test('new resonance may confirm against an earlier known chain',()=>{
  const c={kind:'chain',symbol:'TEST',level:'1h',barT:3600000,initial:true};
  const t={kind:'top5',symbol:'TEST',level:'1h',barT:7200000,initial:false};
  const a=scanResonance([c,t],new Map(),{res2WindowBars:3},10801000)[0];assert.equal(a.initial,false);assert.equal(a.delayMs,1000);
});
