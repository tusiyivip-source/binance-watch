/* 币安多级别共振盯盘 — 前端 */
'use strict';

const $ = s => document.querySelector(s);
const STATE_NAME = { 0: '数据不足', 1: '多头排列', 2: '站上MA7', 3: '均线纠缠', 4: '弱势', 5: '空头排列' };
const EVENT_NAME = { 0: '', 1: '上穿MA7', 2: '回踩MA7', 3: '跌破MA7', 4: '回踩后突破' };

let LEVELS = [];
let SNAP = null;
// null = 强制重建行顺序。注意不能用 ''：当筛选结果为空集时 orderKey 也是 ''，会被误判为"顺序未变"
let stockRows = new Map();   // symbol -> {tr, refs}
let DISPLAY_ORDER = [];      // 当前表格显示顺序（供 K 线图 ◀ ▶ 使用）
let alerts = [];
let PRICE = new Map();       // symbol -> 最新价（用于报警卡片"信号后"追踪）
let cfg = null;
let soundOn = localStorage.getItem('sound') === '1';
let notifyOn = localStorage.getItem('notify') === '1';

/* ---------------- 格式化 ---------------- */
// 注意：不能用 !isFinite(p) 判断，因为 isFinite(null) === true（Number(null) 是 0），
// 结果 null 会一路走到 p.toPrecision() 抛异常，把整个抽屉的渲染打断。
// 没有数据的级别（新上市币、K线不足）会返回 null，必须显式拦住。
function fmtPrice(p) {
  if (p === null || p === undefined || !isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toPrecision(4);
}
function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}
const pctStr = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
function hhmmss(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const base = s => s.replace(/USDT$/, '');
const lvLabel = k => { const f = LEVELS.find(x => x.key === k); return f ? f.label : k; };

/* ---------------- 声音 ---------------- */
let actx = null;
function ensureAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* 不支持则忽略 */ } }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function beep(kind) {
  if (!soundOn) return;
  const ctx = ensureAudio(); if (!ctx) return;
  const now = ctx.currentTime;
  const notes = kind === 'confirmed' ? [880, 1320] : [660];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.11);
    g.gain.exponentialRampToValueAtTime(0.22, now + i * 0.11 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.19);
    o.connect(g); g.connect(ctx.destination);
    o.start(now + i * 0.11); o.stop(now + i * 0.11 + 0.22);
  });
}

/* ---------------- Toast ---------------- */
function toast(html, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 5200);
  setTimeout(() => el.remove(), 5700);
}

/* ---------------- SSE ---------------- */
let sse = null, lastSnapAt = 0, snapGap = 0;
function connect() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.addEventListener('open', () => setWs('ok', '实时连接'));
  sse.addEventListener('error', () => setWs('bad', '连接断开·重连中'));
  sse.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    LEVELS = d.levels;
    ALL_LEVELS = d.allLevels ?? d.levels;
    cfg = d.cfg;
    fillCfgForm();
    if (d.app?.marketName) {
      MARKET_NAME = d.app.marketName;
      const sub = document.querySelector('.brand p');
      if (sub) {
        const feedTxt = d.app.feed === 'tick-rest' ? '实时价+REST补K线' : d.app.feed === 'kline-ws' ? 'K线WebSocket' : '自动';
        sub.textContent = `${d.app.marketName} · 涨幅榜 Top${d.app.topN} · ${LEVELS.length} 个级别 · MA7/EMA7 回踩突破共振 · 行情源 ${feedTxt}`;
      }
      const h1 = document.querySelector('.brand h1');
      if (h1) h1.textContent = `币安多级别共振盯盘 · ${d.app.market === 'futures' ? '合约' : '现货'}`;
    }
  });
  sse.addEventListener('snapshot', e => {
    const t = performance.now();
    if (lastSnapAt) snapGap = t - lastSnapAt;
    lastSnapAt = t;
    SNAP = JSON.parse(e.data);
      });
  sse.addEventListener('alerts', e => {
    alerts = JSON.parse(e.data);
    renderAlerts();
  });
  sse.addEventListener('alert', e => {
    const a = JSON.parse(e.data);

    // ⚠ 顺序很关键：**先通知，再渲染**，且两者各自 try/catch。
    //   原来是先 renderAlerts() 再弹窗 —— 渲染一旦抛异常（比如某个报警类型字段不全），
    //   弹窗和鸣笛就永远不会执行，用户表现为「信号不弹了」，非常难查。
    //   通知路径不能依赖渲染路径。
    if (!a.initial) {
      try {
        beep(a.confirmed ? 'confirmed' : 'preview');
      } catch (err) { console.warn('[alert] 鸣笛失败', err); }
      try {
        const isDual = a.kind === 'dual';
        const tag = isDual
          ? (a.side === 'long' ? '🔴 双阴不破 · 看多' : '🟢 双阳不穿 · 看空')
          : (a.confirmed ? '✅ 共振确认' : '⚡ 共振预警');
        const tail = isDual ? '' : ` · ${a.score}分`;
        toast(`<b>${base(a.symbol)}</b> ${a.levelLabel ? '· ' + a.levelLabel : ''} · ${tag}${tail}<br>
               <span style="color:#8ba0bd;font-size:11.5px">${a.text}</span>`);
        if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`${a.symbol} ${tag.replace(/[🔴🟢✅⚡]\s*/g, '')}`,
            { body: a.text, tag: a.symbol + (a.level || a.base) + a.candleT });
        }
      } catch (err) { console.warn('[alert] 弹窗失败', err); }
    }

    alerts.unshift(a);
    if (alerts.length > 300) alerts.pop();
    try { renderAlerts(); } catch (err) { console.warn('[alert] 面板渲染失败', err); }
  });
}
function setWs(kind, text) {
  const p = $('#pill-ws');
  p.className = 'pill ' + kind;
  p.innerHTML = `<i></i>${text}`;
}

