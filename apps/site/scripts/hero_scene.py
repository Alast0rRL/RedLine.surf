"""Изометрическая воксельная сцена для фона hero: сетка + блоки, деревья, домик.

Запуск: python apps/site/scripts/hero_scene.py → templates/partials/hero_scene.svg
Цвета не зашиты: у граней только классы (материал + сторона), палитра — в assets/site.css,
поэтому сцена сама подстраивается под тёмную и светлую тему.
"""
from pathlib import Path

W, H = 1600, 900          # viewBox
U = 16                     # полуширина ромба клетки: ось x → (U, U/2), ось y → (-U, U/2), ось z → (0, -U)
OX, OY = W / 2, 0


def proj(x, y, z):
    return OX + (x - y) * U, OY + (x + y) * U / 2 - z * U


# ---------- мир ----------
world: dict[tuple[int, int, int], str] = {}


def put(x, y, z, m):
    world[(x, y, z)] = m


def box(x0, x1, y0, y1, z0, z1, m):
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                put(x, y, z, m)


def ground(cx, cy, cells, z=0):
    """Площадка травы: cells — строки из '#' (клетка есть) и '.'"""
    for j, row in enumerate(cells):
        for i, ch in enumerate(row):
            if ch == "#":
                put(cx + i, cy + j, z, "grass")


def tree(x, y, z, trunk=4, big=True):
    for k in range(trunk):
        put(x, y, z + k, "log")
    top = z + trunk
    r = 2 if big else 1
    for dz, rad in ((-1, r), (0, r), (1, 1)):
        for dx in range(-rad, rad + 1):
            for dy in range(-rad, rad + 1):
                if rad == 2 and abs(dx) == 2 and abs(dy) == 2:
                    continue  # срезанные углы кроны
                if (dx, dy) == (0, 0) and dz < 1:
                    continue  # там ствол
                put(x + dx, y + dy, top + dz, "leaf")
    for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        put(x + dx, y + dy, top + 2, "leaf")


def house(x, y, z):
    """Домик 5×4: каменный фундамент, стены из досок с брёвнами по углам, окна, дверь, двускатная крыша."""
    x1, y1 = x + 4, y + 3
    box(x, x1, y, y1, z, z, "stone")
    for zz in range(z + 1, z + 4):
        for xx in range(x, x1 + 1):
            for yy in range(y, y1 + 1):
                if xx in (x, x1) or yy in (y, y1):
                    corner = xx in (x, x1) and yy in (y, y1)
                    put(xx, yy, zz, "log" if corner else "plank")
    # дверь на лицевой (+y) стене, окна на +y и +x
    world.pop((x + 2, y1, z + 1), None)
    world.pop((x + 2, y1, z + 2), None)
    put(x + 3, y1, z + 2, "win")
    put(x + 1, y1, z + 2, "win")
    put(x1, y + 1, z + 2, "win")
    put(x1, y + 2, z + 2, "win")
    # крыша: скаты вдоль x, конёк по середине y
    for k in range(3):
        for xx in range(x - 1, x1 + 2):
            for yy in (y - 1 + k, y1 + 1 - k):
                put(xx, yy, z + 4 + k, "roof")
    for xx in range(x - 1, x1 + 2):
        for yy in range(y + 2, y1 - 1):
            put(xx, yy, z + 6, "roof")
    # фронтоны
    for xx in (x, x1):
        for k in range(1, 3):
            for yy in range(y - 1 + k + 1, y1 + 1 - k):
                put(xx, yy, z + 3 + k, "plank")


def hill(cx, cy, heights):
    """Холм: heights — строки цифр (высота столба), верх — трава, ниже — земля/камень."""
    for j, row in enumerate(heights):
        for i, ch in enumerate(row):
            if ch.isdigit() and ch != "0":
                h = int(ch)
                for z in range(h):
                    m = "grass" if z == h - 1 else ("dirt" if z >= h - 2 else "stone")
                    put(cx + i, cy + j, z, m)


