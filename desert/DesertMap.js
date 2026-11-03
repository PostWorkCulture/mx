// DesertMap.js – renders and streams the MX desert (three.js r150+).
//
//   import { DesertMap } from './DesertMap.js';
//   const map = new DesertMap({ scene, renderer, terrainOpts: { routes: SPRINT_ROUTES, buttes: BUTTES } });
//   await map.init(startX, startZ, (p) => loadingBar(p));
//   const world = new TruckWorld({ groundHeight: map.terrain.height, surface: map.terrain.surface });
//   // every frame:
//   map.update(dt, camera, [truck.pos, …], [truck.vel, …]);
//
// What it does
//   • TerrainBaker: a pool of module workers (TerrainWorker.js) bakes physics tiles and render meshes,
//     so streaming never stalls the frame. If physics asks for a tile that isn't ready it is baked
//     synchronously (≈50 ms) – prefetching around each truck makes that rare.
//   • Ground: 64 m tiles in three LODs (0.5 m / 1 m / 2 m) out to ~420 m, skirts hide LOD cracks,
//     plus a 12 km far-field mesh (24 m) that discards itself inside the tile ring.
//   • Atmosphere: physical sky, low golden sun with soft shadows that follow the camera, PMREM
//     environment from the sky (truck paint reflects it), exponential haze matched to the horizon.
//   • Race dressing for a route: start / finish gantries, inflatable checkpoint arches, edge marker flags
//     (instanced). Static colliders for the gantry legs are in map.colliders (feed to world.addStaticBox).
//   • Scatter: boulders (talus round buttes, canyon floor, gravel plains) and dry shrubs, instanced.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { DesertTerrain, TILE } from './DesertTerrain.js';
import { createSandMaterial } from './SandMaterial.js';

// ------------------------------------------------------------------ worker pool
export class TerrainBaker {
  constructor(opts, count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    this.workers = []; this.queue = []; this.busy = new Map(); this._id = 0; this.cbs = new Map();
    const url = new URL('./TerrainWorker.js', import.meta.url);
    this.ready = Promise.all(Array.from({ length: count }, () => new Promise((res) => {
      const w = new Worker(url, { type: 'module' });
      w.onmessage = (e) => {
        if (e.data.type === 'ready') { this.workers.push(w); res(); this._pump(); return; }
        const cb = this.cbs.get(e.data.id); this.cbs.delete(e.data.id); this.busy.delete(w); cb?.(e.data); this._pump();
      };
      w.onerror = (e) => console.error('TerrainWorker', e.message);
      w.postMessage({ type: 'init', opts });
    })));
  }
  // priority: lower first
  request(msg, priority, cb) { const id = ++this._id; msg.id = id; this.cbs.set(id, cb); this.queue.push({ msg, priority }); this._sorted = false; this._pump(); return id; }
  cancel(pred) { this.queue = this.queue.filter((q) => { if (pred(q.msg)) { this.cbs.delete(q.msg.id); return false; } return true; }); }
  _pump() {
    if (!this._sorted) { this.queue.sort((a, b) => a.priority - b.priority); this._sorted = true; }
    for (const w of this.workers) {
      if (this.busy.has(w) || !this.queue.length) continue;
      const { msg } = this.queue.shift(); this.busy.set(w, msg.id); w.postMessage(msg);
    }
  }
  get pending() { return this.queue.length + this.busy.size; }
  dispose() { for (const w of this.workers) w.terminate(); }
}

function geometryFrom(d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(d.mask, 4, true));
  g.setAttribute('aRoute', new THREE.BufferAttribute(d.route, 3));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// terrain mesh LODs (vertices per 64 m tile side, radius). Sand detail comes from the shader, so the near mesh can be
// coarser than the 0.5 m physics grid – about half the triangles of the old 128/64/32 set, and faster to stream.
const LODS = [{ n: 96, r: 60 }, { n: 48, r: 160 }, { n: 24, r: 430 }];
// ultra (dedicated GPU): the finest mesh reaches half as far again and the detailed ring runs to ~650 m, so
// dune shapes stay crisp toward the horizon instead of melting into the far field
const LODS_ULTRA = [{ n: 128, r: 90 }, { n: 64, r: 250 }, { n: 32, r: 650 }];