/* ---------------- 表头 ---------------- */


/* ---------------- 行构建 ---------------- */


/* ---------------- 主渲染 ---------------- */


/* ---------------- 报警列表 ---------------- */
function renderAlerts() {
  const box = $('#alertlist');
  $('#alert-count').textContent = alerts.length;
  const frag = document.createDocumentFragment();
  for (const a of alerts.slice(0, 120)) {
    const el = document.createElement('div');
    el.className = 'acard ' + (a.confirmed ? 'confirmed' : 'pre');
    const extra = (a.matchCount ?? (a.combos ? a.combos.length : 1)) - 1;
    // 防御：不同来源的报警字段并不一致（形态提醒没有 bullCount / distBaseMa7Pct），
    // 直接 .toFixed() 会抛异常并让整个面板渲染中断 —— 这里全部做存在性判断。
    const isDual = a.kind === 'dual';
    const chainTxt = isDual
      ? (lvLabel(a.level || a.base) + (a.side === 'long' ? ' · 双阴不破' : ' · 双阳不穿'))
      : (lvLabel(a.base) + ' → ' + lvLabel(a.mid) + ' → ' + lvLabel(a.big));
    const bullTxt = Number.isFinite(a.bullCount) ? ('共振 ' + a.bullCount + ' 级') : '';
    const distTxt = Number.isFinite(a.distBaseMa7Pct)
      ? ('距MA7 ' + (a.distBaseMa7Pct >= 0 ? '+' : '') + a.distBaseMa7Pct.toFixed(2) + '%') : '';
    // 盯盘（主级别回踩结构）与形态提醒都没有共振评分，不显示「0分」
    const scoreTxt = (isDual || a.kind === 'watch') ? '' : (a.score + '分');
    // 信号后表现追踪：用当前价与信号价对比，便于用户自行验证信号有效性
    const now = PRICE.get(a.symbol);
    const since = (now && a.price) ? ((now - a.price) / a.price) * 100 : null;
    const sinceTxt = since == null ? '<span style="color:#5b6f8c">信号后 —</span>'
      : `<span style="color:${since >= 0 ? '#22c55e' : '#ef4444'}">信号后 ${since >= 0 ? '+' : ''}${since.toFixed(2)}%</span>`;
    el.innerHTML = `
      <div class="l1">
        <span class="sym">${a.symbol}</span>
        <span class="badge2">${a.confirmed ? '已确认' : '预警'}</span>
        ${a.initial ? '<span class="badge3" style="background:#2a3444;color:#94a3b8">存量</span>' : ''}
        <span class="score">${scoreTxt}</span>
      </div>
      <div class="chain">${chainTxt}${extra > 0 ? ` <span style="color:#5b6f8c">(+${extra} 组)</span>` : ''}</div>
      <div class="txt">${a.text}</div>
      <div class="meta">
        <span>@${fmtPrice(a.price)}</span>
        ${bullTxt ? '<span>' + bullTxt + '</span>' : ''}
        ${distTxt ? '<span>' + distTxt + '</span>' : ''}
        <span>${hhmmss(a.ts)}</span>
        ${sinceTxt}
      </div>`;
    el.addEventListener('click', () => openDetail(a.symbol));
    frag.appendChild(el);
  }
  if (!alerts.length) {
    const p = document.createElement('div');
    p.style.cssText = 'color:#5b6f8c;font-size:12px;padding:14px;text-align:center;line-height:1.8';
    p.innerHTML = '暂无共振信号<br><span style="font-size:11px">系统正持续扫描涨幅榜前 200 个标的 × 7 组级别</span>';
    frag.appendChild(p);
  }
  box.textContent = '';
  box.appendChild(frag);
}

