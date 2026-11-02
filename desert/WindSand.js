// WindSand.js – the wind moving sand (three.js r150+).
//
//   spindrift   – plumes of fine sand streaming off dune brinks and settling over the slip faces
//   saltation   – grains hopping low over soft sand in the wind (a moving shimmer at tyre height)
//   dust devils – the occasional whirl wandering across the plains
//
// Strength follows map.gust (0..1). Spawns only where the terrain cache already has tiles, so it
// never stalls on a bake.
//
//   const windSand = new WindSand(scene, { terrain, wind: terrain.wind });
//   windSand.update(dt, camera, map.gust);
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute float aSize; attribute float aAlpha;
  varying float vAlpha; uniform float uScale;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float ps = aSize * uScale / max(0.1, -mvPosition.z);
    gl_PointSize = clamp(ps, 1.0, 256.0);
    vAlpha = aAlpha * clamp(ps * ps, 0.0, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uSoft;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c);
    if (r > 1.0) discard;
    float a = vAlpha * mix(1.0 - smoothstep(0.5, 1.0, r), exp(-r * 2.8), uSoft);
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

class Pool {
  constructor(scene, max, color, soft, name) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max); this.size = new Float32Array(max);
    this.a0 = new Float32Array(max); this.grav = new Float32Array(max); this.k = new Uint8Array(max); this.extra = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aSize', this.aSize); g.setAttribute('aAlpha', this.aAlpha);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) }, uSoft: { value: soft }, uScale: { value: 600 } }]),
    });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.name = name;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, size, alpha, grav, kind = 0) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3);
    this.age[i] = 0; this.life[i] = life; this.size[i] = size; this.a0[i] = alpha; this.grav[i] = grav; this.k[i] = kind;
    return i;
  }
  kill(i) {
    const j = --this.n; if (i === j) return;
    this.p.copyWithin(i * 3, j * 3, j * 3 + 3); this.v.copyWithin(i * 3, j * 3, j * 3 + 3); this.extra.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.a0[i] = this.a0[j]; this.grav[i] = this.grav[j]; this.k[i] = this.k[j];
  }
  upload(sizeFn, alphaFn) {
    const P = this.aPos.array, S = this.aSize.array, A = this.aAlpha.array;
    for (let i = 0; i < this.n; i++) {
      P[i * 3] = this.p[i * 3]; P[i * 3 + 1] = this.p[i * 3 + 1]; P[i * 3 + 2] = this.p[i * 3 + 2];
      const t = this.age[i] / this.life[i]; S[i] = sizeFn(this.size[i], t); A[i] = alphaFn(this.a0[i], t);
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
  }
}

export class WindSand {
  constructor(scene, { terrain, wind = [1, 0.18], windSpeed = 8, color = 0xe9cfa3, intensity = 1, devils = true } = {}) {
    this.T = terrain; this.wind = wind; this.windSpeed = windSpeed; this.intensity = intensity; this.devilsOn = devils;
    this.plume = new Pool(scene, 7000, color, 1.0, 'Spindrift');
    this.salt = new Pool(scene, 3500, 0xd8b585, 0.4, 'Saltation');
    this.devil = new Pool(scene, 1600, 0xcfae84, 1.0, 'DustDevil');
    this.devils = []; this._nextDevil = 6; this.time = 0;
    this._rng = 12345;
  }
  _r() { this._rng = (this._rng * 16807) % 2147483647; return this._rng / 2147483647; }
  _h(x, z) { return this.T.hasTile(x, z) ? this.T.height(x, z) : null; }

  update(dt, camera, gust = 0.5, renderer = null) {
    dt = Math.min(dt, 0.05); this.time += dt;
    const T = this.T, [wx, wz] = this.wind, W = this.windSpeed * (0.6 + 0.8 * gust), I = this.intensity;
    const cx = camera.position.x, cz = camera.position.z;
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const scale = renderer ? renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) : 600;
    for (const p of [this.plume, this.salt, this.devil]) p.mat.uniforms.uScale.value = scale;

