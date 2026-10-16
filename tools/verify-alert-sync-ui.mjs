import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const executable=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const port=9361,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn(executable,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(),'alert-sync-'))}`,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});
let ws,id=0;const pending=new Map(),errors=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const i=++id,t=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(i,{resolve:v=>{clearTimeout(t);resolve(v)},reject});ws.send(JSON.stringify({id:i,method,params}));});}
async function ev(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
try{
 for(let n=0;n<40;n++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}await sleep(250);}
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:8860/'});await sleep(4500);
 const initial=await ev(`({view:activeView,history:document.querySelector('#show-alert-history').checked,items:VIEWS.alert.items.length,old:VIEWS.alert.items.filter(a=>a.initial||a.historical).length})`);
 assert.equal(initial.view,'alert');assert.equal(initial.history,false);assert.equal(initial.old,0);
 await ev(`document.querySelector('#show-alert-history').click();document.querySelector('#alert-kind').value='res2';document.querySelector('#alert-kind').dispatchEvent(new Event('change'));`);await sleep(1500);
 const resonance=await ev(`({items:VIEWS.alert.items.map(a=>({id:a.alertId,key:a.key,level:a.levelLabel,kind:a.kind})),right:[...document.querySelectorAll('#alertlist .acard')].map(e=>e.dataset.alertId)})`);
 assert.ok(resonance.items.length>0,'real resonance data required');
 assert.ok(resonance.items.every(i=>i.kind==='res2'&&resonance.right.includes(String(i.id))));
 const chosen=await ev(`(()=>{const e=document.querySelector('#alertlist .acard');const id=Number(e.dataset.alertId);const a=alerts.find(a=>a.id===id);e.click();return {id,level:a.level};})()`);await sleep(1000);
 const focused=await ev(`({count:VIEWS.alert.items.length,id:VIEWS.alert.items[0]?.alertId,key:VIEWS.alert.items[0]?.key,title:document.querySelector('#alertchartgrid .px')?.title})`);
 assert.equal(focused.count,1);assert.equal(focused.id,chosen.id);assert.equal(focused.key,chosen.level);assert.ok(focused.title.includes('确认'));
 const refresh=await ev(`(async()=>{let n=0;const f=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/api/alertchart'))n++;return f(...args);};document.dispatchEvent(new Event('monitor-alerts-updated'));await new Promise(r=>setTimeout(r,500));window.fetch=f;return n;})()`);assert.ok(refresh>0);
 assert.equal(errors.length,0);const result={initial,resonance,chosen,focused,eventRefreshRequests:refresh,errors};
 fs.writeFileSync('data/alert-sync-ui-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{ws?.close();child.kill();}
