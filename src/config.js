/**
 * 全局配置：级别定义、信号参数、限频预算
 */

/** 级别定义，按周期升序。
 *  native=false 的级别由本地合成（币安无该原生周期：2分钟 / 10分钟 / 3小时）。
 *  hidden=true 的级别不参与界面显示与「多头排列」计数，仅作为合成数据源。
 *  limit = 该级别每次拉取的K线根数（合约权重敏感，权重 1 的上限是 99 根）。
 */
export const LEVELS = [
  { key: '1m', label: '1分', minutes: 1, native: true, hidden: true, limit: 200, backfill: 400 },
  { key: '2m', label: '2分', minutes: 2, native: false, from: '1m', ratio: 2 },
  { key: '3m', label: '3分', minutes: 3, native: true, limit: 99, backfill: 1000 },
  { key: '5m', label: '5分', minutes: 5, native: true, limit: 150, backfill: 1000 },
  { key: '10m', label: '10分', minutes: 10, native: false, from: '5m', ratio: 2 },
  { key: '15m', label: '15分', minutes: 15, native: true, limit: 99, backfill: 300 },
  { key: '30m', label: '30分', minutes: 30, native: true, limit: 99, backfill: 300 },
  { key: '1h', label: '1时', minutes: 60, native: true, limit: 150, backfill: 300 },
  { key: '2h', label: '2时', minutes: 120, native: true, limit: 99, backfill: 300 },
  { key: '3h', label: '3时', minutes: 180, native: false, from: '1h', ratio: 3 },
  { key: '4h', label: '4时', minutes: 240, native: true, limit: 99, backfill: 300 },
  { key: '6h', label: '6时', minutes: 360, native: true, limit: 99, backfill: 300 },
  { key: '12h', label: '12时', minutes: 720, native: true, limit: 99, backfill: 300 },
  { key: '1d', label: '日线', minutes: 1440, native: true, limit: 99, backfill: 300 },
  { key: '1w', label: '周线', minutes: 10080, native: true, limit: 99, backfill: 300 },
];

/** 界面显示与「多头排列」计数使用的级别（排除隐藏的数据源级别） */
export const VISIBLE_LEVELS = LEVELS.filter(l => !l.hidden);
export const LEVEL_KEYS = VISIBLE_LEVELS.map(l => l.key);
/** 全部级别 key（含隐藏），用于查找序列 */
export const ALL_LEVEL_KEYS = LEVELS.map(l => l.key);
export const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l.key, i]));
export const NATIVE_LEVELS = LEVELS.filter(l => l.native);
export const MINUTE_MS = 60_000;

/** 级别状态码（前端按此着色） */
export const STATE = {
  NODATA: 0,   // 数据不足
  BULL_ALIGN: 1, // 多头排列 close>MA7>MA25 且 MA7 上行
  BULL: 2,       // 站上 MA7，但 MA7 尚未站上 MA25
  NEUTRAL: 3,    // 均线纠缠
  WEAK: 4,       // 跌破 MA7，但 MA25 仍在下方支撑
  BEAR_ALIGN: 5, // 空头排列 close<MA7<MA25
};

/** 级别事件码（叠加在状态上） */
export const EVENT = {
  NONE: 0,
  CROSS_UP: 1,      // 近期收盘上穿 MA7
  PULLBACK: 2,      // 近期回踩触及 MA7
  CROSS_DOWN: 3,    // 近期收盘跌破 MA7
  PULLBACK_CROSS: 4, // 回踩后再度上穿（本系统的核心触发形态）
};

/**
 * 级别组合（核心）：一组「基准 → 确认 → 最大」的**固定三元组**。
 * 基准级别：发生「回踩后上穿 MA7/EMA7」的触发级别
 * 确认级别：必须同步上穿自身均线
 * 最大级别：不得跌破自身均线
 * 三者不必相邻（如 3分 → 15分 → 2时，中间跨过 5分/10分）。
 */
