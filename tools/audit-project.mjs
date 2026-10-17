/**
 * 项目体检：静态面
 *   node tools/audit-project.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const run = cmd => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return ''; } };
const pct = (a, b) => b ? (a / b * 100).toFixed(0) + '%' : '-';

console.log('================ 1. 仓库体积 ================');
const tree = run('git ls-tree -r -l HEAD').split('\n').filter(Boolean);
const files = tree.map(line => {
  const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\s+(\d+)\t(.*)$/);
  return m ? { size: +m[3], p: m[4] } : null;
}).filter(Boolean);
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`跟踪文件 ${files.length} 个 · 合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
const groups = {};
for (const f of files) {
  const k = f.p.includes('/') ? f.p.split('/')[0] : '(根)';
  groups[k] = groups[k] ?? { n: 0, size: 0 };
  groups[k].n++; groups[k].size += f.size;
}
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${k.padEnd(10)} ${String(v.n).padStart(4)} 个  ${(v.size / 1024).toFixed(0).padStart(7)} KB  ${pct(v.size, total)}`);
}
console.log(`  docs/ 副本占 ${pct(groups['docs']?.size ?? 0, total)}（构建产物，与 public/ 重复）`);

console.log('\n================ 2. 源码规模 ================');
const src = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js'));
let srcTotal = 0;
const srcRows = [];
for (const f of src) {
  const txt = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  const lines = txt.split('\n').length;
  srcTotal += lines;
  // 是否被别处 import
  const used = run(`git grep -l "from './${f}" -- server.js src tools public 2>nul`).trim()
    || run(`git grep -l "${f}" -- server.js src tools 2>nul`).trim();
  srcRows.push({ f, lines, used: !!used });
}
for (const r of srcRows.sort((a, b) => b.lines - a.lines)) {
  console.log(`  ${r.f.padEnd(22)} ${String(r.lines).padStart(5)} 行  ${r.used ? '' : '★ 未被引用'}`);
}
console.log(`  小计 ${srcTotal} 行（src/）`);
const tools = fs.readdirSync(path.join(ROOT, 'tools')).filter(f => /\.(mjs|js|py)$/.test(f));
console.log(`  tools/ 脚本 ${tools.length} 个`);

console.log('\n================ 3. 策略通道启用状态 ================');
const { DEFAULT_SIGNAL } = await import('../src/config.js');
const flags = ['signalEnabled', 'watchEnabled', 'waveEnabled', 'dualEnabled', 'fbEnabled', 'brkEnabled', 'chainEnabled', 'top5Enabled', 'bot5Enabled', 'fracEnabled', 'fibEnabled', 'res2Enabled'];
for (const k of flags) console.log(`  ${k.padEnd(16)} ${DEFAULT_SIGNAL[k] === true ? '开' : '关'}`);

console.log('\n================ 4. 已关闭策略的界面残留 ================');
const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const chart = fs.readFileSync(path.join(ROOT, 'public/chart.js'), 'utf8');
const kinds = { watch: '回调靠零轴', wave: '五浪完成', wavefirst: '五浪首底', breakout: '均线突破', dual: '双阴', top5: '顶部结构', bot5: '底部结构', chain: '两级五浪', frac: '底分型即报', fib: '斐波那契', res2: '共振' };
const on = new Set(Object.keys(kinds).filter(k => {
  const map = { watch: 'watchEnabled', wave: 'waveEnabled', wavefirst: 'fbEnabled', breakout: 'brkEnabled', dual: 'dualEnabled', top5: 'top5Enabled', bot5: 'bot5Enabled', chain: 'chainEnabled', frac: 'fracEnabled', fib: 'fibEnabled', res2: 'res2Enabled' };
  return DEFAULT_SIGNAL[map[k]] === true;
}));
for (const [k, label] of Object.entries(kinds)) {
  const inSel = idx.includes(`value="${k}"`) || idx.includes(`value="${k},`);
  const inCard = chart.includes(`'${k}'`);
  if (!on.has(k) && (inSel || inCard)) console.log(`  ★ ${label}（${k}）：已关闭，但${inSel ? '仍在通道筛选里' : ''}${inCard ? ' 卡片渲染仍保留' : ''}`);
}
console.log(`  启用中的通道：${[...on].join(', ') || '无'}`);

console.log('\n================ 5. 测试与构建 ================');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`  package.json scripts: ${Object.keys(pkg.scripts ?? {}).join(', ') || '（无）'}`);
const verify = run('node tools/verify.mjs 2>&1');
const m = verify.match(/(\d+) 通过 \/ (\d+) 失败/);
console.log(`  verify.mjs：${m ? `${m[1]} 通过 / ${m[2]} 失败` : '未跑出结果'}`);
const publicFiles = fs.readdirSync(path.join(ROOT, 'public')).filter(f => /\.(js|css|html)$/.test(f));
const docsFiles = fs.readdirSync(path.join(ROOT, 'docs')).filter(f => /\.(js|css|html)$/.test(f));
const drift = publicFiles.filter(f => {
  const a = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  const bPath = path.join(ROOT, 'docs', f);
  return fs.existsSync(bPath) && fs.readFileSync(bPath, 'utf8') !== a;
});
console.log(`  public/ → docs/ 未同步的文件：${drift.length ? drift.join(', ') : '无（已同步）'}`);

console.log('\n================ 6. 运行期数据体积 ================');
const dataDir = path.join(ROOT, 'data');
if (fs.existsSync(dataDir)) {
  const rows = fs.readdirSync(dataDir).map(f => {
    const st = fs.statSync(path.join(dataDir, f));
    return { f, size: st.size, t: st.mtime };
  }).sort((a, b) => b.size - a.size);
  let dtotal = 0;
  for (const r of rows) { dtotal += r.size; }
  for (const r of rows.slice(0, 10)) console.log(`  ${r.f.padEnd(30)} ${(r.size / 1024 / 1024).toFixed(1).padStart(7)} MB  ${r.t.toISOString().slice(0, 10)}`);
  console.log(`  合计 ${(dtotal / 1024 / 1024).toFixed(0)} MB（.gitignore 已排除，仅占本地磁盘）`);
}
