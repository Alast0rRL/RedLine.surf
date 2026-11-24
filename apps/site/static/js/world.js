// Живой мир на фоне hero: изометрический мир на <canvas id="world">.
// Рельеф берётся из готового файла static/world/world.json (карта настоящего мира).
// Земля рисуется один раз в два слоя (день и ночь). Каждый кадр — только живое: вода, огонь,
// дым костра, облака, смена дня и ночи, факел у курсора, параллакс.
(() => {
  'use strict';
  const canvas = document.getElementById('world');
  if (!canvas || !canvas.getContext) return;
  const main = canvas.getContext('2d');
  const frameCv = document.createElement('canvas');
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  const CFG = {
    seed: 20260131,
    clouds: false,        // облака: выключить — false
    dayNightMs: 2400,     // за сколько «проходит день» при смене темы
    torchRadius: 170,     // радиус света факела у курсора, px
    parallax: [12, 7],    // сдвиг мира от мыши, px
    vScale: 0.6,          // высота блока рельефа относительно ширины клетки
    dayFade: 0,           // день не бледнеет
    mobScale: 2.2,        // размер мобов, костра, огня и дыма
    cloudCell: 4,         // облако: сторона одной клетки, блоков
    cloudZ: 95,           // высота облаков (выше гор)
  };

  // ---------- данные мира: грузим один раз ----------
  const ver = ((document.querySelector('script[src*="world.js"]') || {}).src || '').match(/[?&]v=([^&]+)/);
  const b64 = (s) => { const a = atob(s), u = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) u[i] = a.charCodeAt(i); return u; };
  const data = fetch('/static/world/world.json?v=' + (ver ? ver[1] : ''))
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((d) => { for (const k of ['h', 'c', 'l', 'fg', 'fc']) d[k] = b64(d[k]); return d; })
    .catch((e) => { console.error('[redline] world', e); return null; });

  // ---------- случайность и шум ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const hash = (x, y) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(CFG.seed, 144665);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), u = smooth(x - xi), v = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  let rs = 0;
  const rand = () => {
    rs = (rs + 0x6D2B79F5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---------- палитра костра и облаков: день почти без осветления, ночь с синевой ----------
  const BASE = {
    log: [108, 82, 55], logtop: [160, 128, 88], ash: [70, 66, 62],
    wool: [236, 236, 232],
  };
  const DAY = {}, NIGHT = {};
  for (const [k, c] of Object.entries(BASE)) {
    DAY[k] = c.map((v) => Math.round(lerp(v, 246, CFG.dayFade)));
    NIGHT[k] = c.map((v, i) => Math.round(v * 0.17 + [4, 6, 14][i]));
  }
  const HAZE = { day: [200, 215, 235], night: [10, 14, 28], max: 0.3 };
  const GRADE = {
    top: [1.08, 1.02, 0.88], left: 0.78, right: 0.5,
    shadow: [30, 45, 80], shadowMix: 0.35, moon: [140, 170, 235], ao: 0.7,
    stoneLit: [215, 195, 165], stoneShade: [28, 38, 66], contrast: 0.2,
  };
  const HZB = 8, TB = 5;
  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const rgb = (c, k = 1, a = 1) => `rgba(${clampByte(c[0] * k)},${clampByte(c[1] * k)},${clampByte(c[2] * k)},${a})`;
  const mix = (name, n) => DAY[name].map((v, i) => lerp(v, NIGHT[name][i], n));
  const saturate = (v, k = 1.45) => {
    const l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return v.map((x) => clampByte(l + (x - l) * k));
  };
  const contrast = (v) => v.map((x) => {
    const d = x - 128;
    return clampByte(x + GRADE.contrast * d * (1 - Math.abs(d) / 128));
  });
  const gradeFace = (v, face, night, row = -1) => {
    if (night) {
      if (face === 0) return v.map((x, j) => lerp(x, GRADE.moon[j], 0.16));
      if (face === 2) return v.map((x, j) => lerp(x, GRADE.shadow[j], 0.22));
      return v;
    }
    let o;
    if (face === 0) o = v.map((x, j) => x * GRADE.top[j]);
    else if (face === 1) o = v.map((x) => x * GRADE.left);
    else o = v.map((x) => x * GRADE.right).map((x, j) => lerp(x, GRADE.shadow[j], GRADE.shadowMix));
    if (row >= 5 && row <= 12) {
      if (face === 0) o = o.map((x, j) => lerp(x, GRADE.stoneLit[j], 0.2));
      else if (face === 1) o = o.map((x, j) => lerp(x, GRADE.stoneShade[j], 0.12));
      else o = o.map((x, j) => lerp(x, GRADE.stoneShade[j], 0.22));
    }
    return o;
  };
  const gradeCell = (v, face, hz, ao, night, tex, row = -1) => {
    let o = gradeFace(v, face, night, row);
    if (ao) o = o.map((x) => x * GRADE.ao);
    o = contrast(o);
    if (tex !== undefined) o = o.map((x) => x * (0.93 + tex * (0.14 / (TB - 1))));
    if (hz > 0) {
      const sky = night ? HAZE.night : HAZE.day;
      o = o.map((x, j) => lerp(x, sky[j], hz * HAZE.max));
    }
    return o.map(clampByte);
  };

  function quad(c, pts, fill, edge) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (edge) { c.strokeStyle = edge; c.stroke(); }
  }
  // Брусок произвольного размера: видны левая (+y), правая (+x) и верхняя грани
  function box(c, P, x, y, z, dx, dy, dz, top, side, edge, a = 1, night = false) {
    quad(c, [P(x, y + dy, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x, y + dy, z)], rgb(gradeFace(side, 1, night), 1, a), edge);
    quad(c, [P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x + dx, y, z)], rgb(gradeFace(side, 2, night), 1, a), edge);
    quad(c, [P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], rgb(gradeFace(top, 0, night), 1, a), edge);
  }

  // ---------- сборка мира из данных ----------
  let W = 0, H = 0, dpr = 1, world = null;

  // Сборка идёт кусками по ~10 мс между кадрами: на слабом телефоне это пара секунд,
  // и страница при этом не замирает. Пока собирается, старый кадр остаётся на экране.
  let buildId = 0, building = false;
  // отдать ход браузеру: MessageChannel, а не setTimeout — его в фоновой вкладке не тормозят до 1 с
  const yieldNow = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
  async function build(D) {
    const id = ++buildId;
    building = true;
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    rs = CFG.seed;
    let slice = performance.now();
    const pause = async () => {
      if (performance.now() - slice < 10) return true;
      await yieldNow();
      slice = performance.now();
      return id === buildId;   // началась новая сборка — эту бросаем
    };

    const { n, pal, h, c, l, fg, fc, spots } = D;
    const vS = CFG.vScale, S = CFG.mobScale, half = n / 2;
    const waterSet = new Uint8Array(256);
    for (const i of D.water) waterSet[i] = 1;

    const U = W < 768 ? clamp(W / 90, 4, 6) : clamp(W / 210, 5, 12);
    const M = 30, CW = W + 2 * M, CH = H + 2 * M;
    const ox = CW / 2, oy = CH / 2;
    const P = (x, y, z) => [ox + (x - y) * U, oy + ((x + y) * U) / 2 - z * U];
    const Pg = (x, y, z) => P(x - half, y - half, z);   // то же, но по индексам клеток карты
    const fromScreen = (sx, sy) => {
      const a = (sx - ox) / U, b = ((sy - oy) * 2) / U;
      return [Math.round((a + b) / 2), Math.round((b - a) / 2)];
    };

    // высота земли под клеткой для проверки соседей: у «парящих» построек — земля под ними
    const gz = (x, y) => {
      if (x < 0 || y < 0 || x >= n || y >= n) return 0;
      const i = y * n + x;
      return (fg[i] !== 255 ? fg[i] : h[i]) * vS;
    };
    const hazeBucket = (s, z) => {
      const far = Math.max(0, 1 - s / (2 * n - 2));
      const t = clamp((far - 2 / 3) * 3, 0, 1);
      const hi = 0.75 + 0.25 * clamp(z / (120 * vS), 0, 1);
      return Math.min(HZB - 1, Math.round(Math.pow(t, 0.8) * hi * (HZB - 1)));
    };
    const [cx, cy] = spots.camp;

    // ---------- цвета: кэш по палитре, градиенту и затенению ----------
    const dayBase = [];
    for (let i = 0; i < pal.length; i++) {
      const row = i >> 2;
      let v = saturate(pal[i], row >= 5 && row <= 12 ? 1.15 : 1.45);
      if (row < 5) v = v.map((x, j) => lerp(x, [130, 190, 205][j], 0.08));
      dayBase[i] = v.map(clampByte);
    }
    const dayC = [], nightC = [];
    const texBucket = (x, y, b = 0) => Math.min(TB - 1, (hash(x * 13 + b * 7, y * 7 + b * 11) * TB) | 0);
    const dayFace = (i, face, hz, ao, tex) => {
      const key = ((((i * HZB + hz) * TB + tex) << 1) | (ao ? 1 : 0));
      return dayC[key] || (dayC[key] = [0, 1, 2].map((f) => rgb(gradeCell(dayBase[i], f, hz / (HZB - 1), ao, false, tex, i >> 2))));
    };
    const nightFace = (i, lt, face, hz, ao, tex) => {
      const key = (((((i * 16 + lt) * HZB + hz) * TB + tex) << 1) | (ao ? 1 : 0));
      if (nightC[key]) return nightC[key];
      const warm = Math.pow(lt / 15, 2) * 0.75, tg = [255, 165, 80];
      let v = pal[i].map((x, j) => x * 0.17 + [4, 6, 14][j]);
      v = v.map((x, j) => lerp(x, tg[j] * (pal[i][j] / 255 * 0.6 + 0.4), warm));
      if ((i >> 2) < 5) v = v.map((x, j) => lerp(x, [90, 120, 170][j], 0.06));
      return (nightC[key] = [0, 1, 2].map((f) => rgb(gradeCell(v, f, hz / (HZB - 1), ao, true, tex, i >> 2))));
    };

    // ---------- отрисовка земли в два слоя ----------
    const edgeD = U >= 6 ? 'rgba(38,34,30,0.055)' : null, edgeN = U >= 6 ? 'rgba(215,228,255,0.028)' : null;
    const mk = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(CW * dpr);
      cv.height = Math.round(CH * dpr);
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      g.lineWidth = 1;
      g.lineJoin = 'round';
      return [cv, g];
    };
    const [day, cd] = mk(), [night, cn] = mk();
    const qSide = (pts, fd, fn) => { quad(cd, pts, fd, null); quad(cn, pts, fn, null); };
    const qTop = (pts, fd, fn) => { quad(cd, pts, fd, edgeD); quad(cn, pts, fn, edgeN); };
    const emissive = [], water = [], seenEm = new Set();

    const bandGradient = (g, yTop, yBot, zt, zb, colorAt) => {
      const gr = g.createLinearGradient(0, yTop, 0, yBot);
      const span = zt - zb;
      for (let b = Math.ceil(zt / vS) - 1; b >= Math.floor(zb / vS); b--) {
        const z1 = Math.min(zt, (b + 1) * vS), z0 = Math.max(zb, b * vS);
        if (z1 <= z0) continue;
        const col = colorAt(b);
        gr.addColorStop(clamp((zt - z1) / span, 0, 1), col);
        gr.addColorStop(clamp((zt - z0) / span, 0, 1), col);
      }
      return gr;
    };

    // столб земли от zt вниз: левая грань, правая грань, верхний ромб
    const column = (x, y, X, Y, zt, i, ci, lt, hz) => {
      const zl = Math.min(zt, gz(x, y + 1)), zr = Math.min(zt, gz(x + 1, y));
      const aoL = y + 1 < n && h[(y + 1) * n + x] - h[i] >= 4;
      const aoR = x + 1 < n && h[y * n + x + 1] - h[i] >= 4;
      if (zt > zl) {
        const p0 = P(X, Y + 1, zt), p1 = P(X + 1, Y + 1, zt), p2 = P(X + 1, Y + 1, zl), p3 = P(X, Y + 1, zl);
        qSide([p0, p1, p2, p3],
          bandGradient(cd, p0[1], p3[1], zt, zl, (b) => dayFace(ci, 1, hz, aoL, texBucket(x, y, b))),
          bandGradient(cn, p0[1], p3[1], zt, zl, (b) => nightFace(ci, lt, 1, hz, aoL, texBucket(x, y, b))));
      }
      if (zt > zr) {
        const p0 = P(X + 1, Y, zt), p1 = P(X + 1, Y + 1, zt), p2 = P(X + 1, Y + 1, zr), p3 = P(X + 1, Y, zr);
        qSide([p0, p1, p2, p3],
          bandGradient(cd, p0[1], p3[1], zt, zr, (b) => dayFace(ci, 2, hz, aoR, texBucket(x + 1, y, b))),
          bandGradient(cn, p0[1], p3[1], zt, zr, (b) => nightFace(ci, lt, 2, hz, aoR, texBucket(x + 1, y, b))));
      }
      qTop([P(X, Y, zt), P(X + 1, Y, zt), P(X + 1, Y + 1, zt), P(X, Y + 1, zt)],
        dayFace(ci, 0, hz, aoL || aoR, texBucket(x, y)),
        nightFace(ci, lt, 0, hz, aoL || aoR, texBucket(x, y)));
    };

    // костёр на клетке spots.camp (рисуется чуть позже, чтобы соседи его не перекрыли)
    const campZ = h[cy * n + cx] * vS;
    const drawCamp = () => {
      const mx = cx + 0.5 - half, my = cy + 0.5 - half;
      for (const [g, T, e, n] of [[cd, DAY, edgeD, false], [cn, NIGHT, edgeN, true]]) {
        const B = (x, y, z, dx, dy, dz, top, side) => box(g, P, mx + (x - 0.5) * S, my + (y - 0.5) * S, campZ + z * S, dx * S, dy * S, dz * S, top, side, e, 1, n);
        B(0.1, 0.1, 0, 0.8, 0.8, 0.1, T.ash, T.ash);
        B(0.15, 0.38, 0.1, 0.7, 0.24, 0.2, T.logtop, T.log);
        B(0.38, 0.15, 0.3, 0.24, 0.7, 0.2, T.logtop, T.log);
      }
    };
    let campDone = false;

    for (let s = 0; s <= 2 * n - 2; s++) {
      if (!(await pause())) return false;
      if (!campDone && s >= cx + cy + 3) { drawCamp(); campDone = true; }
      for (let x = Math.max(0, s - n + 1), x1 = Math.min(n - 1, s); x <= x1; x++) {
        const y = s - x, i = y * n + x, X = x - half, Y = y - half, z = h[i] * vS;
        // отсекаем клетки, чей столб целиком за кадром
        const sx = ox + (X - Y) * U;
        if (sx + U < 0 || sx - U > CW || oy + (X + Y + 2) * U / 2 < 0 || oy + (X + Y) * U / 2 - z * U > CH) continue;
        const ci = c[i], wat = waterSet[ci] === 1, lt = wat ? 0 : Math.min(15, l[i]);
        const hz = hazeBucket(s, z);
        if (fg[i] !== 255) {
          // парящая постройка: земля под ней, затем плита своего цвета с обоими боками
          const fz = fg[i] * vS;
          column(x, y, X, Y, fz, i, fc[i], 0, hazeBucket(s, fz));
          const aoL = y + 1 < n && h[(y + 1) * n + x] - h[i] >= 4;
          const aoR = x + 1 < n && h[y * n + x + 1] - h[i] >= 4;
          const zb = z - 2 * vS;
          qSide([P(X, Y + 1, z), P(X + 1, Y + 1, z), P(X + 1, Y + 1, zb), P(X, Y + 1, zb)],
            dayFace(ci, 1, hz, aoL, texBucket(x, y)), nightFace(ci, lt, 1, hz, aoL, texBucket(x, y)));
          qSide([P(X + 1, Y, z), P(X + 1, Y + 1, z), P(X + 1, Y + 1, zb), P(X + 1, Y, zb)],
            dayFace(ci, 2, hz, aoR, texBucket(x + 1, y)), nightFace(ci, lt, 2, hz, aoR, texBucket(x + 1, y)));
          qTop([P(X, Y, z), P(X + 1, Y, z), P(X + 1, Y + 1, z), P(X, Y + 1, z)],
            dayFace(ci, 0, hz, aoL || aoR, texBucket(x, y)), nightFace(ci, lt, 0, hz, aoL || aoR, texBucket(x, y)));
        } else column(x, y, X, Y, z, i, ci, lt, hz);
        if (wat) {
          if ((x * 7 + y * 13) % 9 === 0 && water.length < 700) water.push([...P(X + 0.5, Y + 0.5, z), hash(x, y)]);
        } else if (lt >= 14 && emissive.length < 160) {
          const k = (x >> 2) * 1000 + (y >> 2);
          if (!seenEm.has(k)) { seenEm.add(k); emissive.push(P(X + 0.5, Y + 0.5, z)); }
        }
      }
    }
    if (!campDone) drawCamp();

    // дымка, тёплый свет и лёгкая виньетка запекаются в слои — в кадре только crossfade
    for (const [g, glow, night] of [
      [cd, [255, 205, 120, 0.14], false],
      [cn, [110, 140, 230, 0.10], true],
    ]) {
      const gx = CW * 0.86, gy = M + H * 0.14, sr = Math.max(W, H) * 0.75;
      const sun = g.createRadialGradient(gx, gy, 0, gx, gy, sr);
      sun.addColorStop(0, `rgba(${glow[0]},${glow[1]},${glow[2]},${glow[3]})`);
      sun.addColorStop(1, `rgba(${glow[0]},${glow[1]},${glow[2]},0)`);
      g.fillStyle = sun;
      g.fillRect(0, 0, CW, CH);
      const vr = Math.max(W, H) * 0.78;
      const vig = g.createRadialGradient(CW / 2, CH / 2, Math.min(W, H) * 0.28, CW / 2, CH / 2, vr);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, night ? 'rgba(0,0,0,0.32)' : 'rgba(48,34,22,0.12)');
      g.fillStyle = vig;
      g.fillRect(0, 0, CW, CH);
    }

    const clouds = [];
    if (CFG.clouds) {
      for (let i = 0; i < 6; i++) {
        const shape = [];
        const w = 3 + Math.floor(rand() * 5), d = 2 + Math.floor(rand() * 3);
        for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) if (rand() > 0.12) shape.push([x, y]);
        for (let k = 0; k < 3; k++) shape.push([Math.floor(rand() * w), d]);
        const [qx, qy] = fromScreen(rand() * CW, rand() * CH * 0.5 + CFG.cloudZ * U);
        clouds.push({ x: qx, y: qy, shape: shape.sort((a, b) => a[0] + a[1] - b[0] - b[1]) });
      }
    }

    const stars = Array.from({ length: 60 }, () => [rand() * W, rand() * H * 0.22, rand() * 6, 0.6 + rand() * 1.2]);

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    building = false;
    world = { U, M, CW, CH, P, Pg, fromScreen, sun: pixelTex('sun'), moon: pixelTex('moon'),
      day, night, emissive, water, clouds, stars,
      camp: Pg(cx + 0.5, cy + 0.5, campZ + 0.35 * S), smoke: [], smokeT: 0 };
    return true;
  }

  // ---------- состояние ----------
  let t = root.classList.contains('dark') ? 1 : 0;           // 0 — день, 1 — ночь
  let tFrom = t, tTo = t, tStart = 0;
  let time = 0, last = 0, raf = 0, visible = true;
  let ptr = { x: 0, y: 0, inside: false }, par = { x: 0, y: 0, tx: 0, ty: 0 };
  const light = finePointer ? document.createElement('canvas') : null;

  function glow(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function draw() {
    const w = world;
    if (!w || building) return;
    // земля (день/ночь, градинг, закат, факел) собирается в отдельный кадр
    if (frameCv.width !== canvas.width || frameCv.height !== canvas.height) { frameCv.width = canvas.width; frameCv.height = canvas.height; }
    const ctx = frameCv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    const ox = -w.M + par.x, oy = -w.M + par.y;
    ctx.drawImage(w.day, ox, oy, w.CW, w.CH);
    if (t > 0.001) { ctx.globalAlpha = t; ctx.drawImage(w.night, ox, oy, w.CW, w.CH); ctx.globalAlpha = 1; }

    // закат/рассвет посередине перехода
    const dusk = Math.sin(Math.PI * t) * (tFrom !== tTo || (t > 0 && t < 1) ? 1 : 0);
    if (dusk > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,110,50,${dusk * 0.55})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // факел у курсора: ночью вокруг мыши проступает освещённый мир
    const flick = 1 + Math.sin(time * 9.3) * 0.03 + Math.sin(time * 23.7) * 0.02;
    const torchOn = light && ptr.inside && t > 0.05;
    const R = CFG.torchRadius * flick;
    if (torchOn) {
      if (light.width !== canvas.width || light.height !== canvas.height) { light.width = canvas.width; light.height = canvas.height; }
      const l = light.getContext('2d');
      l.setTransform(dpr, 0, 0, dpr, 0, 0);
      l.globalCompositeOperation = 'source-over';
      l.clearRect(0, 0, W, H);
      const g = l.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, R);
      g.addColorStop(0, 'rgba(0,0,0,0.95)');
      g.addColorStop(0.45, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.fillRect(ptr.x - R, ptr.y - R, R * 2, R * 2);
      l.globalCompositeOperation = 'source-in';
      l.drawImage(w.day, ox, oy, w.CW, w.CH);
      ctx.globalAlpha = t * 0.8;
      ctx.drawImage(light, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'soft-light';
      glow(ctx, ptr.x, ptr.y, R * 1.1, '255,150,60', 0.5 * t);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    drawSky(ctx, w);
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalCompositeOperation = 'source-over';
    main.globalAlpha = 1;
    main.clearRect(0, 0, canvas.width, canvas.height);
    main.drawImage(frameCv, 0, 0);
    drawScene(main, w, ox, oy);
  }

  function drawScene(ctx, w, ox, oy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(ox, oy);
    const P = w.P, S = CFG.mobScale;

    // блики на воде
    const wl = t < 0.5 ? '245,250,255' : '180,205,255';
    const wa = lerp(0.6, 0.26, t);
    ctx.lineWidth = Math.max(1.5, w.U * 0.22);
    const vx = w.U * 0.28, vy = w.U * 0.14;
    for (const [x, y, ph] of w.water) {
      const a = Math.sin(time * 1.1 + ph * 40);
      if (a < 0.6) continue;
      ctx.strokeStyle = `rgba(${wl},${((a - 0.6) / 0.4) * wa})`;
      const sh = Math.sin(time * 0.7 + ph * 9) * w.U * 0.15;
      ctx.beginPath();
      ctx.moveTo(x - vx + sh, y - vy);
      ctx.lineTo(x + vx + sh, y + vy);
      ctx.stroke();
    }

    // огонь костра
    const fire = (x, y, s, i) => {
      const f = 0.7 + noise(time * 7 + i * 13, i) * 0.6;
      ctx.fillStyle = `rgba(255,140,40,${0.9})`;
      ctx.fillRect(x - s / 2, y - s * 1.4 * f, s, s * 1.4 * f);
      ctx.fillStyle = 'rgba(255,225,120,0.95)';
      ctx.fillRect(x - s / 4, y - s * 0.9 * f, s / 2, s * 0.9 * f);
    };
    const cs = Math.max(2, w.U * 0.16 * S);
    for (let i = 0; i < 3; i++) fire(w.camp[0] + (i - 1) * cs * 1.1, w.camp[1], cs, i);

    // дым костра: серые квадраты поднимаются высоко и тают, как в Minecraft
    const sc = lerp(150, 70, t);
    for (const p of w.smoke) {
      const k = p.age / p.life;
      ctx.fillStyle = `rgba(${sc},${sc},${sc + 6},${(1 - k) * (k < 0.08 ? k / 0.08 : 1) * 0.5})`;
      const s = p.size * (1 + k * 1.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    // ночные огни: тёплые места карты и костёр
    if (t > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const a = smooth(clamp((t - 0.35) / 0.65, 0, 1));
      for (const [x, y] of w.emissive) glow(ctx, x, y, w.U * 4, '255,140,60', 0.22 * a);
      glow(ctx, w.camp[0], w.camp[1] - w.U * 0.2, w.U * S * (2.7 + noise(time * 4, 99) * 0.5), '255,130,50', 0.32 * a);
      ctx.globalCompositeOperation = 'source-over';
    }

    // облака — выше всего и с более сильным параллаксом
    if (w.clouds.length) {
      ctx.translate(par.x * 1.5, par.y * 1.5);
      const C = CFG.cloudCell, top = mix('wool', t * 0.9), alpha = lerp(0.5, 0.18, t);
      for (const cl of w.clouds) for (const [dx, dy] of cl.shape) box(ctx, P, cl.x + dx * C, cl.y + dy * C, CFG.cloudZ, C, C, C * 0.6, top, top, null, alpha, t > 0.5);
    }
    ctx.restore();

  }

  // Пиксельные текстуры 8x8, как у солнца и луны в игре
  function pixelTex(kind) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 8;
    const c = cv.getContext('2d');
    const craters = new Set(['1,1', '2,1', '1,2', '5,2', '5,3', '6,3', '2,5', '3,5', '6,6']);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const n = (hash(i * 7 + 3, j * 5 + 1) - 0.5) * 14;
      let col;
      if (kind === 'sun') {
        const d = Math.max(Math.abs(i - 3.5), Math.abs(j - 3.5));
        col = d <= 1.5 ? [255, 255, 236] : d <= 2.5 ? [255, 243, 168] : [255, 216, 92];
      } else {
        col = craters.has(`${i},${j}`) ? [160, 166, 184] : [214, 219, 232];
        if (i === 0 || j === 7) col = col.map((v) => v - 18);
      }
      c.fillStyle = `rgb(${col[0] + n | 0},${col[1] + n | 0},${col[2] + n | 0})`;
      c.fillRect(i, j, 1, 1);
    }
    return cv;
  }

  // Небо: солнце и луна ходят по дуге. Смена темы = солнце уходит вниз за правый край
  // и краснеет, с другой стороны поднимается луна. Небо — самый дальний план:
  // за мышью сдвигается слабее мира, при прокрутке отстаёт от страницы.
  function drawSky(ctx, w) {
    const lagY = Math.min(scrollY, H) * 0.35;
    const kx = 0.45, ky = 0.45;
    const sx0 = par.x * kx, sy0 = par.y * ky + lagY;
    const s = Math.round(clamp(w.U * 4.6, 40, 72) / 8) * 8;   // кратно 8 — пиксели ровные
    ctx.imageSmoothingEnabled = false;
    // дуга по трём точкам (доли ширины/высоты hero)
    const arc = (k, a, b, c) => [0, 1].map((i) => ((1 - k) * (1 - k) * a[i] + 2 * k * (1 - k) * b[i] + k * k * c[i]) * (i ? H : W));

    // звёзды
    const starA = smooth(clamp((t - 0.45) / 0.55, 0, 1));
    if (starA > 0.01) {
      for (const [x, y, ph, sz] of w.stars) {
        ctx.fillStyle = `rgba(230,235,255,${starA * (0.35 + 0.35 * Math.sin(time * 1.7 + ph))})`;
        ctx.fillRect(x + par.x * 0.25, y + par.y * 0.25 + lagY * 1.3, sz, sz);
      }
    }

    // солнце: днём справа над миром, к ночи — вниз по дуге и за край
    const p = t;
    const sunA = 1 - smooth(clamp((p - 0.45) / 0.45, 0, 1));
    if (sunA > 0.01) {
      const [bx, by] = arc(smooth(p), [0.87, W < 600 ? 0.11 : 0.2], [1.02, W < 600 ? 0.08 : 0.16], [1.12, 0.85]);
      const x = bx + sx0, y = by + sy0;
      const warm = smooth(clamp(p / 0.7, 0, 1));
      const sz = s * (1 + warm * 0.15);
      // мягкое сияние и «квадратный» ореол, как у шейдеров в Minecraft
      glow(ctx, x, y, sz * (3.2 + warm * 1.8), warm > 0.2 ? '255,150,80' : '255,236,170', (0.42 + warm * 0.2) * sunA);
      for (const [k, a] of [[2.1, 0.1], [1.55, 0.16]]) {
        ctx.fillStyle = `rgba(255,${(232 - warm * 90) | 0},${(150 - warm * 90) | 0},${a * sunA})`;
        ctx.fillRect(x - sz * k / 2, y - sz * k / 2, sz * k, sz * k);
      }
      ctx.globalAlpha = sunA;
      ctx.drawImage(w.sun, x - sz / 2, y - sz / 2, sz, sz);
      if (warm > 0.01) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgba(255,${(150 - warm * 40) | 0},70,${warm * 0.7})`;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
    }

    // луна: поднимается слева по своей дуге
    const moonA = smooth(clamp((t - 0.3) / 0.55, 0, 1));
    if (moonA > 0.01) {
      const [bx, by] = arc(smooth(t), [-0.12, 0.85], [-0.02, W < 600 ? 0.08 : 0.16], [0.12, W < 600 ? 0.11 : 0.2]);
      const x = bx + sx0, y = by + sy0;
      const mz = s * 0.85;
      glow(ctx, x, y, mz * 3.4, '170,190,255', 0.28 * moonA);
      ctx.fillStyle = `rgba(200,212,255,${0.08 * moonA})`;
      ctx.fillRect(x - mz, y - mz, mz * 2, mz * 2);
      ctx.globalAlpha = moonA;
      ctx.drawImage(w.moon, x - mz / 2, y - mz / 2, mz, mz);
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = true;
  }

  function update(dt) {
    const w = world;
    if (tFrom !== tTo) {
      const k = clamp((performance.now() - tStart) / CFG.dayNightMs, 0, 1);
      t = lerp(tFrom, tTo, smooth(k));
      if (k >= 1) tFrom = tTo;
    }
    par.x += (par.tx - par.x) * 0.06;
    par.y += (par.ty - par.y) * 0.06;
    w.smokeT -= dt;
    if (w.smokeT <= 0 && w.smoke.length < 70) {
      w.smokeT = 0.14;
      w.smoke.push({ x: w.camp[0] + (Math.random() - 0.5) * w.U * 0.3 * CFG.mobScale, y: w.camp[1] - w.U * 0.4 * CFG.mobScale, vy: -(20 + Math.random() * 10),
        age: 0, life: 6 + Math.random() * 2, size: (3 + Math.random() * 3) * CFG.mobScale, ph: Math.random() * 6 });
    }
    for (const p of w.smoke) { p.age += dt; p.y += p.vy * dt; p.x += Math.sin(p.age * 1.2 + p.ph) * 5 * dt + 3 * dt; }
    w.smoke = w.smoke.filter((p) => p.age < p.life);
    for (const cl of w.clouds) {
      cl.x += dt * 5 / w.U;
      const [sx, sy] = w.P(cl.x, cl.y, CFG.cloudZ);
      if (sx > w.CW + 160 || sy > w.CH + 120) {
        const fromLeft = Math.random() < 0.5;
        [cl.x, cl.y] = w.fromScreen(fromLeft ? -140 : Math.random() * w.CW, (fromLeft ? Math.random() * w.CH * 0.5 : -60) + CFG.cloudZ * w.U);
      }
    }
  }

  function frame(now) {
    raf = 0;
    if (!visible || document.hidden || !world) return;
    if (building) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    time += dt;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && !reduced) { last = 0; raf = requestAnimationFrame(frame); } }

  // ---------- события ----------
  new MutationObserver(() => {
    const target = root.classList.contains('dark') ? 1 : 0;
    if (target === tTo) return;
    if (reduced) { t = tFrom = tTo = target; draw(); return; }
    tFrom = t; tTo = target; tStart = performance.now();
    start();
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top;
    ptr.inside = ptr.x >= 0 && ptr.y >= 0 && ptr.x <= r.width && ptr.y <= r.height;
    if (!reduced) {
      par.tx = -(e.clientX / innerWidth - 0.5) * 2 * CFG.parallax[0];
      par.ty = -(e.clientY / innerHeight - 0.5) * 2 * CFG.parallax[1];
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => { ptr.inside = false; });
  document.addEventListener('visibilitychange', start);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }).observe(canvas);

  let resizeTimer = 0, lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const r = canvas.getBoundingClientRect();
      // мобильная адресная строка меняет высоту на чуть-чуть — не пересобираем мир ради этого
      if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 80 && world) return;
      lastW = r.width; lastH = r.height;
      const D = await data;
      if (!D) return;
      if (!(await build(D))) return;
      draw();
      canvas.classList.add('is-ready');
      start();
    }, world ? 200 : 0);
  }).observe(canvas);

  window.__redlineWorld = { cfg: CFG, get t() { return t; }, get world() { return world; } };
})();