export const DEFAULT_GROUPS = [
  { base: '3m', mid: '15m', big: '2h', enabled: true },
  { base: '2m', mid: '10m', big: '1h', enabled: true },
  { base: '5m', mid: '30m', big: '3h', enabled: true },
];

/** 信号引擎参数（前端可实时调） */
/**
 * 「主级别回踩结构」盯盘的级别对应表（可改）。
 *
 * 每组三个级别：base 次级别 → mid 主级别 → big 最大级别。
 *
 * · 用户确认的小组（数字写法 2-10-1 / 3-15-2 / 5-30-3）主级别是 10分 / 15分 / 30分；
 * · 大组把 **1时 / 2时 / 3时 / 6时** 也当主级别扫，次级别按同一倍率关系选档：
 *   10分→1时(×6)、15分→2时(×8)、30分→3时(×6)、1时→6时(×6)。
 *   「够笔」换算不变：主级别回调 5 根 → 1时组看 10分要有 30 根、2时组看 15分要有 40 根。
 *
 * 中间级别**不在这里写死**，而是取「base 与 mid 之间的全部级别」（见 watchInnerLevels）：
 *   5m→30m 看 10分/15分   3m→15m 看 5分/10分   2m→10m 看 3分/5分
 *   10m→1h 看 15分/30分   15m→2h 看 30分/1时   30m→3h 看 1时/2时   1h→6h 看 2时/3时/4时
 */
export const DEFAULT_WATCH_GROUPS = [
  { base: '2m', mid: '10m', big: '1h', enabled: true },
  { base: '3m', mid: '15m', big: '2h', enabled: true },
  { base: '5m', mid: '30m', big: '3h', enabled: true },
  { base: '10m', mid: '1h', big: '4h', enabled: true },
  { base: '15m', mid: '2h', big: '6h', enabled: true },
  { base: '30m', mid: '3h', big: '12h', enabled: true },
  { base: '1h', mid: '6h', big: '1d', enabled: true },
];

/** 某组「中间级别」的全部 key：严格介于 base 与 mid 之间的级别（按周期升序） */
export function watchInnerLevels(group) {
  const b = LEVEL_INDEX[group?.base], m = LEVEL_INDEX[group?.mid];
  if (b == null || m == null || !(b < m)) return [];
  const out = [];
  for (let i = b + 1; i < m; i++) out.push(LEVELS[i].key);
  return out;
}

