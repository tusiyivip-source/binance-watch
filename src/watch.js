/**
 * 盯盘通道（用户最新口径：**多对级别**，完全替换了之前的 7 组 / 延续笔 / 回调后突破）
 *
 *   监控 5 对相邻级别（列表内相邻）：
 *     10分↔15分、15分↔30分、30分↔1时、1时↔2时、2时↔3时
 *
 *   每一对独立跑同一套逻辑：
 *     分支A —— **更大级别 MACD 没有死叉**：
 *         本级别 MACD 死叉 → 本级别自最近高点 ≥ minBars 根K线 → 本级别收盘站上 MA7 与 EMA7 → ★ 报本级别
 *     分支B —— **更大级别 MACD 也死叉**：
 *         本级别那条**作废**；改判更大级别：更大级别自最近高点 ≥ minBars 根K线
 *         → 更大级别收盘站上 MA7 与 EMA7 → ★ 报更大级别
 *
 *   MACD 12/26/9；死叉 = 收盘时 DIF < DEA。
 *   「站上均线」是状态，但同一段「站在均线上方」期间只报一次，价格重新跌破均线后才允许下一次；
 *   同一个级别同一根K线只报一次（一个级别可能同时是某一对的快级别、另一对的慢级别）。
 *
 * 纯逻辑模块，不依赖任何 Node 内置，浏览器版同样可用。
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

const label = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);

/** 该级别是否满足「自最近高点够根数 + 收盘站上 MA7 与 EMA7」 */
export function standOk(v, minBars = 5) {
  return !!(v && v.barsFromHigh != null && v.barsFromHigh >= minBars
    && v.above7 === true && v.aboveEma7 === true);
}

/** 该级别此刻是否站在两条均线上方（用于「同一段只报一次」的边沿判定） */
export function aboveBoth(v) {
  return !!(v && v.above7 === true && v.aboveEma7 === true);
}

/**
 * MACD 没有下穿零轴：**触发级别自己**的 DIF 仍在 0 轴上方。
 * 含义是「这一次回调是强势回调」——只有快线跌破慢线（死叉），但没有跌破零轴。
 */
export function aboveZeroOk(v, require = true) {
  if (require === false) return true;
  return v?.dif != null && v.dif > 0;
}

/** 单对判定：给出这一对该报哪个级别（ok=false 表示这一对不报） */
export function judgePair(pair, levels, opt = {}) {
  const fast = levels[pair.fast], slow = levels[pair.slow];
  if (!fast || !slow) return null;
  const minBars = opt.minBars ?? 5;
  const needZero = opt.requireAboveZero !== false;
  const fastDead = fast.macdDead === true;
  const slowDead = slow.macdDead === true;
  if (!slowDead) {
    return {
      pair, level: pair.fast, branch: 'A', v: fast,
      fastDead, slowDead, zeroOk: aboveZeroOk(fast, needZero),
      ok: fastDead && standOk(fast, minBars) && aboveZeroOk(fast, needZero),
    };
  }
  return {
    pair, level: pair.slow, branch: 'B', v: slow,
    fastDead, slowDead, voidFast: true, zeroOk: aboveZeroOk(slow, needZero),
    ok: fastDead && standOk(slow, minBars) && aboveZeroOk(slow, needZero),
  };
}

/** 兼容单对调用（探针/测试用）：默认取第一对 */
export function judge(levels, opt = {}) {
  const pair = opt.pair ?? (opt.pairs ?? [])[0] ?? { fast: '1h', slow: '2h' };
  return judgePair(pair, levels, opt) ?? { level: null, reason: 'no-data' };
}

/** 所有配对一起判定 */
export function judgeAll(levels, opt = {}) {
  const out = [];
  for (const pair of (opt.pairs ?? [])) {
    const r = judgePair(pair, levels, opt);
    if (r) out.push(r);
  }
  return out;
}

export class Watcher {
  constructor(log, opt = {}) {
    this.log = log;
    this.cfg = {
      enabled: opt.enabled !== false,
      pairs: Array.isArray(opt.pairs) && opt.pairs.length ? opt.pairs : [{ fast: '1h', slow: '2h' }],
      minBars: opt.minBars ?? 5,
      requireAboveZero: opt.requireAboveZero !== false,   // 触发级别的 MACD 不能下穿零轴
      useLiveCandle: opt.useLiveCandle !== false,
    };
    this.fired = new Map();   // `${symbol}|${level}` -> 这一段「站在均线上方」期间是否已报过
    this.seen = new Map();    // `C|symbol|level|candleT` / `P|...` -> ts
    this.stats = { fired: 0, preview: 0, evaluations: 0, branchA: 0, branchB: 0, byLevel: {} };
    this.seq = 0;
  }

  setConfig(patch = {}) {
    if (patch.watchEnabled !== undefined) this.cfg.enabled = !!patch.watchEnabled;
    if (Array.isArray(patch.watchPairs) && patch.watchPairs.length) this.cfg.pairs = patch.watchPairs;
    if (patch.watchMinBars !== undefined) this.cfg.minBars = Number(patch.watchMinBars);
    if (patch.watchRequireAboveZero !== undefined) this.cfg.requireAboveZero = !!patch.watchRequireAboveZero;
    if (patch.watchUseLiveCandle !== undefined) this.cfg.useLiveCandle = !!patch.watchUseLiveCandle;
    if (patch.watchReset === true) {
      this.fired.clear(); this.seen.clear();
      this.stats = { fired: 0, preview: 0, evaluations: 0, branchA: 0, branchB: 0, byLevel: {} };
    }
    return { ...this.cfg };
  }

