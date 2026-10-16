/**
 * 整点（收线）调度：把 REST 补K线 + 重估 对齐到各周期的K线收盘时刻。
 *
 * 用户要求（2026-10-16）：
 *   「每个整点刷新 比如 5分钟 15分钟 30分钟 1小时 这种整点都要扫描一下 以防被接口屏蔽」
 *
 * 原来的做法是「按固定间隔持续轮询」（1分/3分/5分 每 90 秒、15分 每 120 秒…），
 * 权重是匀速消耗的，且跟K线收盘时刻无关。改成：
 *   · 每个级别组只在**自己周期的整点**（收线时刻 + grace）集中跑一轮
 *   · 一轮在 spread 窗口内均匀打完（不瞬间并发打爆接口）
 *   · 组与组之间**错峰**（stagger），避免整点时所有组一起冲
 *   · 其余时间完全不动接口 —— 这就是"以防被接口屏蔽"
 */
import { LEVELS, LEVEL_INDEX } from './config.js';

/** 某个级别的周期（毫秒） */
export const levelPeriodMs = key => (LEVELS[LEVEL_INDEX[key]]?.minutes ?? 1) * 60_000;

/** 组里最小周期（该组的整点节奏就是它） */
export const groupPeriodMs = levels => Math.min(...levels.map(levelPeriodMs));

/** 严格大于 now 的下一个整点 */
export function nextBoundary(periodMs, now = Date.now()) {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return now + 60_000;
  return (Math.floor(now / periodMs) + 1) * periodMs;
}

/** 距下一个整点还有多久（毫秒） */
export function msToBoundary(periodMs, now = Date.now()) {
  return nextBoundary(periodMs, now) - now;
}

/**
 * 整点调度器（每个级别组一个实例）
 *   到点 → 重开一轮（items 重新铺满）→ 在 spread 窗口内均匀发送 → 跑完就歇到下一个整点
 */
export class BoundaryScheduler {
  constructor(levels, opts = {}) {
    this.levels = levels;
    this.periodMs = groupPeriodMs(levels);
    this.graceMs = opts.graceMs ?? 4000;        // 收线后等几秒，等交易所把K线定稿
    this.staggerMs = opts.staggerMs ?? 0;       // 组间错峰
    this.spreadMs = opts.spreadMs ?? 25_000;    // 一轮在多久内打完
    this.roundStartAt = 0;
    this.rounds = 0;
    this.lastRoundAt = 0;
    this.nextAt = nextBoundary(this.periodMs) + this.graceMs + this.staggerMs;
  }

  /** 是否到了新一轮（到点且上一轮已跑完） */
  shouldStart(now, cursorDone) {
    return cursorDone && now >= this.nextAt;
  }

  /** 开一轮 */
  beginRound(now) {
    this.roundStartAt = now;
    this.lastRoundAt = now;
    this.rounds++;
    this.nextAt = nextBoundary(this.periodMs, now) + this.graceMs + this.staggerMs;
  }

  /** 这一秒该发多少条（把总量摊到 spread 窗口里） */
  batchSize(total, cursor, now) {
    const elapsed = Math.max(0, now - this.roundStartAt);
    const target = Math.ceil(((elapsed + 1000) / this.spreadMs) * total);
    return Math.max(1, Math.min(total, target) - cursor);
  }

  get info() {
    return {
      levels: this.levels,
      periodMs: this.periodMs,
      nextAt: this.nextAt,
      lastRoundAt: this.lastRoundAt,
      rounds: this.rounds,
    };
  }
}
