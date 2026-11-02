// TruckDirt.js – sand that sticks to a monster truck and falls off again (three.js r150+).
//
// Patches the truck's own materials (no extra meshes or draw calls) with a dirt layer:
//   • tyres   – pick up a dusty film quickly while driving
//   • low     – splash on the lower body, sills, bumpers and the whole chassis from roost, slides
//               and landings; also fed by real thrown sand grains that hit the truck (SandFX catcher)
//   • top     – roof / upper sides get caked when the truck rolls or slides on its body
// Dirt is patchy (object-space noise, so it moves with the truck), turns paint matte and kills
// the clearcoat where it sits. It sheds over time – faster when driving, bouncing and after a
// recovery – and the sand that falls off is emitted as real grains through SandFX.shed().
//
//   const dirt = new TruckDirt(rig.root, { sand });   // after loading the GLB, before first render
//   sand.addCatcher(dirt.catcher(truck));              // optional: thrown grains stick to this truck
//   per frame:  dirt.update(dt, truck);                // truck = TruckBody from MonsterTruckSim
//   dirt.wash() to clean, dirt.set({ tyre, low, top }) to force levels (0..1).
import * as THREE from 'three';

const NOISE = /* glsl */`
  uniform float uDirtTyre; uniform float uDirtLow; uniform float uDirtTop; uniform float uDirtMode;
  uniform vec3 uDirtCol;
  varying vec3 vDirtP; varying vec3 vDirtN;
  float dh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float dnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(dh(i), dh(i+vec3(1,0,0)), f.x), mix(dh(i+vec3(0,1,0)), dh(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(dh(i+vec3(0,0,1)), dh(i+vec3(1,0,1)), f.x), mix(dh(i+vec3(0,1,1)), dh(i+vec3(1,1,1)), f.x), f.y), f.z); }
  float dfbm(vec3 p){ return 0.55*dnoise(p) + 0.3*dnoise(p*2.13+7.1) + 0.15*dnoise(p*4.7+3.3); }
  // returns x = patch mask (thick sand), y = film (light dust)
  vec2 dirtMask(){
    vec3 p = vDirtP; float big = dfbm(p * vec3(2.2, 1.3, 2.2)), fine = dnoise(p * 9.0 + 2.0);
    float streak = dnoise(p * vec3(10.0, 1.4, 10.0) + 5.0), spots = dnoise(p * 17.0 + 9.0);
    float low = 0.0, top = 0.0, film = 0.0;
    if (uDirtMode < 0.5) {            // body shell (GLB root frame: body spans y≈1.3..3.1)
      float h = clamp((2.45 - p.y) / 1.15, 0.0, 1.0);
      float rear = clamp(0.5 - p.z / 4.0, 0.0, 1.0);          // more behind the wheels / at the back
      float upFacing = clamp(vDirtN.y, 0.0, 1.0), sideFacing = 1.0 - abs(vDirtN.y);
      low = uDirtLow * h * (0.75 + 0.45 * rear) * (0.6 + 0.4 * sideFacing);
      top = uDirtTop * (clamp((p.y - 2.0) / 0.9, 0.0, 1.0) * 0.45 + 0.75) * (0.7 + 0.3 * max(upFacing, sideFacing));
      film = max(uDirtLow * h * 0.45, uDirtTop * 0.4);
    } else if (uDirtMode < 1.5) {     // wheels: tyres dust up all over, rims less
      float r = length(p.yz);
      float tyre = smoothstep(0.50, 0.58, r);                  // rim edge ≈0.48 m, tyre beyond
      low = uDirtTyre * mix(0.2, 0.45, tyre); top = uDirtTop * 0.4;
      film = uDirtTyre * mix(0.35, 0.95, tyre);
    } else {                          // chassis, axles, shocks, links: low and filthy
      low = uDirtLow * 1.1 + uDirtTyre * 0.3; top = uDirtTop * 0.45; film = low * 0.6;
    }
    float cover = pow(clamp(max(low, top), 0.0, 1.0), 1.4);
    float n = big * 0.5 + streak * 0.3 + spots * 0.2;
    float patchM = smoothstep(1.0 - cover * 1.05, 1.0 - cover * 1.05 + 0.07, n);
    return vec2(patchM, clamp(film, 0.0, 1.0) * (0.55 + 0.45 * big));
  }`;

