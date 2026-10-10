/**
 * 盯盘通道（用户 v3 口径，**完全替换**了之前的 5 对级别分支规则）
 *
 *   扫描 8 个级别：10分 / 15分 / 30分 / 1时 / 2时 / 3时 / 4时 / 6时
 *   次级别对应表：10分→2分、15分→3分、30分→5分、1时→10分、2时→15分、3时→30分、4时→30分、6时→1时
 *
 *   ① 预警提醒（一段一次）
 *      「靠近零轴且没有跌破零轴」= DIF > 0 且 |DIF| / 收盘价 ≤ nearPct（默认 0.3%）
 *      多个级别同时满足 → **只报一条**：先看谁更接近零轴，接近程度在 tieRatio 倍以内的候选里
 *      再优先小级别（用户口径「同时看更接近和级别更小」）。
 *      该级别离开近零区间或跌破零轴后，这一段结束，才允许下一次预警。
 *
 *   ② 确认提醒（一个预警段内一次）
 *      预警级别确定后，它的**次级别**满足任一即可：
 *        · MACD **金叉**（DIF 上穿 DEA，最近 confirmLookback 根内发生），或
 *        · **收盘突破 EMA7** 且 DIF > 0（没有跌破零轴）
 *
 *   MACD 12/26/9，全部以收盘为准。快级别未收盘时可先给 `[预警]` 形式的确认。
 *
 * 纯逻辑模块，不依赖任何 Node 内置，浏览器版同样可用。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const minutesOf = k => (LEVELS[LEVEL_INDEX[k]]?.minutes ?? 0);

/** 该级别是否「靠近零轴且未跌破零轴」 */
export function nearOk(v) {
  return !!(v && v.nearZero === true);
}

/**
 * 多级别命中时挑一个报：
 *   1) 取最接近零轴的候选做基准；
 *   2) 接近程度在 tieRatio 倍以内的候选都算「并列」，并列里**优先小级别**。
 */
export function pickNear(cands, opt = {}) {
  if (!cands.length) return null;
  const tie = opt.tieRatio ?? 1.25;
  let best = cands[0];
  for (const c of cands) if (c.distPct < best.distPct) best = c;
  const band = cands.filter(c => c.distPct <= best.distPct * tie + 1e-9);
  band.sort((a, b) => minutesOf(a.key) - minutesOf(b.key));
  return { chosen: band[0], best, band };
}

/** 次级别是否给出确认 */
export function confirmOk(sub) {
  if (!sub) return { ok: false, why: null };
  if (sub.macdGoldIn != null) {
    return { ok: true, why: `次级别 MACD 金叉（${sub.macdGoldIn === 0 ? '本根' : sub.macdGoldIn + ' 根前'}）` };
  }
  if (sub.aboveEma7 === true && sub.dif != null && sub.dif > 0) {
    return { ok: true, why: '次级别收盘突破 EMA7 且 DIF > 0（未跌破零轴）' };
  }
  return { ok: false, why: null };
}

export class Watcher {
  constructor(log, opt = {}) {
    this.log = log;
    this.cfg = {
      enabled: opt.enabled !== false,
      levels: Array.isArray(opt.levels) && opt.levels.length ? opt.levels : ['10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h'],
      subMap: opt.subMap ?? { '10m': '2m', '15m': '3m', '30m': '5m', '1h': '10m', '2h': '15m', '3h': '30m', '4h': '30m', '6h': '1h' },
      nearPct: opt.nearPct ?? 0.3,
      tieRatio: opt.tieRatio ?? 1.25,
      useLiveCandle: opt.useLiveCandle !== false,
    };
    this.armed = new Map();      // symbol -> { level, since, candleT, confirmed }
    this.seen = new Map();       // 去重键 -> ts
    this.stats = { warning: 0, confirm: 0, preview: 0, evaluations: 0, byLevel: {} };
    this.seq = 0;
  }

