// DesertTerrain.js – the MX desert: dune sea, gravel plains, buttes and graded sprint routes (no dependencies).
//
// The terrain is a pure height function plus surface masks, so the same data drives physics,
// rendering and race logic.
//
//   import { DesertTerrain } from './DesertTerrain.js';
//   import { SPRINT_ROUTES } from './routes.js';
//   const terrain = new DesertTerrain({ routes: SPRINT_ROUTES });
//   const world = new TruckWorld({ groundHeight: terrain.height, surface: terrain.surface });
//   terrain.prefetch(x, z, 90);          // each frame, around every truck (bakes height tiles in a time budget)
//
// What's in it
//   • Transverse dunes built like real ones: a long gentle windward slope (≈6–9°), a rounded brink,
//     then a planar slip face at the angle of repose (≈30°) on the downwind side. Crests meander and
//     break up (domain warp + per-ridge height), with a second set of smaller oblique dunes on top.
//     Driving downwind = up the windward side, launch off the brink, land on the slip face.
//   • Dune amount varies by region: a dune sea in the south, gravel plains (serir) with low sand
//     sheets in the north, sandstone buttes as landmarks.
//   • Sprint routes (see routes.js): a Catmull-Rom centreline sampled every 2 m. Inside the route
//     corridor the ground is graded to the centreline profile (no camber), which keeps a chosen share
//     of the dune shape (`keep`) so crests still become jumps. Shoulders blend back to the natural
//     ground, never steeper than ~30°. Route features: kickers, whoops, canyon (trench with
//     sandstone walls), dune sections.
//   • Surfaces: soft sand (low grip, high drag), graded track (best grip), gravel, rock.
//   • height(x, z) is a bilinear lookup in cached 0.5 m tiles (64 m), so the ~130 lookups per truck
//     per physics substep stay cheap. heightExact() is the analytic function the tiles are baked from.
//
// Units: metres. World: +Y up. Wind blows along `wind` (x, z) – default roughly +X (east).

// ---------------------------------------------------------------- noise
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);
class Simplex {
  constructor(seed) {
    const r = mulberry32(seed), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512); for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  // 2D simplex noise, range ≈ −1..1
  n(x, y) {
    const perm = this.perm;
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = (perm[ii + perm[jj]] & 7) * 2; t0 *= t0; n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2; t1 *= t1; n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2; t2 *= t2; n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
    return 70 * n;
  }
  fbm(x, y, oct = 4, lac = 2.03, gain = 0.5) {
    let a = 0, amp = 1, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) { a += amp * this.n(x * f, y * f); norm += amp; amp *= gain; f *= lac; }
    return a / norm;
  }
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(b, a, h) - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------------------------------------------------------------- surfaces (physics)
// grip multiplies TRUCK_DEFAULTS.grip (0.78); roll is rolling-resistance coefficient (replaces 0.02).
export const SURFACES = {
  soft:   { name: 'soft sand', grip: 0.86, roll: 0.11 },
  track:  { name: 'graded track', grip: 1.08, roll: 0.018 },
  gravel: { name: 'gravel', grip: 1.0, roll: 0.03 },
  rock:   { name: 'rock', grip: 1.12, roll: 0.015 },
};

// ---------------------------------------------------------------- route
const SAMPLE = 2;            // m between centreline samples
const CELL = 64;             // spatial hash cell for route queries
const COARSE = 8;            // coarse search stride (samples)
const cellKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
export const ROUTE_REACH = 260;   // max distance at which a route still shapes the ground (canyon rims)

function catmullRom(pts, closed = false, step = 1) {
  // centripetal Catmull-Rom through [x, z] control points, returns dense polyline
  const P = closed ? pts : [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]], ...pts,
    [2 * pts[pts.length - 1][0] - pts[pts.length - 2][0], 2 * pts[pts.length - 1][1] - pts[pts.length - 2][1]]];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = t1 + (t2 - t1) * (k / n);
      const A = (q0, q1, ta, tb) => [((tb - t) * q0[0] + (t - ta) * q1[0]) / (tb - ta), ((tb - t) * q0[1] + (t - ta) * q1[1]) / (tb - ta)];
      const A1 = A(p0, p1, t0, t1), A2 = A(p1, p2, t1, t2), A3 = A(p2, p3, t2, t3);
      const B1 = A(A1, A2, t0, t2), B2 = A(A2, A3, t1, t3);
      out.push(A(B1, B2, t1, t2));
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