function patch(material, u, mode) {
  const m = material.clone();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uDirtMode: { value: mode } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDirtP; varying vec3 vDirtN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDirtP = position; vDirtN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        vec2 dM = dirtMask();
        float dAmt = max(dM.x * 0.92, dM.y * (uDirtMode > 0.5 && uDirtMode < 1.5 ? 0.6 : 0.32));
        vec3 dCol = uDirtCol * (0.82 + 0.3 * dnoise(vDirtP * 23.0)) * (1.0 - 0.18 * dM.x);   // packed sand is a bit darker
        diffuseColor.rgb = mix(diffuseColor.rgb, dCol, dAmt);
        roughnessFactor = mix(roughnessFactor, 0.97, dAmt);
        metalnessFactor = mix(metalnessFactor, 0.0, dAmt);`);
    if (shader.fragmentShader.includes('#include <lights_physical_fragment>'))
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n material.clearcoat *= 1.0 - dAmt;\n#endif');
  };
  m.customProgramCacheKey = () => 'truckdirt' + mode;
  return m;
}

export class TruckDirt {
  constructor(root, o = {}) {
    this.root = root.getObjectByName?.('MonsterTruck') || root;
    this.sand = o.sand || null;
    this.u = {
      uDirtTyre: { value: o.tyre ?? 0.15 }, uDirtLow: { value: o.low ?? 0 }, uDirtTop: { value: o.top ?? 0 },
      uDirtCol: { value: new THREE.Color(o.color ?? 0xcfae7c) },
    };
    this.level = { tyre: this.u.uDirtTyre.value, low: this.u.uDirtLow.value, top: this.u.uDirtTop.value };
    this.root.traverse((obj) => {
      if (!obj.isMesh) return;
      const nm = obj.name + '|' + (obj.parent?.name || '');
      const mode = /(^|\|)Body/.test(nm) ? 0 : /(^|\|)Wheel_/.test(nm) ? 1 : 2;
      obj.material = Array.isArray(obj.material) ? obj.material.map((m) => patch(m, this.u, mode)) : patch(obj.material, this.u, mode);
    });
    this._shedAcc = 0; this._wasUpside = false; this._caught = 0;
  }
  set(l) { Object.assign(this.level, l); this._apply(); }
  wash() { this.set({ tyre: 0, low: 0, top: 0 }); }
  _apply() { this.u.uDirtTyre.value = this.level.tyre; this.u.uDirtLow.value = this.level.low; this.u.uDirtTop.value = this.level.top; }

  // thrown sand grains that hit this truck's body box stick to it
  catcher(truck) {
    const b = truck.p.hullBox;
    return (x, y, z) => {
      const dx = x - truck.pos[0], dy = y - truck.pos[1], dz = z - truck.pos[2];
      if (dx * dx + dy * dy + dz * dz > 16) return false;
      const q = truck.q;  // world → truck local (inverse rotate)
      const ix = -q[0], iy = -q[1], iz = -q[2], w = q[3];
      const tx = 2 * (iy * dz - iz * dy), ty = 2 * (iz * dx - ix * dz), tz = 2 * (ix * dy - iy * dx);
      const lx = dx + w * tx + (iy * tz - iz * ty), ly = dy + w * ty + (iz * tx - ix * tz) + truck.p.cgHeight, lz = dz + w * tz + (ix * ty - iy * tx);
      if (Math.abs(lx - b.center[0]) < b.half[0] && Math.abs(ly - b.center[1]) < b.half[1] && Math.abs(lz - b.center[2]) < b.half[2]) {
        this._caught++; return Math.random() < 0.6;   // most stick, some bounce through
      }
      return false;
    };
  }

  update(dt, truck) {
    const L = this.level, sp = truck.speed;
    let slip = 0, roost = 0, contacts = 0;
    for (const k in truck.wheels) { const w = truck.wheels[k]; if (w.contact) { contacts++; slip += Math.abs(w.slipLat); roost += w.slipLong; } }
    // pick-up
    if (contacts) L.tyre += dt * (0.04 * Math.min(1, sp / 8) + 0.003 * (slip + roost));
    L.low += dt * (0.0012 * roost + 0.0018 * slip) * (contacts ? 1 : 0) + this._caught * 0.0006;
    this._caught = 0;
    if (truck.hullContact && truck.tilt > 0.6) L.top += dt * (0.28 + 0.06 * Math.min(8, sp));   // rolling / sliding on the body
    if (truck.hullContact && truck.tilt > 0.6) L.low += dt * 0.05;
    // landings knock some off, sliding on the roof packs it on
    if (!truck._dirtLand) { truck._dirtLand = true; const prev = truck.onLand; truck.onLand = (v, i) => { prev?.(v, i); this._jolt = Math.min(1, v / 8); }; }
    // shedding: vibration + airflow when upright and moving, plus jolts; tyres fling it off at speed
    const upright = truck.tilt < 0.5;
    let shedTop = upright ? dt * (0.02 + 0.006 * Math.min(15, sp)) : dt * 0.004;
    let shedLow = upright ? dt * (0.004 + 0.0015 * Math.min(15, sp)) : 0;
    if (this._jolt) { shedTop += 0.06 * this._jolt; shedLow += 0.02 * this._jolt; this._jolt = 0; }
    const wasUpside = this._wasUpside; this._wasUpside = truck.tilt > 1.6;
    if (wasUpside && !this._wasUpside) shedTop += 0.07;                        // righted / recovered: a chunk slides off
    const dTop = Math.min(L.top, shedTop), dLow = Math.min(L.low, shedLow);
    L.top -= dTop; L.low -= dLow;
    L.tyre -= dt * (0.004 + 0.002 * Math.min(10, sp)) * (contacts ? 0.3 : 1);
    for (const k of ['tyre', 'low', 'top']) L[k] = Math.max(0, Math.min(k === 'top' ? 0.75 : 0.85, L[k]));
    this._apply();
    // emit what fell off as real grains from the upper / lower body
    if (this.sand) {
      this._shedAcc += dTop * 420 + dLow * 260;
      const n = Math.min(50, Math.floor(this._shedAcc)); this._shedAcc -= n;
      if (n > 0) {
        const pts = [], b = truck.p.hullBox;
        for (let i = 0; i < n; i++) {
          const top = Math.random() < dTop / (dTop + dLow + 1e-6);
          const lx = b.center[0] + (Math.random() * 2 - 1) * b.half[0];
          const ly = top ? b.center[1] + b.half[1] * (0.4 + 0.6 * Math.random()) : b.center[1] - b.half[1] * (0.3 + 0.7 * Math.random());
          const lz = b.center[2] + (Math.random() * 2 - 1) * b.half[2];
          pts.push(truck.toWorld([lx, ly, lz]));
        }
        this.sand.shed(pts, truck.vel);
      }
    }
  }
}
