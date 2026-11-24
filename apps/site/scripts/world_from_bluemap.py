"""Вырезает кусок настоящего мира сервера из BlueMap для фона hero (static/js/world.js).

BlueMap lowres-тайл lod 1 = 500x500 блоков, PNG 501x1002:
  верх (y 0..500)    — цвет верхнего блока (RGB),
  низ  (y 501..1001) — R = свет от блоков (0..15), G<<8|B = высота (int16).

Запуск (из apps/site, нужны Pillow, numpy и scipy):
  python scripts/world_from_bluemap.py
  python scripts/world_from_bluemap.py --cx -4440 --cz 6780 --rot 1 --n 440

Кадр по умолчанию — холм AlastOr с самолётом, горы сзади (вид как с карты
minecraft.redline.surf/map/#world:-4505:150:6556).

Сетка уже повёрнута под изометрию сайта: клетка (x, y), x вправо-вниз, y влево-вниз,
дальний край — x+y мал. Пишет static/world/world.json:
  n, base, pal (палитра RGB), water (индексы палитры-воды),
  h  — высота над base (uint8), c — индекс палитры, l — свет 0..15,
  fg — для «висящих» построек (самолёт): высота земли под ней, 255 = нет, fc — цвет этой земли,
  spots — точки для овец, кур и костра (клетки x, y).
Массивы — base64, построчно: индекс = y * n + x.
"""
import argparse
import base64
import io
import json
import math
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

MAP = "https://minecraft.redline.surf/map/maps/world/tiles/1"
TILE = 500
OUT = Path(__file__).resolve().parent.parent / "static" / "world" / "world.json"
FLOAT_R, FLOAT_DH = 11, 14   # постройка «висит», если земля в радиусе 11 ниже на 14+ блоков
FLOAT_MAX = 6000             # ... и таких клеток рядом меньше 6000 (иначе это гора)


