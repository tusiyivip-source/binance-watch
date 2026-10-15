"""解析截图 + 用真实K线数据反查是哪只币/哪个级别，并直接跑五浪检测器。
用法：python parse_shots.py <img...>
"""
import sys, json, os
from PIL import Image

UP = (246, 70, 93)
DOWN = (14, 203, 129)
MA7 = (240, 185, 11)
EMA7 = (14, 240, 240)
OUT = []


def w(s=''):
    OUT.append(str(s))


def near(px, ref, tol=40):
    return abs(px[0]-ref[0]) <= tol and abs(px[1]-ref[1]) <= tol and abs(px[2]-ref[2]) <= tol


def candles_of(path):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    cols = []
    for x in range(W):
        up = down = 0
        ys = []
        ma = []
        ema = []
        for y in range(H):
            p = px[x, y]
            if near(p, UP):
                up += 1; ys.append(y)
            elif near(p, DOWN):
                down += 1; ys.append(y)
            elif near(p, MA7, 45):
                ma.append(y)
            elif near(p, EMA7, 45):
                ema.append(y)
        cols.append({'x': x, 'up': up, 'down': down,
                     'top': min(ys) if ys else None, 'bot': max(ys) if ys else None,
                     'ma': sum(ma)/len(ma) if ma else None,
                     'ema': sum(ema)/len(ema) if ema else None})
    # 合并连续列为K线
    cs, cur = [], None
    for c in cols:
        if c['top'] is not None:
            if cur is None:
                cur = {'up': 0, 'down': 0, 'top': c['top'], 'bot': c['bot']}
            cur['up'] += c['up']; cur['down'] += c['down']
            cur['top'] = min(cur['top'], c['top']); cur['bot'] = max(cur['bot'], c['bot'])
        else:
            if cur: cs.append(cur); cur = None
    if cur: cs.append(cur)
    for c in cs:
        c['dir'] = 1 if c['up'] >= c['down'] else -1       # 1=阳 0/阴=-1
    return cs, cols, W, H


def shape_str(cs):
    return ''.join('1' if c['dir'] == 1 else '0' for c in cs)


def analyze(path):
    cs, cols, W, H = candles_of(path)
    w(f"\n===== {os.path.basename(path)}  ({W}x{H}) =====")
    w(f"识别到蜡烛 {len(cs)} 根")
    seq = ''.join('阳' if c['dir'] == 1 else '阴' for c in cs)
    w(f"方向序列（左→右）：{seq}")
    w(f"方向编码（1=阳 0=阴）：{shape_str(cs)}")
    tops = [c['top'] for c in cs]
    bots = [c['bot'] for c in cs]
    hi = tops.index(min(tops)); lo = bots.index(max(bots))
    w(f"最高点：第 {hi+1} 根；最低点：第 {lo+1} 根；跨度 {abs(lo-hi)+1} 根（规则要求 ≥5）")
    if lo > hi:
        seg = max(1, (lo-hi)//3)
        seglow = lambda a, b: max(bots[a:b+1]) if a <= b else None
        l1 = seglow(hi, hi+seg); l2 = seglow(hi+seg+1, hi+2*seg); l3 = seglow(hi+2*seg+1, lo)
        lows = [x for x in (l1, l2, l3) if x is not None]
        w(f"下跌段三等分低点(y，越大越低)：{' → '.join(str(x) for x in lows)}"
          f"　逐个降低={all(lows[i] < lows[i+1] for i in range(len(lows)-1))}")
    ma = [(c['x'], c['ma']) for c in cols if c['ma'] is not None]
    ema = dict((c['x'], c['ema']) for c in cols if c['ema'] is not None)
    cross, prev = [], None
    for x, m in ma:
        e = ema.get(x)
        if e is None: continue
        now = 'MA7在上' if m < e else 'EMA7在上'
        if prev and now != prev: cross.append(f"x={x}:{prev}→{now}")
        prev = now
    w(f"MA7/EMA7 交叉：{' '.join(cross) if cross else '（无交叉）'}")
    return shape_str(cs), cs


def load_cache():
    with open(r'K:\币\binance-watch\data\klines-cache.json', 'r', encoding='utf-8') as f:
        return json.load(f)


# 级别定义（与 src/config.js 一致），只查原生级别
def build_series(lvls):
    out = {}
    for k, rows in lvls.items():
        if isinstance(rows, list) and rows and isinstance(rows[0], list):
            out[k] = rows
    return out


def main():
    # —— 反查：把方向序列在真实数据的末尾窗口里滑窗匹配 ——
    try:
        cache = load_cache()
    except Exception as e:
        w(f"\n（读不到缓存，跳过反查：{e}）")
        return
    syms = cache.get('symbols', {})
    w(f"\n===== 用真实数据反查（缓存 {len(syms)} 个标的）=====")
    for p in sys.argv[1:]:
        cs_shape, _ = analyze(p)
        n = len(cs_shape)
        best = []
        for sym, lvls in syms.items():
            for k, rows in build_series(lvls).items():
                if len(rows) < n: continue
                for end in range(len(rows), len(rows)-40, -1):   # 只看最近 40 根窗口
                    if end - n < 0: break
                    win = rows[end-n:end]
                    s = ''.join('1' if r[4] >= r[1] else '0' for r in win)
                    if s == cs_shape:
                        best.append(f"{sym} {k} 末尾倒数第 {len(rows)-end} 根")
        w(f"{os.path.basename(p)}：方向序列 {cs_shape} → 完全匹配 {len(best)} 处")
        for b in best[:8]:
            w("    " + b)
    with open(r'K:\币\shot-analysis.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(OUT))


if __name__ == '__main__':
    main()
