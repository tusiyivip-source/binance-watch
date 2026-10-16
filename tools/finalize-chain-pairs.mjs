import fs from 'node:fs';
import { DEFAULT_SIGNAL } from '../src/config.js';
fs.writeFileSync('data/chain-pairs.json',JSON.stringify(DEFAULT_SIGNAL.chainTriples));
fs.writeFileSync('STRATEGY-CHAIN.md',`# 两级五浪监控

币安U本位合约涨幅榜前200。各组独立判断：

| 五浪级别 | 底分型确认级别 |
| --- | --- |
| 3分钟 | 15分钟 |
| 5分钟 | 30分钟 |
| 10分钟 | 1小时 |
| 15分钟 | 2小时 |
| 30分钟 | 3小时 |
| 1小时 | 6小时 |

小级别下上下上下五笔，每笔至少5根K线（含首尾）。等待对应主级别最低点的底分型第三根收盘确认。
主级别回调至少5根，回看20根，默认any底分型（中间低点低于左右）。首顶仍须处于主级别高点K线内，末底无需与主级别低点时间对应。

每组仅使用两个周期。MACD交叉次数、序列及间隔不作为条件。10分钟五浪只等1小时底分型；6小时仅用于1小时五浪的另一组配对。

仅用确认时刻已收盘数据。同一结构在当前进程内只提醒一次。报警图保存并画出实际识别的六个端点及主级别确认时刻。

验证：node --test tools/chain-rules.test.mjs；node tools/verify.mjs。
`);
for(const p of ['chain.js','config.js'])fs.copyFileSync('src/'+p,'docs/src/'+p);
fs.copyFileSync('public/chart.js','docs/chart.js');
