// Живой мир на фоне hero: изометрический воксельный мир на <canvas id="world">.
// Земля рисуется один раз в два слоя (день и ночь). Каждый кадр — только живое: вода, огонь,
// дым костра, овцы и курицы, вагонетка, облака, смена дня и ночи, факел у курсора, параллакс.
// Мир процедурный, но с постоянным зерном — у всех посетителей он один и тот же.
(() => {
  'use strict';
  const canvas = document.getElementById('world');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  const CFG = {
    seed: 20260131,
    clouds: true,         // облака: выключить — false
    dayNightMs: 2400,     // за сколько «проходит день» при смене темы
    torchRadius: 170,     // радиус света факела у курсора, px
    parallax: [12, 7],    // сдвиг мира от мыши, px
  };

  // ---------- случайность и шум ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const step = (e0, e1, x) => smooth(clamp((x - e0) / (e1 - e0), 0, 1));
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
  const fbm = (x, y) => noise(x, y) * 0.6 + noise(x * 2.03 + 17, y * 2.03 + 9) * 0.28 + noise(x * 4.1 + 31, y * 4.1 + 5) * 0.12;
  let rs = 0;
  const rand = () => {
    rs = (rs + 0x6D2B79F5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---------- палитра: день бледный (под светлую тему), ночь почти чёрная с синевой ----------
  const BASE = {
    grass: [128, 178, 98], dirt: [150, 112, 80], stone: [140, 140, 140], sand: [219, 205, 150],
    water: [92, 150, 205], snow: [238, 242, 247], log: [108, 82, 55], logtop: [160, 128, 88],
    leaves: [86, 140, 70], planks: [184, 146, 96], roof: [110, 72, 58], path: [158, 146, 118],
    wheat: [208, 186, 92], cobble: [122, 122, 122], glass: [176, 208, 222], dark: [24, 22, 22],
    ash: [70, 66, 62], fence: [150, 118, 78],
    wool: [236, 236, 232], skin: [214, 196, 178], feather: [246, 246, 244], beak: [235, 170, 60],
    wattle: [200, 40, 40], iron: [125, 125, 132], ironin: [62, 62, 66],
  };
  const MOB = new Set(['wool', 'skin', 'feather', 'beak', 'wattle', 'iron', 'ironin']);
  const DAY = {}, NIGHT = {};
  for (const [k, c] of Object.entries(BASE)) {
    DAY[k] = c.map((v) => Math.round(lerp(v, 246, MOB.has(k) ? 0.12 : 0.46)));
    NIGHT[k] = c.map((v, i) => Math.round(v * 0.17 + [4, 6, 14][i]));
  }
  NIGHT.glass = [255, 140, 64]; // ночью окна горят
  const SHADE = { t: 1, l: 0.86, r: 0.72 };
  const rgb = (c, k = 1, a = 1) => `rgba(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0},${a})`;
  const mix = (name, n) => DAY[name].map((v, i) => lerp(v, NIGHT[name][i], n));
  const SKY = { day: [238, 242, 247], night: [5, 7, 13] };

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
  function box(c, P, x, y, z, dx, dy, dz, top, side, edge, a = 1) {
    quad(c, [P(x, y + dy, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x, y + dy, z)], rgb(side, SHADE.l, a), edge);
    quad(c, [P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x + dx, y, z)], rgb(side, SHADE.r, a), edge);
    quad(c, [P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], rgb(top, SHADE.t, a), edge);
  }

  // ---------- генерация мира ----------
  let W = 0, H = 0, dpr = 1, world = null;

  function build() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    rs = CFG.seed;

    const U = clamp(Math.round(W / 95), 10, 18);
    const M = 30, CW = W + 2 * M, CH = H + 2 * M;
    const ox = CW / 2, oy = CH / 2;
    const P = (x, y, z) => [ox + (x - y) * U, oy + ((x + y) * U) / 2 - z * U];
    const toUV = (x, y) => { const p = P(x + 0.5, y + 0.5, 0); return [((p[0] - M) / W) * 2 - 1, (p[1] - M) / H]; };
    const fromScreen = (sx, sy) => {
      const a = (sx - ox) / U, b = ((sy - oy) * 2) / U;
      return [Math.round((a + b) / 2), Math.round((b - a) / 2)];
    };
    const fromUV = (u, v) => fromScreen(M + ((u + 1) / 2) * W, M + v * H);

    const KEY = (x, y) => (x + 4096) * 8192 + (y + 4096);
    const cells = new Map();
    const cell = (x, y) => cells.get(KEY(x, y));
    const WL = 1, MAXH = 13;

    // Река течёт вдоль оси x: на экране слева-сверху вниз-вправо, в море
    const [rx0, ry0] = fromUV(-1.15, 0.38);
    const riverY = (x) => ry0 + 3 * Math.sin((x - rx0) * 0.13) + 1.6 * Math.sin((x - rx0) * 0.31 + 1.3);

    function terrain(x, y) {
      const [u, v] = toUV(x, y);
      const n = fbm(x * 0.07, y * 0.07);
      const side = step(0.3, 1.0, Math.abs(u));
      let h = 2 + n * 2.2 + Math.pow(side, 1.6) * (2 + n * 7) + step(0.3, 0, v) * n * 4;
      // под заголовком — спокойная равнина
      const calm = (1 - step(0.22, 0.6, Math.abs(u))) * step(0.06, 0.2, v);
      h = lerp(h, 2 + n * 0.9, calm * 0.9);
      const dr = Math.abs(y - riverY(x));
      const inRiver = x > rx0 - 6;
      if (inRiver) h = Math.min(h, WL + 1 + Math.max(0, dr - 2) * 0.9);
      const coast = v - 0.9 + (n - 0.5) * 0.08;
      if (coast > -0.05) h = Math.min(h, lerp(2.4, 0, clamp((coast + 0.05) / 0.07, 0, 1)) + 0.4);
      let hh = Math.max(0, Math.round(h));
      if (inRiver && dr <= 1.25) hh = 0;
      return { h: hh, sandy: coast > -0.035 || (inRiver && dr < 2.4) };
    }

    const aMax = Math.ceil(CW / 2 / U) + 2;
    const bMin = Math.floor((-oy * 2) / U) - 2;
    const bMax = Math.ceil(((CH - oy) * 2) / U + MAXH * 2) + 2;
    for (let b = bMin; b <= bMax; b++) {
      for (let a = -aMax; a <= aMax; a++) {
        if ((a + b) & 1) continue;
        const x = (a + b) / 2, y = (b - a) / 2;
        const t = terrain(x, y);
        cells.set(KEY(x, y), { x, y, h: t.h, sandy: t.sandy, top: null, rail: false });
      }
    }

    // Постройки — отдельные воксели поверх земли
    const vox = new Map();
    const VK = (x, y, z) => KEY(x, y) * 64 + z;
    const setV = (x, y, z, m) => vox.set(VK(x, y, z), { x, y, z, m });
    const delV = (x, y, z) => vox.delete(VK(x, y, z));
    const hasV = (x, y, z) => vox.has(VK(x, y, z));
    const reserved = new Set();
    const flatten = (x0, x1, y0, y1, h, keepWater = true) => {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const c = cell(x, y);
        if (!c) continue;
        if (!(keepWater && c.h <= WL)) c.h = h;
        reserved.add(KEY(x, y));
      }
    };
    const setTop = (x, y, top) => { const c = cell(x, y); if (c && c.h > WL) c.top = top; };

    const torches = [], fences = [], items = [];
    const G = WL + 1;

    function house(x, y, w, d, g) {
      for (let xx = x; xx < x + w; xx++) for (let yy = y; yy < y + d; yy++) setV(xx, yy, g, 'cobble');
      for (let z = g + 1; z <= g + 3; z++) {
        for (let xx = x; xx < x + w; xx++) for (let yy = y; yy < y + d; yy++) {
          const edge = xx === x || xx === x + w - 1 || yy === y || yy === y + d - 1;
          if (!edge) continue;
          const corner = (xx === x || xx === x + w - 1) && (yy === y || yy === y + d - 1);
          setV(xx, yy, z, corner ? 'log' : 'planks');
        }
      }
      const doorX = x + Math.floor(w / 2);
      delV(doorX, y + d - 1, g + 1);
      delV(doorX, y + d - 1, g + 2);
      setV(doorX, y + d - 1, g + 1, 'dark');
      setV(doorX, y + d - 1, g + 2, 'dark');
      for (let xx = x + 1; xx < x + w - 1; xx++) if (xx !== doorX) setV(xx, y + d - 1, g + 2, 'glass');
      for (let yy = y + 1; yy < y + d - 1; yy++) setV(x + w - 1, yy, g + 2, 'glass');
      for (let k = 0; ; k++) {
        const lo = y - 1 + k, hi = y + d - k, z = g + 4 + k;
        if (lo > hi) break;
        for (let xx = x - 1; xx <= x + w; xx++) { setV(xx, lo, z, 'roof'); setV(xx, hi, z, 'roof'); }
        for (const xx of [x, x + w - 1]) for (let yy = lo + 1; yy < hi; yy++) setV(xx, yy, z, 'planks');
      }
      torches.push([doorX + 1, y + d, g]);
      return [doorX, y + d];
    }
    function path(x0, y0, x1, y1, bridgeH) {
      const mark = (x, y) => {
        const c = cell(x, y);
        if (!c) return;
        if (c.h <= WL) { for (let dx = -1; dx <= 1; dx++) setV(x + dx, y, bridgeH - 1, 'planks'); fences.push([x - 1, y, bridgeH], [x + 1, y, bridgeH]); }
        else c.top = 'path';
        reserved.add(KEY(x, y));
      };
      let x = x0, y = y0;
      mark(x, y);
      while (x !== x1) { x += Math.sign(x1 - x); mark(x, y); }
      while (y !== y1) { y += Math.sign(y1 - y); mark(x, y); }
    }

    // Деревня — у реки, слева
    let vx = rx0;
    while (vx < rx0 + 400 && toUV(vx, riverY(vx))[0] < -0.6) vx++;
    const ry = Math.round(riverY(vx));
    const V = [vx + 1, ry + 9];
    flatten(V[0] - 9, V[0] + 6, ry + 2, V[1] + 7, G);
    // поле пшеницы между рекой и домами, с канавкой воды
    for (let x = V[0] - 7; x <= V[0] - 2; x++) for (let y = ry + 2; y <= ry + 5; y++) {
      const c = cell(x, y);
      if (!c || c.h <= WL) continue;
      if (y === ry + 4) c.h = WL; else c.top = 'wheat';
    }
    const doors = [house(V[0] - 7, V[1] - 1, 4, 3, G), house(V[0] + 1, V[1] - 2, 3, 3, G), house(V[0] - 4, V[1] + 3, 4, 3, G)];
    const camp = [V[0] - 1, V[1] + 1];
    items.push({ x: camp[0], y: camp[1], z: G, draw: 'campfire' });
    for (const [dx, dy] of doors) path(camp[0], camp[1] + 1, dx, dy, G);
    path(camp[0] + 1, camp[1], camp[0] + 1, ry - 7, G); // через мост на тот берег
    torches.push([camp[0] + 2, ry + 2, G], [camp[0] + 2, ry - 2, G]);

    // Пастбище с забором — справа внизу
    const Pc = fromUV(0.42, 0.74);
    const pg = clamp(Math.round(terrain(Pc[0], Pc[1]).h), G, 4);
    const PB = [Pc[0] - 5, Pc[0] + 5, Pc[1] - 4, Pc[1] + 4];
    flatten(PB[0] - 1, PB[1] + 1, PB[2] - 1, PB[3] + 1, pg, false);
    for (let x = PB[0]; x <= PB[1]; x++) for (let y = PB[2]; y <= PB[3]; y++) {
      const border = x === PB[0] || x === PB[1] || y === PB[2] || y === PB[3];
      if (border && !(y === PB[3] && x === Pc[0])) fences.push([x, y, pg]);
    }

    // Шахта в холме справа и рельсы к равнине
    const Mn = fromUV(0.8, 0.34);
    const L = 11;
    const hr = clamp(terrain(Mn[0], Mn[1] + L).h, G, 5);
    for (let dx = -3; dx <= 3; dx++) for (let dy = -5; dy <= 0; dy++) {
      const c = cell(Mn[0] + dx, Mn[1] + dy);
      if (c) c.h = Math.max(c.h, hr + 4 + Math.round(fbm(dx, dy) * 2));
    }
    flatten(Mn[0] - 1, Mn[0] + 1, Mn[1] + 1, Mn[1] + L + 1, hr, false);
    const rails = [];
    for (let i = 1; i <= L; i++) { const c = cell(Mn[0], Mn[1] + i); if (c) { c.rail = true; c.top = 'path'; rails.push(c); } }
    setV(Mn[0] - 1, Mn[1] + 1, hr, 'log'); setV(Mn[0] - 1, Mn[1] + 1, hr + 1, 'log');
    setV(Mn[0] + 1, Mn[1] + 1, hr, 'log'); setV(Mn[0] + 1, Mn[1] + 1, hr + 1, 'log');
    for (let dx = -1; dx <= 1; dx++) setV(Mn[0] + dx, Mn[1] + 1, hr + 2, 'planks');
    const mineCell = cell(Mn[0], Mn[1]);
    if (mineCell) { mineCell.h = hr; setV(Mn[0], Mn[1], hr, 'dark'); setV(Mn[0], Mn[1], hr + 1, 'dark'); setV(Mn[0], Mn[1], hr + 2, 'stone'); }
    torches.push([Mn[0] - 2, Mn[1] + 2, hr], [Mn[0] + 2, Mn[1] + 2, hr]);

    // Материалы земли
    for (const c of cells.values()) {
      if (c.h <= WL) { c.h = WL; c.top = 'water'; continue; }
      if (c.top) continue;
      if (c.h >= 10) c.top = 'snow';
      else if (c.h >= 8) c.top = hash(c.x, c.y) > 0.45 ? 'stone' : 'grass';
      else if (c.h === G && c.sandy) c.top = 'sand';
      else c.top = 'grass';
    }

    // Деревья: лес по краям, редкие деревья на равнине, в центре — пусто
    const taken = new Set();
    for (const c of cells.values()) {
      if (c.top !== 'grass' || reserved.has(KEY(c.x, c.y)) || c.h > 8) continue;
      const [u, v] = toUV(c.x, c.y);
      if (v > 0.95 || v < -0.05) continue;
      const forest = fbm(c.x * 0.11 + 50, c.y * 0.11 + 50);
      let p = forest > 0.58 ? 0.09 : 0.006;
      p *= step(0.18, 0.45, Math.abs(u)) * 0.95 + 0.05;
      if (hash(c.x * 3 + 7, c.y * 5 + 1) > p) continue;
      let near = false;
      for (let dx = -2; dx <= 2 && !near; dx++) for (let dy = -2; dy <= 2; dy++) if (taken.has(KEY(c.x + dx, c.y + dy))) { near = true; break; }
      if (near) continue;
      taken.add(KEY(c.x, c.y));
      const t = 3 + Math.floor(rand() * 3), z = c.h, big = rand() > 0.35;
      for (let k = 0; k < t; k++) setV(c.x, c.y, z + k, 'log');
      const top = z + t, R = big ? 2 : 1;
      for (const [dz, rad] of [[-1, R], [0, R], [1, 1]]) {
        for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;
          if (dx === 0 && dy === 0 && dz < 1) continue;
          if (!hasV(c.x + dx, c.y + dy, top + dz)) setV(c.x + dx, c.y + dy, top + dz, 'leaves');
        }
      }
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) setV(c.x + dx, c.y + dy, top + 2, 'leaves');
    }

    for (const [x, y, z] of torches) items.push({ x, y, z, draw: 'torch' });
    for (const [x, y, z] of fences) items.push({ x, y, z, draw: 'fence' });
    const fenceSet = new Set(fences.map(([x, y]) => KEY(x, y)));

    // ---------- отрисовка земли в слой ----------
    const sideMat = (c, z) => {
      if (c.top === 'water') return 'water';
      if (c.top === 'sand') return 'sand';
      if (c.top === 'snow' || c.top === 'stone') return 'stone';
      return z >= c.h - 3 ? 'dirt' : 'stone';
    };
    const vTop = { log: 'logtop' };
    const order = [];
    for (const c of cells.values()) order.push({ k: c.x + c.y, z: -1, c });
    for (const v of vox.values()) order.push({ k: v.x + v.y, z: v.z, v });
    for (const it of items) order.push({ k: it.x + it.y, z: it.z + 0.5, it });
    order.sort((a, b) => a.k - b.k || a.z - b.z);

    const emissive = [], water = [];
    function render(night) {
      const pal = night ? NIGHT : DAY;
      const edge = night ? 'rgba(255,255,255,0.045)' : 'rgba(40,40,40,0.10)';
      const cv = document.createElement('canvas');
      cv.width = Math.round(CW * dpr);
      cv.height = Math.round(CH * dpr);
      const c = cv.getContext('2d');
      c.scale(dpr, dpr);
      c.lineWidth = 1;
      c.lineJoin = 'round';
      const hAt = (x, y) => { const n = cell(x, y); return n ? n.h : 0; };
      for (const o of order) {
        if (o.c) {
          const { x, y, h } = o.c;
          const hl = Math.min(h, hAt(x, y + 1)), hr2 = Math.min(h, hAt(x + 1, y));
          for (let z = hl; z < h; z++) quad(c, [P(x, y + 1, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z), P(x, y + 1, z)], rgb(pal[sideMat(o.c, z)], SHADE.l), edge);
          for (let z = hr2; z < h; z++) quad(c, [P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z), P(x + 1, y, z)], rgb(pal[sideMat(o.c, z)], SHADE.r), edge);
          const isWater = o.c.top === 'water';
          quad(c, [P(x, y, h), P(x + 1, y, h), P(x + 1, y + 1, h), P(x, y + 1, h)], rgb(pal[o.c.top], SHADE.t), isWater ? null : edge);
          if (!night && isWater) water.push([...P(x + 0.5, y + 0.5, h), hash(x, y)]);
          if (o.c.rail) {
            c.strokeStyle = rgb(pal.log, 0.8); c.lineWidth = 2;
            for (const s of [0.17, 0.5, 0.83]) { const a = P(x + 0.15, y + s, h), b = P(x + 0.85, y + s, h); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
            c.strokeStyle = rgb(pal.iron, 1.1); c.lineWidth = 1.2;
            for (const s of [0.3, 0.7]) { const a = P(x + s, y, h), b = P(x + s, y + 1, h); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
            c.lineWidth = 1;
          }
        } else if (o.v) {
          const { x, y, z, m } = o.v;
          const occ = (xx, yy, zz) => hasV(xx, yy, zz) || hAt(xx, yy) > zz;
          const side = pal[m], top = pal[vTop[m] || m];
          const e = m === 'glass' && night ? null : edge;
          if (!occ(x, y + 1, z)) quad(c, [P(x, y + 1, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z), P(x, y + 1, z)], rgb(side, m === 'glass' && night ? 1 : SHADE.l), e);
          if (!occ(x + 1, y, z)) quad(c, [P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z), P(x + 1, y, z)], rgb(side, m === 'glass' && night ? 0.9 : SHADE.r), e);
          if (!hasV(x, y, z + 1)) quad(c, [P(x, y, z + 1), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], rgb(top, SHADE.t), edge);
          if (night && m === 'glass') {
            if (!occ(x, y + 1, z)) emissive.push([...P(x + 0.5, y + 1, z + 0.5), 'win']);
            else if (!occ(x + 1, y, z)) emissive.push([...P(x + 1, y + 0.5, z + 0.5), 'win']);
          }
        } else {
          const { x, y, z, draw } = o.it;
          if (draw === 'torch') {
            box(c, P, x + 0.44, y + 0.44, z, 0.12, 0.12, 0.62, pal.log, pal.log, null);
          } else if (draw === 'campfire') {
            box(c, P, x + 0.1, y + 0.1, z, 0.8, 0.8, 0.1, pal.ash, pal.ash, edge);
            box(c, P, x + 0.15, y + 0.38, z + 0.1, 0.7, 0.24, 0.2, pal.logtop, pal.log, edge);
            box(c, P, x + 0.38, y + 0.15, z + 0.3, 0.24, 0.7, 0.2, pal.logtop, pal.log, edge);
          } else if (draw === 'fence') {
            box(c, P, x + 0.4, y + 0.4, z, 0.2, 0.2, 0.8, pal.fence, pal.fence, edge);
            if (fenceSet.has(KEY(x + 1, y))) for (const zz of [0.3, 0.58]) box(c, P, x + 0.6, y + 0.45, z + zz, 0.8, 0.1, 0.12, pal.fence, pal.fence, null);
            if (fenceSet.has(KEY(x, y + 1))) for (const zz of [0.3, 0.58]) box(c, P, x + 0.45, y + 0.6, z + zz, 0.1, 0.8, 0.12, pal.fence, pal.fence, null);
          }
        }
      }
      // дымка у горизонта: верх кадра растворяется в небе
      const sky = night ? SKY.night : SKY.day;
      const g = c.createLinearGradient(0, 0, 0, M + H * 0.28);
      g.addColorStop(0, rgb(sky, 1, 1));
      g.addColorStop(1, rgb(sky, 1, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, CW, M + H * 0.28);
      return cv;
    }

    const day = render(false);
    const night = render(true);

    // ---------- живность ----------
    const mobs = [];
    for (let i = 0; i < 4; i++) {
      mobs.push({ kind: 'sheep', x: lerp(PB[0] + 1.5, PB[1] - 1.5, rand()), y: lerp(PB[2] + 1.5, PB[3] - 1.5, rand()), g: pg,
        bounds: [PB[0] + 1, PB[1] - 1, PB[2] + 1, PB[3] - 1], speed: 0.55, face: i % 4, state: 'idle', timer: rand() * 3, phase: rand() * 6 });
    }
    for (let i = 0; i < 3; i++) {
      mobs.push({ kind: 'chicken', x: camp[0] + (rand() - 0.5) * 6, y: camp[1] + 2 + rand() * 2, g: G,
        bounds: [camp[0] - 4, camp[0] + 3, camp[1] + 1, camp[1] + 3], speed: 0.9, face: i % 4, state: 'idle', timer: rand() * 2, phase: rand() * 6 });
    }
    const cart = rails.length > 2 ? { x: Mn[0] + 0.5, y0: Mn[1] + 1.6, y1: Mn[1] + L + 0.4, z: hr, p: 0, dir: 1, wait: 1 } : null;

    const clouds = [];
    if (CFG.clouds) {
      for (let i = 0; i < 6; i++) {
        const shape = [];
        const w = 3 + Math.floor(rand() * 5), d = 2 + Math.floor(rand() * 3);
        for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) if (rand() > 0.12) shape.push([x, y]);
        for (let k = 0; k < 3; k++) shape.push([Math.floor(rand() * w), d]);
        const [cx, cy] = fromScreen(rand() * CW, rand() * CH * 0.7 + 18 * U);
        clouds.push({ x: cx, y: cy, shape: shape.sort((a, b) => a[0] + a[1] - b[0] - b[1]) });
      }
    }

    const stars = Array.from({ length: 60 }, () => [rand() * W, rand() * H * 0.22, rand() * 6, 0.6 + rand() * 1.2]);

    world = { U, M, CW, CH, P, fromScreen, day, night, emissive, water, mobs, cart, clouds, stars,
      torches: torches.map(([x, y, z]) => P(x + 0.5, y + 0.5, z + 0.78)),
      camp: P(camp[0] + 0.5, camp[1] + 0.5, G + 0.35), smoke: [], smokeT: 0 };
  }

  // ---------- состояние ----------
  let t = root.classList.contains('dark') ? 1 : 0;           // 0 — день, 1 — ночь
  let tFrom = t, tTo = t, tStart = 0;
  let time = 0, last = 0, raf = 0, visible = true;
  let ptr = { x: 0, y: 0, inside: false }, par = { x: 0, y: 0, tx: 0, ty: 0 };
  const light = finePointer ? document.createElement('canvas') : null;

  function updateMob(m, dt) {
    m.timer -= dt;
    if (m.state === 'idle') {
      if (m.timer <= 0) {
        const [x0, x1, y0, y1] = m.bounds;
        m.tx = Math.floor(lerp(x0, x1 + 1, Math.random())) + 0.5;
        m.ty = Math.floor(lerp(y0, y1 + 1, Math.random())) + 0.5;
        m.state = 'walk';
        m.graze = false;
      }
    } else {
      const dx = m.tx - m.x, dy = m.ty - m.y, s = m.speed * dt;
      if (Math.abs(dx) > 0.02) { m.face = dx > 0 ? 0 : 1; m.x += Math.sign(dx) * Math.min(Math.abs(dx), s); }
      else if (Math.abs(dy) > 0.02) { m.face = dy > 0 ? 2 : 3; m.y += Math.sign(dy) * Math.min(Math.abs(dy), s); }
      else { m.state = 'idle'; m.timer = 1.5 + Math.random() * 4; m.graze = m.kind === 'sheep' && Math.random() < 0.5; }
    }
  }

  function drawMob(c, P, m, n) {
    const alongX = m.face < 2, dir = m.face === 0 || m.face === 2 ? 1 : -1;
    const bob = m.state === 'walk' ? Math.abs(Math.sin(time * (m.kind === 'chicken' ? 14 : 8) + m.phase)) * 0.05 : 0;
    const z = m.g + bob;
    const sheep = m.kind === 'sheep';
    const len = sheep ? 0.8 : 0.34, wid = sheep ? 0.5 : 0.26, hgt = sheep ? 0.42 : 0.24, leg = sheep ? 0.28 : 0.12;
    const bx = m.x - (alongX ? len : wid) / 2, by = m.y - (alongX ? wid : len) / 2;
    const bw = alongX ? len : wid, bd = alongX ? wid : len;
    const body = mix(sheep ? 'wool' : 'feather', n), skin = mix(sheep ? 'skin' : 'beak', n);
    const legs = [[0.08, 0.08], [bw - 0.2, 0.08], [0.08, bd - 0.2], [bw - 0.2, bd - 0.2]];
    for (const [lx, ly] of legs) box(c, P, bx + lx, by + ly, m.g, 0.12, 0.12, leg, skin, skin, null);
    const hs = sheep ? 0.32 : 0.16;
    const hx = m.x + (alongX ? dir * (len / 2 + hs * 0.35) : 0) - hs / 2;
    const hy = m.y + (alongX ? 0 : dir * (len / 2 + hs * 0.35)) - hs / 2;
    const hz = z + (sheep ? (m.graze ? 0.12 : leg + hgt - 0.1) : leg + hgt - 0.02);
    const head = () => {
      box(c, P, hx, hy, hz, hs, hs, sheep ? hs : hs * 1.2, sheep ? skin : body, sheep ? skin : body, null);
      if (!sheep) {
        const bxk = hx + (alongX ? (dir > 0 ? hs : -0.06) : hs / 2 - 0.03), byk = hy + (alongX ? hs / 2 - 0.03 : (dir > 0 ? hs : -0.06));
        box(c, P, bxk, byk, hz + 0.06, 0.06, 0.06, 0.05, skin, skin, null);
        box(c, P, bxk, byk, hz - 0.02, 0.05, 0.05, 0.06, mix('wattle', n), mix('wattle', n), null);
      }
    };
    if (dir < 0) head();
    box(c, P, bx, by, z + leg, bw, bd, hgt, body, body, 'rgba(0,0,0,0.12)');
    if (dir > 0) head();
  }

  function drawCart(c, P, k, n) {
    const y = lerp(k.y0, k.y1, smooth(k.p));
    const iron = mix('iron', n), dark = mix('ironin', n);
    box(c, P, k.x - 0.33, y - 0.43, k.z + 0.08, 0.66, 0.86, 0.42, iron, iron, 'rgba(0,0,0,0.25)');
    quad(c, [P(k.x - 0.25, y - 0.35, k.z + 0.5), P(k.x + 0.25, y - 0.35, k.z + 0.5), P(k.x + 0.25, y + 0.35, k.z + 0.5), P(k.x - 0.25, y + 0.35, k.z + 0.5)], rgb(dark), null);
  }

  function glow(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function draw() {
    const w = world;
    if (!w) return;
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
    const nightAt = (sx, sy) => {
      if (!torchOn) return t;
      const d = Math.hypot(sx + ox - ptr.x, sy + oy - ptr.y);
      return t * (1 - clamp(1 - d / R, 0, 1) * 0.85);
    };

    ctx.save();
    ctx.translate(ox, oy);
    const P = w.P;

    // блики на воде
    const wl = t < 0.5 ? '255,255,255' : '170,190,240';
    const wa = lerp(0.55, 0.22, t);
    ctx.lineWidth = 1.5;
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

    // огонь: костёр и факелы
    const fire = (x, y, s, i) => {
      const f = 0.7 + noise(time * 7 + i * 13, i) * 0.6;
      ctx.fillStyle = `rgba(255,140,40,${0.9})`;
      ctx.fillRect(x - s / 2, y - s * 1.4 * f, s, s * 1.4 * f);
      ctx.fillStyle = 'rgba(255,225,120,0.95)';
      ctx.fillRect(x - s / 4, y - s * 0.9 * f, s / 2, s * 0.9 * f);
    };
    const cs = w.U * 0.16;
    for (let i = 0; i < 3; i++) fire(w.camp[0] + (i - 1) * cs * 1.1, w.camp[1], cs, i);
    w.torches.forEach(([x, y], i) => fire(x, y, Math.max(2, w.U * 0.12), i + 10));

    // мобы и вагонетка — по глубине
    const actors = w.mobs.map((m) => ({ k: m.x + m.y, f: () => drawMob(ctx, P, m, nightAt(...P(m.x, m.y, m.g))) }));
    if (w.cart) { const y = lerp(w.cart.y0, w.cart.y1, smooth(w.cart.p)); actors.push({ k: w.cart.x + y, f: () => drawCart(ctx, P, w.cart, nightAt(...P(w.cart.x, y, w.cart.z))) }); }
    actors.sort((a, b) => a.k - b.k).forEach((a) => a.f());

    // дым костра: серые квадраты поднимаются высоко и тают, как в Minecraft
    const sc = lerp(150, 70, t);
    for (const p of w.smoke) {
      const k = p.age / p.life;
      ctx.fillStyle = `rgba(${sc},${sc},${sc + 6},${(1 - k) * (k < 0.08 ? k / 0.08 : 1) * 0.5})`;
      const s = p.size * (1 + k * 1.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    // ночные огни: окна, факелы, костёр
    if (t > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const a = smooth(clamp((t - 0.35) / 0.65, 0, 1));
      for (const [x, y] of w.emissive) glow(ctx, x, y, w.U * 2.2, '255,140,60', 0.22 * a);
      w.torches.forEach(([x, y], i) => glow(ctx, x, y - 2, w.U * (3 + noise(time * 5, i) * 0.6), '255,150,60', 0.28 * a));
      glow(ctx, w.camp[0], w.camp[1] - w.U * 0.2, w.U * (6 + noise(time * 4, 99) * 1.2), '255,130,50', 0.32 * a);
      ctx.globalCompositeOperation = 'source-over';
    }

    // облака — выше всего и с более сильным параллаксом
    if (w.clouds.length) {
      ctx.translate(par.x * 1.5, par.y * 1.5);
      const top = mix('wool', t * 0.9), alpha = lerp(0.5, 0.18, t);
      for (const cl of w.clouds) for (const [dx, dy] of cl.shape) box(ctx, P, cl.x + dx, cl.y + dy, 16, 1, 1, 0.6, top, top, null, alpha);
    }
    ctx.restore();

    // небо: квадратные солнце и луна, звёзды
    const sunA = 1 - smooth(clamp(t / 0.6, 0, 1));
    if (sunA > 0.01) {
      const p = clamp(t / 0.6, 0, 1);
      const sx = W * (0.8 + 0.14 * p), sy = H * (0.11 + 0.16 * p), s = Math.max(22, W * 0.022);
      glow(ctx, sx, sy, s * 3, '255,230,160', 0.45 * sunA);
      ctx.fillStyle = `rgba(255,238,170,${sunA})`;
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      ctx.fillStyle = `rgba(255,250,215,${sunA})`;
      ctx.fillRect(sx - s / 4, sy - s / 4, s / 2, s / 2);
    }
    const moonA = smooth(clamp((t - 0.4) / 0.6, 0, 1));
    if (moonA > 0.01) {
      const q = clamp((t - 0.4) / 0.6, 0, 1);
      const mx = W * (0.07 + 0.08 * q), my = H * (0.26 - 0.14 * q), s = Math.max(18, W * 0.018);
      for (const [x, y, ph, sz] of world.stars) {
        ctx.fillStyle = `rgba(230,235,255,${moonA * (0.35 + 0.35 * Math.sin(time * 1.7 + ph))})`;
        ctx.fillRect(x, y, sz, sz);
      }
      glow(ctx, mx, my, s * 3, '190,205,255', 0.25 * moonA);
      ctx.fillStyle = `rgba(222,226,236,${moonA})`;
      ctx.fillRect(mx - s / 2, my - s / 2, s, s);
      ctx.fillStyle = `rgba(170,176,192,${moonA})`;
      ctx.fillRect(mx - s * 0.3, my - s * 0.25, s * 0.22, s * 0.22);
      ctx.fillRect(mx + s * 0.08, my + s * 0.05, s * 0.28, s * 0.22);
    }
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
    for (const m of w.mobs) updateMob(m, dt);
    if (w.cart) {
      const k = w.cart;
      if (k.wait > 0) k.wait -= dt;
      else {
        k.p += k.dir * dt / 7;
        if (k.p >= 1 || k.p <= 0) { k.p = clamp(k.p, 0, 1); k.dir *= -1; k.wait = 2.5; }
      }
    }
    w.smokeT -= dt;
    if (w.smokeT <= 0 && w.smoke.length < 70) {
      w.smokeT = 0.14;
      w.smoke.push({ x: w.camp[0] + (Math.random() - 0.5) * w.U * 0.3, y: w.camp[1] - w.U * 0.4, vy: -(20 + Math.random() * 10),
        age: 0, life: 6 + Math.random() * 2, size: 3 + Math.random() * 3, ph: Math.random() * 6 });
    }
    for (const p of w.smoke) { p.age += dt; p.y += p.vy * dt; p.x += Math.sin(p.age * 1.2 + p.ph) * 5 * dt + 3 * dt; }
    w.smoke = w.smoke.filter((p) => p.age < p.life);
    for (const cl of w.clouds) {
      cl.x += dt * 0.35;
      const [sx, sy] = w.P(cl.x, cl.y, 16);
      if (sx > w.CW + 160 || sy > w.CH + 120) {
        const fromLeft = Math.random() < 0.5;
        [cl.x, cl.y] = w.fromScreen(fromLeft ? -140 : Math.random() * w.CW, (fromLeft ? Math.random() * w.CH * 0.6 : -60) + 16 * w.U);
      }
    }
  }

  function frame(now) {
    raf = 0;
    if (!visible || document.hidden || !world) return;
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
    resizeTimer = setTimeout(() => {
      const r = canvas.getBoundingClientRect();
      // мобильная адресная строка меняет высоту на чуть-чуть — не пересобираем мир ради этого
      if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 80 && world) return;
      lastW = r.width; lastH = r.height;
      build();
      draw();
      canvas.classList.add('is-ready');
      start();
    }, world ? 200 : 0);
  }).observe(canvas);

  window.__redlineWorld = { cfg: CFG, get t() { return t; }, get world() { return world; } };
})();