export const DEFAULT_SIGNAL = {
  // ============================================================
  // ⚠ 2026-10-15：用户要求「策略全部清除，将重新定义」→ 下面所有策略开关已置 false。
  //   行情引擎、K线、图表视图、报警列表、明细、钉钉推送等基础设施保持不动；
  //   各策略的实现代码也都留着（src/watch.js / wave.js / firstbottom.js /
  //   breakout.js / dual / resonance），定义好新规则后把对应开关打开并改判定即可。
  // ============================================================
  // ============ 三条通道总开关 ============
  // signalEnabled：共振信号引擎（固定级别组合 + 回踩突破 MA7/EMA7 + 背驰/成笔链过滤）
  // watchEnabled ：两阶段盯盘（大级别预备 → 最小级别首次站上）
  // dualEnabled  ：双阴不破均线（多） / 双阳不穿破均线（空）★ 当前只跑这一条
  signalEnabled: false,
  scanMode: 'groups',      // groups=只扫描下面配置的固定组合；auto=穷举（基准+下一档+任意更大级别）
  groups: DEFAULT_GROUPS,  // 固定组合列表
  minBullLevels: 3,        // 至少 N 个级别为多头排列（用户要求 ≥3）
  pullbackLookback: 6,     // 基准级别：多少根K线内必须出现"回踩MA7"
  pullbackTolerance: 0.002,// 回踩触及判定容差（相对 MA7 的百分比）
  triggerLookback: 2,      // 基准级别：多少根K线内完成"上穿MA7"
  adjacentLookback: 3,     // 确认级别：多少根K线内"上穿均线"
  requireEma7: true,       // 基准级别必须同时站上 EMA7
  requireAdjacentCross: true, // 确认级别必须同步上穿
  requireBaseBull: true,   // 基准级别必须处于多头形态
  bigMa: 'ema7',           // 最大级别"不跌破"用哪条均线：ma7 | ema7
  bigTolerance: 0.0,       // 最大级别允许贴近均线的容差（0 = 必须在其上方）
  useLiveCandle: true,     // 是否同时给出"形成中K线"的预警信号
  countRule: 'align',      // 共振计数：align=严格多头排列 c>MA7>MA25；above=站上MA7
  baseMinIdx: 2,           // auto 模式：允许作为"基准级别"的最小下标（2=3分钟）
  baseMaxIdx: 6,           // auto 模式：允许作为"基准级别"的最大下标（6=30分钟）

  // ============ 启动补载开关（用户 2026-10-17：已恢复补载） ============
  //   true  = 启动时把「最近刚成立」的信号也报一遍（重启后页面立刻有内容）
  //   false = 只报服务启动之后新产生的信号（页面会短暂为空，属正常）
  //   ⚠ 改动后需重启服务才生效（启动水位线 startedAt 在启动时确定）
  backfillEnabled: true,

  // ============ 斐波那契回调（★ 用户 2026-10-16 新策略，替代顶部结构） ============
  //   10分钟级别：MACD 金叉 → 高点死叉 = 一段上涨，拉斐波那契；
  //   死叉之后的回调（到再次金叉 或 底分型收盘）回撤 ≤ fibMaxRetrace(50%) → 有效 → 提醒
  fibEnabled: true,
  fibLevels: ['10m', '30m', '1h', '2h', '3h', '6h'],   // 多级别一起监控（A=10分钟 为基础级别）
  fibMaxRetrace: 50,        // 回调不超过前段涨幅的 50%
  fibMinRisePct: 0,         // 前段涨幅下限（%），0=不限
  fibLookback: 40,          // MACD 交叉在最近几根里找
  fibFreshBars: 1,          // 实时：回调结束信号出现后 ≤1 根内报
  fibInitFreshMs: 7_200_000,// 启动补报窗口（按级别折算）
  fibFractalType: 'any',    // 底分型口径

  // ============ 顶部结构（★ 已按用户要求被斐波那契回调替代，默认关闭） ============，独立界面；级别 15分/30分/1时/2时/3时/6时） ============
  //   第1根=高点 → 第2根不创新高 → 第3根不超第1根 → 第4根不超第2根 → 第5根创这段新低
  //   且 高点向下 ≥ top5MinBars 根（用户口径"大于5根以上" → 默认 6）
  top5Enabled: false,        // 顶部结构（做空方向）
  bot5Enabled: false,       // 底部结构（顶部逻辑的镜像）—— 用户 2026-10-16 要求去除，已关闭；代码保留
  top5Levels: ['30m', '1h', '2h', '3h', '6h'],   // 用户：提醒级别 30 1 2 3 6
  top5WarnBars: 5,         // 走到第几根开始预警（第5根创新低 → 预警）
  top5StrictEngulf: true,  // 反包口径：true=严格阳包阴（开盘也不高于前收）| false=只要求收盘盖过前开
  top5NeedMa: true,        // ★ 确认再加一条：底部收盘同时站上 EMA7+MA7 / 顶部同时跌破（收盘成立才算）
  top5AllowWarn: false,    // ★ 默认关闭"提前预警"，只报收盘确认
  top5FreshBars: 3,        // 启动/补报：确认发生在最近几根内也报一次（实时仍只报当根）
  top5Lookback: 20,        // 高点在最近几根里找

  // 两级五浪：每组独立，仅次级别五笔 + 对应主级别底分型确认。
  // ============ 双确认共振（★ 用户 2026-10-16：共振报警，要在左侧K线图表显示） ============
  //   同一标的、同一级别：两级五浪链先报出 → 顶部结构在 ≤N 根内收盘确认
  res2Enabled: true,
  res2WindowBars: 3,       // 两者相隔多少根K线内算共振（实测多为 1 根）

  // ============ 底分型即报（★ 用户 2026-10-16：底分型出来就提醒） ============
  //   最近 lookback 根里最低点那根是底分型中间根 + 第三根刚收盘（≤fracFreshBars 根）
  //   不要求次级别五笔、不要求站上均线 —— 分型一收盘就报
  fracEnabled: true,
  fracLevels: ['30m', '1h', '2h', '3h', '6h'],   // 用户：提醒级别 30 1 2 3 6
  fracLookback: 20,
  fracFreshBars: 0,        // 实时只报刚收盘的第三根；旧形态仅在首次加载时展示
  fracInitFreshBars: 3,    // 启动补报（按根数，备用）
  fracInitFreshMs: 7_200_000,  // ★ 启动补报按**时间**给窗口（2 小时）：避免大级别把窗口吃光（6时3根=18小时 vs 15分3根=45分钟）
  fracType: 'any',
  // ★ 用户 2026-10-17：底分型之后第 3/4/5 根回踩不破 → 提醒
  // ★ 用户 2026-10-17：底分型必须「内部有结构 + 上一级也成立」
  fracInnerMap: { '30m': '1m', '1h': '2m', '2h': '5m', '3h': '5m', '6h': '10m' },
  fracInnerStrokes: 5,      // 内部至少要几笔（下上下上下）
  fracInnerMinBars: 5,      // 每笔至少几根K线
  fracHigherWinBars: 2,     // 上级别允许在低点前后几根内出现底分型
  fracInnerGraceBars: 2,    // 内部笔允许比分型确认晚几根（笔确认天然滞后）
  fracHigherMap: { '30m': '1h', '1h': '2h', '2h': '3h', '3h': '6h', '6h': null },
  // ============ 主级别浅回调 + 次级别回踩结构（用户 2026-10-17） ============
  //   主级别：一根阴线/十字星 且 收盘不跌破均线（做多）；做空镜像
  //   次级别：MACD 死叉后回踩 ≥5 根、内部够笔、底分型成立且收盘站上
  pbEnabled: true,
  pbPairs: [{ main: '10m', sub: '3m' }],   // 主级别 ← 次级别
  pbDirs: ['long', 'short'],
  pbMinBars: 5,          // 次级别回踩至少几根
  pbMinStrokes: 3,       // 回踩段至少几笔
  pbDojiPct: 0.15,       // 十字星：实体 ≤ 此百分比
  pbNeedBothMa: false,   // 是否要求同时站上 MA7+EMA7
  pbFreshBars: 0,        // 实时：分型确认当根报
  pbInitFreshBars: 2,    // 补载窗口
  pbChanMinBars: 5,      // 缠论笔最少根数
  pbFractalType: 'any',

  fracInvalidBars: 8,      // 底分型发出后，在这么多根K线内跌破低点 → 标记作废（不合格）
  fracRetestEnabled: true,
  fracRetestBars: 3,          // 允许回踩的根数（3 → 第 3/4/5 根）
  fracRetestFreshBars: 1,     // 命中后 ≤N 根内报
  fracRetestBreakPct: 0,      // 允许破低点的容差%，0=一点都不许破
  fracRetestNearPct: 3,       // 回踩必须靠近低点：最低价距分型低点 ≤ 此百分比          // any=中间低点最低 | standard=中间高低点都最低

  chainEnabled: true,
  chainTriples: [
  {
    "main": "15m",
    "sub": "3m"
  },
  {
    "main": "30m",
    "sub": "5m"
  },
  {
    "main": "1h",
    "sub": "10m"
  },
  {
    "main": "2h",
    "sub": "15m"
  },
  {
    "main": "3h",
    "sub": "30m"
  },
  {
    "main": "6h",
    "sub": "1h"
  }
],
  chainMainMinBars: 5,      // 主级别回调最少几根K线（用户：不少于5根）
  chainSubMinBars: 5,       // 次级别每一笔（一浪）至少5根K线，包含首尾端点
  chainInnerMinBars: 5,     // 内部相邻交叉之间最少几根K线（用户：每次内部不少于五根）
  chainLookback: 20,        // 主级别高点在最近几根里找
  chainFractalType: 'any',
  // ===== 用户 2026-10-16 口径调整 =====
  chainMainMode: 'top5',   // 主级别收盘K按「顶部结构」逻辑：五根形态 + 反转点 + 收盘站上 MA7+EMA7
  chainMainNeedMa: true,   // 确认阶段要均线（收盘站上 MA7+EMA7）；早的那一声由 chainMainWarn 的「预警」负责
  chainMainFreshBars: 20,
  chainMainWarn: true,
  chainMainWarnFreshBars: 3,  // 预警窗口：底分型确认后 ≤N 根内都算     // 两阶段：底分型刚确认先发**预警**（不偏晚），站上均线再发**确认**  // 主级别反转点发生在最近 N 根内就算（去重保证只报一次，且在反转那根就报；设小会大量漏报）
  chainMinStrokes: 5,      // 次级别最少几笔；**允许高于五浪**（6/7/8 笔都行，取最长合法浪）       // 主级别见底分型口径：any=中间低点最低（默认，实测覆盖最好）| standard/relay/weakest

  // ============ 缠论笔 / 背驰（★ 引擎内部计算，界面完全不显示） ============
  // 按用户要求：这些判定照常算（供共振通道与内部结构分析使用），
  // 但界面上不画笔线、不显示「底/顶背驰酝酿」徽标、参数面板也不再放出这几项。
  filterBeichi: true,          // 总开关
  beichiScope: 'mid',          // mid = 只查确认级别；mid+big = 连最大级别一起查
  beichiMinBars: 5,            // 标准笔：顶底分型之间至少 5 根K线（含包含处理）
  beichiRatio: 1.0,            // MACD 柱面积衰减阈值：当前面积 < 前一同向笔面积 × 该值
  beichiMinProgress: 0.3,      // 当前笔至少走到前一同向笔幅度的 30% 才判定（避免刚起步误判）
  requireStrokeChain: true,    // 基准 → 确认级别之间的所有级别，都必须被这波回调带动成笔
  chainRequireAboveMa: false,  // 附加：链上各级别同时站上 MA7
  minScore: 0,             // 低于此评分的信号不推送
  // —— 回踩形态 ——
  //   touch      = 最低价触及 MA7、收盘站住，之后发生「上穿 MA7」事件才触发（旧行为）
  //   twoBearHold = 连续 N 根阴K下跌但收盘始终没跌破 MA7/EMA7（影线可插破），
  //                 当前K线收盘同时站上两条均线即触发（跌无可跌）
  pullbackPattern: 'twoBearHold',
  pullbackBars: 2,         // twoBearHold 模式下要求几根阴K

  // —— 盯盘通道（用户最新口径 v3：MACD 靠近零轴 → 次级别确认）——
  //   扫描 8 个级别：10分 / 15分 / 30分 / 1时 / 2时 / 3时 / 4时 / 6时
  //
  //   ① 唯一提醒：**回调中、MACD 的均线（DEA）贴近零轴且没有跌破**
  //      · 「没跌破零轴」= DIF > 0；「靠近零轴」= |DIF| / 收盘价 ≤ watchNearPct（默认 0.3%）
  //      · 多个级别同时满足时**只报一个**：先看谁更接近零轴，接近程度在 watchTieRatio 倍以内的
  //        候选里再**优先小级别**（用户口径：「同时看更接近和级别更小」）
  //   ② 确认提醒：预警级别出现后，它的**次级别**满足任一即可
  //      · 次级别 **MACD 金叉**（DIF 上穿 DEA，最近 watchConfirmLookback 根内发生），或
  //      · 次级别 **收盘突破 EMA7** 且 **DIF > 0**（不跌破零轴）
  //
  //   MACD 统一 12/26/9、以收盘为准。预警按「一段」去重：该级别离开近零区间或跌破零轴后才允许下一次。
  watchEnabled: false,
  watchLevels: ['15m', '30m', '1h', '2h', '3h', '4h'],   // 6 个级别（10分已去除，新增 2时/3时/4时）
  // （次级别与确认段已按用户要求整体去掉，不再需要对应表）
  watchNearPct: 0.3,             // 「贴近零轴」：|MACD均线(DEA)| / 收盘价 ≤ 0.3%
  watchNeedFalling: true,        // **只看回调中**：MACD 均线正在回落；上涨途中贴近零轴的不报
  watchTieRatio: 1.25,           // 接近程度的并列容差：差距在这个倍数内就优先小级别
  watchConfirmLookback: 2,       // 次级别金叉须发生在最近几根K线内
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  watchUseLiveCandle: true,      // 次级别那根未收盘时先给一条「预警」形式的确认
  // —— 五浪反弹通道（v5 独立策略，与盯盘通道互不影响）——
  //   主级别「一笔下」= 最近窗口内 高点 → 之后最低点 跨度 ≥ waveMinBars 根（不靠缠论、高点不要求顶分型）；
  //   这笔下跌的**次级别** MACD 交叉末尾五个必须是 死→金→死→金→死（五浪）；
  //   先见最低点、之后才出现「再次金叉」；
  //   该金叉后 waveCrossWindow 根主级别收盘K线内，主级别**由下向上穿越 EMA7** → 报警。
  waveEnabled: false,
  wavePairs: [
    { main: '15m', sub: '3m' },
    { main: '30m', sub: '5m' },
    { main: '1h', sub: '10m' },
    { main: '2h', sub: '15m' },
  ],
  waveMinBars: 5,          // 主级别 高点→低点 至少几根K线
  waveHighLookback: 20,    // 「高点」在最近几根里找
  waveCrossWindow: 2,      // 金叉后 主级别 几根收盘K线内必须上穿 EMA7

  // —— 五浪首底预警（最早的那一声）——
  //   主级别上：高点 → 低点 跨度 ≥ fbMinBars 根，然后在**高点之后第一个缠论底分型确认时**立刻报警。
  //   不等五浪走完、不等上穿 EMA7 —— 这是"五浪可能正在成型"的提前预警。
  fbEnabled: false,
  fbLevels: ['15m', '30m', '1h', '2h'],
  fbMinBars: 5,        // 高点到低点至少几根K线（用户口径：不低于 5 根）
  fbLookback: 20,      // 高点在最近几根里找
  fbFreshBars: 2,      // 底分型**确认**后最多几根内还报（早了才有意义）
  fbType: 'standard',  // 底分型类型：standard=标准（中间高、低点都最低，图里那个）| relay=中继 | weakest=最弱 | any
  fbMinDropPct: 5,     // 高点→底分型至少要跌多少 %（0=不限；实测 0%→74条 / 3%→68 / 5%→58 / 8%→26）

  // —— 均线压制后突破（独立通道，与五浪并列）——
  //   用户口径：连续 ≥brkMinBars 根收盘在 EMA7 下方（长期压制/贴着均线阴跌），
  //   紧接着一根收盘**由下向上穿越 EMA7** → 报警。
  brkEnabled: false,
  brkLevels: ['15m', '30m', '1h', '2h'],
  brkMinBars: 12,          // 连续多少根收盘在 EMA7 下方才算「长期压制」

  // —— 独立形态提醒：双阴不破均线（多） / 双阳不穿破均线（空）——
  //   不依赖共振组合，也不依赖盯盘状态机；这几档级别上一出现形态、第二根K线一收盘就提醒。
  // 「双阴不破 / 双阳不穿」独立形态提醒。
  // 注意：默认**关闭** —— 用户已把策略改成上面的「主级别回踩结构盯盘」，
  //       且要求「三条同时成立才可以预警提醒」。想并跑就在参数面板勾上。
  dualEnabled: false,
  dualLevels: ['15m', '30m', '1h', '2h', '3h'],
  dualBars: 2,             // 连续几根（默认两根）
  dualRequireMaSlope: true,// 均线方向：做多要求 MA7 向上，做空要求 MA7 向下
  dualPrevBars: 3,         // 前置趋势：形态之前价格需已在均线同侧持续 N 根（0=不检查）
  // 成交额门槛：24H 成交额低于此值不提醒（单位 USDT）。
  // 小成交额的币容易凑出「两根K线勉强不破均线」的假形态，而且滑点大、实际不好成交。
  dualMinQuoteVolume: 4_000_000,   // 400 万 USDT
  // —— 缠论背驰过滤（排除「确认级别将要出现背驰笔」的信号） ——
  // —— 回踩成笔链（笔延续级别） ——
};

