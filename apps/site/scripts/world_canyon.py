"""Процедурный каньон с рекой для фона hero (static/js/world.js).

Запуск (из apps/site, нужны numpy и Pillow для превью):
  python scripts/world_canyon.py

Пишет static/world/world.json в формате world.js:
  n, base, pal (RGB), water (индексы воды), h (uint8 над base), c (палитра),
  l (свет 0..15), fg (255 — нет построек), fc (0), spots (овцы, курица, костёр).
Массивы — base64 построчно: индекс = y*n + x.
Карта 460x460: река по диагонали x≈y, каменные террасы, ели, зелёный берег.
Ещё сохраняет простой изометрический кадр 1440x800 (U=3.6) в scratchpad.
"""
import base64
import json
from pathlib import Path

import numpy as np

N = 460
HALF = N // 2
BASE = 0
SEED = 20260215
OUT = Path(__file__).resolve().parent.parent / "static" / "world" / "world.json"
PREVIEW = Path(r"C:\Users\Hunter\AppData\Local\Temp\claude\762192bbe5d77549\c290088f-6b6b-451f-b505-488580a83d63\scratchpad\canyon_preview.png")

# палитра: вода, ступенчатый камень, трава, земля, мох, ель, берег, ствол
MATERIALS = [
    ([17, 49, 60], "water"), ([21, 57, 68], "water"), ([25, 64, 74], "water"),
    ([29, 71, 80], "water"), ([14, 43, 54], "water"),
    ([82, 84, 90], "stone"), ([66, 68, 76], "stone"), ([112, 114, 118], "stone"),
    ([132, 132, 130], "stone"), ([168, 160, 146], "stone"), ([198, 188, 172], "stone"),
    ([118, 132, 104], "stone"), ([150, 138, 122], "stone"),
    ([110, 170, 60], "grass"), ([132, 186, 72], "grass"), ([92, 145, 54], "grass"),
    ([190, 120, 60], "dirt"), ([170, 105, 55], "dirt"), ([150, 95, 50], "dirt"),
    ([78, 122, 66], "moss"), ([102, 146, 72], "moss"),
    ([178, 174, 164], "pale"), ([156, 153, 145], "pale"),
    ([42, 88, 42], "leaf"), ([48, 100, 46], "leaf"), ([58, 112, 52], "leaf"),
    ([68, 122, 58], "leaf"),
    ([186, 170, 130], "shore"), ([156, 130, 88], "shore"), ([142, 142, 134], "shore"),
    ([90, 60, 35], "trunk"),
]
OFFSETS = [(-7, -5, -4), (-2, -1, 0), (2, 2, 1), (6, 5, 4)]
STRATA = np.array([6, 5, 7, 8, 12, 9, 10, 8], dtype=np.uint8)

M_WATER0, M_STONE0, M_GRASS0, M_DIRT0 = 0, 5, 13, 16
M_MOSS0, M_PALE0, M_LEAF0, M_SHORE0 = 19, 21, 23, 27
M_TRUNK0 = 30