/* ---------------- 详情 ---------------- */
window.closeDetailThenChart = function (sym) {
  $('#detail').classList.add('hidden');
  if (typeof openChartFor === 'function') openChartFor(sym);
};
async function openDetail(sym) {
  const d = await fetch('/api/detail?symbol=' + sym).then(r => r.json()).catch(() => null);
  if (!d || d.error) { toast('获取 ' + sym + ' 详情失败', true); return; }
  $('#d-title').innerHTML = `${sym} <span style="font-size:12px;color:${d.changePct >= 0 ? '#22c55e' : '#ef4444'}">${pctStr(d.changePct)}</span>`;
  let html = `<div class="dsum">
      <div class="k"><i>最新价</i><b>${fmtPrice(d.price)}</b></div>
      <div class="k"><i>24h成交额</i><b>${fmtVol(d.quoteVolume)}</b></div>
      <div class="k"><i>数据状态</i><b style="font-size:12px">${d.seeded ? '已播种' : '加载中'}</b></div>
      <div class="k"><i>评估时间</i><b style="font-size:12px">${d.evaluatedAt ? hhmmss(d.evaluatedAt) : '—'}</b></div>
      <div class="k" style="cursor:pointer" onclick="closeDetailThenChart('${sym}')"><i>切换到</i><b style="font-size:12px;color:#38bdf8">📈 K线图</b></div>
    </div>`;

  if (d.matches && d.matches.length) {
    for (const m of d.matches) {
      html += `<div class="hint" style="border-color:#fde047;color:#fde047;margin-bottom:10px">🔔 ${m.text}</div>`;
    }
  }
  html += `<table class="lvtable"><thead><tr>
      <th>级别</th><th>K线</th><th>状态</th><th>价格</th><th>MA7</th><th>EMA7</th><th>MA25</th><th>距MA7</th></tr></thead><tbody>`;
  for (const lv of LEVELS) {
    const x = d.levels[lv.key];
    if (!x) continue;
    const st = STATE_NAME[x.state] ?? '—';
    const dist = x.distMa7Pct;
    html += `<tr>
      <td>${x.label}</td>
      <td style="color:#5b6f8c">${x.closed}/${x.candles}</td>
      <td><span class="pillbox s${x.state}">${st}${x.event ? ' ' + EVENT_NAME[x.event] : ''}</span></td>
      <td>${fmtPrice(x.price)}</td>
      <td>${fmtPrice(x.ma7)}</td>
      <td>${fmtPrice(x.ema7)}</td>
      <td style="color:#8ba0bd">${fmtPrice(x.ma25)}</td>
      <td style="color:${dist >= 0 ? '#22c55e' : '#ef4444'}">${dist == null ? '—' : (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  $('#d-body').innerHTML = html;
  $('#detail').classList.remove('hidden');
}

/* ---------------- 信号绩效 ---------------- */
let perfTimer = null;
function fxPct(x, digits = 2) {
  if (x == null || !isFinite(x)) return '<span style="color:#5b6f8c">—</span>';
  const c = x > 0 ? '#22c55e' : x < 0 ? '#ef4444' : '#8ba0bd';
  return `<span style="color:${c}">${x > 0 ? '+' : ''}${x.toFixed(digits)}%</span>`;
}
function perfRow(h) {
  const n = h?.n ?? 0;
  return `<tr>
    <td>${h?.hours ?? ''} 小时</td>
    <td>${n} / ${h?.total ?? 0}</td>
    <td>${fxPct(h?.avg)}</td>
    <td>${fxPct(h?.med)}</td>
    <td>${n ? h.win.toFixed(1) + '%' : '—'}</td>
    <td>${fxPct(h?.best)}</td>
    <td>${fxPct(h?.worst)}</td>
  </tr>`;
}

async function openPerf() {
  let d;
  try { d = await fetch('/api/performance').then(r => r.json()); }
  catch { toast('获取绩效数据失败', true); return; }
  if (!d) return;
  const resolved = d.horizons?.[1]?.n ?? 0;
  let html = `<div class="dsum">
    <div class="k"><i>累计记录</i><b>${d.total}</b></div>
    <div class="k"><i>参与统计</i><b>${d.tracked}</b></div>
    <div class="k"><i>已确认 / 预警</i><b style="font-size:13px">${d.confirmed} / ${d.preview}</b></div>
    <div class="k"><i>已结算 +4h</i><b>${resolved}</b></div>
  </div>`;

  if (!d.tracked) {
    html += `<div class="hint">还没有信号记录。系统每产生一条报警都会存入 <code>data/signals.jsonl</code>，
      并在 1 / 4 / 24 小时后自动结算实际涨跌幅。运行一段时间后回到这里，就能看到这套逻辑在你本机实际数据上的表现。</div>`;
  } else {
    html += `<div class="hint" style="border-color:#fbbf24;color:#fbbf24">
      ⚠ 这里的数字是<b>你本机实际运行</b>的结果，比任何回测都可信。但注意：
      信号在同一标的的相近时刻高度重叠，有效独立样本远少于条数；短样本下的胜率波动很大，建议至少积累数天后再判断。</div>`;
    html += `<h3 style="font-size:13px;margin:14px 0 6px">按时间窗口</h3>
      <table class="lvtable"><thead><tr>
        <th>持有期</th><th>已结算/总</th><th>平均</th><th>中位</th><th>胜率</th><th>最好</th><th>最差</th>
      </tr></thead><tbody>`;
    for (const h of d.horizons) html += perfRow(h);
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">仅「已确认」信号（不含未收盘预警）</h3>
      <table class="lvtable"><thead><tr>
        <th>持有期</th><th>已结算/总</th><th>平均</th><th>中位</th><th>胜率</th><th>最好</th><th>最差</th>
      </tr></thead><tbody>`;
    for (const k of ['h1', 'h4', 'h24']) {
      const h = d.confirmedOnly?.[k];
      const hours = k === 'h1' ? 1 : k === 'h4' ? 4 : 24;
      html += perfRow({ ...(h || {}), hours });
    }
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">按评分分组（验证评分是否真的有区分度）</h3>
      <table class="lvtable"><thead><tr>
        <th>评分</th><th>条数</th><th>+1h 平均</th><th>+4h 平均</th><th>+4h 胜率</th><th>+24h 平均</th>
      </tr></thead><tbody>`;
    for (const b of d.byScore || []) html += scoreRow(b);
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">最近信号明细</h3>
      <table class="lvtable"><thead><tr>
        <th>时间</th><th>币种</th><th>组合</th><th>评分</th><th>信号价</th><th>+1h</th><th>+4h</th><th>+24h</th>
      </tr></thead><tbody>`;
    for (const r of d.recent || []) {
      const t = new Date(r.ts);
      const p = n => String(n).padStart(2, '0');
      html += `<tr>
        <td>${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}</td>
        <td>${r.symbol}${r.confirmed ? '' : ' <span style="color:#fbbf24">预</span>'}</td>
        <td>${lvLabel(r.base)}→${lvLabel(r.mid)}→${lvLabel(r.big)}</td>
        <td>${r.score}</td>
        <td>${fmtPrice(r.price)}</td>
        <td>${fxPct(r.out?.h1)}</td>
        <td>${fxPct(r.out?.h4)}</td>
        <td>${fxPct(r.out?.h24)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  $('#p-body').innerHTML = html;
  $('#perf').classList.remove('hidden');
}

/* ---------------- 级别组合编辑器 ---------------- */
let ALL_LEVELS = [];          // 含隐藏级别（1分），仅用于内部换算
const PRESET_GROUPS = [
  { base: '3m', mid: '15m', big: '2h', enabled: true },
  { base: '2m', mid: '10m', big: '1h', enabled: true },
  { base: '5m', mid: '30m', big: '3h', enabled: true },
];









async function saveGroups() {
  const idx = k => ALL_LEVELS.findIndex(l => l.key === k);
  const bad = (cfg.groups ?? []).filter(g => !(idx(g.base) < idx(g.mid) && idx(g.mid) < idx(g.big)));
  if (bad.length) { toast('有组合的级别顺序不合法（必须 基准 < 确认 < 最大）', true); return; }
  await postCfg({ groups: cfg.groups, scanMode: 'groups' });
  alerts = [];
  renderAlerts();
  toast('级别组合已更新，重新开始扫描');
}

/* ---------------- 钉钉推送配置 ---------------- */
let PUSH_META = {};
let PUSH_CFG = null;

function renderPush() {
  const box = $('#pushlist');
  if (!box) return;
  const chans = PUSH_CFG?.channels ?? [];
  $('#p-enabled').checked = !!PUSH_CFG?.enabled;
  $('#p-minScore').value = PUSH_CFG?.minScore ?? 60;
  $('#p-batch').value = Math.round((PUSH_CFG?.batchWindowMs ?? 20000) / 1000);
  $('#p-maxpm').value = PUSH_CFG?.maxPerMinute ?? 10;
  $('#p-maxitems').value = PUSH_CFG?.maxItemsPerMessage ?? 8;
  $('#p-confirmedOnly').checked = !!PUSH_CFG?.confirmedOnly;

  box.innerHTML = '';
  chans.forEach((c, i) => {
    const meta = PUSH_META[c.type] ?? PUSH_META.dingtalk ?? { label: c.type, fields: [] };
    const el = document.createElement('div');
    el.className = 'pchan';
    el.innerHTML = `
      <div class="top">
        <input type="checkbox" ${c.enabled === false ? '' : 'checked'} data-i="${i}" data-k="enabled" title="启用本通道">
        <select data-i="${i}" data-k="__type">
          ${Object.entries(PUSH_META).map(([k, m]) => `<option value="${k}"${k === c.type ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <button class="del" data-i="${i}" title="删除">✕</button>
      </div>
      ${meta.fields.map(f => `
        <div class="pfld">
          <span>${f.label}</span>
          <input data-i="${i}" data-k="${f.key}" type="text"
                 placeholder="${f.placeholder ?? ''}"
                 value="${f.secret && c[f.key + 'Masked'] ? c[f.key + 'Masked'] : (c[f.key] ?? '')}">
        </div>`).join('')}`;
    box.appendChild(el);
  });
  if (!chans.length) {
    box.innerHTML = `<div class="gnote">还没有通道。点「＋ 添加通道」→ 选「钉钉群机器人」→ 粘贴 Webhook 里的 access_token。
      若安全设置选了「加签」，再填上 SEC 开头的 secret。</div>`;
  }

  box.querySelectorAll('input[type=text]').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i, k = inp.dataset.k;
    PUSH_CFG.channels[i][k] = inp.value;
    if (inp.value.includes('****')) return;
    delete PUSH_CFG.channels[i][k + 'Masked'];
  }));
  box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    PUSH_CFG.channels[+cb.dataset.i].enabled = cb.checked;
  }));
  box.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
    PUSH_CFG.channels[+sel.dataset.i] = { type: sel.value, enabled: true };
    renderPush();
  }));
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    PUSH_CFG.channels.splice(+b.dataset.i, 1);
    renderPush();
  }));
}