/**
 * 市场配置档：现货 与 U 本位永续合约是两套独立的接口与额度。
 *
 * 注意（实测）：从部分网络访问时，U 本位合约的 kline / aggTrade / markPrice /
 * miniTicker / ticker 这几类 WS 流会被静默拦截（订阅回执正常但零数据），
 * 而 depth / bookTicker 正常。因此合约默认走「!bookTicker 实时价 + REST 补K线」。
 * 详见 README「合约数据通道」一节。
 */
export const MARKET_PROFILES = {
  spot: {
    key: 'spot',
    name: '现货 Spot',
    baseUrls: [
      'https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com',
      'https://api3.binance.com', 'https://api4.binance.com', 'https://data-api.binance.vision',
    ],
    wsUrl: 'wss://stream.binance.com:9443/ws',
    klinesPath: '/api/v3/klines',
    tickerPath: '/api/v3/ticker/24hr',
    exchangeInfoPath: '/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING',
    tickerWeight: 80,
    officialWeightCap: 6000,
    weightPerMinute: 3600,       // 现货额度宽裕，保持原值
    wsKlineStreams: true,        // 该市场的 kline WS 可用
    universeFilter: s => s.quoteAsset === 'USDT' && s.status === 'TRADING',
  },
  futures: {
    key: 'futures',
    name: 'U本位合约 USDⓈ-M',
    baseUrls: ['https://fapi.binance.com'],
    wsUrl: 'wss://fstream.binance.com/ws',
    klinesPath: '/fapi/v1/klines',
    tickerPath: '/fapi/v1/ticker/24hr',
    exchangeInfoPath: '/fapi/v1/exchangeInfo',
    tickerWeight: 40,
    officialWeightCap: 2400,
    // 合约硬上限 2400/分钟，且**按 IP 计**。
    // 本实例与 K:\币\binance-monitor（8848）同时跑，共享同一个 IP 出口，
    // 所以这里把额度压到 700+150=850，两边合计 1300+850=2150 < 2400，不会互相撞限流。
    weightPerMinute: 1600,   // ⚠ 独占出口 IP 时用 1600；若与 8848 等其它实例并行，改回 420（共享额度）
    wsKlineStreams: false,       // 实测：kline WS 被拦截，改用 bookTicker
    bookTickerStream: '!bookTicker',
    universeFilter: s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING',
  },
};