class Route {
  constructor(def, index) {
    Object.assign(this, { halfWidth: 10, keep: 0.25, ...def });
    this.index = index;
    // dense polyline → resample at exactly SAMPLE metres
    const dense = catmullRom(def.points, false, 0.5);
    const xs = [dense[0][0]], zs = [dense[0][1]];
    let acc = 0;
    for (let i = 1; i < dense.length; i++) {
      const ax = dense[i - 1][0], az = dense[i - 1][1], bx = dense[i][0], bz = dense[i][1];
      let seg = Math.hypot(bx - ax, bz - az), u = 0;
      while (acc + (seg - u) >= SAMPLE) {
        u += SAMPLE - acc; acc = 0;
        xs.push(ax + (bx - ax) * (u / seg)); zs.push(az + (bz - az) * (u / seg));
      }
      acc += seg - u;
    }
    const n = xs.length;
    this.n = n; this.length = (n - 1) * SAMPLE;
    this.x = Float64Array.from(xs); this.z = Float64Array.from(zs);
    this.tx = new Float32Array(n); this.tz = new Float32Array(n); this.curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
      const dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a], l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    for (let i = 0; i < n; i++) {   // signed curvature (1/m), + = turning left (toward +X when heading +Z)
      const a = Math.max(0, i - 5), b = Math.min(n - 1, i + 5);
      const cr = this.tz[a] * this.tx[b] - this.tx[a] * this.tz[b];
      this.curv[i] = Math.asin(clamp(cr, -1, 1)) / Math.max(SAMPLE, (b - a) * SAMPLE);
    }
    this.hc = new Float32Array(n);            // graded centreline height (filled by the terrain)
    this.canyon = new Float32Array(n);        // canyon depth at each sample (smoothed)
    this.keepS = new Float32Array(n);
    this.bbox = [Math.min(...xs) - ROUTE_REACH, Math.min(...zs) - ROUTE_REACH, Math.max(...xs) + ROUTE_REACH, Math.max(...zs) + ROUTE_REACH];
  }
  // interpolate a per-sample array at arc length s
  at(arr, s) {
    const f = clamp(s / SAMPLE, 0, this.n - 1), i = Math.min(this.n - 2, Math.floor(f)), t = f - i;
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }
  pointAt(s) {
    return { x: this.at(this.x, s), z: this.at(this.z, s), tx: this.at(this.tx, s), tz: this.at(this.tz, s), y: this.at(this.hc, s) };
  }
}

// ---------------------------------------------------------------- terrain
const TILE = 64, RES = 0.5, TN = TILE / RES + 1;   // 129 × 129 samples per physics tile

export class DesertTerrain {
  constructor({ seed = 7, routes = [], wind = [1, 0.18], buttes = [], duneSea = null, maxTiles = 160 } = {}) {
    this.seed = seed;
    this.sx = new Simplex(seed); this.sy = new Simplex(seed + 101); this.sz = new Simplex(seed + 202);
    const wl = Math.hypot(wind[0], wind[1]); this.wind = [wind[0] / wl, wind[1] / wl];
    // secondary (oblique) dune set: wind rotated by 28°
    const a2 = 0.49; this.wind2 = [this.wind[0] * Math.cos(a2) - this.wind[1] * Math.sin(a2), this.wind[0] * Math.sin(a2) + this.wind[1] * Math.cos(a2)];
    this.buttes = buttes;
    this.duneSea = duneSea || ((x, z) => sstep(-700, -1300, z));   // where the big dunes are (0..1)
    this.routes = routes.map((r, i) => new Route(r, i));
    this._buildRouteIndex();
    for (const r of this.routes) this._gradeRoute(r);
    this.tiles = new Map(); this.maxTiles = maxTiles; this._lru = 0;
    this._m = { track: 0, soft: 0, rock: 0, crest: 0, slip: 0, d: 1e9, s: 0, route: -1 };
    // bound methods so they can be passed as callbacks
    this.height = this.height.bind(this);
    this.surface = this.surface.bind(this);
    this.normal = this.normal.bind(this);
  }

