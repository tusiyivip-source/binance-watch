/**
 * 线上页面「没反应」诊断：直接抓控制台异常 / 失败请求 / 界面状态
 *   node tools/diag-live.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://tusiyivip-source.github.io/binance-watch/';
const PORT = 9381;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diag-'));
const child = spawn(CHROME, ['--headless=new', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => {
    pending.set(i, { res, rej });
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 60000);
  });
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') };
  return r.result?.value;
};

const exceptions = [], consoleErrs = [], failed = [];
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push((d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 160));
    }
    if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText + ' ' + (m.params.blockedReason ?? ''));
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      failed.push('HTTP ' + m.params.response.status + ' ' + m.params.response.url.slice(0, 120));
    }
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate', { url: URL_ });

  for (const t of [5, 10, 20, 35]) {
    await sleep(t === 5 ? 5000 : (t === 10 ? 5000 : (t === 20 ? 10000 : 15000)));
    const st = await evalJs(`(() => ({
      ready: document.readyState,
      title: document.title,
      cssLoaded: [...document.styleSheets].length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      scripts: [...document.scripts].map(s => s.src || '(inline)').length,
      hasLC: typeof LC !== 'undefined',
      hasSNAP: typeof SNAP !== 'undefined',
      matrixRows: document.querySelectorAll('#matrix tr, #grid tr').length,
      symbar: !!document.querySelector('#chart-symbar'),
      alertLevel: !!document.querySelector('#alert-level'),
      webBanner: document.querySelector('#web-mode-note')?.style.display ?? 'n/a',
      bannerText: (document.querySelector('#web-mode-note')?.textContent ?? '').slice(0, 200),
    }))()`);
    console.log(`t=${t}s`, JSON.stringify(st));
  }
} catch (e) {
  console.log('探针异常：' + e.message);
} finally {
  console.log('\n=== JS 异常 (' + exceptions.length + ') ===');
  [...new Set(exceptions)].slice(0, 8).forEach(x => console.log('  ✗ ' + x));
  console.log('=== 控制台 error/warn (' + consoleErrs.length + ') ===');
  [...new Set(consoleErrs)].slice(0, 8).forEach(x => console.log('  ! ' + x));
  console.log('=== 失败请求/响应 (' + failed.length + ') ===');
  [...new Set(failed)].slice(0, 10).forEach(x => console.log('  ✗ ' + x));
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
}