def palette():
    """Четыре оттенка на материал: индекс = материал*4 + вариант шума."""
    pal, water, idx = [], [], []
    for rgb, kind in MATERIALS:
        row = []
        for d in OFFSETS:
            if kind == "water":
                d = tuple(max(-2, min(2, v // 3)) for v in d)
            elif kind == "trunk":
                d = (0, 0, 0)
            i = len(pal)
            pal.append([max(0, min(255, int(v + dv))) for v, dv in zip(rgb, d)])
            row.append(i)
            if kind == "water":
                water.append(i)
        idx.append(row)
    return pal, water, np.array(idx, dtype=np.uint8)


def f(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def noise(shape, cell, rng):
    """Гладкий value-noise на решётке с шагом cell."""
    h, w = shape
    gy, gx = np.arange(h, dtype=np.float32) / cell, np.arange(w, dtype=np.float32) / cell
    iy, ix = np.floor(gy).astype(int), np.floor(gx).astype(int)
    wy, wx = f(gy - iy)[:, None], f(gx - ix)[None, :]
    g = rng.random((iy[-1] + 2, ix[-1] + 2)).astype(np.float32)
    return ((g[iy[:, None], ix[None, :]] * (1 - wx) + g[iy[:, None], ix[None, :] + 1] * wx) * (1 - wy)
            + (g[iy[:, None] + 1, ix[None, :]] * (1 - wx) + g[iy[:, None] + 1, ix[None, :] + 1] * wx) * wy)


def spot(su, sv):
    """Экран -> клетка: те же W=1440, H=800, U=3.6, что и в старом генераторе."""
    du, dv = (su - 0.5) * 1440 / 3.6, (sv - 0.5) * 2 * 800 / 3.6
    return [int(round(HALF + (du + dv) / 2)), int(round(HALF + (dv - du) / 2))]


def terrain(rng):
    Y, X = np.mgrid[0:N, 0:N]
    t, d = (X - Y).astype(np.float32), (X + Y - N).astype(np.float32)
    big = noise((N, N), 110, rng)
    med = noise((N, N), 45, rng)
    small = noise((N, N), 16, rng)
    fine = noise((N, N), 6, rng)
    tiny = noise((N, N), 4, rng)
    fbm = 0.5 * big + 0.3 * med + 0.15 * small + 0.05 * fine

    # река: изгибы вдоль диагонали, ширина 14..22 клетки
    tc = 7 * np.sin(d / 58) + 4 * np.sin(d / 24 + 1.1) + 3 * np.sin(d / 140 + 0.4)
    w = np.clip(8 + 2 * np.sin(d / 70 + 0.6) + 1.5 * np.sin(d / 31), 7, 11)
    a = np.abs(t - tc)
    water = a < w

    # стены: крутой подъём от берега, выше к дальнему краю, сходит на нет вблизи
    back = f((-d + 90) / 300)
    wall = f((a - (w + 3)) / 26)
    near = f((165 - d) / 110)
    outer = f((a - 190) / 70)
    low = np.clip(7 + 6 * fbm + 4 * np.sin(d / 37) * np.sin(t / 29), 4, 18)
    hwall = low + wall * (45 + 170 * back) * near
    hout = 30 + 75 * back + 35 * (1 - near)
    h = np.maximum(np.maximum(low, hwall), hout * outer)
    h += (fbm - 0.5) * (8 + 22 * wall * near + 10 * outer)
    h = np.clip(np.round(h / 4) * 4, 4, 244).astype(np.uint8)

    # материалы: горизонтальные слои камня, мелкие пятна земли и мох на уступах
    hp = np.pad(h, 1, mode="edge")
    neigh = [hp[:-2, 1:-1], hp[2:, 1:-1], hp[1:-1, :-2], hp[1:-1, 2:]]
    drop = np.maximum.reduce([h.astype(int) - v.astype(int) for v in neigh])
    step_edge = np.maximum.reduce([np.abs(h.astype(int) - v.astype(int)) for v in neigh]) >= 4
    step_top = drop >= 4
    mat = np.full((N, N), M_GRASS0, np.uint8)
    stone = h > 24
    edge_pad = np.pad(step_edge, 3)
    near_edge = np.zeros_like(step_edge)
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            if abs(dx) + abs(dy) <= 3:
                near_edge |= edge_pad[3 + dy:3 + dy + N, 3 + dx:3 + dx + N]
    mat[stone] = STRATA[(h[stone].astype(int) // 6 + (med[stone] * 2).astype(int)) % 8]
    moss = stone & step_top & (fine > 0.52) & (small > 0.35)
    moss |= stone & (h % 16 < 4) & (a < 130) & (small > 0.62)
    mat[moss] = M_MOSS0 + np.minimum((fine[moss] * 2).astype(int), 1)
    mat[stone & step_top & (tiny > 0.78) & (h < 140)] = M_GRASS0 + 2
    shore = (~water) & (a < w + 6)
    mat[shore] = M_SHORE0 + np.minimum((fine[shore] * 3).astype(int), 2)
    mat[water] = M_WATER0 + (small[water] * 5).astype(np.uint8)
    h[water] = 2

    spots = {"sheep": spot(0.15, 0.85), "chicken": spot(0.80, 0.88)}
    sx, sy = spots["chicken"]
    spots["camp"] = [sx + 2, sy]
    centers = [spots["sheep"], spots["chicken"], spots["camp"]]

    # полянки: широкий шумный переход без кольца, ровный квадрат 9x9 под мобами
    yy, xx = np.mgrid[0:N, 0:N]
    warp = 5 * (med - 0.5) + 3 * (small - 0.5)
    for cx, cy in centers:
        r = np.hypot(xx - cx, yy - cy) + warp
        blend = f((36 - r) / 28)
        h = np.clip(np.round((h * (1 - blend) + 8 * blend) / 4) * 4, 4, 244).astype(np.uint8)

    ground = h.copy()
    fg = np.full((N, N), 255, np.uint8)
    fc = np.zeros((N, N), np.uint8)
    trees(rng, h, mat, ground, water, centers, fg, fc)

    flat_all = np.zeros((N, N), bool)
    for cx, cy in centers:
        flat = (np.abs(xx - cx) <= 4) & (np.abs(yy - cy) <= 4)
        h[flat] = 8
        mat[flat] = M_GRASS0 + np.minimum((tiny[flat] * 3).astype(int), 2)
        flat_all |= flat

    # земля: отдельные средние пятна (5..30 клеток) по краям террас
    grass = (mat >= M_GRASS0) & (mat < M_GRASS0 + 3)
    edge_cand = np.argwhere(grass & ~flat_all & near_edge)
    open_cand = np.argwhere(grass & ~flat_all)
    drng = np.random.default_rng(SEED + 31)
    dirt = np.zeros((N, N), bool)
    placed_dirt = []
    target = int(grass.sum() * 0.15)
    for _ in range(1600):
        if int(dirt.sum()) >= target:
            break
        pool = edge_cand if drng.random() < 0.82 else open_cand
        y0, x0 = (int(v) for v in pool[drng.integers(len(pool))])
        if any((y0 - py) ** 2 + (x0 - px) ** 2 < 49 for py, px in placed_dirt):
            continue
        rad = float(drng.uniform(2.0, 3.1))
        rr = int(np.ceil(rad))
        cells = []
        for dy in range(-rr, rr + 1):
            for dx in range(-rr, rr + 1):
                iy, ix = y0 + dy, x0 + dx
                if not (0 <= iy < N and 0 <= ix < N) or not grass[iy, ix] or flat_all[iy, ix]:
                    continue
                dist = 0.5 * (abs(dx) + abs(dy)) + 0.5 * (dx * dx + dy * dy) ** 0.5
                if dist <= rad:
                    cells.append((iy, ix))
        unseen = set(cells)
        groups = []
        while unseen:
            start = unseen.pop()
            group = {start}
            stack = [start]
            while stack:
                iy, ix = stack.pop()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nb = (iy + dy, ix + dx)
                    if nb in unseen:
                        unseen.remove(nb)
                        group.add(nb)
                        stack.append(nb)
            groups.append(group)
        cells = list(max(groups, key=len))
        if not (5 <= len(cells) <= 30) or any(dirt[iy, ix] for iy, ix in cells):
            continue
        for iy, ix in cells:
            dirt[iy, ix] = True
        placed_dirt.append((y0, x0))
    mat[dirt] = M_DIRT0 + np.minimum((fine[dirt] * 3).astype(int), 2)

    light = np.zeros((N, N), np.uint8)
    cx, cy = spots["camp"]
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            if abs(dx) + abs(dy) <= 4 and 0 <= cy + dy < N and 0 <= cx + dx < N:
                light[cy + dy, cx + dx] = 15 if (dx * dx + dy * dy) < 5 else 13
    bank = (~water) & (a > w + 1) & (a < w + 6) & (d > -100) & (d < 150)
    cand = np.argwhere(bank & ((xx * 7 + yy * 13) % 19 == 0))
    if len(cand):
        pick = cand[np.linspace(0, len(cand) - 1, min(26, len(cand))).astype(int)]
        for y, x in pick:
            light[y, x] = 14 if (x + y) % 3 else 12
    h[water] = 2
    return h, mat, water, light, spots, fg, fc


def trees(rng, h, mat, ground, water, centers, fg, fc):
    """Ёли: радиус 5, ярусы ~3 блока, шпиль в одну клетку, ствол под нижним ярусом."""
    placed = []
    for i in range(82):
        side = 1 if rng.random() < 0.5 else -1
        if i < 18:
            d0, t0 = rng.uniform(60, 190), side * rng.uniform(38, 85)
        elif i < 48:
            d0, t0 = rng.uniform(-160, 95), side * rng.uniform(36, 78)
        elif i < 68:
            d0, t0 = rng.uniform(-240, 115), side * rng.uniform(85, 165)
        else:
            d0, t0 = rng.uniform(-260, 220), side * rng.uniform(175, 250)
        rad, count = rng.uniform(8, 20), int(rng.integers(5, 13))
        for _ in range(count):
            dd = d0 + rng.normal(0, rad * 0.6)
            tt = t0 + rng.normal(0, rad * 0.6)
            x, y = int(round(HALF + (tt + dd) / 2)), int(round(HALF + (dd - tt) / 2))
            if not (8 <= x < N - 8 and 8 <= y < N - 8) or water[y, x]:
                continue
            g = int(ground[y, x])
            if g < 4 or g > 180 or rng.random() > (0.45 if g < 30 else 0.85 if g < 120 else 0.5):
                continue
            if any(np.hypot(x - cx, y - cy) < 22 for cx, cy in centers):
                continue
            if any((x - px) ** 2 + (y - py) ** 2 < 42 for px, py in placed):
                continue
            ht = int(rng.integers(18, 23))
            rbase, hstart = 5, 2
            tier = (ht - hstart) / rbase
            foot = slice(y - rbase, y + rbase + 1), slice(x - rbase, x + rbase + 1)
            if water[foot].any():
                continue
            placed.append((x, y))
            for dy in range(-rbase, rbase + 1):
                for dx in range(-rbase, rbase + 1):
                    d = max(abs(dx), abs(dy))
                    off = int(round(ht - d * tier))
                    # нижняя кромка яруса выходит на 1 блок ниже — пилообразный силуэт
                    if d >= 2 and (dx * 3 + dy * 5 + ht) % 7 == 0:
                        off -= 1
                    off = max(hstart, off)
                    iy, ix = y + dy, x + dx
                    z = int(ground[iy, ix]) + off
                    if z > h[iy, ix]:
                        h[iy, ix] = z
                        mat[iy, ix] = M_LEAF0 + int(rng.integers(0, 4))
            tx, ty = x + rbase, y
            if fg[ty, tx] == 255:
                fg[ty, tx] = h[ty, tx]
                fc[ty, tx] = M_TRUNK0 * 4 + int(rng.integers(0, 4))


def encode(a):
    return base64.b64encode(np.ascontiguousarray(a, np.uint8).tobytes()).decode()


def preview(data, path):
    """Простой изометрический кадр: те же проекция и порядок отрисовки, что в world.js."""
    from PIL import Image, ImageDraw
    W, H, U, vS = 1440, 800, 3.6, 0.6
    n = data["n"]
    h = np.frombuffer(base64.b64decode(data["h"]), np.uint8).reshape(n, n)
    mat = np.frombuffer(base64.b64decode(data["c"]), np.uint8).reshape(n, n)
    top = [tuple(int(v) for v in col) for col in data["pal"]]
    lefts = [tuple(int(v * 0.86) for v in col) for col in data["pal"]]
    rights = [tuple(int(v * 0.72) for v in col) for col in data["pal"]]
    img = Image.new("RGB", (W, H), (238, 242, 247))
    dr = ImageDraw.Draw(img)

    def P(X, Y, z):
        return (W / 2 + (X - Y) * U, H / 2 + (X + Y) * U / 2 - z * U)

    for s in range(2 * n - 1):
        for x in range(max(0, s - n + 1), min(n - 1, s) + 1):
            y = s - x
            X, Y = x - HALF, y - HALF
            sx = W / 2 + (X - Y) * U
            sy = H / 2 + (X + Y) * U / 2
            z = int(h[y, x]) * vS
            if sx + U < 0 or sx - U > W or sy + U < 0 or sy - z * U > H + 2 * U:
                continue
            i = int(mat[y, x])
            zl = min(z, (int(h[y + 1, x]) if y + 1 < n else 0) * vS)
            zr = min(z, (int(h[y, x + 1]) if x + 1 < n else 0) * vS)
            if z > zl:
                dr.polygon([P(X, Y + 1, z), P(X + 1, Y + 1, z), P(X + 1, Y + 1, zl), P(X, Y + 1, zl)], fill=lefts[i])
            if z > zr:
                dr.polygon([P(X + 1, Y, z), P(X + 1, Y + 1, z), P(X + 1, Y + 1, zr), P(X + 1, Y, zr)], fill=rights[i])
            dr.polygon([P(X, Y, z), P(X + 1, Y, z), P(X + 1, Y + 1, z), P(X, Y + 1, z)], fill=top[i])

    haze = int(H * 0.28)
    a = np.zeros((H, W, 4), np.uint8)
    a[:haze, :, :3] = (238, 242, 247)
    a[:haze, :, 3] = np.linspace(255, 0, haze, endpoint=False).astype(np.uint8)[:, None]
    img = Image.alpha_composite(img.convert("RGBA"), Image.fromarray(a, "RGBA")).convert("RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def main():
    rng = np.random.default_rng(SEED)
    h, mat, water, light, spots, fg, fc = terrain(rng)
    pal, water_idx, mapping = palette()
    variant = (noise((N, N), 6, np.random.default_rng(SEED + 1)) * 4).astype(int)
    idx = mapping[mat, variant]
    data = {
        "n": N, "base": BASE, "pal": pal, "water": water_idx,
        "h": encode(h), "c": encode(idx), "l": encode(light),
        "fg": encode(fg), "fc": encode(fc),
        "spots": spots,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    preview(data, PREVIEW)
    trees_count = int(np.count_nonzero((mat >= M_LEAF0) & (mat < M_LEAF0 + 4)))
    print(f"{OUT} {OUT.stat().st_size} bytes; n={N}, base={BASE}, max h={int(h.max())}, "
          f"water cells={int(water.sum())}, water colors={len(water_idx)}, "
          f"leaf cells={trees_count}, spots={spots}")
    print(f"preview: {PREVIEW} ({PREVIEW.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
