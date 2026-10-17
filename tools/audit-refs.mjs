/** 引用关系体检：哪些模块真的被用到、哪些是死代码 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const srcFiles = fs.readdirSync('src').filter(f => f.endsWith('.js'));
const entry = ['server.js', ...srcFiles.map(f => 'src/' + f)];
const allText = {};
for (const f of entry) allText[f] = read(f);
const toolsText = fs.readdirSync('tools').filter(f => /\.(mjs|js)$/.test(f)).map(f => read('tools/' + f)).join('\n');

const imports = {};
for (const f of entry) {
  const t = allText[f];
  const list = [...t.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).filter(p => p.startsWith('.'));
  imports[f] = list.map(p => path.normalize(path.join(path.dirname(f), p)).replace(/\\/g, '/'));
}

console.log('================ 模块引用关系 ================');
const usedBy = {};
for (const [from, list] of Object.entries(imports)) {
  for (const to of list) {
    const key = to.endsWith('.js') ? to : to + '.js';
    (usedBy[key] = usedBy[key] ?? []).push(from);
  }
}
for (const f of srcFiles.map(x => 'src/' + x)) {
  const by = usedBy[f] ?? [];
  const inTools = toolsText.includes(path.basename(f, '.js'));
  const flag = by.length ? '' : (inTools ? '（仅测试/工具引用）' : '★ ★ 完全未被引用');
  console.log(`  ${f.padEnd(26)} 被 ${String(by.length).padStart(2)} 个模块引用 ${flag}`);
  if (by.length && by.length <= 3) console.log(`       ← ${by.join(', ')}`);
}

console.log('\n================ 疑似死代码（启用通道之外） ================');
const { DEFAULT_SIGNAL } = await import('../src/config.js');
const groups = [
  { mod: 'src/watch.js', flag: 'watchEnabled', label: '回调靠零轴' },
  { mod: 'src/wave.js', flag: 'waveEnabled', label: '五浪反弹' },
  { mod: 'src/firstbottom.js', flag: 'fbEnabled', label: '五浪首底' },
  { mod: 'src/breakout.js', flag: 'brkEnabled', label: '均线压制突破' },
  { mod: 'src/top5.js', flag: 'top5Enabled', label: '顶部结构（已停用）' },
];
for (const g of groups) {
  if (DEFAULT_SIGNAL[g.flag] !== true) {
    const lines = allText[g.mod]?.split('\n').length ?? 0;
    console.log(`  ${g.label.padEnd(18)} ${g.mod.padEnd(22)} ${String(lines).padStart(4)} 行  开关关闭`);
  }
}
const sigLines = allText['src/signals.js']?.split('\n').length ?? 0;
console.log(`  signals.js（早期共振/双阴/笔链逻辑）${String(sigLines).padStart(4)} 行 —— 引擎当前是否调用见上表`);