function collectPush() {
  const c = PUSH_CFG ?? { channels: [] };
  return {
    enabled: $('#p-enabled').checked,
    minScore: Math.round(+$('#p-minScore').value || 0),
    batchWindowMs: Math.max(0, Math.round(+$('#p-batch').value || 0) * 1000),
    maxPerMinute: Math.max(1, Math.round(+$('#p-maxpm').value || 10)),
    maxItemsPerMessage: Math.max(1, Math.round(+$('#p-maxitems').value || 8)),
    confirmedOnly: $('#p-confirmedOnly').checked,
    channels: c.channels,
  };
}

async function loadPush() {
  try {
    const d = await fetch('/api/push').then(r => r.json());
    PUSH_META = d.channelMeta ?? {};
    PUSH_CFG = d.config ?? { channels: [] };
    renderPush();
    updatePushStats(d.stats);
  } catch { /* 忽略 */ }
}

function updatePushStats(st) {
  const el = $('#push-stats');
  if (!el || !st) return;
  const chans = (st.enabledChannels ?? []).map(c => c.label + (c.signed ? '(已加签)' : '')).join('、') || '无';
  el.innerHTML = `通道：<b>${chans}</b>　|　已发 <b>${st.messages}</b> 条消息 / ${st.sent} 个信号　|　`
    + `失败 ${st.failed}　丢弃 ${st.dropped}　队列 ${st.queueLength}`
    + (st.lastError ? `　|　<span style="color:#f87171">${st.lastError}</span>` : '')
    + (st.lastPreview ? `<br><span style="color:#5b6f8c">最近一条：${st.lastPreview.replace(/\n/g, ' ').slice(0, 120)}…</span>` : '');
}