# Левая группа: домик, деревья, тропинка
LX, LY = 31, 55
ground(LX - 6, LY - 5, [
    "....######.....",
    "..##########...",
    ".#############.",
    "###############",
    "###############",
    "###############",
    ".##############",
    "..############.",
    "...#########...",
    ".....####......",
])
house(LX - 1, LY - 2, 1)
tree(LX + 7, LY - 3, 1)
tree(LX - 5, LY + 3, 1, trunk=3, big=False)
for i in range(4):
    put(LX + 1, LY + 2 + i, 0, "path")  # тропинка к двери (вровень с травой)

# Правая группа: холм с деревьями
RX, RY = 57, 33
hill(RX - 5, RY - 5, [
    "..11111111..",
    ".1122222111.",
    "112233322111",
    "112334322211",
    "112333322111",
    "111222221111",
    ".1111211111.",
    "..11111111..",
])
tree(RX - 1, RY - 2, 4, trunk=4)
tree(RX + 3, RY + 1, 2, trunk=3, big=False)
put(RX + 4, RY - 3, 2, "stone")

# Одинокие блоки — висят высоко, читаются как «мир продолжается»
for x, y, z, m in ((20, 30, 9, "grass"), (21, 30, 9, "dirt"), (44, 14, 11, "grass"), (52, 44, 7, "leaf")):
    put(x, y, z, m)


# ---------- рендер ----------
TOP = {"grass": "g", "dirt": "d", "stone": "s", "log": "wt", "leaf": "l", "plank": "p", "roof": "r", "win": "win", "path": "pa"}
SIDE = {"grass": "d", "dirt": "d", "stone": "s", "log": "w", "leaf": "l", "plank": "p", "roof": "r", "win": "win", "path": "d"}


def poly(pts):
    return "M" + "L".join(f"{px:.0f} {py:.0f}" for px, py in pts) + "Z"


def faces():
    out = []
    for (x, y, z) in sorted(world, key=lambda v: (v[0] + v[1] + v[2], v[2])):
        m = world[(x, y, z)]
        if (x, y, z + 1) not in world:
            out.append((f"m-{TOP[m]} t", poly([proj(x, y, z + 1), proj(x + 1, y, z + 1), proj(x + 1, y + 1, z + 1), proj(x, y + 1, z + 1)])))
        if (x, y + 1, z) not in world:  # левая видимая грань (+y)
            out.append((f"m-{SIDE[m]} a", poly([proj(x, y + 1, z + 1), proj(x + 1, y + 1, z + 1), proj(x + 1, y + 1, z), proj(x, y + 1, z)])))
        if (x + 1, y, z) not in world:  # правая видимая грань (+x)
            out.append((f"m-{SIDE[m]} b", poly([proj(x + 1, y, z + 1), proj(x + 1, y + 1, z + 1), proj(x + 1, y + 1, z), proj(x + 1, y, z)])))
    return out


def grid():
    """Линии клеток плоскости z=0 на весь кадр."""
    segs = []
    for k in range(-80, 160):
        # линии x = k (уклон −1/2) и y = k (уклон +1/2), обрезанные с запасом
        a, b = proj(k, -120, 0), proj(k, 160, 0)
        c, d = proj(-120, k, 0), proj(160, k, 0)
        segs.append(f"M{a[0]:.0f} {a[1]:.0f}L{b[0]:.0f} {b[1]:.0f}")
        segs.append(f"M{c[0]:.0f} {c[1]:.0f}L{d[0]:.0f} {d[1]:.0f}")
    return "".join(segs)


def main():
    parts = [
        f'<svg class="iso-scene" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">',
        "<!-- Сгенерировано apps/site/scripts/hero_scene.py — не править руками -->",
        f'<path class="iso-grid" d="{grid()}"/>',
        '<g class="iso-blocks">',
    ]
    parts += [f'<path class="{cls}" d="{d}"/>' for cls, d in faces()]
    parts += ["</g>", "</svg>", ""]
    out = Path(__file__).resolve().parent.parent / "templates" / "partials" / "hero_scene.svg"
    out.write_text("\n".join(parts), encoding="utf-8")
    print(f"{out}: {len(world)} блоков, {len(parts) - 6} граней, {out.stat().st_size // 1024} КБ")


if __name__ == "__main__":
    main()
