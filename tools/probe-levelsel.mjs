/**
 * 级别选择器真机验证：node tools/probe-levelsel.mjs [url]
 *
 * 断言：
 *   1. 「📈 K线图」工具栏里有 #chart-level，选项 = 全部级别 + 各级别（含报警级别）
 *   2. 选中某个级别后，图上只剩那一张
 *   3. 「🔔 报警级别K线」工具栏里有 #alert-level，选项来自实际报警的级别
 *   4. 切换级别时图表数量随之变化，且没有 JS 异常
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8850/?top=20';
const PORT = 9361;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lvl-'));
const child = spawn(CHROME, ['--headless=new', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => {
    pending.set(i, { res, rej });
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 120000);
  });
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  // ⚠ 必须挂 message 监听把 CDP 的回复派发给 pending，否则 send() 永远等不到结果
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_ });

  // 等界面就绪（矩阵有行 / 引擎起来）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      ready = await evalJs(`(() => {
        const rows = document.querySelectorAll('#matrix tbody tr, #grid tr, .mrow').length;
        return rows > 0 || (typeof SNAP !== 'undefined' && SNAP && (SNAP.symbols?.length ?? 0) > 0);
      })()`);
    } catch { }
    if (ready) break;
  }
  console.log(`等待就绪：${ready ? '已就绪' : '超时（仍继续断言）'}`);

  // 切到「K线图」
  await evalJs(`document.querySelector('#tab-multi').click()`);
  let cards0 = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    cards0 = await evalJs(`document.querySelectorAll('#chartgrid .card, #chartgrid > div').length`);
    if (cards0 > 0) break;
  }
  await sleep(2000);
  console.log(`  等待图表就绪：卡片 ${cards0} 张`);

  const multi = await evalJs(`(() => {
    const sel = document.querySelector('#chart-level');
    const cards = document.querySelectorAll('#chartgrid .card, #chartgrid > div').length;
    return { has: !!sel, options: sel ? [...sel.options].map(o => o.value + ':' + o.textContent) : [], cards };
  })()`);
  ok('★ K线图工具栏里有级别选择器 #chart-level', multi.has);
  ok('★ 选项包含「全部级别」', (multi.options[0] || '').startsWith('all:'), multi.options.slice(0, 3).join(' | '));
  ok('★ 选项覆盖多个级别（≥5 个）', multi.options.length >= 6, `共 ${multi.options.length} 项`);
  ok('★ 默认「全部级别」时画了多张图', multi.cards > 3, `卡片数 ${multi.cards}`);

  // 选一个具体级别 → 只剩一张
  const pickOpt = multi.options.find(o => o.startsWith('30m:')) || multi.options.find(o => o !== 'all' && !o.startsWith('all:')) || null;
  const target = pickOpt ? pickOpt.split(':')[0] : '15m';
  await evalJs(`(() => { const s = document.querySelector('#chart-level'); s.value = ${JSON.stringify(target)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  await sleep(5000);
  const after = await evalJs(`(() => {
    const cards = document.querySelectorAll('#chartgrid .card, #chartgrid > div').length;
    const live = document.querySelector('#chart-live')?.textContent ?? '';
    return { cards, live };
  })()`);
  ok(`★ 选中「${target}」后图上只剩 1 张`, after.cards === 1, `卡片数 ${after.cards} · 状态栏：${after.live.slice(0, 60)}`);
  ok('★ 状态栏标出「只看 xxx」', /只看/.test(after.live), after.live.slice(0, 60));

  // 再切回全部
  await evalJs(`(() => { const s = document.querySelector('#chart-level'); s.value = 'all'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(4000);
  const back = await evalJs(`document.querySelectorAll('#chartgrid .card, #chartgrid > div').length`);
  ok('★ 切回「全部级别」后恢复多张', back > 3, `卡片数 ${back}`);

  // 报警级别K线视图
  await evalJs(`document.querySelector('#tab-alert').click()`);
  await sleep(5000);
  const alert = await evalJs(`(() => {
    const sel = document.querySelector('#alert-level');
    const cards = document.querySelectorAll('#alertchartgrid .card, #alertchartgrid > div').length;
    return { has: !!sel, options: sel ? [...sel.options].map(o => o.value) : [], cards };
  })()`);
  ok('★ 报警级别K线工具栏里有 #alert-level（按报警级别筛选）', alert.has);
  ok('★ 选项含「全部报警级别」', alert.options.includes('all'), alert.options.join(','));
  if (alert.options.length > 1) {
    const lv = alert.options.find(o => o !== 'all');
    await evalJs(`(() => { const s = document.querySelector('#alert-level'); s.value = ${JSON.stringify(lv)}; s.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(5000);
    const onlyOne = await evalJs(`(() => {
      const cards = [...document.querySelectorAll('#alertchartgrid .card, #alertchartgrid > div')];
      const labels = cards.map(c => c.querySelector('.lv')?.textContent ?? '').filter(Boolean);
      return { n: cards.length, labels };
    })()`);
    const same = onlyOne.labels.length === 0 || new Set(onlyOne.labels).size === 1;
    ok(`★ 筛选「${lv}」后只显示该级别的报警`, same, `卡片 ${onlyOne.n} · 级别 ${[...new Set(onlyOne.labels)].join('/')}`);
  }

  const errs = await evalJs(`(window.__DSH_ERRORS__ || []).length`);
  ok('★ 无 JS 异常', !errs || errs === 0, `异常数 ${errs}`);
} catch (e) {
  console.log('  ✗ 探针异常：' + e.message);
  fail++;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
}
console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
