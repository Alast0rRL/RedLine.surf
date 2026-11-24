// Живой мир на фоне hero: изометрический остров на <canvas id="world">.
// Остров собирается кодом: два статичных слоя (день/ночь), кадр — только живое.
// Вода, огонь, дым, мобы, облака, смена темы, факел и параллакс — поверх.
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
    clouds: false,         // облака
    dayNightMs: 2400,      // длина смены темы
    torchRadius: 170,      // свет факела, px
    parallax: [12, 7],     // сдвиг мира от мыши, px
    zBase: 2,              // центр по высоте
    centerDesktop: [0.72, 0.56],
    centerMobile: [0.5, 0.80],
    bob: 5,                // покачивание, px
    bobMs: 7000,
    cliffMin: 8, cliffMax: 11,
    riverWidth: 4,
    trees: 8,
    treeClear: 3,          // минимальная дистанция ели от реки
    treeSpacing: 4,        // зазор между стволами
    treeFront: 5,          // чистые передние ряды
    treeTrunk: [2, 3],
    mobScale: 2.2,
    cloudCell: 4,
    cloudZ: 18,
    miniIslands: [[0.82, 0.47, 0.46], [0.92, 0.44, 0.38]],
    colors: {
      grass: [88, 148, 58], grass2: [102, 162, 66], grass3: [76, 134, 52], grassDark: [52, 102, 46],
      dirt: [132, 92, 58], orange: [196, 104, 48], path: [158, 126, 84],
      stone: [194, 178, 150], stone2: [138, 142, 144], andesite: [96, 102, 110], diorite: [222, 218, 204],
      moss: [72, 126, 58], log: [92, 64, 42], leaf1: [34, 88, 52], leaf2: [44, 106, 58], leaf3: [22, 66, 40],
      water: [24, 68, 126], glowDay: [255, 206, 146], glowNight: [92, 126, 196],
    },
  };

  // ---------- утилиты ----------
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
  const rgb = (c, k = 1, a = 1) => `rgba(${clamp(Math.round(c[0] * k), 0, 255)},${clamp(Math.round(c[1] * k), 0, 255)},${clamp(Math.round(c[2] * k), 0, 255)},${a})`;
  const nightOf = (c) => c.map((v, i) => Math.round(v * 0.2 + [3, 6, 14][i]));
  const mix = (a, b, n) => a.map((v, i) => lerp(v, b[i], n));

  function quad(c, p, fill) {
    c.beginPath();
    c.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }
  function box(c, P, x, y, z, dx, dy, dz, top, side, a = 1) {
    quad(c, [P(x, y + dy, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x, y + dy, z)], rgb(side, 0.64, a));
    quad(c, [P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x + dx, y + dy, z), P(x + dx, y, z)], rgb(side, 0.82, a));
    quad(c, [P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], rgb(top, 1, a));
  }

  // ---------- материалы и кэш цветов ----------
  const MAT = { GRASS: 1, DIRT: 2, ORANGE: 3, PATH: 4, STONE: 5, STONE2: 6, ANDESITE: 7, DIORITE: 8, MOSS: 9, LOG: 10, LEAF1: 11, LEAF2: 12, LEAF3: 13, WATER: 14 };
  const CC = CFG.colors;
  const BASE = {
    [MAT.GRASS]: { top: [CC.grass, CC.grass2, CC.grass3], side: CC.dirt, fringe: CC.grassDark },
    [MAT.DIRT]: { side: CC.dirt }, [MAT.ORANGE]: { side: CC.orange }, [MAT.PATH]: { side: CC.path },
    [MAT.STONE]: { side: CC.stone }, [MAT.STONE2]: { side: CC.stone2 },
    [MAT.ANDESITE]: { side: CC.andesite }, [MAT.DIORITE]: { side: CC.diorite },
    [MAT.MOSS]: { top: [CC.moss, CC.grassDark], side: CC.stone },
    [MAT.LOG]: { side: CC.log }, [MAT.LEAF1]: { side: CC.leaf1 }, [MAT.LEAF2]: { side: CC.leaf2 }, [MAT.LEAF3]: { side: CC.leaf3 },
    [MAT.WATER]: { side: CC.water },
  };
  const SHADE = [1, 0.82, 0.64]; // верх, право, лево
  const caches = [new Map(), new Map()];
  function faceColor(mode, mat, face, variant, bucket, row) {
    const cache = caches[mode];
    const key = `${mat}:${face}:${variant}:${bucket}:${row}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const b = BASE[mat];
    let c = face === 0 ? (b.top ? b.top[variant % b.top.length] : b.side) : (face && row === 0 && b.fringe ? b.fringe : b.side);
    if (mat !== MAT.WATER && bucket <= -3) {
      if (mat === MAT.LEAF1 || mat === MAT.LEAF2 || mat === MAT.LEAF3) c = [30, 60, 38];
      else if (mat === MAT.STONE || mat === MAT.STONE2 || mat === MAT.DIORITE) c = c.map((v) => v * 0.82);
    }
    const k = SHADE[face] * (1 + bucket * 0.023) * (face ? 1 - row * 0.045 : 1);
    const col = mode ? c.map((v, i) => v * 0.2 + [3, 6, 14][i]) : c;
    const s = rgb(col, k);
    cache.set(key, s);
    return s;
  }

  // ---------- мир ----------
  let W = 0, H = 0, dpr = 1, world = null;
  const NX = 26, NY = 22, CX = (NX - 1) / 2, CY = (NY - 1) / 2;
  const ix = (x, y) => y * NX + x;
  const gkey = (x, y, z) => ((x * 64 + y) * 64) + (z + 24);
  let buildId = 0, building = false;
  const yieldNow = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });

  async function build() {
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
      return id === buildId;
    };

    const U = W >= 1024 ? clamp(W / 80, 10, 20) : clamp(W / 48, 6, 12);
    const center = W >= 1024 ? CFG.centerDesktop : CFG.centerMobile;
    const M = 90, CW = W + 2 * M, CH = H + 2 * M;
    const ox = center[0] * W + M, oy = center[1] * H + M;
    const P = (x, y, z) => [ox + (x - y) * U, oy + ((x + y) * U) / 2 - z * U];
    const V = (x, y, z) => P(x - CX, y - CY, z - CFG.zBase);
    const fromScreen = (sx, sy) => {
      const a = (sx - ox) / U, b = 2 * (sy - oy) / U;
      return [(a + b) / 2, (b - a) / 2];
    };

    const n = NX * NY;
    const inside = new Uint8Array(n), river = new Uint8Array(n), coarse = new Uint8Array(n), path = new Uint8Array(n);
    const ground = new Int8Array(n), surface = new Int8Array(n), bottom = new Int8Array(n), waterTop = new Int8Array(n);
    const vox = new Map(), cols = Array.from({ length: n }, () => []);
    const put = (x, y, z, m) => {
      if (x < 0 || y < 0 || x >= NX || y >= NY) return;
      const i = ix(x, y), v = { x, y, z, m };
      vox.set(gkey(x, y, z), v);
      cols[i].push(v);
    };
    const get = (x, y, z) => vox.get(gkey(x, y, z));
    const opaque = (v) => v && v.m !== MAT.WATER;
    const hides = (v, q) => q && (opaque(q) || (v.m === MAT.WATER && q.m === MAT.WATER));
    const stoneMat = (z, b, x, y) => {
      const band = Math.floor((z - b) / 2) & 1;
      if (hash(x * 3 + z, y * 7 - z) > 0.94) return MAT.DIORITE;
      if (hash(x * 5 - z, y * 3 + z) > 0.92) return MAT.ANDESITE;
      return band ? MAT.STONE2 : MAT.STONE;
    };
    const riverAt = (t) => 0.8 + Math.sin(t * Math.PI * 2.1 + 0.5) * 1.1 + (noise(t * 5, 3) - 0.5) * 0.7;

    // ---------- рельеф: овал с шумом, река по диагонали, террасы ----------
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = ix(x, y), t = (x + y) / (NX + NY - 2), d = x - y;
      const rc = riverAt(t), rw = CFG.riverWidth / 2 + noise(x * 0.22, y * 0.22) * 0.35;
      const riv = Math.abs(d - rc) < rw;
      const nx = (x + 0.5 - NX / 2) / (NX / 2), ny = (y + 0.5 - NY / 2) / (NY / 2);
      const rr = Math.hypot(nx * 0.98, ny * 1.02) + (noise(x * 0.32 + 2, y * 0.32 + 5) - 0.5) * 0.2;
      const ok = rr < 1.0 || (riv && t > 0.74 && rr < 1.15);
      inside[i] = ok ? 1 : 0;
      if (!ok) continue;
      river[i] = riv ? 1 : 0;
      const terr = t < 0.30 ? 2 : t < 0.62 ? 1 : 0;
      ground[i] = riv ? terr - 2 : terr;
      waterTop[i] = terr - 1;
      surface[i] = ground[i];
      const side = Math.abs(d - rc);
      if (!riv && t > 0.18 && t < 0.56 && side > 3) {
        const along = clamp((t - 0.18) / 0.1, 0, 1) * clamp((0.56 - t) / 0.16, 0, 1);
        const wall = clamp((side - 3) / 1.4, 0, 1);
        const rise = Math.round(along * wall * lerp(CFG.cliffMin, CFG.cliffMax, noise(x * 0.4 + 8, y * 0.4)));
        if (rise >= 3) surface[i] = terr + rise;
      }
      if (!riv && surface[i] === terr) {
        const p1 = t > 0.22 && noise(x * 0.34 + 13, y * 0.34 + 2) > 0.68;
        const p2 = ((x - 8) ** 2 / 14 + (y - 15) ** 2 / 10 < 1) || ((x - 18) ** 2 / 12 + (y - 16) ** 2 / 9 < 1);
        coarse[i] = p1 || p2 ? 1 : 0;
        path[i] = !coarse[i] && Math.abs(Math.abs(d - rc) - 3.4) < 0.6 && noise(x * 0.7, y * 0.7) > 0.42 ? 1 : 0;
      }
      const u = clamp(rr, 0, 1);
      const under = clamp(Math.round(4 * (1 - u) * (1 - u * 0.25) + (noise(x * 0.5 + 9, y * 0.5 + 1) - 0.5) * 1.2), 0, 4);
      bottom[i] = ground[i] - 2 - under - (under < 4 && hash(x * 11, y * 13) > 0.9 ? 1 : 0);
    }

    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = ix(x, y);
      if (!inside[i]) continue;
      const g = ground[i], b = bottom[i], top = surface[i];
      for (let z = b; z < g; z++) {
        let m;
        if (z === g - 1) m = river[i] ? MAT.DIRT : coarse[i] ? MAT.ORANGE : path[i] ? MAT.PATH : MAT.GRASS;
        else if (z >= g - 2) m = coarse[i] ? MAT.ORANGE : MAT.DIRT;
        else m = stoneMat(z, b, x, y);
        put(x, y, z, m);
      }
      for (let z = g; z < top; z++) {
        const cap = z === top - 1 && (top > g ? hash(x, y) > 0.35 : hash(x, y) > 0.8);
        put(x, y, z, cap ? MAT.MOSS : stoneMat(z, g, x, y));
      }
      if (river[i]) put(x, y, waterTop[i] - 1, MAT.WATER);
    }

    // ---------- ёлки ----------
    const blocked = new Set(), trees = [];
    const treeOK = (x, y) => {
      if (x < 1 || y < 1 || x >= NX - 1 || y >= NY - 1 || !inside[ix(x, y)] || river[ix(x, y)]) return false;
      const i = ix(x, y), t = (x + y) / (NX + NY - 2), d = x - y;
      if (blocked.has(i) || Math.abs(d - riverAt(t)) < CFG.treeClear) return false;
      if (trees.some((tr) => Math.hypot(tr.x - x, tr.y - y) < CFG.treeSpacing)) return false;
      const front = x + y > NX + NY - 2 - CFG.treeFront;
      if (front && (Math.abs(d - riverAt(t)) < 8 || trees.some((tr) => tr.front))) return false;
      return surface[i] > ground[i] || t < 0.52 || Math.abs(d) > 7;
    };
    const leafCell = (rad, dx, dy) => {
      const m = Math.abs(dx) + Math.abs(dy);
      return m <= rad && !(rad === 2 && Math.abs(dx) === 1 && Math.abs(dy) === 1);
    };
    const plant = (x, y) => {
      const i = ix(x, y), z = surface[i], h = Math.round(lerp(CFG.treeTrunk[0], CFG.treeTrunk[1], rand()));
      for (let k = 0; k < h; k++) put(x, y, z + k, MAT.LOG);
      const tiers = rand() > 0.45 ? [2, 1, 2, 1, 1, 0, 0] : [2, 1, 1, 1, 0, 0];
      for (let q = 0; q < tiers.length; q++) {
        const rad = tiers[q], zz = z + h + q;
        for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
          if (!leafCell(rad, dx, dy)) continue;
          const r = hash(x + dx + q * 7, y + dy - q * 3);
          put(x + dx, y + dy, zz, r > 0.92 ? MAT.LEAF3 : r > 0.46 ? MAT.LEAF2 : MAT.LEAF1);
        }
      }
      trees.push({ x, y, z, front: x + y > NX + NY - 2 - CFG.treeFront });
      blocked.add(i);
    };
    const spots = [[4, 3], [7, 2], [3, 7], [21, 3], [23, 6], [19, 2], [2, 12], [24, 11], [3, 16], [24, 15], [5, 5], [20, 5]];
    for (const [x, y] of spots) if (trees.length < CFG.trees && treeOK(x, y)) plant(x, y);
    const extra = [];
    for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) if (treeOK(x, y)) extra.push([x, y]);
    extra.sort((a, b) => a[0] + a[1] - b[0] - b[1] || Math.abs(b[0] - b[1]) - Math.abs(a[0] - a[1]));
    for (const [x, y] of extra) if (trees.length < CFG.trees && treeOK(x, y)) plant(x, y);

    // ---------- столбцы для occlusion ----------
    const ranges = Array.from({ length: n }, () => []);
    for (const v of vox.values()) ranges[ix(v.x, v.y)].push(v.z);
    for (const list of ranges) {
      list.sort((a, b) => a - b);
      if (!list.length) continue;
      const out = []; let a = list[0], b = a + 1;
      for (let k = 1; k < list.length; k++) {
        if (list[k] === b) b++;
        else { out.push([a, b]); a = list[k]; b = a + 1; }
      }
      out.push([a, b]);
      list.length = 0;
      for (const e of out) list.push(e);
    }

    // ---------- объекты на поверхности ----------
    const flat = (x, y) => {
      if (x < 0 || y < 0 || x >= NX || y >= NY) return false;
      const i = ix(x, y);
      return inside[i] && !river[i] && surface[i] === ground[i] && !blocked.has(i);
    };
    const campCell = flat(15, 10) ? [15, 10] : [[15, 10], [14, 11], [16, 9], [13, 10]].find(([x, y]) => flat(x, y)) || [15, 10];
    blocked.add(ix(campCell[0], campCell[1]));
    const campZ = ground[ix(campCell[0], campCell[1])];
    const details = [], detailAt = new Map();
    const addDetail = (x, y, m, color, h = 0.32) => {
      const i = ix(Math.floor(x), Math.floor(y)), d = { x, y, z: surface[i], m, color, h };
      details.push(d);
      if (!detailAt.has(i)) detailAt.set(i, []);
      detailAt.get(i).push(d);
    };
    const lanterns = [];
    for (const [x, y] of [[12, 8], [17, 12]]) {
      if (flat(x, y)) { addDetail(x, y, 'lantern', [255, 178, 72], 0.9); lanterns.push([x, y, surface[ix(x, y)]]); blocked.add(ix(x, y)); }
    }
    const flowers = [[84, 128, 236], [236, 120, 176], [250, 206, 78]];
    for (let k = 0; k < 64; k++) {
      const x = 1 + Math.floor(rand() * (NX - 2)), y = 1 + Math.floor(rand() * (NY - 2));
      if (!flat(x, y) || blocked.has(ix(x, y))) continue;
      const c = rand();
      if (c < 0.45) addDetail(x + rand() * 0.4, y + rand() * 0.4, 'flower', flowers[Math.floor(rand() * 3)], 0.42);
      else if (c < 0.82) addDetail(x + rand() * 0.4, y + rand() * 0.4, 'tuft', CC.grassDark, 0.24);
      else addDetail(x + rand() * 0.4, y + rand() * 0.4, 'stone', CC.stone2, 0.18);
    }

    const mobs = [];
    const spawn = (kind, count, speed, wait, pick) => {
      const ok = [];
      for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) if (flat(x, y) && !blocked.has(ix(x, y)) && pick(x, y)) ok.push([x, y]);
      ok.sort((a, b) => hash(a[0] * 11, a[1] * 7) - hash(b[0] * 11, b[1] * 7));
      const chosen = ok.slice(0, count);
      if (!chosen.length) return;
      const xs = chosen.map((p) => p[0]), ys = chosen.map((p) => p[1]);
      const bounds = [Math.min(...xs) - 1, Math.max(...xs) + 1, Math.min(...ys) - 1, Math.max(...ys) + 1];
      for (let i = 0; i < chosen.length; i++) {
        const [x, y] = chosen[i];
        mobs.push({ kind, x: x + 0.5, y: y + 0.5, g: ground[ix(x, y)], bounds, speed, face: i % 4, state: 'idle', timer: rand() * wait, phase: rand() * 6 });
      }
    };
    spawn('sheep', 4, 0.55, 3, (x, y) => {
      const t = (x + y) / (NX + NY - 2);
      return t > 0.42 && t < 0.78 && x - y < riverAt(t) - 2;
    });
    spawn('chicken', 3, 0.9, 2, (x, y) => {
      const t = (x + y) / (NX + NY - 2);
      return t > 0.5 && t < 0.82 && x - y > riverAt(t) + 2 && Math.abs(x - campCell[0]) + Math.abs(y - campCell[1]) < 6;
    });
    const walkable = (x, y, z) => flat(x, y) && ground[ix(x, y)] === z;

    // ---------- водопад на переднем краю ----------
    const falls = [], drops = [];
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = ix(x, y);
      if (!river[i] || (x + y) / (NX + NY - 2) < 0.83) continue;
      const zt = waterTop[i], zb = bottom[i] - 3;
      const faces = [];
      if (!inside[ix(x, y + 1)] || !river[ix(x, y + 1)]) faces.push([V(x + 1, y + 1, zt), V(x, y + 1, zt), V(x + 1, y + 1, zb)]);
      if (!inside[ix(x + 1, y)] || !river[ix(x + 1, y)]) faces.push([V(x + 1, y, zt), V(x + 1, y + 1, zt), V(x + 1, y, zb)]);
      for (const f of faces) falls.push({ a: f[0], b: f[1], d: f[2], ph: hash(x * 5, y * 7) });
    }
    for (let k = 0; k < 22; k++) {
      const f = falls[k % Math.max(1, falls.length)];
      if (!f) break;
      drops.push({ f, u: 0.15 + rand() * 0.7, v: rand(), sp: 0.35 + rand() * 0.4, ph: rand() * 6, mist: rand() > 0.65 });
    }
    const water = [];
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const i = ix(x, y);
      if (river[i] && hash(x * 3, y * 7) > 0.42 && water.length < 90) water.push([...V(x + 0.5, y + 0.5, waterTop[i]), hash(x, y)]);
    }
    const emissive = [];
    for (const [x, y, z] of lanterns) emissive.push(V(x + 0.5, y + 0.5, z + 0.7));
    emissive.push(V(campCell[0] + 0.5, campCell[1] + 0.5, campZ + 0.3));

    const mk = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(CW * dpr); cv.height = Math.round(CH * dpr);
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [cv, c];
    };
    const [day, cd] = mk(), [night, cn] = mk();

    // ---------- подсветка и дальние островки ----------
    const glowBack = (c, mode) => {
      const col = mode ? CC.glowNight : CC.glowDay;
      const rr = Math.max(W, H) * 0.42;
      const g = c.createRadialGradient(ox, oy, 0, ox, oy, rr);
      g.addColorStop(0, rgb(col, 1, mode ? 0.2 : 0.16));
      g.addColorStop(1, rgb(col, 1, 0));
      c.fillStyle = g;
      c.fillRect(ox - rr, oy - rr, rr * 2, rr * 2);
    };
    const mini = (c, mode, dx, dy, sc) => {
      c.save();
      c.globalAlpha = 0.36;
      const p = (x, y, z) => { const q = V(x * sc, y * sc, z * sc); return [q[0] + dx, q[1] + dy]; };
      for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) {
        const rr = Math.hypot((x - 2.5) / 3, (y - 2) / 2.5);
        if (rr > 0.95 + (noise(x, y) - 0.5) * 0.16) continue;
        const b = -2 - Math.round(2 * (1 - rr));
        for (let z = b; z < 0; z++) {
          const m = z === -1 ? MAT.DIRT : MAT.STONE2;
          quad(c, [p(x, y + 1, z + 1), p(x + 1, y + 1, z + 1), p(x + 1, y + 1, z), p(x, y + 1, z)], faceColor(mode, m, 2, 0, 0, 1));
          quad(c, [p(x + 1, y, z + 1), p(x + 1, y + 1, z + 1), p(x + 1, y + 1, z), p(x + 1, y, z)], faceColor(mode, m, 1, 0, 0, 1));
        }
        quad(c, [p(x, y, 1), p(x + 1, y, 1), p(x + 1, y + 1, 1), p(x, y + 1, 1)], faceColor(mode, MAT.GRASS, 0, 0, 0, 0));
      }
      c.restore();
    };
    for (const [c, mode] of [[cd, 0], [cn, 1]]) {
      glowBack(c, mode);
      for (const [fx, fy, sc] of CFG.miniIslands) mini(c, mode, (fx - center[0]) * W, (fy - center[1]) * H, sc);
    }

    // ---------- текстура грани: 4x4 пикселя по двум рёбрам ----------
    const texFace = (c, mode, v, face) => {
      const { x, y, z, m } = v, z1 = z + 1;
      const F = [
        [V(x, y, z1), V(x + 1, y, z1), V(x, y + 1, z1)],
        [V(x + 1, y, z1), V(x + 1, y + 1, z1), V(x + 1, y, z)],
        [V(x, y + 1, z1), V(x + 1, y + 1, z1), V(x, y + 1, z)],
      ][face];
      if (m === MAT.WATER) {
        quad(c, [F[0], F[1], [F[1][0] + F[2][0] - F[0][0], F[1][1] + F[2][1] - F[0][1]], F[2]], faceColor(mode, m, face, 0, 0, 0));
        return;
      }
      const variant = Math.floor(hash(x * 3 + face, y * 5 - face) * 3);
      const aoX = face === 0 && (ranges[ix(x + 1, y)] || []).some(([a, b]) => b > z1);
      const aoY = face === 0 && (ranges[ix(x, y + 1)] || []).some(([a, b]) => b > z1);
      c.save();
      c.transform(F[1][0] - F[0][0], F[1][1] - F[0][1], F[2][0] - F[0][0], F[2][1] - F[0][1], F[0][0], F[0][1]);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let b = Math.round((hash(x * 17 + i * 13 + face * 31, y * 19 + j * 11 + z * 7) - 0.5) * 6);
        if (face === 0 && ((aoX && i >= 2) || (aoY && j >= 2))) b -= i === 3 || j === 3 ? 3 : 1;
        c.fillStyle = faceColor(mode, m, face, variant, b, j);
        c.fillRect(i, j, 1.02, 1.02);
      }
      c.restore();
    };
    const drawVoxel = (c, mode, v) => {
      if (!hides(v, get(v.x, v.y + 1, v.z))) texFace(c, mode, v, 2);
      if (!hides(v, get(v.x + 1, v.y, v.z))) texFace(c, mode, v, 1);
      if (!hides(v, get(v.x, v.y, v.z + 1))) texFace(c, mode, v, 0);
    };

    const tiny = (c, mode, d) => {
      const z = d.z, s = 0.22, h = d.h;
      const col = d.m === 'lantern' && mode ? [255, 186, 82] : d.color;
      const nc = mode ? nightOf(col) : col;
      const p = (a, b, zz) => V(a, b, zz);
      const x = d.x, y = d.y;
      quad(c, [p(x, y + s, z + h), p(x + s, y + s, z + h), p(x + s, y + s, z), p(x, y + s, z)], rgb(nc, 0.64));
      quad(c, [p(x + s, y, z + h), p(x + s, y + s, z + h), p(x + s, y + s, z), p(x + s, y, z)], rgb(nc, 0.82));
      quad(c, [p(x, y, z + h), p(x + s, y, z + h), p(x + s, y + s, z + h), p(x, y + s, z + h)], rgb(nc, 1));
    };
    const drawDetails = (c, mode, x, y) => {
      for (const d of detailAt.get(ix(x, y)) || []) tiny(c, mode, d);
      if (x === campCell[0] && y === campCell[1]) {
        const p = (a, b, zz) => V(a, b, zz);
        const log = mode ? nightOf(CC.log) : CC.log;
        const ash = mode ? nightOf([70, 66, 62]) : [70, 66, 62];
        box(c, p, x + 0.12, y + 0.28, campZ, 0.76, 0.24, 0.16, log, log);
        box(c, p, x + 0.3, y + 0.12, campZ, 0.24, 0.76, 0.16, log, log);
        box(c, p, x + 0.2, y + 0.2, campZ, 0.6, 0.6, 0.06, ash, ash);
      }
    };

    // ---------- сборка слоёв кусками по 10 мс ----------
    for (let s = 0; s <= NX + NY - 2; s++) {
      if (!(await pause())) return false;
      for (let x = Math.max(0, s - NY + 1); x <= Math.min(NX - 1, s); x++) {
        const y = s - x, i = ix(x, y);
        if (!inside[i]) continue;
        const q = V(x, y, bottom[i]);
        if (q[0] + U * 2 < 0 || q[0] - U * 2 > CW || q[1] + U * 2 < 0 || q[1] - U * 2 > CH) continue;
        for (const v of cols[i]) {
          if (hides(v, get(v.x, v.y + 1, v.z)) && hides(v, get(v.x + 1, v.y, v.z)) && hides(v, get(v.x, v.y, v.z + 1))) continue;
          drawVoxel(cd, 0, v);
          drawVoxel(cn, 1, v);
        }
        drawDetails(cd, 0, x, y);
        drawDetails(cn, 1, x, y);
      }
    }

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    building = false;
    world = {
      U, M, CW, CH, P, Pg: V, fromScreen, walkable,
      solidsAt: (x, y) => (x < 0 || y < 0 || x >= NX || y >= NY ? [] : ranges[ix(x, y)]),
      day, night, water, falls, drops, emissive, mobs,
      stars: Array.from({ length: 60 }, () => [rand() * W, rand() * H * 0.22, rand() * 6, 0.6 + rand() * 1.2]),
      clouds: [], sun: pixelTex('sun'), moon: pixelTex('moon'),
      camp: V(campCell[0] + 0.5, campCell[1] + 0.5, campZ + 0.35), smoke: [], smokeT: 0,
      stats: { voxels: vox.size, trees: trees.length, cells: inside.reduce((a, b) => a + b, 0) },
    };
    if (CFG.clouds) for (let i = 0; i < 6; i++) {
      const shape = [], w = 3 + Math.floor(rand() * 5), d = 2 + Math.floor(rand() * 3);
      for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) if (rand() > 0.12) shape.push([x, y]);
      for (let k = 0; k < 3; k++) shape.push([Math.floor(rand() * w), d]);
      const [qx, qy] = fromScreen(rand() * CW, rand() * CH * 0.5 + CFG.cloudZ * U);
      world.clouds.push({ x: qx, y: qy, shape: shape.sort((a, b) => a[0] + a[1] - b[0] - b[1]) });
    }
    return true;
  }

  // ---------- состояние ----------
  let t = root.classList.contains('dark') ? 1 : 0;           // 0 — день, 1 — ночь
  let tFrom = t, tTo = t, tStart = 0;
  let time = 0, last = 0, raf = 0, visible = true;
  let ptr = { x: 0, y: 0, inside: false }, par = { x: 0, y: 0, tx: 0, ty: 0 };
  const light = finePointer ? document.createElement('canvas') : null;

  const BASEM = {
    log: [92, 64, 42], logtop: [144, 110, 72], ash: [70, 66, 62],
    wool: [236, 236, 232], skin: [214, 196, 178], feather: [246, 246, 244], beak: [235, 170, 60], wattle: [200, 40, 40],
  };
  const MOB = new Set(['wool', 'skin', 'feather', 'beak', 'wattle']);
  const DAYM = {}, NIGHTM = {};
  for (const [k, c] of Object.entries(BASEM)) { DAYM[k] = c.slice(); NIGHTM[k] = nightOf(c); }
  const mobColor = (name, n) => MOB.has(name) ? mix(DAYM[name], NIGHTM[name], n) : (n > 0.5 ? NIGHTM[name] : DAYM[name]);

  function updateMob(m, dt) {
    m.timer -= dt;
    if (m.state === 'idle') {
      if (m.timer <= 0) {
        // цель только по проходимым клеткам: мобы не лезут в воду и на деревья
        const [x0, x1, y0, y1] = m.bounds, ok = world.walkable;
        const fx = Math.floor(m.x), fy = Math.floor(m.y);
        m.timer = 0.6;
        for (let i = 0; i < 8; i++) {
          const tx = Math.floor(lerp(x0, x1 + 1, Math.random())), ty = Math.floor(lerp(y0, y1 + 1, Math.random()));
          let free = true;
          for (let x = Math.min(fx, tx); x <= Math.max(fx, tx) && free; x++) free = ok(x, fy, m.g);
          for (let y = Math.min(fy, ty); y <= Math.max(fy, ty) && free; y++) free = ok(tx, y, m.g);
          if (!free) continue;
          m.tx = tx + 0.5; m.ty = ty + 0.5; m.state = 'walk'; m.graze = false;
          break;
        }
      }
    } else {
      const dx = m.tx - m.x, dy = m.ty - m.y, sp = m.speed * dt;
      if (Math.abs(dx) > 0.02) { m.face = dx > 0 ? 0 : 1; m.x += Math.sign(dx) * Math.min(Math.abs(dx), sp); }
      else if (Math.abs(dy) > 0.02) { m.face = dy > 0 ? 2 : 3; m.y += Math.sign(dy) * Math.min(Math.abs(dy), sp); }
      else { m.state = 'idle'; m.timer = 1.5 + Math.random() * 4; m.graze = m.kind === 'sheep' && Math.random() < 0.5; }
    }
  }

  function drawMob(c, P, m, n) {
    const S = CFG.mobScale;
    const B = (x, y, z, dx, dy, dz, top, side) => box(c, P, m.x + (x - m.x) * S, m.y + (y - m.y) * S, m.g + (z - m.g) * S, dx * S, dy * S, dz * S, top, side);
    const alongX = m.face < 2, dir = m.face === 0 || m.face === 2 ? 1 : -1;
    const bob = m.state === 'walk' ? Math.abs(Math.sin(time * (m.kind === 'chicken' ? 14 : 8) + m.phase)) * 0.05 : 0;
    const z = m.g + bob;
    const sheep = m.kind === 'sheep';
    const len = sheep ? 0.8 : 0.34, wid = sheep ? 0.5 : 0.26, hgt = sheep ? 0.42 : 0.24, leg = sheep ? 0.28 : 0.12;
    const bx = m.x - (alongX ? len : wid) / 2, by = m.y - (alongX ? wid : len) / 2;
    const bw = alongX ? len : wid, bd = alongX ? wid : len;
    const body = mobColor(sheep ? 'wool' : 'feather', n), skin = mobColor(sheep ? 'skin' : 'beak', n);
    const legs = [[0.08, 0.08], [bw - 0.2, 0.08], [0.08, bd - 0.2], [bw - 0.2, bd - 0.2]];
    for (const [lx, ly] of legs) B(bx + lx, by + ly, m.g, 0.12, 0.12, leg, skin, skin);
    const hs = sheep ? 0.32 : 0.16;
    const hx = m.x + (alongX ? dir * (len / 2 + hs * 0.35) : 0) - hs / 2;
    const hy = m.y + (alongX ? 0 : dir * (len / 2 + hs * 0.35)) - hs / 2;
    const hz = z + (sheep ? (m.graze ? 0.12 : leg + hgt - 0.1) : leg + hgt - 0.02);
    const head = () => {
      B(hx, hy, hz, hs, hs, sheep ? hs : hs * 1.2, sheep ? skin : body, sheep ? skin : body);
      if (!sheep) {
        const kx = hx + (alongX ? (dir > 0 ? hs : -0.06) : hs / 2 - 0.03), ky = hy + (alongX ? hs / 2 - 0.03 : (dir > 0 ? hs : -0.06));
        B(kx, ky, hz + 0.06, 0.06, 0.06, 0.05, skin, skin);
        B(kx, ky, hz - 0.02, 0.05, 0.05, 0.06, mobColor('wattle', n), mobColor('wattle', n));
      }
    };
    if (dir < 0) head();
    B(bx, by, z + leg, bw, bd, hgt, body, body);
    if (dir > 0) head();
  }

  function glow(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const fallPoint = (f, u, v) => [
    f.a[0] + (f.b[0] - f.a[0]) * u + (f.d[0] - f.a[0]) * v,
    f.a[1] + (f.b[1] - f.a[1]) * u + (f.d[1] - f.a[1]) * v,
  ];

  function draw() {
    const w = world;
    if (!w || building) return;
    // земля, закат и факел собираются в отдельный кадр: из него же берём перекрытия мобов
    if (frameCv.width !== canvas.width || frameCv.height !== canvas.height) { frameCv.width = canvas.width; frameCv.height = canvas.height; }
    const ctx = frameCv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    drawSky(ctx, w);

    const bob = reduced ? 0 : Math.sin(time * Math.PI * 2 / (CFG.bobMs / 1000)) * CFG.bob;
    const ox = -w.M + par.x, oy = -w.M + par.y + bob;
    ctx.drawImage(w.day, ox, oy, w.CW, w.CH);
    if (t > 0.001) { ctx.globalAlpha = t; ctx.drawImage(w.night, ox, oy, w.CW, w.CH); ctx.globalAlpha = 1; }

    const dusk = Math.sin(Math.PI * t) * (tFrom !== tTo || (t > 0 && t < 1) ? 1 : 0);
    if (dusk > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,110,50,${dusk * 0.55})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

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

    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalCompositeOperation = 'source-over';
    main.globalAlpha = 1;
    main.clearRect(0, 0, canvas.width, canvas.height);
    main.drawImage(frameCv, 0, 0);
    drawScene(main, w, ox, oy, torchOn, R);
  }

  function drawScene(ctx, w, ox, oy, torchOn, R) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nightAt = (sx, sy) => {
      if (!torchOn) return t;
      const d = Math.hypot(sx + ox - ptr.x, sy + oy - ptr.y);
      return t * (1 - clamp(1 - d / R, 0, 1) * 0.85);
    };

    ctx.save();
    ctx.translate(ox, oy);

    // водопад:-base, полосы и брызги
    const fa = lerp(0.9, 0.62, t);
    for (const f of w.falls) {
      const c = [f.b[0] + f.d[0] - f.a[0], f.b[1] + f.d[1] - f.a[1]];
      quad(ctx, [f.a, f.b, c, f.d], `rgba(30,78,132,${fa})`);
    }
    ctx.globalCompositeOperation = 'lighter';
    const streaks = t < 0.5 ? '210,238,255' : '150,185,255';
    for (const f of w.falls) for (let k = 0; k < 3; k++) {
      const u = 0.18 + k * 0.28 + f.ph * 0.06;
      const v = (time * 0.55 + f.ph + k * 0.37) % 1;
      const p = fallPoint(f, u, v), q = fallPoint(f, u + 0.03, Math.min(1, v + 0.22));
      ctx.strokeStyle = `rgba(${streaks},${(0.55 - t * 0.25) * (1 - v * 0.5)})`;
      ctx.lineWidth = Math.max(1, w.U * 0.055);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.stroke();
    }
    for (const p of w.drops) {
      const v = p.v;
      const q = fallPoint(p.f, p.u + Math.sin(time * 2 + p.ph) * 0.04, v);
      const a = (v < 0.1 ? v / 0.1 : 1 - clamp((v - 0.55) / 0.5, 0, 1)) * (p.mist ? 0.28 : 0.55);
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(${p.mist ? '220,238,255' : '160,205,250'},${a})`;
      const s = Math.max(1.5, w.U * (p.mist ? 0.12 : 0.07));
      ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    }
    for (const f of w.falls) for (let k = 0; k < 3; k++) {
      const p = fallPoint(f, 0.16 + k * 0.3, 0);
      const s = w.U * (0.09 + 0.03 * Math.sin(time * 5 + k + f.ph));
      ctx.fillStyle = `rgba(245,252,255,${(0.8 - t * 0.25) * (0.6 + 0.4 * Math.sin(time * 4 + k))})`;
      ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
    }
    ctx.globalCompositeOperation = 'source-over';

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

    // огонь костра
    const fire = (x, y, s, i) => {
      const f = 0.7 + noise(time * 7 + i * 13, i) * 0.6;
      ctx.fillStyle = 'rgba(255,140,40,0.9)';
      ctx.fillRect(x - s / 2, y - s * 1.4 * f, s, s * 1.4 * f);
      ctx.fillStyle = 'rgba(255,225,120,0.95)';
      ctx.fillRect(x - s / 4, y - s * 0.9 * f, s / 2, s * 0.9 * f);
    };
    const cs = Math.max(2, w.U * 0.16 * CFG.mobScale);
    for (let i = 0; i < 3; i++) fire(w.camp[0] + (i - 1) * cs * 1.1, w.camp[1], cs, i);

    // мобы — по глубине; спереди поверх них кладём готовый кадр земли
    const actors = w.mobs.map((m) => ({ k: m.x + m.y, x: m.x, y: m.y, z: m.g, f: () => drawMob(ctx, w.Pg, m, nightAt(...w.Pg(m.x, m.y, m.g))) }));
    actors.sort((a, b) => a.k - b.k).forEach((a) => { a.f(); coverActor(ctx, w, a.x, a.y, a.z); });

    // дым костра: серые квадраты, как в Minecraft
    const sc = lerp(150, 70, t);
    for (const p of w.smoke) {
      const k = p.age / p.life;
      ctx.fillStyle = `rgba(${sc},${sc},${sc + 6},${(1 - k) * (k < 0.08 ? k / 0.08 : 1) * 0.5})`;
      const s = p.size * (1 + k * 1.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    // ночные огни
    if (t > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const a = smooth(clamp((t - 0.35) / 0.65, 0, 1));
      for (const [x, y] of w.emissive) glow(ctx, x, y, w.U * 3.2, '255,140,60', 0.24 * a);
      glow(ctx, w.camp[0], w.camp[1] - w.U * 0.2, w.U * CFG.mobScale * (2.7 + noise(time * 4, 99) * 0.5), '255,130,50', 0.32 * a);
      ctx.globalCompositeOperation = 'source-over';
    }

    // облака выше всего и с более сильным параллаксом
    if (w.clouds.length) {
      ctx.translate(par.x * 1.5, par.y * 1.5);
      const C = CFG.cloudCell, top = mobColor('wool', t * 0.9), alpha = lerp(0.5, 0.18, t);
      for (const cl of w.clouds) for (const [dx, dy] of cl.shape) box(ctx, w.P, cl.x + dx * C, cl.y + dy * C, CFG.cloudZ, C, C, C * 0.6, top, top, alpha);
    }
    ctx.restore();
  }

  // Перекрыть моба тем, что стоит перед ним: вырезаем силуэты из готового кадра земли
  function coverActor(ctx, w, mx, my, mz) {
    const P = w.Pg, fx = Math.floor(mx), fy = Math.floor(my);
    let any = false;
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      if (!i && !j) continue;
      const x = fx + i, y = fy + j;
      for (const [z0, z1] of w.solidsAt(x, y)) {
        if (z1 <= mz + 0.01) continue;
        if (z1 - mz < (i + j) / 2 - 1.2) continue;
        const p = [P(x, y, z1), P(x + 1, y, z1), P(x + 1, y + 1, z1), P(x + 1, y + 1, z0), P(x, y + 1, z0), P(x, y, z0)];
        ctx.moveTo(p[0][0], p[0][1]);
        for (let k = 1; k < 6; k++) ctx.lineTo(p[k][0], p[k][1]);
        ctx.closePath();
        any = true;
      }
    }
    if (!any) return;
    ctx.save();
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(frameCv, 0, 0);
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

  // Небо: солнце и луна по дугам, звёзды, отставание при прокрутке и параллакс
  function drawSky(ctx, w) {
    const lagY = Math.min(scrollY, H) * 0.35;
    const kx = 0.45, ky = 0.45;
    const sx0 = par.x * kx, sy0 = par.y * ky + lagY;
    const s = Math.round(clamp(w.U * 4.6, 40, 72) / 8) * 8;
    ctx.imageSmoothingEnabled = false;
    const arc = (k, a, b, c) => [0, 1].map((i) => ((1 - k) * (1 - k) * a[i] + 2 * k * (1 - k) * b[i] + k * k * c[i]) * (i ? H : W));

    const starA = smooth(clamp((t - 0.45) / 0.55, 0, 1));
    if (starA > 0.01) {
      for (const [x, y, ph, sz] of w.stars) {
        ctx.fillStyle = `rgba(230,235,255,${starA * (0.35 + 0.35 * Math.sin(time * 1.7 + ph))})`;
        ctx.fillRect(x + par.x * 0.25, y + par.y * 0.25 + lagY * 1.3, sz, sz);
      }
    }

    const p = t;
    const sunA = 1 - smooth(clamp((p - 0.45) / 0.45, 0, 1));
    if (sunA > 0.01) {
      const [bx, by] = arc(smooth(p), [0.87, W < 600 ? 0.11 : 0.2], [1.02, W < 600 ? 0.08 : 0.16], [1.12, 0.85]);
      const x = bx + sx0, y = by + sy0;
      const warm = smooth(clamp(p / 0.7, 0, 1));
      const sz = s * (1 + warm * 0.15);
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
    for (const m of w.mobs) updateMob(m, dt);
    w.smokeT -= dt;
    if (w.smokeT <= 0 && w.smoke.length < 70) {
      w.smokeT = 0.14;
      w.smoke.push({ x: w.camp[0] + (Math.random() - 0.5) * w.U * 0.3 * CFG.mobScale, y: w.camp[1] - w.U * 0.4 * CFG.mobScale, vy: -(20 + Math.random() * 10),
        age: 0, life: 6 + Math.random() * 2, size: (3 + Math.random() * 3) * CFG.mobScale, ph: Math.random() * 6 });
    }
    for (const p of w.smoke) { p.age += dt; p.y += p.vy * dt; p.x += Math.sin(p.age * 1.2 + p.ph) * 5 * dt + 3 * dt; }
    w.smoke = w.smoke.filter((p) => p.age < p.life);
    for (const d of w.drops) {
      d.v += dt * d.sp;
      if (d.v > 1.5) { d.v = -0.2; d.u = 0.15 + Math.random() * 0.7; }
    }
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
      // адресная строка меняет высоту чуть-чуть — не пересобираем мир ради этого
      if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 80 && world) return;
      lastW = r.width; lastH = r.height;
      if (!(await build())) return;
      draw();
      canvas.classList.add('is-ready');
      start();
    }, world ? 200 : 0);
  }).observe(canvas);

  window.__redlineWorld = { cfg: CFG, get t() { return t; }, get world() { return world; } };
})();