// ------------------------------------------------------------------ map
export class DesertMap {
  constructor({ scene, renderer, terrainOpts = {}, sunElevation = 21, sunAzimuth = 205, shadows = true, quality = 'high' } = {}) {
    this.scene = scene; this.renderer = renderer;
    this.terrainOpts = terrainOpts;
    this.terrain = new DesertTerrain(terrainOpts);
    this.baker = new TerrainBaker(terrainOpts);
    this.root = new THREE.Group(); this.root.name = 'DesertMap'; scene.add(this.root);
    this.tiles = new Map();                 // key → { ix, iz, lod, mesh, pending }
    this.colliders = [];
    this.wind = this.terrain.wind; this.windSpeed = 8; this.gust = 0.5; this.time = 0;
    this.quality = quality;
    this.lods = quality === 'ultra' ? LODS_ULTRA : LODS;
    // sun direction (toward the sun): azimuth measured from +Z toward +X (°), elevation above horizon
    const el = THREE.MathUtils.degToRad(sunElevation), az = THREE.MathUtils.degToRad(sunAzimuth);
    this.sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    // sun colour / strength by elevation: deep orange near the horizon → warm white at midday
    const k = THREE.MathUtils.clamp((sunElevation - 4) / 40, 0, 1);
    this.sunColor = new THREE.Color().setRGB(1.0, 0.62 + 0.34 * Math.sqrt(k), 0.36 + 0.54 * k);
    this.sunIntensity = 3.0 + 2.3 * Math.sqrt(k);   // hard desert sun: strong light / shade modelling on the dunes
    this.sunElevation = sunElevation;
    this.material = createSandMaterial({ sunDir: this.sunDir, sunColor: this.sunColor, wind: this.wind });
    this.farMaterial = createSandMaterial({ sunDir: this.sunDir, sunColor: this.sunColor, wind: this.wind, farField: true, nearRadius: this.lods[2].r - 30 });
    this._buildAtmosphere(shadows);
    this._physPending = new Set();
  }