async function savePush() {
  const body = collectPush();
  const r = await fetch('/api/push', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cfg = await r.json();
  PUSH_CFG = cfg;
  renderPush();
  const d = await fetch('/api/push').then(x => x.json());
  updatePushStats(d.stats);
  return cfg;
}

/* ---------------- 配置面板 ---------------- */
const CFG_FIELDS = [
  ['minBullLevels', 'int'], ['pullbackLookback', 'int'], ['pullbackTolerance', 'pct'],
  ['triggerLookback', 'int'], ['adjacentLookback', 'int'], ['bigMa', 'str'],
  ['bigTolerance', 'pct'], ['requireEma7', 'bool'], ['requireAdjacentCross', 'bool'],
  ['requireBaseBull', 'bool'], ['useLiveCandle', 'bool'], ['countRule', 'str'],
  ['baseMinIdx', 'int'], ['baseMaxIdx', 'int'], ['minScore', 'int'],
  ['pullbackPattern', 'str'], ['pullbackBars', 'int'],
  ['top5Enabled', 'bool'], ['top5MinBars', 'int'], ['top5Lookback', 'int'],
  ['chainEnabled', 'bool'], ['chainMainMinBars', 'int'], ['chainSubMinBars', 'int'], ['chainInnerMinBars', 'int'], ['chainLookback', 'int'], ['chainFractalType', 'str'],
  ['waveEnabled', 'bool'], ['waveMinBars', 'int'], ['waveHighLookback', 'int'], ['waveCrossWindow', 'int'],
  ['fbEnabled', 'bool'], ['fbMinBars', 'int'], ['fbLookback', 'int'], ['fbFreshBars', 'int'], ['fbMinDropPct', 'num'], ['fbType', 'str'],
  ['brkEnabled', 'bool'], ['brkMinBars', 'int'],
  ['watchEnabled', 'bool'],
  ['watchNearPct', 'pct'], ['watchTieRatio', 'num'], ['watchNeedFalling', 'bool'],
  ['macdFast', 'int'], ['macdSlow', 'int'], ['macdSignal', 'int'],
  ['watchUseLiveCandle', 'bool'],
  ['dualEnabled', 'bool'], ['dualBars', 'int'], ['dualMinQuoteVolume', 'num'],
  ['signalEnabled', 'bool'],
];
const CFG_DEFAULTS = {
  minBullLevels: 3, pullbackLookback: 6, pullbackTolerance: 0.002, triggerLookback: 2,
  adjacentLookback: 3, requireEma7: true, requireAdjacentCross: true, requireBaseBull: true,
  bigMa: 'ema7', bigTolerance: 0, useLiveCandle: true, countRule: 'align',
  baseMinIdx: 2, baseMaxIdx: 6, minScore: 0,
  pullbackPattern: 'twoBearHold', pullbackBars: 2,
  waveEnabled: true, waveMinBars: 5, waveHighLookback: 20, waveCrossWindow: 2,
  fbEnabled: true, fbMinBars: 5, fbLookback: 20, fbFreshBars: 2, fbMinDropPct: 5, fbType: 'standard',
  brkEnabled: true, brkMinBars: 12,
  watchEnabled: true, watchNearPct: 0.3, watchTieRatio: 1.25, watchNeedFalling: true,
  macdFast: 12, macdSlow: 26, macdSignal: 9, watchUseLiveCandle: true,
  dualEnabled: false, dualBars: 2, dualMinQuoteVolume: 4000000, signalEnabled: false,
};

let CFG_SNAPSHOT = {};
function fillCfgForm() {

  if (!cfg) return;
  for (const [k, t] of CFG_FIELDS) {
    const el = $('#c-' + k);
    if (!el) continue;
    if (t === 'bool') el.checked = !!cfg[k];
    else if (t === 'pct') el.value = +(cfg[k] * 100).toFixed(3);
    else el.value = cfg[k];
  }
  // 记录服务端的权威状态：保存时只提交用户真正改动过的字段。
  // 否则界面上的陈旧值（例如某个开关在页面载入时是未勾选）会被当成用户意图写回服务端。
  CFG_SNAPSHOT = readCfgForm();
}

/** 读当前表单值 */
function readCfgForm() {
  const v = {};
  for (const [k, t] of CFG_FIELDS) {
    const el = $('#c-' + k);
    if (!el) continue;
    if (t === 'bool') v[k] = el.checked;
    else if (t === 'pct') v[k] = (+el.value || 0) / 100;
    else if (t === 'int') v[k] = Math.round(+el.value);
    else if (t === 'num') v[k] = +el.value || 0;
    else v[k] = el.value;
  }
  return v;
}
async function postCfg(patch) {
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  cfg = await r.json();
  fillCfgForm();
  return cfg;
}
async function saveCfg() {
  const now = readCfgForm();
  const patch = {};
  for (const k of Object.keys(now)) {
    // 与「服务端权威快照」一致的字段不提交 —— 界面陈旧值不会覆盖服务端
    if (CFG_SNAPSHOT[k] !== undefined && CFG_SNAPSHOT[k] === now[k]) continue;
    patch[k] = now[k];
  }
  if (!Object.keys(patch).length) { toast('没有改动'); return; }
  await postCfg(patch);
  alerts = [];
  renderAlerts();
  Object.assign(CFG_SNAPSHOT, patch);
  $('#cfg-msg').textContent = '✓ 已应用，重新开始扫描形态';
  setTimeout(() => { $('#cfg-msg').textContent = ''; }, 2600);
  toast('信号参数已更新');
}

/* ---------------- 状态轮询 ---------------- */
let MARKET_NAME = '';
async function pollStats() {
  try {
    const s = await fetch('/api/stats').then(r => r.json());
    const m = s.market;
    $('#pill-sym').textContent = `标的 ${m.symbols} · K线就绪 ${m.seededSymbols ?? 0}/${m.symbols}`;
    let progress = $('#data-progress');
    if (!progress) {
      progress = document.createElement('div');
      progress.id = 'data-progress';
      progress.setAttribute('role', 'status');
      progress.style.cssText = 'padding:10px 18px;color:#fbbf24;background:#172033';
      document.querySelector('header').after(progress);
    }
    const ready = m.seededSymbols ?? 0;
    const wait = Math.ceil(((m.rest.rateLimitedUntil ?? 0) - Date.now()) / 1000);
    progress.textContent = (m.rest.geoBlockedUntil > Date.now())
      ? '币安接口受地区访问限制，历史K线暂不可用。'
      : wait > 0 ? `币安接口限流，${wait} 秒后自动重试。K线就绪 ${ready}/${m.symbols}，尚未完成全量扫描。`
      : !m.symbols ? '正在获取币安合约涨幅榜…'
      : ready < m.symbols ? `历史K线加载中：${ready}/${m.symbols} 个币种就绪。已就绪币种持续扫描，首次加载需要数分钟，请保持页面打开。${m.seeding.active ? '' : '未成功加载的币种将在下次刷新时重试。'}`
      : `历史K线已就绪：${ready}/${m.symbols}。持续扫描五笔结构，等待对应主级别底分型收盘确认。`;
    if (m.feedMode === 'tick-rest') {
      // 合约模式：没有 K线 WS 分片，实时价走 !bookTicker，K线由 REST 滚动补
      const t = m.tick ?? {};
      const fresh = t.lastPriceAt && (Date.now() - t.lastPriceAt) < 30_000;
      const on = t.state === 'open' && fresh;
      setWs(on ? 'ok' : t.state === 'open' ? 'warn' : 'bad',
        `${m.marketName ?? '合约'} · 实时价 ${on ? '在线' : t.state === 'open' ? '无数据' : '重连中'}`);
    } else {
      const shards = m.shards ?? [];
      const open = shards.filter(x => x.state === 'open').length;
      const streams = shards.reduce((n, x) => n + x.streams, 0);
      setWs(open === shards.length && open > 0 ? 'ok' : open ? 'warn' : 'bad',
        `WS ${open}/${shards.length} · ${streams}流`);
    }
    const age = m.lastKlineAt ? Date.now() - m.lastKlineAt : -1;
    $('#pill-lat').textContent = `推送 ${snapGap ? Math.round(snapGap) : '—'}ms · 行情 ${age < 0 ? '—' : (age / 1000).toFixed(1) + 's'}`;
    const t = m.tick;
    $('#pill-lat').title = `权重 ${m.rest.lastUsedWeight}/${m.weightCap} · 往返 ${m.rest.avgLatency}ms`
      + ` · 播种 ${m.seeding.done}/${m.seeding.total} · 评估耗时 ${s.engine.lastSweepMs}ms`
      + (t ? ` · 价格tick ${t.priceTicks} · 补K线 ${t.rollingTicks} 次` : '');
  } catch { /* 忽略轮询失败 */ }
}

/* ---------------- 交互 ---------------- */
function bind() {
  $('#t-live').addEventListener('change', e => postCfg({ useLiveCandle: e.target.checked }));

  $('#btn-sound').addEventListener('click', e => {
    soundOn = !soundOn;
    localStorage.setItem('sound', soundOn ? '1' : '0');
    e.currentTarget.classList.toggle('on', soundOn);
    if (soundOn) { ensureAudio(); beep('confirmed'); }
  });
  $('#btn-notify').addEventListener('click', async e => {
    if (!('Notification' in window)) { toast('当前浏览器不支持桌面通知', true); return; }
    if (!notifyOn) {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { toast('通知权限被拒绝', true); return; }
      notifyOn = true;
    } else notifyOn = false;
    localStorage.setItem('notify', notifyOn ? '1' : '0');
    e.currentTarget.classList.toggle('on', notifyOn);
  });
  $('#btn-perf').addEventListener('click', () => {
    openPerf();
    clearInterval(perfTimer);
    perfTimer = setInterval(() => {
      if ($('#perf').classList.contains('hidden')) { clearInterval(perfTimer); return; }
      openPerf();
    }, 30_000);
  });
  $('#btn-clear').addEventListener('click', () => { alerts = []; renderAlerts(); });
  $('#btn-resync').addEventListener('click', async () => {
    await fetch('/api/resync');
    toast('已触发全量对账，稍后自动修复K线缺口');
  });
  $('#btn-addpush').addEventListener('click', () => {
    if (!PUSH_CFG) PUSH_CFG = { channels: [] };
    if (!PUSH_CFG.channels) PUSH_CFG.channels = [];
    PUSH_CFG.channels.push({ type: 'dingtalk', enabled: true, accessToken: '', secret: '', keyword: '' });
    renderPush();
  });
  $('#btn-pushtest').addEventListener('click', async () => {
    const el = $('#push-msg');
    el.style.color = '#fbbf24';
    el.textContent = '正在保存并发送…';
    await savePush();
    try {
      const r = await fetch('/api/push/test', { method: 'POST' }).then(x => x.json());
      if (r.ok) { el.style.color = '#22c55e'; el.textContent = '✓ 测试消息已发送，请查看钉钉群'; }
      else {
        el.style.color = '#f87171';
        el.textContent = '✗ ' + (r.error || (r.results ?? []).map(x => `${x.label}: ${x.error}`).join(' ; '));
      }
    } catch (e) { el.style.color = '#f87171'; el.textContent = '✗ ' + e.message; }
    setTimeout(() => { el.textContent = ''; }, 12000);
  });

  $('#btn-cfgsave').addEventListener('click', async () => {
    await saveCfg();
    await saveGroups();
    await savePush();
  });
  $('#btn-cfgreset').addEventListener('click', async () => {
    await postCfg({ ...CFG_DEFAULTS, groups: PRESET_GROUPS.map(g => ({ ...g })), scanMode: 'groups' });
    toast('已恢复默认参数与示例组合');
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => {
    e.target.closest('.drawer').classList.add('hidden');
  }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.drawer').forEach(d => d.classList.add('hidden'));
    }
  });
}

/* ---------------- 启动 ---------------- */
bind();
$('#btn-sound').classList.toggle('on', soundOn);
$('#btn-notify').classList.toggle('on', notifyOn);
connect();
loadPush();
setInterval(pollStats, 3000);
pollStats();
// 推送状态与报警卡片的"信号后"涨跌幅一起刷新
setInterval(() => { if (alerts.length) renderAlerts(); }, 5000);
setInterval(async () => {
  if ($('#cfgpanel').classList.contains('hidden')) return;
  try { const d = await fetch('/api/push').then(r => r.json()); updatePushStats(d.stats); } catch { /* 忽略 */ }
}, 5000);
setInterval(() => {
  const age = lastSnapAt ? performance.now() - lastSnapAt : 99999;
  if (age > 8000) setWs('bad', '数据中断');
}, 4000);











