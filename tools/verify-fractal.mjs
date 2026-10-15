/**
 * 验证「标准底分型」判定是否符合用户给的分类图
 *   node tools/verify-fractal.mjs
 *
 * A) 用图中 5 种形状逐条喂进判定器
 * B) 从实盘 /api/alertchart?kind=wavefirst 取一条真实报警，打印那三根K线并复核
 */
import { isBottomFractal } from '../src/fractal.js';

const bar = (h, l, o = null, c = null) => ({
  t: 0, o: o ?? (h + l) / 2, h, l, c: c ?? (h + l) / 2,
});
/** 把三根 bar 造成序列（中间那根下标 1） */
const seq = (b1, b2, b3) => ({
  key: 'x', ms: 60000, t: [0, 1, 2], h: [b1.h, b2.h, b3.h], l: [b1.l, b2.l, b3.l],
  c: [b1.c, b2.c, b3.c], o: [b1.o, b2.o, b3.o],
});

const CASES = [
  { name: '标准底分型（图中：中间高低点都最低）', bars: [bar(100, 90), bar(89, 80), bar(99, 89)], expect: { standard: true, relay: false } },
  { name: '中继底分型（图中：小阴/小阳，高点更低）', bars: [bar(100, 90), bar(89, 80), bar(88, 85)], expect: { standard: false, relay: true } },
  { name: '最弱底分型（图中：末根高点低于首根高点）', bars: [bar(100, 90), bar(97, 85), bar(95, 92)], expect: { standard: false, weakest: true } },
  { name: '中继底分型（中间高点不是三根最低，且末根高点不低于首根）', bars: [bar(95, 90), bar(97, 85), bar(100, 92)], expect: { standard: false, relay: true } },
  { name: '反例·顶分型（中间最高，不是底）', bars: [bar(80, 70), bar(100, 92), bar(85, 75)], expect: { standard: false, relay: false, any: false } },
  { name: '反例·中间低点不是最低', bars: [bar(100, 80), bar(90, 85), bar(95, 82)], expect: { standard: false, relay: false, any: false } },
];

console.log('===== A) 按分类图的形状逐条判定 =====');
let bad = 0;
for (const c of CASES) {
  const v = seq(...c.bars);
  const got = {};
  for (const t of ['standard', 'relay', 'weakest', 'any']) got[t] = isBottomFractal(v, 1, t);
  const exp = c.expect;
  const ok = Object.keys(exp).every(k => got[k] === exp[k]);
  if (!ok) bad++;
  const detail = c.bars.map(b => `[${b.h}/${b.l}]`).join(' ');
  console.log(`  ${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`      三根K线(高/低)：${detail}`);
  console.log(`      判定 标准=${got.standard} 中继=${got.relay} 最弱=${got.weakest} 任意=${got.any}` +
    (ok ? '' : `   ← 期望 ${JSON.stringify(exp)}`));
}

console.log('\n===== B) 实盘报警复核 =====');
try {
  const r = await fetch('http://127.0.0.1:8860/api/alertchart?kind=wavefirst&limit=1').then(x => x.json());
  const it = r.items?.[0];
  if (!it) { console.log('  （当前没有首底报警可复核）'); }
  else {
    const cs = it.candles ?? [];
    // 找到报警那一根（candleT = 底分型中间那根的开盘时刻）
    const at = it.signalT ?? it.candleT;
    const idx = cs.findIndex(c => c[0] === at);
    console.log(`  ${it.symbol} ${it.label} · 报警时刻 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`);
    if (idx < 1 || idx + 1 >= cs.length) console.log('  ✗ 定位不到那三根K线');
    else {
      const [a, b, c2] = [cs[idx - 1], cs[idx], cs[idx + 1]];
      const f = n => n.toPrecision(7);
      console.log('  三根K线（时间 / 开 / 高 / 低 / 收）：');
      for (const [k, arr] of [[-1, a], [0, b], [1, c2]]) {
        console.log(`    ${k === 0 ? '中' : k < 0 ? '前' : '后'} ${new Date(arr[0]).toLocaleTimeString('zh-CN', { hour12: false })}`
          + `  O${f(arr[1])} H${f(arr[2])} L${f(arr[3])} C${f(arr[4])}`);
      }
      const v = { t: [a[0], b[0], c2[0]], h: [a[2], b[2], c2[2]], l: [a[3], b[3], c2[3]], c: [a[4], b[4], c2[4]] };
      const condLow = v.l[1] < v.l[0] && v.l[1] < v.l[2];
      const condHigh = v.h[1] < v.h[0] && v.h[1] < v.h[2];
      console.log(`  复核：中间低点最低=${condLow}（${f(b[3])} < ${f(a[3])}, ${f(c2[3])}）`);
      console.log(`        中间高点最低=${condHigh}（${f(b[2])} < ${f(a[2])}, ${f(c2[2])}）`);
      console.log(`        → 标准底分型判定：${isBottomFractal(v, 1, 'standard') ? '✓ 是' : '✗ 否'}`);
    }
  }
} catch (e) {
  console.log('  （取实盘数据失败：' + e.message + '）');
}
console.log(bad === 0 ? '\nA 部分全部符合预期 ✓' : `\nA 部分有 ${bad} 条不符 ✗`);