/**
 * 环境变量读取：Node 下走 process.env；浏览器里没有 process，
 * 于是全部落到默认值 —— 这样**同一份 config.js 两端都能直接跑**。
 */
const ENV = (typeof process !== 'undefined' && process.env) ? process.env : {};
const env = (key, fallback = '') => (ENV[key] ?? fallback);

const PROFILE_KEY = String(env('MARKET', 'futures')).toLowerCase();
export const PROFILE = MARKET_PROFILES[PROFILE_KEY] ?? MARKET_PROFILES.futures;

export const APP = {
  market: PROFILE.key,
  profile: PROFILE,
  port: Number(env('PORT', 8860)),
  host: env('HOST', '127.0.0.1'),
  baseUrls: PROFILE.baseUrls,
  wsUrl: PROFILE.wsUrl,
  klinesPath: PROFILE.klinesPath,
  tickerPath: PROFILE.tickerPath,
  exchangeInfoPath: PROFILE.exchangeInfoPath,
  topN: 200,                 // 盯涨幅榜前 200
  candleLimit: 200,          // 默认K线根数（各级别可在 LEVELS 里单独覆盖）
  tickerRefreshMs: 60_000,   // 涨幅榜刷新
  exchangeInfoRefreshMs: 30 * 60_000,
  resyncMs: 15 * 60_000,     // 全量对账，修复丢包
  // ===== 整点扫描（用户要求：每个整点刷新，以防被接口屏蔽）=====
  boundaryAligned: true,     // true=只在该周期收线时刻集中扫一轮；false=旧的固定间隔持续轮询
  boundaryGraceMs: 4000,     // 收线后等几秒再拉（等交易所定稿）
  boundarySpreadMs: 25_000,  // 一轮标的在这个窗口内均匀打完
  broadcastMs: 1000,
  cacheSaveMs: 300_000,       // K线缓存写盘间隔（5 分钟）
  cacheFile: 'data/klines-cache.json',         // 前端表格推送频率
  weightPerMinute: PROFILE.weightPerMinute,
  /**
   * 按币安规则留足余量：
   *   合约硬上限 2400 权重/分钟（响应头 x-mbx-used-weight-1m 可查）。
   *   旧设置 1900 + 突发 600 = 2500 > 2400 —— **突发打满时会直接越过官方上限**，
   *   这就是「配额看起来没满却还是被 418」的原因。
   *   现在本实例 700 + 150 = 850；8848 那套仍是 1100 + 200 = 1300，
   *   两者合计 2150 < 2400，共用同一个 IP 出口也不会越过官方上限。
   *   代价：全量播种慢一些（缓存已随目录一起复制，重启基本不用重播）。
   */
  weightBurst: 300,             // 突发也压低，避免瞬时把共享额度打穿
  concurrency: 8,            // REST 并发（配合上面的预算，降低瞬时压力）
  maxCandlesKept: 320,       // 每个级别序列保留的K线数（MA99 需 99 根 + 回看 20 根，留足余量）
  minQuoteVolume: 0,         // 0 = 严格按涨幅榜取前200，不做流动性过滤
  minTrades24h: 50,          // 死盘保险丝：24h 成交笔数低于此值的对子剔除（避免僵尸币污染榜单）
  staleMs: 6 * 3600_000,     // K线超过此时长未更新则视为僵尸标的，不参与评估
  /**
   * 行情源模式：
   *   kline-ws   纯 K线 WebSocket（现货默认，真实 OHLC、零权重）
   *   tick-rest  bookTicker 实时价 + REST 定期补K线（合约默认）
   *   auto       启动时先试 K线 WS，15 秒内收不到数据就自动切到 tick-rest
   */
  feed: String(env('FEED', 'auto')).toLowerCase(),
};

/** tick-rest 模式下各周期的 REST 补K线节奏（毫秒） */
export const REST_REFRESH_PLAN = [
  { levels: ['1m'], everyMs: 90_000 },
  { levels: ['3m'], everyMs: 90_000 },
  { levels: ['5m'], everyMs: 90_000 },
  { levels: ['15m'], everyMs: 120_000 },
  { levels: ['30m'], everyMs: 180_000 },
  { levels: ['1h'], everyMs: 180_000 },
  { levels: ['2h', '4h'], everyMs: 300_000 },
  { levels: ['6h', '12h', '1d', '1w'], everyMs: 600_000 },
];

/** 稳定币 / 杠杆代币，从涨幅榜中剔除 */
export const EXCLUDE_BASE = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'USDE', 'USD1', 'XUSD',
  'AEUR', 'EUR', 'GBP', 'EURI', 'PAXG', 'SUSD', 'USTC', 'UST', 'PYUSD', 'GUSD',
]);
export const EXCLUDE_SYMBOL_RE = /(UP|DOWN|BULL|BEAR)USDT$/;












