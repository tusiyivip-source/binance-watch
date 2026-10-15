/**
 * 底分型识别（按用户提供的缠论分型分类图）
 *
 * 图里的三类底分型：
 *   标准底分型：三根K线里，**中间那根的高点和低点都是三根中最低的**
 *              （图中标注：最高值是三根K线中的最低价 / 中间K线三根里面最低价）
 *   中继底分型：中间那根的低点最低，但高点不是最低（只满足"低点最低"的宽松口径）
 *   最弱底分型：宽松口径 + 第三根K线的高点低于第一根K线的高点（反弹更弱）
 *
 * 用法：在当前K线序列里，从某个下标之后找**第一个**符合要求的底分型。
 * 只认**已收盘**K线：底分型由三根K线组成，第三根一收盘就成立（比"成笔"确认更早）。
 */

/** 单点判定：idx 是否构成某种底分型（需要 idx-1、idx、idx+1 三根） */
export function isBottomFractal(v, idx, type = 'standard') {
  if (idx < 1 || idx + 1 >= v.t.length) return false;
  const l0 = v.l[idx - 1], l1 = v.l[idx], l2 = v.l[idx + 1];
  const h0 = v.h[idx - 1], h1 = v.h[idx], h2 = v.h[idx + 1];
  if (![l0, l1, l2, h0, h1, h2].every(Number.isFinite)) return false;
  const lowLowest = l1 < l0 && l1 < l2;          // 中间低点最低（所有类型都要求）
  if (!lowLowest) return false;
  const highLowest = h1 < h0 && h1 < h2;         // 中间高点也最低 → 标准底分型
  switch (type) {
    case 'standard': return highLowest;
    case 'relay': return !highLowest;            // 中继：只满足低点最低
    case 'weakest': return !highLowest && h2 < h0;   // 最弱：第三根高点低于第一根高点
    case 'any': return true;
    default: return highLowest;
  }
}

/** 从 fromIdx（含）之后扫描，返回第一个符合类型的底分型下标；找不到返回 -1 */
export function findFirstBottomFractal(v, fromIdx, type = 'standard', limitIdx = null) {
  const end = limitIdx == null ? v.t.length - 1 : Math.min(limitIdx, v.t.length - 1);
  for (let i = Math.max(1, fromIdx); i < end; i++) {
    if (isBottomFractal(v, i, type)) return i;
  }
  return -1;
}