def load_area(x0, z0, x1, z1):
    """Цвет, высота и свет мира в прямоугольнике [x0, x1) x [z0, z1)."""
    tx0, tz0 = math.floor(x0 / TILE), math.floor(z0 / TILE)
    tx1, tz1 = math.floor((x1 - 1) / TILE), math.floor((z1 - 1) / TILE)
    w, h = (tx1 - tx0 + 1) * TILE, (tz1 - tz0 + 1) * TILE
    C = np.zeros((h, w, 3), np.uint8)
    Hm = np.zeros((h, w), np.int32)
    L = np.zeros((h, w), np.uint8)
    for tx in range(tx0, tx1 + 1):
        for tz in range(tz0, tz1 + 1):
            with urllib.request.urlopen(f"{MAP}/x{tx}/z{tz}.png", timeout=60) as r:
                a = np.array(Image.open(io.BytesIO(r.read())).convert("RGBA")).astype(np.int32)
            s = np.s_[(tz - tz0) * TILE:(tz - tz0 + 1) * TILE, (tx - tx0) * TILE:(tx - tx0 + 1) * TILE]
            C[s] = a[:TILE, :TILE, :3]
            hh = (a[TILE + 1:2 * TILE + 1, :TILE, 1] << 8) | a[TILE + 1:2 * TILE + 1, :TILE, 2]
            Hm[s] = np.where(hh > 32767, hh - 65536, hh)
            L[s] = a[TILE + 1:2 * TILE + 1, :TILE, 0]
    ox, oz = tx0 * TILE, tz0 * TILE
    sl = np.s_[z0 - oz:z1 - oz, x0 - ox:x1 - ox]
    return C[sl], Hm[sl], L[sl]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cx", type=int, default=-4440, help="центр кадра, X блока")
    ap.add_argument("--cz", type=int, default=6780, help="центр кадра, Z блока")
    ap.add_argument("--rot", type=int, default=1, help="поворот 0..3 (по 90°)")
    ap.add_argument("--n", type=int, default=440, help="сторона квадрата в блоках")
    ap.add_argument("--float-box", type=int, nargs=4, default=[-4520, 6628, -4380, 6706],
                    metavar=("X0", "Z0", "X1", "Z1"), help="рамка висящих построек (самолёт); 0 0 0 0 — нет")
    a = ap.parse_args()
    if not any(a.float_box):
        a.float_box = None

    n, R = a.n, FLOAT_R
    half = n // 2 + R + 2
    C, Hm, L = load_area(a.cx - half, a.cz - half, a.cx + half, a.cz + half)

    # земля под «висящими» постройками: минимум высоты в окне
    from numpy.lib.stride_tricks import sliding_window_view
    pad = np.pad(Hm, R, mode="edge")
    win = sliding_window_view(pad, (2 * R + 1, 2 * R + 1))
    gmin = win.min(axis=(2, 3))
    garg = win.reshape(*win.shape[:2], -1).argmin(axis=2)
    gi = np.arange(Hm.shape[0])[:, None] + garg // (2 * R + 1) - R
    gj = np.arange(Hm.shape[1])[None, :] + garg % (2 * R + 1) - R
    gcol = C[np.clip(gi, 0, Hm.shape[0] - 1), np.clip(gj, 0, Hm.shape[1] - 1)]
    # «Висит», если земля низко с двух противоположных сторон (север+юг или запад+восток):
    # у склона горы низко только с одной. Плюс область таких клеток небольшая — пики гор отсекаем.
    from scipy import ndimage
    low = lambda sl: win[sl].min(axis=(2, 3))
    side = lambda a: (Hm - a) > FLOAT_DH
    n_, s_ = low(np.s_[:, :, :R, :]), low(np.s_[:, :, R + 1:, :])
    w_, e_ = low(np.s_[:, :, :, :R]), low(np.s_[:, :, :, R + 1:])
    floating = (side(n_) & side(s_)) | (side(w_) & side(e_))
    lab, num = ndimage.label(floating)
    sizes = np.bincount(lab.ravel())
    floating &= (sizes[lab] < FLOAT_MAX) & (lab > 0)
    # в рамке вокруг висящих построек (самолёт) хватает простого правила
    if a.float_box:
        bx0, bz0, bx1, bz1 = a.float_box
        wz, wx = np.mgrid[0:Hm.shape[0], 0:Hm.shape[1]]
        wx, wz = wx + (a.cx - half), wz + (a.cz - half)
        inbox = (wx >= bx0) & (wx <= bx1) & (wz >= bz0) & (wz <= bz1)
        floating |= inbox & ((Hm - gmin) > FLOAT_DH)

    # сетка сайта: клетка (x, y) -> мир (wx, wz), с поворотом
    ys, xs = np.mgrid[0:n, 0:n]
    x, y = xs - n // 2, ys - n // 2
    for _ in range(a.rot % 4):
        x, y = -y, x
    wz_i = (a.cz - y) - (a.cz - half)
    wx_i = (a.cx - x) - (a.cx - half)
    take = lambda arr: arr[wz_i, wx_i]

    h_raw, col, light = take(Hm), take(C), take(L)
    fl, g_raw, gc = take(floating), take(gmin), take(gcol)
    base = int(np.percentile(h_raw[~fl], 0.5))
    rel = np.clip(h_raw - base, 0, 255).astype(np.uint8)
    fg = np.where(fl, np.clip(g_raw - base, 0, 254), 255).astype(np.uint8)

    # одна палитра на 256 цветов для блоков и земли под постройками
    both = np.concatenate([col.reshape(-1, 3), gc.reshape(-1, 3)]).reshape(-1, 1, 3)
    q = Image.fromarray(both.astype(np.uint8), "RGB").quantize(256, method=Image.Quantize.MEDIANCUT)
    idx = np.array(q).reshape(-1)
    pal = np.array(q.getpalette()[:768]).reshape(-1, 3)
    cidx, gidx = idx[:n * n].astype(np.uint8), idx[n * n:].astype(np.uint8)
    water = [i for i, (r, g, b) in enumerate(pal) if b > r + 40 and b > g + 15]

    # точки для мобов: ровная трава 7x7 рядом с нужным местом на экране (W=1440, H=800, U=3.6)
    green = (col[..., 1] > col[..., 0] + 8) & (col[..., 1] > col[..., 2] + 8) & ~fl
    hv = sliding_window_view(np.pad(rel.astype(int), 3, mode="edge"), (7, 7))
    gv = sliding_window_view(np.pad(green, 3, mode="constant"), (7, 7))
    flat = (hv.max(axis=(2, 3)) == hv.min(axis=(2, 3))) & gv.all(axis=(2, 3))

    def spot(su, sv):
        du, dv = (su - 0.5) * 1440 / 3.6, (sv - 0.5) * 2 * 800 / 3.6
        tx, ty = n / 2 + (du + dv) / 2, n / 2 + (dv - du) / 2
        cand = np.argwhere(flat)
        k = cand[np.argmin((cand[:, 1] - tx) ** 2 + (cand[:, 0] - ty) ** 2)]
        return [int(k[1]), int(k[0])]

    spots = {"sheep": spot(0.12, 0.86), "chicken": spot(0.74, 0.9)}
    cy, cx_ = spots["chicken"][1], spots["chicken"][0]
    spots["camp"] = [cx_ - 2, cy + 3] if flat[cy + 3, cx_ - 2] else [cx_ + 2, cy]

    b64 = lambda v: base64.b64encode(np.ascontiguousarray(v, dtype=np.uint8).tobytes()).decode()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "n": n, "base": base, "pal": pal.tolist(), "water": water,
        "h": b64(rel), "c": b64(cidx), "l": b64(light), "fg": b64(fg), "fc": b64(gidx),
        "spots": spots,
        "source": {"cx": a.cx, "cz": a.cz, "rot": a.rot},
    }, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT} {OUT.stat().st_size} bytes, base {base}, max +{int(rel.max())}, "
          f"floating {int(fl.sum())}, water colors {len(water)}, spots {spots}")


if __name__ == "__main__":
    main()