    // ---- spindrift: probe for brinks ahead of the camera
    const probes = Math.round(380 * I * (0.3 + gust));
    for (let k = 0; k < probes; k++) {
      const d = 8 + this._r() * 110, a = (this._r() - 0.5) * 2.2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = cx + (fwd.x * ca - fwd.z * sa) * d, z = cz + (fwd.z * ca + fwd.x * sa) * d;
      const h0 = this._h(x, z); if (h0 == null) continue;
      const h1 = this._h(x + wx * 3, z + wz * 3), hb = this._h(x - wx * 3, z - wz * 3);
      if (h1 == null || hb == null) continue;
      if (h0 - h1 < 0.9 || h0 - hb < 0.05) continue;           // a brink: rises upwind side, drops downwind
      if (T.surface(x, z).soft < 0.5) continue;
      const n = 5 + ((this._r() * 10 * gust) | 0);
      for (let j = 0; j < n; j++) {
        const o = (this._r() - 0.5) * 4, px = x - wz * o, pz = z + wx * o;
        const v = W * (0.45 + 0.4 * this._r());
        this.plume.spawn(px, h0 + 0.05 + this._r() * 0.3, pz, wx * v, 0.5 + this._r() * 1.4, wz * v, 1.8 + this._r() * 2.6, 0.7 + this._r() * 1.3, 0.09 + 0.12 * gust, 0.7);
      }
    }
    // ---- saltation near the camera
    const sN = Math.round(900 * dt * I * (0.2 + gust * 1.3) * 10);
    for (let k = 0; k < sN; k++) {
      const x = cx + (this._r() - 0.5) * 70 + fwd.x * 25, z = cz + (this._r() - 0.5) * 70 + fwd.z * 25;
      const h = this._h(x, z); if (h == null) continue;
      if (T.surface(x, z).soft < 0.6) continue;
      const v = W * (0.5 + 0.4 * this._r());
      this.salt.spawn(x, h + 0.02, z, wx * v, 0.6 + this._r() * 1.4, wz * v, 0.5 + this._r() * 0.7, 0.012 + this._r() * 0.02, 0.5, 9.8, 1);
    }
    // ---- dust devils
    if (this.devilsOn) {
      this._nextDevil -= dt;
      if (this._nextDevil < 0 && this.devils.length < 2) {
        const a = this._r() * Math.PI * 2, d = 140 + this._r() * 260, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        if (T.hasTile(x, z) || true) this.devils.push({ x, z, age: 0, life: 25 + this._r() * 25, r: 2 + this._r() * 3, h: 25 + this._r() * 35, spin: 5 + this._r() * 4 });
        this._nextDevil = 15 + this._r() * 30;
      }
      for (let i = this.devils.length - 1; i >= 0; i--) {
        const D = this.devils[i]; D.age += dt;
        D.x += (wx * 2.5 + Math.sin(D.age * 0.4) * 1.5) * dt; D.z += (wz * 2.5 + Math.cos(D.age * 0.33) * 1.5) * dt;
        const ground = T.hasTile(D.x, D.z) ? T.height(D.x, D.z) : T.heightExact(D.x, D.z);
        D.y = ground;
        const env = Math.min(1, D.age / 4) * Math.min(1, (D.life - D.age) / 4);
        if (D.age > D.life) { this.devils.splice(i, 1); continue; }
        const n = Math.round(260 * dt * env * 10);
        for (let k = 0; k < n; k++) {
          const ang = this._r() * Math.PI * 2;
          const id = this.devil.spawn(D.x + Math.cos(ang) * D.r * 0.6, ground + this._r() * 1.5, D.z + Math.sin(ang) * D.r * 0.6, 0, 3 + this._r() * 6, 0, 3 + this._r() * 4, 0.7 + this._r() * 1.6, 0.16 * env, 0, 2);
          if (id >= 0) this.devil.extra.set([ang, i, 0], id * 3);
        }
      }
    }
    // ---- integrate
    const drag = 1.6;
    for (const P of [this.plume, this.salt]) {
      for (let i = P.n - 1; i >= 0; i--) {
        P.age[i] += dt; if (P.age[i] > P.life[i]) { P.kill(i); continue; }
        const o = i * 3;
        // relax toward the wind with a little turbulence
        const tb = Math.sin(P.p[o] * 0.31 + this.time * 3.1) * Math.cos(P.p[o + 2] * 0.27 - this.time * 2.3);
        P.v[o] += ((wx * W - P.v[o]) * drag + tb * 2) * dt;
        P.v[o + 2] += ((wz * W - P.v[o + 2]) * drag - tb * 2) * dt;
        P.v[o + 1] -= P.grav[i] * dt;
        if (P.k[i] === 0) P.v[o + 1] += tb * 0.8 * dt;
        P.p[o] += P.v[o] * dt; P.p[o + 1] += P.v[o + 1] * dt; P.p[o + 2] += P.v[o + 2] * dt;
        const h = this._h(P.p[o], P.p[o + 2]);
        if (h != null && P.p[o + 1] < h) {
          if (P.k[i] === 1) { P.p[o + 1] = h; P.v[o + 1] = 0.5 + Math.random() * 1.2; }   // grain hops again
          else { P.p[o + 1] = h + 0.02; P.v[o + 1] = Math.max(0, P.v[o + 1]); }
        }
      }
    }
    {
      const P = this.devil;
      for (let i = P.n - 1; i >= 0; i--) {
        P.age[i] += dt; const D = this.devils[P.extra[i * 3 + 1]];
        if (P.age[i] > P.life[i] || !D) { P.kill(i); continue; }
        const o = i * 3, y = P.p[o + 1] - D.y;
        const ang = (P.extra[o] += D.spin * dt / (0.4 + y * 0.05));
        const r = D.r * (0.5 + y / D.h * 2.2);
        P.p[o] = D.x + Math.cos(ang) * r; P.p[o + 2] = D.z + Math.sin(ang) * r;
        P.p[o + 1] += P.v[o + 1] * dt * (1 - y / D.h * 0.7);
        if (y > D.h) P.age[i] = P.life[i];
      }
    }
    this.plume.upload((s, t) => s * (0.6 + t * 2.4), (a, t) => a * Math.min(1, t * 6) * (1 - t));
    this.salt.upload((s) => s, (a, t) => a * (1 - t));
    this.devil.upload((s, t) => s * (1 + t * 1.5), (a, t) => a * Math.min(1, t * 4) * (1 - t));
  }
}