  // ---------- natural ground (no routes) ----------
  _dunes(x, z, wind, spacing, Hmin, Hmax, warpAmp, seedOff, m) {
    const sx = this.sx;
    const u0 = x * wind[0] + z * wind[1], v = -x * wind[1] + z * wind[0];
    // meandering crests: warp the along-wind coordinate by noise across the wind
    const u = u0 + warpAmp * sx.fbm(v * 0.0035 + seedOff, u0 * 0.0012, 3) + warpAmp * 0.25 * sx.n(v * 0.014 + seedOff, u0 * 0.004);
    const sp = spacing * (1 + 0.18 * this.sy.n(x * 0.0009 + seedOff, z * 0.0009));
    const ph = u / sp, cell = Math.floor(ph), p = ph - cell;
    // per-ridge height that also varies along the crest → crests break up into barchan-ish segments
    const along = this.sz.n(v * 0.006 + cell * 3.7 + seedOff, cell * 1.3);
    const H = lerp(Hmin, Hmax, clamp(0.55 + 0.6 * along, 0, 1)) * clamp(0.35 + 0.65 * (0.5 + 0.5 * this.sy.n(v * 0.0025 - seedOff, cell * 0.71)), 0, 1);
    const c = 0.82;                                   // brink position within the wavelength
    const wind_ = H * Math.pow(p / c, 1.25);          // windward: gentle, slightly concave-up near the toe
    const slip = H * (1 - p) / (1 - c);               // slip face: planar, angle of repose
    const k = Math.max(0.6, H * 0.18);                // brink rounding
    let h = smin(wind_, slip, k);
    h = smax(h, 0, 0.8);
    if (m) {
      const crest = Math.exp(-Math.pow((p - c) / 0.035, 2)) * clamp(H / 6, 0, 1);
      const slipF = sstep(c - 0.01, c + 0.03, p) * (1 - sstep(0.97, 1, p)) * clamp(H / 5, 0, 1);
      if (crest > m.crest) m.crest = crest;
      if (slipF > m.slip) m.slip = slipF;
    }
    return h;
  }

