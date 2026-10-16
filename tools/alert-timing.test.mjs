import test from 'node:test';
import assert from 'node:assert/strict';
import { alertTiming } from '../src/alert-timing.js';
import { detectFractalAlert, makeFractalAlert, scanFractalAlerts } from '../src/fractalalert.js';
import { makeChainAlert } from '../src/chain.js';
const ms = 3600000;
const view = {key:'1h',ms,t:[0,1,2,3,4,5,6].map(n=>n*ms),h:[9,8,7,6,5,4,5],l:[8,7,6,5,4,2,3],c:[8,7,6,5,4,3,4],closed:7};
test('bottom fractal confirmation is third candle CLOSE, not its open',()=>{
  const hit=detectFractalAlert(view,{freshBars:0});
  assert.equal(hit.confirmT,7*ms);
  const a=makeFractalAlert('TEST',hit,7*ms+1200);
  assert.equal(a.candleT,5*ms);assert.equal(a.confirmedAt,7*ms);assert.equal(a.delayMs,1200);assert.equal(a.initial,false);
});
test('unclosed third candle cannot trigger',()=>assert.equal(detectFractalAlert({...view,closed:6},{freshBars:0}),null));
test('two-hour-50-minute delay is historical and silent',()=>{
  const r=alertTiming(13*ms,15*ms+50*60000);
  assert.equal(r.delayMs,10200000);assert.equal(r.initial,true);assert.equal(r.historical,true);
});
test('first symbol load remains historical even after global startup phase',()=>assert.equal(alertTiming(7*ms,7*ms+1000,true).initial,true));
test('live scan refuses old fractal even if stored config permits three bars',()=>{
  const v={...view,t:[...view.t,7*ms],h:[...view.h,6],l:[...view.l,4],c:[...view.c,5],closedCount:8,ensure:()=>({})};
  const cfg={fracEnabled:true,fracLevels:['1h'],fracFreshBars:3,fracInitFreshBars:3};
  assert.equal(scanFractalAlerts('TEST',{'1h':v},cfg,new Map(),8*ms,false).length,0);
  const a=scanFractalAlerts('TEST',{'1h':v},cfg,new Map(),8*ms,true);
  assert.equal(a.length,1);assert.equal(a[0].initial,true);assert.equal(a[0].confirmedAt,7*ms);
});
test('structure confirmation and earlier fractal retain distinct timestamps',()=>{
  const a=makeChainAlert('TEST',{mainKey:'1h',subKey:'10m',stage:'confirmed',top:{},confirmT:9*ms,fractalConfirmedAt:7*ms,subBars:[5,5,5,5,5],subLows:[3,2,1],fractal3Lows:[2,1,2]},9*ms+1000);
  assert.equal(a.confirmationKind,'structure');assert.equal(a.confirmedAt,9*ms);assert.equal(a.fractalConfirmedAt,7*ms);
});
