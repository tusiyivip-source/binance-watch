import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const port=9357, sleep=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn(chrome,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(),'chain-online-'))}`,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});
let ws,id=0;const pending=new Map(),errors=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const i=++id,t=setTimeout(()=>{pending.delete(i);reject(Error(method+' timeout'));},15000);pending.set(i,{resolve:v=>{clearTimeout(t);resolve(v)},reject});ws.send(JSON.stringify({id:i,method,params}));});}
try{
 for(let n=0;n<40;n++){try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}await sleep(250);}
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:process.argv[2] || 'https://tusiyivip-source.github.io/binance-watch/'});
 for(let n=0;n<9;n++){
  await sleep(10000);
  const r=await send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const d=window.__DSH_WEB__;return {ready:!!d,title:document.title,body:document.body.innerText.slice(0,600),latestAlerts:d?.engine.alerts,chainConfig:d?{pairs:d.engine.cfg.chainTriples,fractalType:d.engine.cfg.chainFractalType}:null,symbols:d?.market.symbols.size,seed:d?.market.seeding,requests:d?.rest.stats,engine:d?{evaluations:d.engine.evaluations,alerts:d.engine.alerts.length,enabled:d.engine.cfg.chainEnabled}:null}})()`});
  console.log(JSON.stringify({seconds:(n+1)*10,state:r.result.value,errors}));
  fs.writeFileSync('data/online-diagnostic.json',JSON.stringify({state:r.result.value,errors},null,2));
  if(errors.length||r.result.value?.engine?.alerts>0)break;
 }
}finally{ws?.close();child.kill();}