  natural(x, z, m) {
    const sx = this.sx, sy = this.sy;
    let h = 9 * sx.fbm(x / 1400, z / 1400, 3) + 2.5 * sy.fbm(x / 320, z / 320, 3);
    const sea = this.duneSea(x, z);
    // sand cover: big dunes in the sea, low sand sheets and patches elsewhere
    const patch = clamp(0.5 + 0.9 * sy.fbm(x / 700 + 9, z / 700 - 4, 3), 0, 1);
    const big = sea * (0.65 + 0.35 * patch);
    const small = clamp(0.25 + 0.75 * sea + 0.5 * (patch - 0.5), 0, 1);
    if (m) { m.crest = 0; m.slip = 0; }
    if (big > 0.02) h += big * this._dunes(x, z, this.wind, 150, 5, 17, 70, 0, m);
    if (small > 0.02) {
      const before = m ? m.crest : 0, beforeS = m ? m.slip : 0;
      // secondary dunes come in clusters, not as endless ruled lines
      const cluster = sstep(-0.15, 0.45, this.sz.fbm(x / 160 + 3, z / 160, 2)) * (0.6 + 0.4 * sstep(-0.4, 0.3, this.sx.n(x / 55, z / 55)));
      h += small * cluster * this._dunes(x, z, this.wind2, 46, 0.8, 3.4, 34, 13.7, m) * (1 - 0.5 * big);
      if (m) { m.crest = Math.max(before, m.crest * small * cluster); m.slip = Math.max(beforeS, m.slip * small * cluster); }
    }
    // gravel plains: a little low-amplitude roll
    h += (1 - small) * 0.35 * sx.n(x / 18, z / 18);
    let rock = 0;
    for (const b of this.buttes) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > b.r + 80 || Math.abs(dz) > b.r + 80) continue;
      const ang = Math.atan2(dz, dx), ca = Math.cos(ang), sa = Math.sin(ang);
      const lobe = 0.13 * sx.n(ca * 1.6 + b.x * 0.01, sa * 1.6 + b.z * 0.01);
      const rr = b.r * (1 + lobe + 0.04 * sx.n(ca * 5 + b.x, sa * 5));   // caprock outline: lobes + small notches
      const dist = Math.hypot(dx, dz);
      const body = sstep(rr + 7, rr - 3, dist);                       // near-vertical caprock walls
      const tr = b.r * (1 + lobe);
      const talus = sstep(tr + 55, tr, dist);                          // smooth debris apron
      const top = b.h * (0.95 + 0.05 * sx.n(x / 30, z / 30));
      const apron = b.h * 0.24 * talus * talus;
      const hb = Math.max(apron, top * body);
      if (hb > 0) { h += hb; rock = Math.max(rock, clamp(body * 1.4, 0, 1), sstep(0.35, 0.9, talus) * 0.6); }
    }
    if (m) { m.sand = small; m.big = big; m.rock = clamp(rock, 0, 1); }
    return h;
  }

  // ---------- routes ----------
  _buildRouteIndex() {
    // per cell: coarse samples (every COARSE) of any route that can be within ROUTE_REACH of the cell
    this.grid = new Map();
    const pad = ROUTE_REACH + COARSE * SAMPLE;
    for (const r of this.routes) for (let i = 0; i < r.n; i += COARSE) {
      const x = r.x[i], z = r.z[i];
      const c0 = Math.floor((x - pad) / CELL), c1 = Math.floor((x + pad) / CELL), d0 = Math.floor((z - pad) / CELL), d1 = Math.floor((z + pad) / CELL);
      for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
        const bx = clamp(x, cx * CELL, cx * CELL + CELL), bz = clamp(z, cz * CELL, cz * CELL + CELL);
        if (Math.hypot(x - bx, z - bz) > pad) continue;
        const k = cellKey(cx, cz); let a = this.grid.get(k); if (!a) this.grid.set(k, (a = []));
        a.push(r.index, i);
      }
    }
  }

  // nearest route point → { route, s, d (signed, + = left of travel), tx, tz, i } or null if beyond `reach`
  routeQuery(x, z, reach = ROUTE_REACH, out = {}) {
    const list = this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    // 1) nearest coarse sample per route
    let bc = Infinity, bci = -1, bcr = -1;
    for (let k = 0; k < list.length; k += 2) {
      const r = this.routes[list[k]], i = list[k + 1], dx = x - r.x[i], dz = z - r.z[i], d2 = dx * dx + dz * dz;
      if (d2 < bc) { bc = d2; bci = i; bcr = list[k]; }
    }
    const lim = reach + COARSE * SAMPLE;
    if (bci < 0 || bc > lim * lim) return null;
    // 2) refine on the segments around it
    const r = this.routes[bcr];
    let best = Infinity, bi = -1, bt = 0;
    const i0 = Math.max(0, bci - COARSE - 2), i1 = Math.min(r.n - 2, bci + COARSE + 2);
    for (let i = i0; i <= i1; i++) {
      const ax = r.x[i], az = r.z[i], ex = r.x[i + 1] - ax, ez = r.z[i + 1] - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      const dx = x - (ax + ex * t), dz = z - (az + ez * t), d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (best > reach * reach) return null;
    const s = (bi + bt) * SAMPLE;
    const tx = r.tx[bi], tz = r.tz[bi];
    const px = r.x[bi] + (r.x[bi + 1] - r.x[bi]) * bt, pz = r.z[bi] + (r.z[bi + 1] - r.z[bi]) * bt;
    // left of travel: truck frame has +X left when heading +Z → left = (tz, −tx)
    const d = (x - px) * tz - (z - pz) * tx;
    out.route = r; out.s = s; out.d = d; out.tx = tx; out.tz = tz; out.i = bi; out.dist = Math.sqrt(best);
    // beyond either end the corridor fades out over ~40 m
    let fade = 1;
    if (bi === 0 && bt === 0) fade = sstep(40, 5, (px - x) * tx + (pz - z) * tz);
    else if (bi === r.n - 2 && bt === 1) fade = sstep(40, 5, (x - px) * tx + (z - pz) * tz);
    out.endFade = fade;
    return out;
  }

  _feature(r, s) {   // extra centreline height from authored features
    let h = 0;
    for (const f of r.features || []) {
      if (f.type === 'kicker') {
        const len = f.length || 14, H = f.height || 2.4, back = f.back || 4;
        if (s > f.s - len && s < f.s + back) {
          h += s <= f.s ? H * Math.pow((s - (f.s - len)) / len, 1.7) : H * (1 - (s - f.s) / back);
        }
      } else if (f.type === 'whoops') {
        if (s > f.s0 && s < f.s1) {
          const fade = sstep(f.s0, f.s0 + 20, s) * sstep(f.s1, f.s1 - 20, s);
          h += fade * (f.amp || 0.7) * 0.5 * (1 - Math.cos((2 * Math.PI * (s - f.s0)) / (f.wavelength || 10)));
        }
      } else if (f.type === 'tabletop') {
        const up = f.up || 16, top = f.top || 18, down = f.down || 10, H = f.height || 3;
        const s0 = f.s;
        if (s > s0 && s < s0 + up + top + down) {
          const t = s - s0;
          h += t < up ? H * Math.pow(t / up, 1.6) : t < up + top ? H : H * sstep(up + top + down, up + top, t);
        }
      }
    }
    return h;
  }

  _gradeRoute(r) {
    const n = r.n, nat = new Float32Array(n);
    // canyon depth per sample (smooth ramps at both ends)
    for (let i = 0; i < n; i++) {
      const s = i * SAMPLE; let c = 0, keep = r.keep;
      for (const f of r.features || []) {
        if (f.type === 'canyon') c = Math.max(c, (f.depth || 18) * sstep(f.s0, f.s0 + 90, s) * sstep(f.s1, f.s1 - 90, s));
        if (f.type === 'dunes') keep = lerp(keep, f.keep, sstep(f.s0, f.s0 + 40, s) * sstep(f.s1, f.s1 - 40, s));
      }
      r.canyon[i] = c; r.keepS[i] = keep;
      nat[i] = this.natural(r.x[i], r.z[i]);
    }

    // graded profile: keep part of the dune shape, low-pass the rest (±50 m moving average)
    const W = Math.round(50 / SAMPLE), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + nat[i];
    const lp = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n, i + W + 1); lp[i] = (pre[b] - pre[a]) / (b - a); }
    for (let i = 0; i < n; i++) r.hc[i] = lerp(lp[i], nat[i], r.keepS[i]);
    // a light smoothing pass so brinks are crisp but not knife edges for the tyres (±3 m)
    const tmp = Float32Array.from(r.hc);
    for (let i = 0; i < n; i++) { let a = 0, w = 0; for (let k = -2; k <= 2; k++) { const j = clamp(i + k, 0, n - 1); const wk = 3 - Math.abs(k); a += tmp[j] * wk; w += wk; } r.hc[i] = a / w; }
    // start / finish pads are flat
    const flat = (s0, s1) => { const i0 = Math.round(s0 / SAMPLE), i1 = Math.round(s1 / SAMPLE); let a = 0; for (let i = i0; i <= i1; i++) a += r.hc[clamp(i, 0, n - 1)]; a /= i1 - i0 + 1; return a; };
    const hs = flat(0, 70), he = flat(r.length - 60, r.length);
    for (let i = 0; i < n; i++) {
      const s = i * SAMPLE;
      r.hc[i] = lerp(r.hc[i], hs, sstep(110, 70, s));
      r.hc[i] = lerp(r.hc[i], he, sstep(r.length - 100, r.length - 60, s));
      r.hc[i] += this._feature(r, s);
    }
    r.canyonPts = [];
    for (let i = 0; i < n; i += 6) if (r.canyon[i] > 0.05) r.canyonPts.push(r.x[i], r.z[i], r.canyon[i], r.hc[i]);
  }

  // ---------- full analytic height (+ masks in this._m when wantMask) ----------
  heightExact(x, z, wantMask = false) {
    const m = wantMask ? this._m : null;
    let h = this.natural(x, z, m);
    let track = 0, rock = m ? m.rock : 0;
    const q = this._q || (this._q = {});
    const hit = this.routes.length ? this.routeQuery(x, z, ROUTE_REACH, q) : null;
    if (m) { m.d = 1e9; m.s = 0; m.route = -1; }
    if (hit) {
      const r = hit.route, ad = Math.abs(hit.d), fade = hit.endFade;
      const canyon = r.at(r.canyon, hit.s);
      const hc = r.at(r.hc, hit.s);
      let plat = 0;
      if (r.canyonPts.length) {
        // canyon: a plateau (smooth union of discs along the canyon section, so it has no seams far
        // from the route) cut by the trench; sandstone walls are the trench sides
        plat = 0; let bw = 0, bh = 0;
        const P = r.canyonPts;
        for (let k = 0; k < P.length; k += 4) {
          const dx = x - P[k], dz = z - P[k + 1];
          if (dx > 230 || dx < -230 || dz > 230 || dz < -230) continue;
          const wk = sstep(228, 110, Math.sqrt(dx * dx + dz * dz));
          if (wk <= 0) continue;
          const v = P[k + 2] * wk;
          if (v > plat) plat = v;
          bw += wk * wk; bh += wk * wk * P[k + 3];
        }
        if (plat > 0.05) {
          const rimN = this.sx.fbm(x / 40, z / 40, 3);
          const wallIn = r.halfWidth + 3 + 3 * this.sy.n(x / 30, z / 30);
          const cut = sstep(wallIn, wallIn + 8 + 4 * rimN, ad);
          const top = bh / bw + plat * (1 + 0.12 * rimN);
          const up = cut * fade * sstep(0.05, 6, plat);
          h = lerp(h, Math.max(h, top), up);
          rock = Math.max(rock, sstep(0.02, 0.25, cut) * (1 - sstep(0.75, 1, cut)) * sstep(2, 6, plat) * fade);
        }
      }
      const half = r.halfWidth;
      const dh = Math.abs(h - hc);
      const shoulder = lerp(Math.max(10, dh * 1.75), 3, Math.max(sstep(0.05, 2, canyon), sstep(1, 5, plat)));
      const w = (1 - sstep(half, half + shoulder, ad)) * fade;
      if (w > 0) {
        h = lerp(h, hc, w);
        track = 1 - sstep(half - 2, half + 2, ad);
        track *= fade;
        if (m) rock *= 1 - w;
      }
      if (m) { m.d = hit.d; m.s = hit.s; m.route = r.index; m.cw = w; }
    }
    if (m) {
      m.track = track; m.rock = rock;
      m.soft = clamp((m.sand ?? 0) * (1 - track) * (1 - rock), 0, 1);
      m.crest *= 1 - track; m.slip *= 1 - (m.cw || 0);
      m.cw = 0;
    }
    return h;
  }

  // ---------- render mesh data for a square patch ----------
  // n quads per side over `size` metres starting at (x0, z0). Returns typed arrays (transferable):
  //   position (xyz), normal (xyz), mask (track, soft, rock, crest – 0..255), route (d, s, slip), index.
  // A skirt (dropped `skirt` m) runs round the edge to hide cracks between LOD levels.
  meshData(x0, z0, size, n, skirt = 3) {
    const st = size / n, N = n + 3;                       // +1 border ring for normals
    const H = new Float32Array(N * N);
    const V = (n + 1) * (n + 1), S = 4 * n + 4;           // grid + skirt vertices
    const pos = new Float32Array((V + S) * 3), nor = new Float32Array((V + S) * 3);
    const mask = new Uint8Array((V + S) * 4), route = new Float32Array((V + S) * 3);
    const m = this._m;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const inner = i >= 1 && j >= 1 && i <= n + 1 && j <= n + 1;
      const x = x0 + (i - 1) * st, z = z0 + (j - 1) * st;
      H[j * N + i] = this.heightExact(x, z, inner);
      if (inner) {
        const v = (j - 1) * (n + 1) + (i - 1);
        mask[v * 4] = m.track * 255; mask[v * 4 + 1] = m.soft * 255; mask[v * 4 + 2] = m.rock * 255; mask[v * 4 + 3] = clamp(m.crest, 0, 1) * 255;
        route[v * 3] = clamp(m.d, -999, 999); route[v * 3 + 1] = m.s; route[v * 3 + 2] = m.slip;
      }
    }
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i, k = (j + 1) * N + (i + 1);
      pos[v * 3] = x0 + i * st; pos[v * 3 + 1] = H[k]; pos[v * 3 + 2] = z0 + j * st;
      const dx = (H[k + 1] - H[k - 1]) / (2 * st), dz = (H[k + N] - H[k - N]) / (2 * st), l = Math.hypot(dx, 1, dz);
      nor[v * 3] = -dx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -dz / l;
    }
    // skirt: walk the border, copy vertex, drop it
    const border = [];
    for (let i = 0; i < n; i++) border.push(i);                               // z0 edge
    for (let j = 0; j < n; j++) border.push(j * (n + 1) + n);                 // x1 edge
    for (let i = n; i > 0; i--) border.push(n * (n + 1) + i);                 // z1 edge
    for (let j = n; j > 0; j--) border.push(j * (n + 1));                     // x0 edge
    border.push(0);
    border.forEach((v, b) => {
      const w = V + b;
      pos[w * 3] = pos[v * 3]; pos[w * 3 + 1] = pos[v * 3 + 1] - skirt; pos[w * 3 + 2] = pos[v * 3 + 2];
      for (let c = 0; c < 3; c++) { nor[w * 3 + c] = nor[v * 3 + c]; route[w * 3 + c] = route[v * 3 + c]; }
      for (let c = 0; c < 4; c++) mask[w * 4 + c] = mask[v * 4 + c];
    });
    const idx = new Uint32Array(n * n * 6 + (border.length - 1) * 6);
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // split along the shorter diagonal-ish: alternate for less directional artefacts
      if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
      else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
    }
    for (let b = 0; b < border.length - 1; b++) {
      const t0 = border[b], t1 = border[b + 1], s0 = V + b, s1 = V + b + 1;
      // outward-facing (winding chosen so the skirt faces out; material is double-sided-safe anyway)
      idx[q++] = t0; idx[q++] = t1; idx[q++] = s0; idx[q++] = t1; idx[q++] = s1; idx[q++] = s0;
    }
    return { position: pos, normal: nor, mask, route, index: idx };
  }

  // physics tile data (for workers): h, soft, trk, rk typed arrays
  tileData(ix, iz) { const t = this._bake(ix, iz); this.tiles.delete(this._tileKey(ix, iz)); this._last = null; return t; }
  insertTile(t) {
    t.used = ++this._lru; this.tiles.set(this._tileKey(t.ix, t.iz), t);
    if (this.tiles.size > this.maxTiles) { let old = null; for (const v of this.tiles.values()) if (!old || v.used < old.used) old = v; this.tiles.delete(this._tileKey(old.ix, old.iz)); if (this._last === old) this._last = null; }
  }

  // ---------- cached tiles for physics ----------
  _tileKey(ix, iz) { return (ix + 32768) * 65536 + (iz + 32768); }
  _bake(ix, iz) {
    const h = new Float32Array(TN * TN), soft = new Uint8Array(TN * TN), trk = new Uint8Array(TN * TN), rk = new Uint8Array(TN * TN);
    const x0 = ix * TILE, z0 = iz * TILE, m = this._m;
    for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
      const k = j * TN + i;
      h[k] = this.heightExact(x0 + i * RES, z0 + j * RES, true);
      soft[k] = (m.soft * 255) | 0; trk[k] = (m.track * 255) | 0; rk[k] = (m.rock * 255) | 0;
    }
    const t = { ix, iz, h, soft, trk, rk, used: ++this._lru };
    this.tiles.set(this._tileKey(ix, iz), t);
    if (this.tiles.size > this.maxTiles) {   // evict least recently used
      let old = null; for (const v of this.tiles.values()) if (!old || v.used < old.used) old = v;
      this.tiles.delete(this._tileKey(old.ix, old.iz)); if (this._last === old) this._last = null;
    }
    return t;
  }
  _tile(x, z) {
    const ix = Math.floor(x / TILE), iz = Math.floor(z / TILE);
    let t = this._last;
    if (t && t.ix === ix && t.iz === iz) return t;
    t = this.tiles.get(this._tileKey(ix, iz));
    if (!t || t.ix !== ix || t.iz !== iz) t = this._bake(ix, iz);
    t.used = ++this._lru; this._last = t;
    return t;
  }
  hasTile(x, z) { const ix = Math.floor(x / TILE), iz = Math.floor(z / TILE); const t = this.tiles.get(this._tileKey(ix, iz)); return !!t && t.ix === ix && t.iz === iz; }

  // bilinear height from the 0.5 m cache – this is what physics uses
  height(x, z) {
    const t = this._tile(x, z);
    const fx = (x - t.ix * TILE) / RES, fz = (z - t.iz * TILE) / RES;
    const i = Math.min(TN - 2, fx | 0), j = Math.min(TN - 2, fz | 0), u = fx - i, v = fz - j, k = j * TN + i, H = t.h;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + TN] * (1 - u) + H[k + TN + 1] * u) * v;
  }
  normal(x, z, e = 0.3) {
    const dx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e), dz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
  }
  // physics surface at (x, z): { grip (×), roll (coefficient) } blended from the masks
  surface(x, z) {
    const t = this._tile(x, z);
    const i = Math.round((x - t.ix * TILE) / RES), j = Math.round((z - t.iz * TILE) / RES), k = clamp(j, 0, TN - 1) * TN + clamp(i, 0, TN - 1);
    const soft = t.soft[k] / 255, trk = t.trk[k] / 255, rk = t.rk[k] / 255;
    const gravel = Math.max(0, 1 - soft - trk - rk);
    const o = this._surf || (this._surf = { grip: 1, roll: 0.02, soft: 0, track: 0, rock: 0 });
    const S = SURFACES, sum = soft + trk + rk + gravel || 1;
    o.grip = (S.soft.grip * soft + S.track.grip * trk + S.rock.grip * rk + S.gravel.grip * gravel) / sum;
    o.roll = (S.soft.roll * soft + S.track.roll * trk + S.rock.roll * rk + S.gravel.roll * gravel) / sum;
    o.soft = soft; o.track = trk; o.rock = rk;
    return o;
  }

  // bake missing tiles around (x, z) within a time budget (ms). Call every frame per truck.
  prefetch(x, z, radius = 80, budgetMs = 4, vx = 0, vz = 0) {
    const t0 = performance.now();
    const cx = x + vx * 1.5, cz = z + vz * 1.5;   // lead the motion
    const r = Math.ceil(radius / TILE), ix0 = Math.floor(cx / TILE), iz0 = Math.floor(cz / TILE);
    const list = [];
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const ix = ix0 + a, iz = iz0 + b;
      const dx = Math.max(0, Math.abs((ix + 0.5) * TILE - cx) - TILE / 2), dz = Math.max(0, Math.abs((iz + 0.5) * TILE - cz) - TILE / 2);
      if (dx * dx + dz * dz > radius * radius) continue;
      const t = this.tiles.get(this._tileKey(ix, iz));
      if (t && t.ix === ix && t.iz === iz) { t.used = ++this._lru; continue; }
      list.push([dx * dx + dz * dz, ix, iz]);
    }
    list.sort((p, q) => p[0] - q[0]);
    let baked = 0;
    for (const [, ix, iz] of list) {
      if (baked && performance.now() - t0 > budgetMs) break;
      this._bake(ix, iz); baked++;
    }
    return list.length - baked;   // tiles still missing
  }
}

export { Simplex, sstep, clamp, lerp, TILE, RES };
