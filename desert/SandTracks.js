// SandTracks.js – persistent tyre ruts pressed into the sand (three.js r150+).
//
// Each wheel lays a ribbon of quads on the ground: a dark rut floor with chevron lug prints, rut walls
// lit/shadowed by the sun, and fades out over `life` seconds. Drawn with multiply blending in one draw
// call over a ring buffer, so old marks are recycled. Deeper/darker in soft sand, faint on hardpack.
//
//   const tracks = new SandTracks(scene, { groundHeight: terrain.height, sunDir });
//   // per frame, per wheel touching the ground:
//   tracks.stamp(truck.id + k, x, z, fx, fz, strength);   // contact point, truck forward (xz), 0..1
//   tracks.update(elapsed);
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec2 aUV; attribute float aBirth; attribute float aStr; attribute float aShade;
  uniform float uTime; uniform float uLife;
  varying vec2 vUV; varying float vFade; varying float vShade; varying float vDist;
  #include <fog_pars_vertex>
  void main() {
    vUV = aUV; vShade = aShade;
    float age = uTime - aBirth;
    vFade = aStr * (1.0 - smoothstep(uLife * 0.6, uLife, age)) * step(0.0, aBirth);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDist = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FRAG = /* glsl */`
  varying vec2 vUV; varying float vFade; varying float vShade; varying float vDist;
  #include <fog_pars_fragment>
  void main() {
    float u = vUV.x * 2.0 - 1.0, au = abs(u);
    if (au > 1.0) discard;
    float floorM = 1.0 - smoothstep(0.62, 0.86, au);
    float wall = smoothstep(0.55, 0.85, au) * (1.0 - smoothstep(0.88, 1.0, au));
    // chevron lugs (monster-truck paddle tread)
    float chev = fract(vUV.y * 1.15 + au * 0.55);
    float lug = smoothstep(0.40, 0.47, chev) * (1.0 - smoothstep(0.70, 0.77, chev)) * floorM;
    // rut walls: the wall facing the sun is lit, the other in shade (vShade = side·sun)
    float wallLight = sign(u) * vShade;
    float f = 1.0;
    float near = 1.0 - smoothstep(12.0, 45.0, vDist);
    f -= floorM * 0.13;                    // disturbed sand is darker, rut floor in soft shadow
    f -= lug * 0.08 * near;
    f -= wall * max(0.0, -wallLight) * 0.35;
    f += wall * max(0.0, wallLight) * 0.06;
    float a = vFade * (1.0 - smoothstep(70.0, 110.0, vDist));
    f = mix(1.0, f, a);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      f = mix(f, 1.0, fogFactor);
    #endif
    gl_FragColor = vec4(vec3(min(f, 1.0)), 1.0);
  }`;

export class SandTracks {
  constructor(scene, { groundHeight, sunDir = new THREE.Vector3(0.5, 0.5, 0.2), maxSegments = 18000, width = 0.95, spacing = 0.35, life = 180, lift = 0.035 } = {}) {
    this.groundHeight = groundHeight; this.width = width; this.spacing = spacing; this.lift = lift;
    this.max = maxSegments; this.head = 0; this.time = 0;
    this.sun = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
    const N = maxSegments * 4;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aUV = new THREE.BufferAttribute(new Float32Array(N * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aBirth = new THREE.BufferAttribute(new Float32Array(N).fill(-1e6), 1).setUsage(THREE.DynamicDrawUsage);
    this.aStr = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
    this.aShade = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aUV', this.aUV); g.setAttribute('aBirth', this.aBirth);
    g.setAttribute('aStr', this.aStr); g.setAttribute('aShade', this.aShade);
    const idx = new Uint32Array(maxSegments * 6);
    for (let i = 0; i < maxSegments; i++) { const v = i * 4; idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6); }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLife: { value: life } }]),
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.name = 'SandTracks';
    scene.add(this.mesh);
    this.last = new Map();
    this._dirty = [Infinity, -Infinity];
  }

  // x, z: contact point; fx, fz: rolling direction (unit, xz); strength 0..1 (soft sand ≈1, hardpack ≈0.3)
  stamp(key, x, z, fx, fz, strength = 1) {
    let L = this.last.get(key);
    const now = this.time;
    if (!L || now - L.t > 0.25) { this.last.set(key, { x, z, v: 0, t: now, lx: 0, lz: 0 }); return; }
    const dx = x - L.x, dz = z - L.z, d = Math.hypot(dx, dz);
    if (d < this.spacing) { L.t = now; return; }
    if (d > 3) { this.last.set(key, { x, z, v: 0, t: now }); return; }
    const ux = dx / d, uz = dz / d, sx = uz, sz = -ux;   // side (right of travel)
    const hw = this.width / 2;
    const i = this.head; this.head = (this.head + 1) % this.max;
    const P = this.aPos.array, U = this.aUV.array, B = this.aBirth.array, S = this.aStr.array, SH = this.aShade.array;
    const pts = [[L.x, L.z, L.sx ?? sx, L.sz ?? sz, L.v], [x, z, sx, sz, L.v + d]];
    let k = i * 4;
    for (const [px, pz, qx, qz, v] of pts) for (const side of [-1, 1]) {
      const X = px + qx * hw * side, Z = pz + qz * hw * side;
      P[k * 3] = X; P[k * 3 + 1] = this.groundHeight(X, Z) + this.lift; P[k * 3 + 2] = Z;
      U[k * 2] = side < 0 ? 0 : 1; U[k * 2 + 1] = v;
      B[k] = now; S[k] = strength; SH[k] = qx * this.sun.x + qz * this.sun.y;
      k++;
    }
    L.x = x; L.z = z; L.v += d; L.t = now; L.sx = sx; L.sz = sz;
    this._dirty[0] = Math.min(this._dirty[0], i * 4); this._dirty[1] = Math.max(this._dirty[1], i * 4 + 3);
  }

  update(time) {
    this.time = time; this.mat.uniforms.uTime.value = time;
    const [a, b] = this._dirty;
    if (b >= a) {
      for (const [attr, n] of [[this.aPos, 3], [this.aUV, 2], [this.aBirth, 1], [this.aStr, 1], [this.aShade, 1]]) {
        attr.clearUpdateRanges?.(); attr.addUpdateRange?.(a * n, (b - a + 1) * n); attr.needsUpdate = true;
      }
      this._dirty = [Infinity, -Infinity];
    }
  }

  clear() { this.aBirth.array.fill(-1e6); this.aBirth.clearUpdateRanges?.(); this.aBirth.needsUpdate = true; this.last.clear(); }
}
