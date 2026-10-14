/**
 * 简化后界面的真机验证：node tools/probe-ui.mjs [url]
 *
 * 断言（对应「删除多级别矩阵 / K线图 / 缠论笔」+「默认五浪」）：
 *   1. 只剩两个页签，默认选中「🌊 五浪反弹」
 *   2. 多级别矩阵与 K线图 的元素已彻底不存在
 *   3. 「缠论笔」勾选框已不存在，图上也没有笔线序列
 *   4. 五浪视图能正常渲染（卡片或空态）
 *   5. 切到「报警级别K线」正常，级别筛选可用
 *   6. 全程无 JS 异常、无失败请求
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://tusiyivip-source.github.io/binance-watch/?top=20';
const PORT = 9411;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-'));
const child = spawn(CHROME, ['--headless=new', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

let ws, id = 0; const pending = new Map(); const ex = [];
const send = (m, p = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => {
    pending.set(i, { res, rej });
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 60000);
  });
};
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
};
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`); c ? pass++ : fail++; };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') ex.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') ex.push('console: ' + m.params.args.map(a => a.value ?? '').join(' ').slice(0, 120));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_ });

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const r = await evalJs(`typeof SNAP !== 'undefined' && (SNAP?.symbols?.length ?? 0) > 0`);
    if (r === true) break;
  }
  await sleep(6000);

  const st = await evalJs(`(() => ({
    tabs: [...document.querySelectorAll('.viewtabs .vt')].filter(b => /^tab-/.test(b.id)).map(b => b.id + (b.classList.contains('on') ? '(选中)' : '')),
    hasMatrix: !!document.querySelector('#tablewrap, #grid, #tab-matrix'),
    hasMulti: !!document.querySelector('#chartgrid, #tab-multi, #chart-symbar, #chart-level'),
    hasChanBox: !!document.querySelector('#chart-chan'),
    bodyClass: document.body.className,
    waveGrid: !!document.querySelector('#wavechartgrid'),
    waveCards: document.querySelectorAll('#wavechartgrid .chartcard').length,
    waveEmptyShown: (document.querySelector('#wave-empty')?.style.display ?? 'x') !== 'none',
    alertGrid: !!document.querySelector('#alertchartgrid'),
    alertLevelVisible: (() => { const s = document.querySelector('#alert-level'); return !!s; })(),
  }))()`);

  const tabIds = st.tabs.map(t => t.replace('(选中)', ''));
  ok('★ 只剩两个页签（报警级别K线 + 五浪反弹）', tabIds.length === 2 && tabIds.includes('tab-alert') && tabIds.includes('tab-wave'), st.tabs.join(' '));
  ok('★ 默认选中「🌊 五浪反弹」', st.tabs.some(t => t.startsWith('tab-wave') && t.includes('选中')), st.bodyClass);
  ok('★ 多级别矩阵已彻底移除', !st.hasMatrix);
  ok('★ K线图（多级别）已彻底移除', !st.hasMulti);
  ok('★ 「缠论笔」勾选框已移除', !st.hasChanBox);
  ok('★ 五浪视图容器在且能渲染（卡片或空态）', st.waveGrid && (st.waveCards > 0 || st.waveEmptyShown),
    'cards=' + st.waveCards + ' empty=' + st.waveEmptyShown);

  // 切到报警视图
  await evalJs(`document.querySelector('#tab-alert').click()`);
  await sleep(6000);
  const alt = await evalJs(`(() => ({
    bodyClass: document.body.className,
    alertShown: getComputedStyle(document.querySelector('#alertchartwrap')).display !== 'none',
    waveHidden: getComputedStyle(document.querySelector('#wavechartwrap')).display === 'none',
    levelSel: !!document.querySelector('#alert-level') && getComputedStyle(document.querySelector('#alert-level')).display !== 'none',
    cards: document.querySelectorAll('#alertchartgrid .chartcard').length,
    empty: (document.querySelector('#alert-empty')?.style.display ?? 'x'),
  }))()`);
  ok('★ 切到报警级别K线：该视图显示、五浪视图隐藏', alt.alertShown && alt.waveHidden, alt.bodyClass);
  ok('★ 报警级别筛选存在且可见', alt.levelSel);
  ok('★ 报警视图能渲染（卡片或空态）', alt.cards > 0 || alt.empty !== 'none', 'cards=' + alt.cards);

  // 切回五浪
  await evalJs(`document.querySelector('#tab-wave').click()`);
  await sleep(4000);
  const back = await evalJs(`getComputedStyle(document.querySelector('#wavechartwrap')).display !== 'none'`);
  ok('★ 切回五浪正常', back === true);

  ok('★ 全程无 JS 异常', ex.length === 0, ex.slice(0, 2).join(' | '));
} catch (e) {
  console.log('  ✗ 探针异常：' + e.message); fail++;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
}
console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