  // ---------------- atmosphere
  _buildAtmosphere(shadows) {
    const { scene, renderer } = this;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.62;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }   // PCF + radius: soft edges, far cheaper than PCFSoft at 4K
    const sky = new Sky(); sky.scale.setScalar(20000); sky.name = 'Sky';
    const u = sky.material.uniforms;
    u.turbidity.value = 8; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDir);
    this.sky = sky; scene.add(sky);
    // environment lighting from the sky
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene(); const sky2 = new Sky(); sky2.scale.setScalar(1000);
    sky2.material.uniforms.turbidity.value = u.turbidity.value;
    for (const k of ['rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = u[k].value;
    sky2.material.uniforms.sunPosition.value.copy(this.sunDir);
    envScene.add(sky2);
    // warm ground bounce in the lower hemisphere of the env map
    const ground = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.55, 0.36, 0.2), side: THREE.BackSide }));
    envScene.add(ground);
    this.envRT = pm.fromScene(envScene, 0.02); scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.75;
    pm.dispose();
    // sun
    const sun = new THREE.DirectionalLight(this.sunColor, this.sunIntensity);
    sun.castShadow = shadows;
    // ultra: 4096² over a wider box – sharper contact shadows under the trucks and shadows that reach further out
    const ultra = this.quality === 'ultra';
    sun.shadow.mapSize.set(ultra ? 4096 : 2048, ultra ? 4096 : 2048);
    const S = ultra ? 140 : 95; Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 700 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06; sun.shadow.radius = 2.5;
    this.sun = sun; scene.add(sun); scene.add(sun.target);
    // haze matched to the horizon
    const kk = THREE.MathUtils.clamp((this.sunElevation - 4) / 40, 0, 1);
    const haze = new THREE.Color().setRGB(0.86 - 0.06 * kk, 0.66 + 0.06 * kk, 0.48 + 0.14 * kk, THREE.SRGBColorSpace);
    scene.environmentIntensity = 0.42 + 0.25 * kk;
    renderer.toneMappingExposure = 0.55 + 0.1 * kk;
    scene.fog = new THREE.FogExp2(haze, 0.00032);
    this.haze = haze;
  }

  // ---------------- streaming
  async init(x, z, onProgress) {
    await this.baker.ready;
    const far = this.far ? Promise.resolve() : new Promise((res) => this.baker.request({ type: 'mesh', x0: -6000, z0: -6000, size: 12000, n: this.quality === 'ultra' ? 400 : 240, skirt: 0 }, -1, (d) => {
      const mesh = new THREE.Mesh(geometryFrom(d), this.farMaterial); mesh.name = 'FarField'; mesh.receiveShadow = false;
      mesh.frustumCulled = false; mesh.renderOrder = -1;
      this.root.add(mesh); this.far = mesh; res();
    }));
    // physics + near tiles around the start
    this.prefetchPhysics(x, z, 100, 0, 0);
    const cam = new THREE.Vector3(x, 0, z);
    this._updateTiles(cam, true);
    const total = this.baker.pending;
    await new Promise((res) => {
      const tick = () => { onProgress?.(1 - this.baker.pending / Math.max(1, total)); if (this.baker.pending === 0) res(); else setTimeout(tick, 50); };
      tick();
    });
    await far;
    onProgress?.(1);
  }

  prefetchPhysics(x, z, radius = 100, vx = 0, vz = 0, lead = 2) {
    const cx = x + vx * lead, cz = z + vz * lead;
    const r = Math.ceil(radius / TILE), ix0 = Math.floor(cx / TILE), iz0 = Math.floor(cz / TILE);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const ix = ix0 + a, iz = iz0 + b, key = ix + ',' + iz;
      if (this._physPending.has(key)) continue;
      const tx = (ix + 0.5) * TILE, tz = (iz + 0.5) * TILE;
      if (this.terrain.hasTile(tx, tz)) continue;
      const dx = Math.max(0, Math.abs(tx - cx) - TILE / 2), dz = Math.max(0, Math.abs(tz - cz) - TILE / 2), d = Math.hypot(dx, dz);
      if (d > radius) continue;
      this._physPending.add(key);
      this.baker.request({ type: 'phys', ix, iz }, d - 1000, (t) => {   // physics first
        this._physPending.delete(key);
        if (!this.terrain.hasTile(tx, tz)) this.terrain.insertTile({ ix: t.ix, iz: t.iz, h: t.h, soft: t.soft, trk: t.trk, rk: t.rk });
      });
    }
  }

  _updateTiles(cam, force = false) {
    const LODS = this.lods, maxR = LODS[LODS.length - 1].r;
    const r = Math.ceil(maxR / TILE) + 1, ix0 = Math.floor(cam.x / TILE), iz0 = Math.floor(cam.z / TILE);
    const want = new Map();
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const ix = ix0 + a, iz = iz0 + b;
      const dx = Math.max(0, Math.abs((ix + 0.5) * TILE - cam.x) - TILE / 2), dz = Math.max(0, Math.abs((iz + 0.5) * TILE - cam.z) - TILE / 2);
      const d = Math.hypot(dx, dz);
      let lod = -1;
      for (let l = 0; l < LODS.length; l++) if (d <= LODS[l].r) { lod = l; break; }
      if (lod < 0) continue;
      const key = ix + ',' + iz, cur = this.tiles.get(key);
      // hysteresis: keep a finer LOD a little longer
      if (cur && cur.lod >= 0 && cur.lod < lod && d <= LODS[cur.lod].r + 20) lod = cur.lod;
      want.set(key, { ix, iz, lod, d });
    }
    for (const [key, w] of want) {
      let t = this.tiles.get(key);
      if (!t) { t = { ix: w.ix, iz: w.iz, lod: -1, mesh: null, pending: -1 }; this.tiles.set(key, t); }
      if (t.lod === w.lod || t.pending === w.lod) continue;
      t.pending = w.lod;
      const lod = w.lod;
      this.baker.cancel((m) => m.type === 'mesh' && m.key === key);
      this.baker.request({ type: 'mesh', key, x0: w.ix * TILE, z0: w.iz * TILE, size: TILE, n: LODS[lod].n, skirt: lod === 0 ? 1.5 : 3 }, w.d + lod * 40, (d) => {
        if (t.pending !== lod || !this.tiles.has(key)) return;
        const mesh = new THREE.Mesh(geometryFrom(d), this.material);
        mesh.receiveShadow = true; mesh.castShadow = lod === 0; mesh.name = 'Tile_' + key + '_L' + lod;
        if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); }
        t.mesh = mesh; t.lod = lod; t.pending = -1; this.root.add(mesh);
      });
    }
    for (const [key, t] of this.tiles) if (!want.has(key)) {
      if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); }
      this.baker.cancel((m) => m.type === 'mesh' && m.key === key);
      this.tiles.delete(key);
    }
  }

  // ---------------- per frame
  update(dt, camera, focus = [], vels = []) {
    this.time += dt;
    // gusts: slow swell + quicker flurries
    const t = this.time;
    this.gust = THREE.MathUtils.clamp(0.45 + 0.3 * Math.sin(t * 0.21) + 0.2 * Math.sin(t * 0.83 + 1.3) * Math.sin(t * 0.37), 0, 1);
    this.material.userData.update(t, this.gust); this.farMaterial.userData.update(t, this.gust);
    // tiles follow the camera (re-evaluated every ~8 m of travel)
    const c = camera.position;
    if (!this._lastCam || this._lastCam.distanceToSquared(c) > 64) { this._updateTiles(c); (this._lastCam ||= new THREE.Vector3()).copy(c); }
    // physics tiles around every truck, leading their motion
    focus.forEach((p, i) => { const v = vels[i] || [0, 0, 0]; this.prefetchPhysics(p[0], p[2], 120, v[0], v[2], 2.5); });   // well ahead of a flat-out truck, so physics never waits on a bake
    // sun + shadow box follow the camera's look point, snapped to shadow texels to stop shimmering
    const target = focus[0] ? new THREE.Vector3(focus[0][0], focus[0][1], focus[0][2]) : c;
    const S = this.sun.shadow.camera.right * 2 / this.sun.shadow.mapSize.x;
    const tx = Math.round(target.x / S) * S, tz = Math.round(target.z / S) * S;
    this.sun.target.position.set(tx, target.y, tz);
    this.sun.position.set(tx, target.y, tz).addScaledVector(this.sunDir, 300);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(c);
  }

  // ---------------- race dressing
  addRouteDressing(route, checkpointsS = [], { start = 60, finish = null } = {}) {
    const g = new THREE.Group(); g.name = 'Route_' + route.id; this.root.add(g);
    const color = new THREE.Color(route.color || '#ff7a1a');
    const finishS = finish ?? route.length - 50;
    g.add(this._gantry(route, start, 'START', color, false));
    g.add(this._gantry(route, finishS, 'FINISH', color, true));
    checkpointsS.forEach((s, i) => g.add(this._arch(route, s, color, i + 1)));
    g.add(this._markers(route, color, start, finishS));
    return g;
  }

  _frame(route, s) {
    const p = route.pointAt(s), y = this.terrain.heightExact(p.x, p.z);
    return { x: p.x, z: p.z, y, tx: p.tx, tz: p.tz, lx: p.tz, lz: -p.tx, yaw: Math.atan2(p.tx, p.tz) };
  }

  _gantry(route, s, label, color, checkered) {
    const f = this._frame(route, s), half = route.halfWidth + 3;
    const g = new THREE.Group(); g.name = label;
    const legMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.5, metalness: 0.6 });
    const H = 8.5;
    for (const side of [-1, 1]) {
      const x = f.x + f.lx * half * side, z = f.z + f.lz * half * side, y = this.terrain.heightExact(x, z);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, H + 2, 1.1), legMat);
      leg.position.set(x, y + (H + 2) / 2 - 2, z); leg.rotation.y = f.yaw; leg.castShadow = true; g.add(leg);
      this.colliders.push({ center: [x, y + H / 2, z], half: [0.6, H / 2 + 1, 0.6], yaw: f.yaw });
      // ballast blocks
      const blk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 2.2), new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.9 }));
      blk.position.set(x, y + 0.3, z); blk.rotation.y = f.yaw; blk.castShadow = true; g.add(blk);
    }
    const tex = this._bannerTexture(label, color, checkered);
    const banner = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.1, 2.4, 0.5),
      [legMat, legMat, legMat, legMat, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 })]);
    banner.position.set(f.x, f.y + H - 0.4, f.z); banner.rotation.y = Math.atan2(-f.lz, f.lx); banner.castShadow = true;
    g.add(banner);
    return g;
  }

  _bannerTexture(label, color, checkered) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
    const x = c.getContext('2d');
    // Black-and-white race dressing: START is a black banner with white text, FINISH a chequered flag.
    if (checkered) {
      for (let i = 0; i < 32; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) & 1 ? '#0a0a0a' : '#f5f5f5'; x.fillRect(i * 32, j * 32, 32, 32); }
      x.fillStyle = '#0a0a0a'; x.fillRect(304, 16, 416, 96); x.strokeStyle = '#f5f5f5'; x.lineWidth = 4; x.strokeRect(310, 22, 404, 84);
    } else {
      x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, 1024, 128); x.fillStyle = '#f5f5f5'; x.fillRect(0, 10, 1024, 4); x.fillRect(0, 114, 1024, 4);
    }
    x.fillStyle = '#f5f5f5'; x.font = '900 84px system-ui, Arial Black, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, 512, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }

  _arch(route, s, color, n) {
    const f = this._frame(route, s), R = route.halfWidth + 2.5;
    const g = new THREE.Group(); g.name = 'Checkpoint_' + n;
    const geo = new THREE.TorusGeometry(R, 0.85, 14, 48, Math.PI);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
    const arch = new THREE.Mesh(geo, mat); arch.castShadow = true;
    // stripes: second torus slice in white near the top
    const top = new THREE.Mesh(new THREE.TorusGeometry(R, 0.88, 14, 16, Math.PI * 0.22), new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.6 }));
    top.rotation.z = Math.PI * 0.39;
    const holder = new THREE.Group(); holder.add(arch, top);
    holder.position.set(f.x, f.y - 0.6, f.z);
    holder.rotation.y = Math.atan2(-f.lz, f.lx);
    g.add(holder);
    // number board
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = '#111'; x.fillRect(0, 0, 256, 128); x.fillStyle = '#f4f1ea'; x.font = '900 86px system-ui, Arial Black, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('CP' + n, 128, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide }));
    board.position.set(f.x, f.y + R - 0.3, f.z); board.rotation.y = holder.rotation.y; g.add(board);
    for (const side of [-1, 1]) {
      const x0 = f.x + f.lx * R * side, z0 = f.z + f.lz * R * side;
      this.colliders.push({ center: [x0, this.terrain.heightExact(x0, z0) + 1.2, z0], half: [0.9, 1.4, 0.9], yaw: f.yaw });
    }
    return g;
  }

  _markers(route, color, s0, s1) {
    // poles every 25 m, alternating sides, a bit tighter on corners
    const items = [];
    for (let s = s0 + 20, k = 0; s < s1 - 10; k++) {
      const curv = Math.abs(route.at(route.curv, s));
      const side = curv > 0.004 ? -Math.sign(route.at(route.curv, s)) : (k & 1 ? 1 : -1);   // outside of corners
      const f = this._frame(route, s), off = route.halfWidth + 1.5;
      const x = f.x + f.lx * off * side, z = f.z + f.lz * off * side;
      items.push([x, this.terrain.heightExact(x, z), z, f.yaw]);
      s += curv > 0.004 ? 15 : 25;
    }
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.06, 2.6, 6).translate(0, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }), items.length);
    const flagGeo = new THREE.PlaneGeometry(0.75, 0.5, 4, 1).translate(0.4, 2.3, 0);
    const flag = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 }), items.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const wy = Math.atan2(-this.wind[1], this.wind[0]);   // flags stream downwind
    items.forEach(([x, y, z], i) => {
      m.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(0, 0, 0)), new THREE.Vector3(1, 1, 1)); pole.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(0, wy, 0)), new THREE.Vector3(1, 1, 1)); flag.setMatrixAt(i, m);
    });
    pole.castShadow = true; flag.castShadow = true;
    const g = new THREE.Group(); g.add(pole, flag); g.name = 'Markers';
    return g;
  }

  // ---------------- scatter (rocks + shrubs) along the routes
  addScatter({ seed = 3, perRoute = 1400 } = {}) {
    let a = seed * 9301 + 49297; const rnd = () => ((a = (a * 9301 + 49297) % 233280) / 233280);
    const T = this.terrain, rocks = [], shrubs = [];
    for (const r of T.routes) {
      for (let k = 0; k < perRoute; k++) {
        const s = rnd() * r.length, side = rnd() < 0.5 ? -1 : 1;
        const off = r.halfWidth + 4 + Math.pow(rnd(), 1.6) * 160;
        const p = r.pointAt(s), x = p.x + p.tz * off * side + (rnd() - 0.5) * 10, z = p.z - p.tx * off * side + (rnd() - 0.5) * 10;
        const y = T.heightExact(x, z, true), m = T._m;
        if (m.track > 0.05) continue;
        const gravel = 1 - m.soft - m.rock;
        if (m.rock > 0.2 || (gravel > 0.5 && rnd() < 0.35)) rocks.push([x, y, z, m.rock > 0.2 ? 0.8 + rnd() * 2.2 : 0.25 + rnd() * 0.7, rnd() * 6.28]);
        else if (gravel > 0.3 && rnd() < 0.5) shrubs.push([x, y, z, 0.35 + rnd() * 0.6, rnd() * 6.28]);
        else if (m.soft > 0.6 && rnd() < 0.06) shrubs.push([x, y, z, 0.3 + rnd() * 0.35, rnd() * 6.28]);
      }
      // canyon floor boulders and talus round buttes
      for (const f of r.features || []) if (f.type === 'canyon') for (let s = f.s0 + 60; s < f.s1 - 60; s += 9) {
        const p = r.pointAt(s), side = rnd() < 0.5 ? -1 : 1, off = r.halfWidth + 1 + rnd() * 3;
        const x = p.x + p.tz * off * side, z = p.z - p.tx * off * side;
        rocks.push([x, T.heightExact(x, z), z, 0.5 + rnd() * 1.4, rnd() * 6.28]);
      }
    }
    for (const b of T.buttes) for (let k = 0; k < 90; k++) {
      const ang = rnd() * 6.28, d = b.r + 5 + rnd() * 40, x = b.x + Math.cos(ang) * d, z = b.z + Math.sin(ang) * d;
      rocks.push([x, T.heightExact(x, z), z, 0.6 + rnd() * 2.6 * (1 - (d - b.r) / 50), rnd() * 6.28]);
    }
    // rock geometry: a lumpy, flattened icosahedron
    const rg = new THREE.IcosahedronGeometry(1, 1), pa = rg.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i);
      const n = 0.75 + 0.35 * Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3 - v.y) + 0.12 * Math.sin(v.x * 9 + v.z * 7);
      v.multiplyScalar(n); v.y *= 0.62; pa.setXYZ(i, v.x, v.y, v.z);
    }
    rg.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.36, 0.17, 0.09), roughness: 0.9, flatShading: true });
    const col = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    // instances are split into 300 m cells, one InstancedMesh each, so groups off screen (and outside the
    // shadow box) are culled – a single mesh spanning the whole map was drawn in full every frame, twice
    const chunked = (geo, mat, items, place, name) => {
      const cells = new Map(), g = new THREE.Group(); g.name = name;
      for (const it of items) { const k = Math.floor(it[0] / 300) + ',' + Math.floor(it[2] / 300); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(it); }
      for (const list of cells.values()) {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((it, i) => place(im, it, i));
        im.computeBoundingSphere(); g.add(im);
      }
      return g;
    };
    const rim = chunked(rg, rockMat, rocks, (im, [x, y, z, s, r], i) => {
      m4.compose(new THREE.Vector3(x, y - s * 0.2, z), q.setFromEuler(e.set((rnd() - 0.5) * 0.4, r, (rnd() - 0.5) * 0.4)), new THREE.Vector3(s, s * (0.7 + rnd() * 0.5), s * (0.8 + rnd() * 0.4)));
      im.setMatrixAt(i, m4); { const k = 0.75 + rnd() * 0.45; im.setColorAt(i, col.setRGB(k, k * (0.92 + rnd() * 0.12), k * (0.85 + rnd() * 0.15))); }
      im.castShadow = true; im.receiveShadow = true;
    }, 'Rocks');
    // shrub: a spiky dry tuft – crossed cones of thin twigs as a low-poly ball
    const sg = new THREE.IcosahedronGeometry(1, 1), sp = sg.attributes.position;
    for (let i = 0; i < sp.count; i++) { v.fromBufferAttribute(sp, i); const k = 0.6 + 0.6 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1); v.multiplyScalar(k); v.y = Math.abs(v.y) * 0.8; sp.setXYZ(i, v.x, v.y, v.z); }
    sg.computeVertexNormals();
    const shrubMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.32, 0.27, 0.16), roughness: 1, flatShading: true });
    const sim = chunked(sg, shrubMat, shrubs, (im, [x, y, z, s, r], i) => {
      m4.compose(new THREE.Vector3(x, y - 0.05, z), q.setFromEuler(e.set(0, r, 0)), new THREE.Vector3(s, s * 0.8, s)); im.setMatrixAt(i, m4);
      im.setColorAt(i, col.setRGB(0.8 + rnd() * 0.4, 0.8 + rnd() * 0.35, 0.7 + rnd() * 0.3));
      im.castShadow = true;
    }, 'Shrubs');
    this.root.add(rim, sim);
    return { rocks: rocks.length, shrubs: shrubs.length };
  }

  dispose() {
    this.baker.dispose();
    this.root.traverse((o) => { o.geometry?.dispose(); });
    this.scene.remove(this.root, this.sky, this.sun, this.sun.target);
    this.envRT.dispose();
  }
}