  setConfig(patch = {}) {
    if (patch.watchEnabled !== undefined) this.cfg.enabled = !!patch.watchEnabled;
    if (Array.isArray(patch.watchLevels) && patch.watchLevels.length) this.cfg.levels = patch.watchLevels;
    if (patch.watchNearPct !== undefined) this.cfg.nearPct = Number(patch.watchNearPct);
    if (patch.watchTieRatio !== undefined) this.cfg.tieRatio = Number(patch.watchTieRatio);
    if (patch.watchUseLiveCandle !== undefined) this.cfg.useLiveCandle = !!patch.watchUseLiveCandle;
    if (patch.watchReset === true) {
      this.armed.clear(); this.seen.clear();
      this.stats = { warning: 0, confirm: 0, preview: 0, evaluations: 0, byLevel: {} };
    }
    return { ...this.cfg };
  }

  /**
   * @param {string} symbol
   * @param {object} levels 各已收盘级别的盯盘视图
   * @param {number} now
   * @param {object|null} liveLevels 次级别「正在形成」那根的视图
   * @returns {Array} 本次新触发的报警（0~2 条：预警 + 确认）
   */
  update(symbol, levels, now = Date.now(), liveLevels = null) {
    if (!this.cfg.enabled) return [];
    this.stats.evaluations++;
    const out = [];

    // —— 先判「确认」：用**上一轮已经预警过**的级别，避免被本轮新预警覆盖 ——
    const cur0 = this.armed.get(symbol) ?? null;
    if (cur0 && !cur0.confirmed) {
      const subKey = this.cfg.subMap[cur0.level];
      const sub = levels[subKey];
      let r = confirmOk(sub);
      let live = false;
      if (!r.ok && this.cfg.useLiveCandle) {
        const lv = liveLevels?.[subKey];
        if (lv && lv.live) { const r2 = confirmOk(lv); if (r2.ok) { r = r2; live = true; } }
      }
      if (r.ok) {
        const id = `C|${symbol}|${cur0.level}|${subKey}|${cur0.candleT}`;
        if (!this.seen.has(id)) {
          this.seen.set(id, now);
          cur0.confirmed = true;
          this.stats.confirm++;
          if (live) this.stats.preview++;
          out.push(this._confirmAlert(symbol, cur0, levels, sub, r, now, live));
        }
      }
    }

    // —— ① 预警：找出所有「靠近零轴且未跌破零轴」的级别 ——
    //    ⚠ 时效关键：优先用「正在形成的那根K线」判（K线收完之前就能发），
    //     否则 4时 级别最多要等 4 小时、1时 最多等 1 小时 —— 这就是「提醒偏滞后」的主因。
    const cands = [];
    for (const k of this.cfg.levels) {
      const live = this.cfg.useLiveCandle ? liveLevels?.[k] : null;
      const vLive = live && live.live ? live : null;
      const v = (vLive && nearOk(vLive)) ? vLive : levels[k];
      if (nearOk(v)) cands.push(vLive && nearOk(vLive) ? { ...v, __live: true } : v);
    }
    const pick = pickNear(cands, this.cfg);
    const cur = this.armed.get(symbol) ?? null;

    if (pick) {
      const chosen = pick.chosen;
      const changed = !cur || cur.level !== chosen.key;
      // 用未收盘那根判出来的，按「本根K线」去重：避免插针反复进出区间刷屏
      const id = `W|${symbol}|${chosen.key}|${chosen.candleT}`;
      if (changed && !this.seen.has(id)) {
        this.seen.set(id, now);
        this.stats.warning++;
        if (chosen.__live) this.stats.preview++;
        this.stats.byLevel[chosen.key] = (this.stats.byLevel[chosen.key] ?? 0) + 1;
        this.armed.set(symbol, { level: chosen.key, since: now, candleT: chosen.candleT, confirmed: false });
        out.push(this._warnAlert(symbol, chosen, pick, now));
      } else if (changed) {
        this.armed.set(symbol, { level: chosen.key, since: now, candleT: chosen.candleT, confirmed: false });
      }
    } else if (cur) {
      this.armed.delete(symbol);          // 没有级别再满足 → 这一段结束
    }
    return out;
  }

