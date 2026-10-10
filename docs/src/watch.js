/**
 * 盯盘通道（用户 v4 口径）
 *
 *   只扫 4 个级别：10分 / 15分 / 30分 / 1时
 *   只有一条提醒（**已按用户要求去掉次级别与确认段**）：
 *
 *     「回调中、MACD 的均线（信号线 DEA）贴近零轴且没有跌破」→ 报警
 *       · 贴近零轴且未跌破 = DEA > 0 且 |DEA| ÷ 收盘价 ≤ nearPct（默认 0.3%）
 *       · **回调中** = DEA 正在回落（本根 < 上一根）；上涨途中贴近零轴的不报
 *
 *   多个级别同时满足 → 只报一条：先看谁更贴近零轴，接近程度在 tieRatio 倍以内的候选里
 *   再优先小级别（用户口径「同时看更接近和级别更小」）。
 *   一段一次：该级别离开近零区间 / 跌破零轴 / 均线转为上行后，这一段结束。
 *
 *   MACD 12/26/9、以收盘为准；扫描级别用「正在形成的那根」实时判，做到不等收盘。
 *
 * 纯逻辑模块，不依赖任何 Node 内置，浏览器版同样可用。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
const minutesOf = k => (LEVELS[LEVEL_INDEX[k]]?.minutes ?? 0);

/** 「回调中 + 贴近零轴 + 未跌破」三合一 */
export function nearOk(v, needFalling = true) {
  if (!v || v.nearZero !== true) return false;
  if (needFalling && v.deaFalling !== true) return false;
  return true;
}

/**
 * 多级别命中时挑一个报：
 *   1) 取最贴近零轴的候选做基准；
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

export class Watcher {
  constructor(log, opt = {}) {
    this.log = log;
    this.cfg = {
      enabled: opt.enabled !== false,
      levels: Array.isArray(opt.levels) && opt.levels.length ? opt.levels : ['10m', '15m', '30m', '1h'],
      nearPct: opt.nearPct ?? 0.3,
      tieRatio: opt.tieRatio ?? 1.25,
      needFalling: opt.needFalling !== false,   // 只看回调中（DEA 回落）
      useLiveCandle: opt.useLiveCandle !== false,
    };
    this.armed = new Map();      // symbol -> { level, since, candleT }
    this.seen = new Map();       // 去重键 -> ts
    this.stats = { warning: 0, preview: 0, evaluations: 0, byLevel: {} };
    this.seq = 0;
  }

  setConfig(patch = {}) {
    if (patch.watchEnabled !== undefined) this.cfg.enabled = !!patch.watchEnabled;
    if (Array.isArray(patch.watchLevels) && patch.watchLevels.length) this.cfg.levels = patch.watchLevels;
    if (patch.watchNearPct !== undefined) this.cfg.nearPct = Number(patch.watchNearPct);
    if (patch.watchTieRatio !== undefined) this.cfg.tieRatio = Number(patch.watchTieRatio);
    if (patch.watchNeedFalling !== undefined) this.cfg.needFalling = !!patch.watchNeedFalling;
    if (patch.watchUseLiveCandle !== undefined) this.cfg.useLiveCandle = !!patch.watchUseLiveCandle;
    if (patch.watchReset === true) {
      this.armed.clear(); this.seen.clear();
      this.stats = { warning: 0, preview: 0, evaluations: 0, byLevel: {} };
    }
    return { ...this.cfg };
  }

  /**
   * @param {string} symbol
   * @param {object} levels 各扫描级别的盯盘视图（已收盘）
   * @param {number} now
   * @param {object|null} liveLevels 同一批级别「正在形成」那根的视图
   * @returns {Array} 本次新触发的报警（0~1 条）
   */
  update(symbol, levels, now = Date.now(), liveLevels = null) {
    if (!this.cfg.enabled) return [];
    this.stats.evaluations++;
    const out = [];

    // 时效关键：优先用「正在形成的那根」判（K线收完之前就能发）
    const cands = [];
    for (const k of this.cfg.levels) {
      const live = this.cfg.useLiveCandle ? liveLevels?.[k] : null;
      const vLive = live && live.live ? live : null;
      const v = (vLive && nearOk(vLive, this.cfg.needFalling)) ? vLive : levels[k];
      if (nearOk(v, this.cfg.needFalling)) {
        cands.push(vLive && nearOk(vLive, this.cfg.needFalling) ? { ...v, __live: true } : v);
      }
    }
    const pick = pickNear(cands, this.cfg);
    const cur = this.armed.get(symbol) ?? null;

    if (pick) {
      const chosen = pick.chosen;
      const changed = !cur || cur.level !== chosen.key;
      // 用未收盘那根判出来的，按「本根K线」去重，避免插针反复进出区间刷屏
      const id = `W|${symbol}|${chosen.key}|${chosen.candleT}`;
      if (changed && !this.seen.has(id)) {
        this.seen.set(id, now);
        this.stats.warning++;
        if (chosen.__live) this.stats.preview++;
        this.stats.byLevel[chosen.key] = (this.stats.byLevel[chosen.key] ?? 0) + 1;
        this.armed.set(symbol, { level: chosen.key, since: now, candleT: chosen.candleT });
        out.push(this._warnAlert(symbol, chosen, pick, now));
      } else if (changed) {
        this.armed.set(symbol, { level: chosen.key, since: now, candleT: chosen.candleT });
      }
    } else if (cur) {
      this.armed.delete(symbol);          // 条件不再满足 → 这一段结束
    }
    return out;
  }

  _warnAlert(symbol, v, pick, now) {
    const others = pick.band.filter(x => x.key !== v.key).map(x => `${label(x.key)}(${x.distPct.toFixed(2)}%)`);
    const better = pick.best.key !== v.key
      ? `；更贴近零轴的是 ${label(pick.best.key)}(${pick.best.distPct.toFixed(2)}%)，差距在并列容差内，按“级别更小”取 ${label(v.key)}`
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
      price: v.close ?? null,
      candleT: v.candleT ?? now,
      ts: now,
      initial: false,
      dif: v.dif ?? null,
      dea: v.dea ?? null,
      distPct: v.distPct ?? null,
      difPct: v.difPct ?? null,
      deaFalling: !!v.deaFalling,
      nearPct: this.cfg.nearPct,
      text: `【预警·回调中 MACD 均线靠零轴】${label(v.key)} MACD均线(DEA) ${Number(v.dea).toFixed(6)} > 0（未跌破零轴）、`
        + `离零轴 ${v.distPct.toFixed(3)}%（阈值 ${this.cfg.nearPct}%）、均线正在回落（回调中）；`
        + `${v.__live ? '现价' : '收盘'} ${v.close}（DIF ${Number(v.dif).toFixed(6)}）`
        + candTxt
        + (v.__live ? ' · [预警/未收盘]' : ''),
    };
  }

  /** 界面用：当前处于预警段的币种 */
  armedList(limit = 60) {
    const rows = [...this.armed.entries()].map(([symbol, st]) => ({
      symbol, level: st.level, levelLabel: label(st.level), since: st.since,
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
