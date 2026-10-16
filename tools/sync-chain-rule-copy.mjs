import fs from 'node:fs';
for(const path of ['public/index.html','docs/index.html']){
  let text=fs.readFileSync(path,'utf8');
  text=text.replace('MACD <b>死→金→死→金→死</b>，且<b>相邻交叉之间 ≥5 根K线</b>；','MACD <b>不足5次交叉不拦截</b>；满5次检查死→金→死→金→死，已有相邻交叉间隔仍须≥5根；');
  text=text.replace('取五笔窗口内最近一组交叉；第五次死叉后的末段也须至少5根已收盘K线。','取五笔窗口内最近一组交叉；满5次时末段须≥5根。五笔末底无需与主级别低点K线时间对应。');
  text=text.replace('（相邻间隔 ≥5 根）→','（不足5次不拦截，已有间隔仍须≥5根）→');
  fs.writeFileSync(path,text);
}
fs.copyFileSync('src/chain.js','docs/src/chain.js');