  _warnAlert(symbol, v, pick, now) {
    const others = pick.band.filter(x => x.key !== v.key).map(x => `${label(x.key)}(${x.distPct.toFixed(2)}%)`);
    const better = pick.best.key !== v.key
      ? `；更接近零轴的是 ${label(pick.best.key)}(${pick.best.distPct.toFixed(2)}%)，差距在并列容差内，按“级别更小”取 ${label(v.key)}`
      : '';
    const candTxt = others.length ? `；同时候选：${others.join('、')}${better}` : '';
    return {
      kind: 'watch',
      stage: 'warning',
      mode: v.__live ? 'live' : 'closed',
      confirmed: false,
      id: ++this.seq,
      symbol,
      level: v.key,
      levelLabel: label(v.key),
      subLevel: this.cfg.subMap[v.key] ?? null,
      pair: `${label(v.key)}→${label(this.cfg.subMap[v.key] ?? '')}`,
      branch: 'near',
      price: v.close ?? null,
      candleT: v.candleT ?? now,
      ts: now,
      initial: false,
      dif: v.dif ?? null,
      dea: v.dea ?? null,
      distPct: v.distPct ?? null,
      nearPct: this.cfg.nearPct,
      text: `【预警·MACD 靠零轴】${label(v.key)} DIF ${Number(v.dif).toFixed(6)} > 0（未跌破零轴）、`
        + `离零轴 ${v.distPct.toFixed(3)}%（阈值 ${this.cfg.nearPct}%）；${v.__live ? '现价' : '收盘'} ${v.close}`
        + candTxt
        + (v.__live ? ' · [预警/未收盘]' : ''),
    };
  }

  _confirmAlert(symbol, st, levels, sub, r, now, live) {
    const subKey = this.cfg.subMap[st.level];
    return {
      kind: 'watch',
      stage: 'confirm',
      confirmed: true,
      id: ++this.seq,
      symbol,
      level: subKey,
      levelLabel: label(subKey),
      alarmLevel: st.level,
      subLevel: subKey,
      pair: `${label(st.level)}→${label(subKey)}`,
      branch: 'confirm',
      price: sub?.close ?? null,
      candleT: sub?.candleT ?? now,
      ts: now,
      initial: false,
      dif: sub?.dif ?? null,
      dea: sub?.dea ?? null,
      goldIn: sub?.macdGoldIn ?? null,
      text: `【确认·${label(st.level)} 靠零轴后 ${label(subKey)} 跟进】${r.why}`
        + `（${label(subKey)} 收盘 ${sub?.close} / EMA7 ${sub?.ema7} / DIF ${Number(sub?.dif).toFixed(6)}）`
        + (live ? ' · [预警/未收盘]' : ' · [已确认]'),
    };
  }

  /** 界面用：当前处于预警段的币种 */
  armedList(limit = 60) {
    const rows = [...this.armed.entries()].map(([symbol, st]) => ({
      symbol, level: st.level, levelLabel: label(st.level),
      subLevel: this.cfg.subMap[st.level], since: st.since, confirmed: st.confirmed,
    }));
    rows.sort((a, b) => b.since - a.since);
    return rows.slice(0, limit);
  }

  snapshot(limit = 60) {
    const rows = this.armedList(limit);
    return {
      total: rows.length, fired: this.stats.warning, armed: rows.length,
      stats: this.stats, cfg: this.cfg, rows,
    };
  }

  prune(now = Date.now(), maxAgeMs = 6 * 3600_000) {
    for (const [k, t] of this.seen) if (now - t > maxAgeMs) this.seen.delete(k);
    for (const [s, st] of this.armed) if (now - st.since > maxAgeMs) this.armed.delete(s);
  }
}
