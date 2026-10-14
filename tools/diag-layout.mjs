/**
 * 图表布局体检：抓每张卡片的位置/尺寸，看是否"平铺/协调"
 *   node tools/diag-layout.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://tusiyivip-source.github.io/binance-watch/?top=20';
const PORT = 9391;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lay-'));
const child = spawn(CHROME, ['--headless=new', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'],
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
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result?.value;
};

const report = async (label, gridSel) => {
  const g = await evalJs(`(() => {
    const grid = document.querySelector('${gridSel}');
    if (!grid) return { err: 'no grid' };
    const gr = grid.getBoundingClientRect();
    const cs = getComputedStyle(grid);
    const cards = [...grid.children].filter(c => getComputedStyle(c).display !== 'none');
    const rects = cards.map(c => { const r = c.getBoundingClientRect(); return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
    const uniq = a => [...new Set(a)].sort((p, q) => p - q);
    return {
      grid: { x: Math.round(gr.x), y: Math.round(gr.y), w: Math.round(gr.width), h: Math.round(gr.height) },
      cols: cs.getPropertyValue('--cols').trim(), ch: cs.getPropertyValue('--ch').trim(),
      display: cs.display, n: cards.length,
      widths: uniq(rects.map(r => r.w)), heights: uniq(rects.map(r => r.h)),
      rowYs: uniq(rects.map(r => r.y)), perRow: (() => {
        const m = new Map(); rects.forEach(r => m.set(r.y, (m.get(r.y) ?? 0) + 1)); return [...m.values()];
      })(),
      lastRowRight: (() => { if (!rects.length) return 0;
        const maxY = Math.max(...rects.map(r => r.y));
        const last = rects.filter(r => r.y === maxY);
        return Math.round(Math.max(...last.map(r => r.x + r.w)) - gr.x); })(),
      bottomGap: (() => { if (!rects.length) return 0;
        const maxBottom = Math.max(...rects.map(r => r.y + r.h));
        return Math.round(gr.y + gr.height - maxBottom); })(),
      rects: rects.slice(0, 6),
    };
  })()`);
  console.log(`\n【${label}】`);
  console.log('  网格：', JSON.stringify(g.grid), ' 列数=', g.cols, ' 行高=', g.ch);
  console.log('  卡片数=', g.n, ' 每行张数=', JSON.stringify(g.perRow));
  console.log('  卡片宽度集合=', JSON.stringify(g.widths), ' 高度集合=', JSON.stringify(g.heights));
  console.log('  行数(y 去重)=', g.rowYs.length, ' 末行右边界距网格右边缘=', Math.round(g.grid.w - g.lastRowRight), 'px  底部空隙=', g.bottomGap, 'px');
  console.log('  前几张：', JSON.stringify(g.rects));
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const ready = await evalJs(`(document.querySelectorAll('#matrix tr, #grid tr').length > 1) || (typeof SNAP !== 'undefined' && SNAP?.symbols?.length > 0)`);
    if (ready) break;
  }
  // 全部级别
  await evalJs(`document.querySelector('#tab-multi').click()`);
  await sleep(9000);
  await report('K线图 · 全部级别', '#chartgrid');
  fs.writeFileSync(path.join(os.tmpdir(), 'dsh-layout-all.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // 只看 30分
  await evalJs(`(() => { const s = document.querySelector('#chart-level'); s.value = '30m'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(6000);
  await report('K线图 · 只看 30分', '#chartgrid');
  // 五浪视图
  await evalJs(`document.querySelector('#tab-wave').click()`);
  await sleep(6000);
  await report('五浪反弹视图', '#wavechartgrid');
  // 报警级别K线
  await evalJs(`document.querySelector('#tab-alert').click()`);
  await sleep(6000);
  await report('报警级别K线', '#alertchartgrid');
  fs.writeFileSync(path.join(os.tmpdir(), 'dsh-layout-alert.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('\n截图已存到临时目录（不再写进仓库）');
} catch (e) {
  console.log('探针异常：' + e.message);
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
}
