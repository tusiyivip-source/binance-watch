const tabs=await(await fetch('http://127.0.0.1:9357/json/list')).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r));
const result=new Promise(r=>ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id===1)r(m.result);}));
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:`(()=>{const d=window.__DSH_WEB__;return {now:Date.now(),banned:d.rest.bannedUntil,geo:d.rest.geoBlockedUntil,active:d.rest.active,queue:d.rest.queue.length,seeding:d.market.seeding,seeded:[...d.market.symbols.values()].filter(s=>s.seeded).length,stats:d.market.stats,sample:[...d.market.symbols.values()].slice(0,2).map(s=>({symbol:s.symbol,seeded:s.seeded,counts:Object.fromEntries(Object.entries(s.series).map(([k,v])=>[k,v.t.length]))}))}})()`}}));
console.log(JSON.stringify((await result).result.value,null,2));ws.close();
