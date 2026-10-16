import fs from 'node:fs';
import assert from 'node:assert/strict';
const url='http://127.0.0.1:8860/api/config';
if(process.argv[2]==='save'){
  const r=await fetch(url);assert.ok(r.ok);
  fs.writeFileSync('data/chain-restart-config.json',JSON.stringify(await r.json()));
}else{
  const body=fs.readFileSync('data/chain-restart-config.json','utf8');
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});assert.ok(r.ok);
  const cfg=await r.json();assert.deepEqual(cfg,JSON.parse(body));
  console.log(JSON.stringify({enabled:cfg.chainEnabled,pairs:cfg.chainTriples}));
}