  /**
   * @param {string} symbol
   * @param {object} levels 各已收盘级别的盯盘视图（配对里用到的级别）
   * @param {number} now
   * @param {object|null} liveLevels 快级别「正在形成」那根的视图
   * @returns {Array} 本次新触发的报警（每个级别一条）
   */
  update(symbol, levels, now = Date.now(), liveLevels = null) {
    if (!this.cfg.enabled) return [];
    this.stats.evaluations++;
    const out = [];

    for (const j of judgeAll(levels, this.cfg)) {
      const key = j.level;
      const v = j.v;
      // —— 同一段「站在均线上方」期间只报一次：跌破均线后重置 ——
      const ak = `${symbol}|${key}`;
      if (!aboveBoth(v)) { this.fired.set(ak, false); continue; }
      if (!j.ok || this.fired.get(ak) === true) continue;
      const id = `C|${symbol}|${key}|${v.candleT}`;
      if (this.seen.has(id)) continue;
      this.seen.set(id, now);
      this.fired.set(ak, true);
      this.stats.fired++;
      this.stats.byLevel[key] = (this.stats.byLevel[key] ?? 0) + 1;
      if (j.branch === 'A') this.stats.branchA++; else this.stats.branchB++;
      out.push(this._makeAlert(symbol, j, v, now, false));
    }

    // —— 未收盘预警：只对每个配对的**快级别**做 ——
    if (this.cfg.useLiveCandle && liveLevels) {
      for (const pair of this.cfg.pairs) {
        const live = liveLevels[pair.fast];
        if (!live || !live.live) continue;
        if (aboveBoth(levels[pair.fast])) continue;        // 已收盘那根就站着 → 不必预警
        const lj = judgePair(pair, { ...levels, [pair.fast]: live }, this.cfg);
        if (!lj || !lj.ok || lj.level !== pair.fast) continue;
        const ak = `${symbol}|${pair.fast}`;
        if (this.fired.get(ak) === true) continue;
        const id = `P|${symbol}|${pair.fast}|${live.candleT}`;
        if (this.seen.has(id)) continue;
        this.seen.set(id, now);
        this.stats.preview++;
        out.push(this._makeAlert(symbol, lj, live, now, true));
      }
    }
    return out;
  }

  _makeAlert(symbol, j, v, now, preview) {
    const which = label(j.level);
    const pairTxt = `${label(j.pair.fast)}↔${label(j.pair.slow)}`;
    const macdTxt = j.branch === 'A'
      ? `${label(j.pair.fast)} MACD 死叉、${label(j.pair.slow)} 未死叉（更大级别未转弱）`
      : `${label(j.pair.fast)} 与 ${label(j.pair.slow)} MACD 均死叉（${label(j.pair.fast)} 作废）`;
    return {
      kind: 'watch',
      id: ++this.seq,
      symbol,
      mode: preview ? 'live' : 'closed',
      stage: preview ? 'preview' : 'confirmed',
      confirmed: !preview,
      group: pairTxt,
      level: j.level,
      pairFast: j.pair.fast, pairSlow: j.pair.slow,
      base: j.level, mid: j.pair.slow, big: null,
      branch: j.branch,
      score: 0,
      price: v.close ?? null,
      candleT: v.candleT ?? now,
      ts: now,
      initial: false,
      levelLabel: which,
      macdDeadFast: j.fastDead,
      macdDeadSlow: j.slowDead,
      barsFromHigh: v.barsFromHigh ?? null,
      dif: v.dif ?? null,
      aboveZero: v.dif != null ? v.dif > 0 : null,
      highAt: v.highT ?? null,
      distBaseMa7Pct: (Number.isFinite(v.ma7) && v.ma7) ? ((v.close - v.ma7) / v.ma7) * 100 : null,
      ma7: v.ma7 ?? null,
      ema7: v.ema7 ?? null,
      text: `【${which} 反弹站上均线】${pairTxt} 这一对：${macdTxt}；${which} 自最近高点 ${v.barsFromHigh ?? '—'} 根K线`
        + `（需 ≥${this.cfg.minBars}），MACD 快线 DIF ${Number.isFinite(v.dif) ? v.dif.toFixed(6) : '—'}`
        + `（${Number.isFinite(v.dif) && v.dif > 0 ? '仍在零轴上方，回调未破零轴' : '已破零轴'}）；`
        + `收盘 ${v.close} 站上 MA7 ${v.ma7} / EMA7 ${v.ema7}`
        + ` · 分支${j.branch}`
        + (preview ? ' · [预警/未收盘]' : ' · [已确认]'),
    };
  }

  snapshot(limit = 60) {
    const rows = [];
    for (const [k, t] of this.seen) {
      const [tag, symbol, level] = k.split('|');
      if (tag !== 'C') continue;
      rows.push({ symbol, level, firedAt: t, phase: 'fired' });
    }
    rows.sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
    return {
      total: rows.length, fired: rows.length, armed: 0,
      stats: this.stats, cfg: this.cfg,
      pairs: this.cfg.pairs.map(p => ({ ...p })),
      rows: rows.slice(0, limit),
    };
  }

  prune(now = Date.now(), maxAgeMs = 6 * 3600_000) {
    for (const [k, t] of this.seen) if (now - t > maxAgeMs) this.seen.delete(k);
  }
}

