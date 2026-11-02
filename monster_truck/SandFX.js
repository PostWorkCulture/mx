// SandFX.js – sand thrown up by monster-truck tyres (three.js r150+).  v2
//
// Layers (CPU-simulated, two draw calls):
//   grains – small sand clumps: rooster tail behind spinning tyres, a sideways sheet when sliding,
//            ballistic; they land and vanish, or get caught on a truck (→ TruckDirt builds up)
//   dust   – soft billows that hang in the air, drift with the wind, expand and fade
//
// v2 changes – the particles now sit in the scene properly instead of looking like a brown wash:
//   • lit like the terrain: sun (wrap-diffuse for dust, which scatters light) + sky ambient, + fog
//   • soft particles: faded against the scene depth, so billows never cut hard lines across the
//     truck or ground and are correctly hidden behind it
//   • drawn after the ambient-occlusion pass (ParticlePass), so AO no longer darkens dust in odd patches
//   • far fewer, smaller billows from crashes; debris that hits a truck can stick to it (catchers)
//
//   const fxScene = new THREE.Scene();                       // particles live in their own scene
//   const sand = new SandFX(fxScene, { groundHeight, sunDirection: sun.position.clone().normalize() });
//   composer: RenderPass(scene) → GTAOPass → new ParticlePass(fxScene, camera, sand, gtao.depthTexture) → OutputPass
//   per frame: sand.emitWheel(dt, {...}) for each wheel on the ground; sand.update(dt, camera)
//
// slipLong – m/s the tyre surface spins faster than the ground. slipLat – m/s of sideways scrub (+ = left).
import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */`
  attribute float aSize; attribute float aAlpha; attribute float aShade;
  varying float vAlpha; varying float vShade; varying float vViewZ;
  uniform float uScale; uniform float uMaxSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(uMaxSize, aSize * uScale / max(0.1, -mv.z));
    vAlpha = aAlpha; vShade = aShade; vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`
  #include <packing>
  uniform vec3 uAlbedo; uniform float uDust;
  uniform vec3 uSunDirV; uniform vec3 uSunCol; uniform vec3 uAmb;
  uniform vec3 uFogCol; uniform float uFogNear; uniform float uFogFar;
  uniform sampler2D uDepth; uniform vec2 uRes; uniform float uNear; uniform float uFar; uniform float uUseDepth; uniform float uSoftDist;
  varying float vAlpha; varying float vShade; varying float vViewZ;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0; c.y = -c.y; float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    vec3 n = normalize(vec3(c * 0.9, sqrt(max(0.0, 1.0 - r2))));
    float ndl = dot(n, uSunDirV);
    // dust scatters light (wrap lighting, bright rim toward the sun); grains are small opaque clumps
    float diff = uDust > 0.5 ? 0.35 + 0.65 * clamp(ndl * 0.5 + 0.5, 0.0, 1.0) : 0.5 + 0.5 * clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
    vec3 col = uAlbedo * vShade * (uAmb + uSunCol * diff);
    float a = vAlpha * (uDust > 0.5 ? pow(1.0 - r2, 1.6) : 1.0 - smoothstep(0.6, 1.0, r2));
    if (uUseDepth > 0.5) {
      float d = texture2D(uDepth, gl_FragCoord.xy / uRes).x;
      float sceneZ = perspectiveDepthToViewZ(d, uNear, uFar);
      float gap = vViewZ - sceneZ;                // > 0: particle is in front of the scene
      if (gap < 0.0) discard;
      a *= clamp(gap / (uDust > 0.5 ? uSoftDist : 0.05), 0.0, 1.0);
      a *= clamp((-vViewZ - uNear) / 1.5, 0.0, 1.0);    // fade when very close to the camera
    }
    col = mix(col, uFogCol, smoothstep(uFogNear, uFogFar, -vViewZ));
    gl_FragColor = vec4(col, a);
  }`;

class Layer {
  constructor(max, albedo, isDust, scene, maxSize, shared) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.size0 = new Float32Array(max); this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max); this.shade = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aShade = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.g.setAttribute('position', this.aPos); this.g.setAttribute('aSize', this.aSize);
    this.g.setAttribute('aAlpha', this.aAlpha); this.g.setAttribute('aShade', this.aShade);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false,
      uniforms: { ...shared, uAlbedo: { value: new THREE.Color(albedo) }, uDust: { value: isDust ? 1 : 0 },
        uScale: { value: 600 }, uMaxSize: { value: maxSize } },
    });
    this.points = new THREE.Points(this.g, this.mat); this.points.frustumCulled = false;
    this.points.renderOrder = isDust ? 2 : 1;
    scene.add(this.points);
  }
  spawn(px, py, pz, vx, vy, vz, life, s0, s1, a0, shade, drag, grav) {
    const i = this.n < this.max ? this.n++ : (Math.random() * this.max) | 0;
    const j = i * 3;
    this.pos[j] = px; this.pos[j + 1] = py; this.pos[j + 2] = pz;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.age[i] = 0; this.life[i] = life; this.size0[i] = s0; this.size1[i] = s1;
    this.alpha0[i] = a0; this.shade[i] = shade; this.drag[i] = drag; this.grav[i] = grav;
  }
  kill(i) {
    const l = --this.n; if (i === l) return;
    const j = i * 3, k = l * 3;
    for (let c = 0; c < 3; c++) { this.pos[j + c] = this.pos[k + c]; this.vel[j + c] = this.vel[k + c]; }
    this.age[i] = this.age[l]; this.life[i] = this.life[l]; this.size0[i] = this.size0[l]; this.size1[i] = this.size1[l];
    this.alpha0[i] = this.alpha0[l]; this.shade[i] = this.shade[l]; this.drag[i] = this.drag[l]; this.grav[i] = this.grav[l];
  }
}

export class SandFX {
  constructor(scene, o = {}) {
    this.groundHeight = o.groundHeight || (() => 0);
    this.intensity = o.intensity ?? 1;
    this.wind = o.wind || new THREE.Vector3(0.6, 0, 0.3);
    this.sunDirection = (o.sunDirection || new THREE.Vector3(-0.45, 0.62, 0.64)).clone().normalize();
    // lighting defaults match the MX desert look (sun 4.2, sky ambient); tune to your scene
    this.u = {
      uSunDirV: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color(o.sunColor ?? 0xfff0dc).multiplyScalar((o.sunIntensity ?? 4.2) / Math.PI) },
      uAmb: { value: new THREE.Color(o.ambient ?? 0x8fa3bd).multiplyScalar(o.ambientIntensity ?? 0.75) },
      uFogCol: { value: new THREE.Color(o.fogColor ?? 0xe9d6b8) }, uFogNear: { value: o.fogNear ?? 120 }, uFogFar: { value: o.fogFar ?? 520 },
      uDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 1000 },
      uUseDepth: { value: 0 }, uSoftDist: { value: 1.2 },
    };
    this.grains = new Layer(o.maxGrains || 9000, o.grainColor ?? 0xb8966a, false, scene, o.grainMaxPx || 8, this.u);
    this.dust = new Layer(o.maxDust || 1600, o.dustColor ?? 0xd8bc8e, true, scene, 700, this.u);
    this.catchers = [];   // fn(x, y, z) → true if a grain hit something (and was absorbed)
    this._acc = new Map();
  }
  addCatcher(fn) { this.catchers.push(fn); }
  setDepth(depthTexture, width, height) { this.u.uDepth.value = depthTexture; this.u.uRes.value.set(width, height); this.u.uUseDepth.value = depthTexture ? 1 : 0; }
  _rate(key, perSecond, dt) { const a = (this._acc.get(key) || 0) + perSecond * dt; const n = Math.floor(a); this._acc.set(key, a - n); return n; }

  emitWheel(dt, { id = 'w', contact, forward, left, slipLong = 0, slipLat = 0, speed = 0 }) {
    const I = this.intensity, R = Math.random;
    const spin = Math.max(0, slipLong), scrub = Math.abs(slipLat);
    const roost = Math.min(1.6, spin / 6), slide = Math.min(1.6, scrub / 5), roll = Math.min(1, speed / 18);
    let n = this._rate(id + 'r', I * (1300 * roost + 70 * roll), dt);
    for (let i = 0; i < n; i++) {
      const back = (0.45 + R() * 0.75) * (spin * 0.9 + 1.5), up = (2.0 + R() * 5.0) * (0.4 + 0.6 * roost), side = (R() - 0.5) * 2.2;
      const px = contact.x - forward.x * 0.6 + left.x * (R() - 0.5) * 0.9, pz = contact.z - forward.z * 0.6 + left.z * (R() - 0.5) * 0.9;
      this.grains.spawn(px, contact.y + 0.15 + R() * 0.25, pz,
        -forward.x * back + left.x * side + forward.x * speed * 0.35, up, -forward.z * back + left.z * side + forward.z * speed * 0.35,
        1.2 + R() * 0.9, 0.035 + R() * 0.05, 0.035, 0.95, 0.75 + R() * 0.35, 0.35, 1.0);
    }
    if (scrub > 0.3) {
      const sgn = Math.sign(slipLat);
      n = this._rate(id + 's', I * 950 * slide, dt);
      for (let i = 0; i < n; i++) {
        const out = (0.5 + R() * 0.9) * scrub * 1.1, up = (1.0 + R() * 3.2) * (0.5 + 0.5 * slide);
        const px = contact.x + left.x * sgn * 0.55 + forward.x * (R() - 0.5) * 1.0, pz = contact.z + left.z * sgn * 0.55 + forward.z * (R() - 0.5) * 1.0;
        this.grains.spawn(px, contact.y + 0.12 + R() * 0.2, pz,
          left.x * sgn * out + forward.x * (speed * 0.45 + (R() - 0.5) * 2), up, left.z * sgn * out + forward.z * (speed * 0.45 + (R() - 0.5) * 2),
          1.0 + R() * 0.9, 0.035 + R() * 0.05, 0.035, 0.95, 0.75 + R() * 0.35, 0.3, 1.0);
      }
    }
    n = this._rate(id + 'd', I * (30 * roost + 28 * slide + 6 * roll), dt);
    for (let i = 0; i < n; i++) {
      const sgn = Math.sign(slipLat) || 0, k = slide > roost ? 1 : 0;
      this.dust.spawn(contact.x - forward.x * 1.1 + left.x * sgn * 0.9 * k, contact.y + 0.5 + R() * 0.4, contact.z - forward.z * 1.1 + left.z * sgn * 0.9 * k,
        -forward.x * (1 + spin * 0.4) + left.x * sgn * scrub * 0.35 + (R() - 0.5) * 1.2 + forward.x * speed * 0.15,
        0.4 + R() * 1.1 * (0.5 + roost + slide),
        -forward.z * (1 + spin * 0.4) + left.z * sgn * scrub * 0.35 + (R() - 0.5) * 1.2 + forward.z * speed * 0.15,
        2.2 + R() * 2.2, 1.0 + R() * 0.7, 3.2 + R() * 2.4 * (0.6 + roost + slide), 0.17 + 0.13 * Math.min(1, roost + slide), 0.9 + R() * 0.15, 1.6, -0.08);
    }
  }

  // landing / crash: a ring of sand at ground level (never a cloud centred inside the truck)
  burst(center, impactSpeed = 5, radius = 2.2) {
    const I = this.intensity, R = Math.random, k = Math.min(2.2, impactSpeed / 5);
    const g = this.groundHeight(center.x, center.z);
    const nG = Math.round(I * 600 * k), nD = Math.round(I * 26 * k);
    for (let i = 0; i < nG; i++) {
      const a = R() * Math.PI * 2, r = radius * (0.7 + R() * 0.6), sp = (2 + R() * 5.5) * k;
      this.grains.spawn(center.x + Math.cos(a) * r, g + 0.12, center.z + Math.sin(a) * r * 1.3,
        Math.cos(a) * sp, (1.2 + R() * 3.5) * k, Math.sin(a) * sp, 0.9 + R() * 0.9, 0.04 + R() * 0.05, 0.04, 0.95, 0.75 + R() * 0.35, 0.4, 1.0);
    }
    for (let i = 0; i < nD; i++) {
      const a = R() * Math.PI * 2, r = radius * (1.0 + R() * 0.8), sp = (0.8 + R() * 2.2) * k;
      this.dust.spawn(center.x + Math.cos(a) * r, g + 0.45, center.z + Math.sin(a) * r * 1.3,
        Math.cos(a) * sp, 0.3 + R() * 1.0 * k, Math.sin(a) * sp, 2.0 + R() * 1.8, 1.0 + R() * 0.6, 2.4 + R() * 1.8 * k, 0.2, 0.9 + R() * 0.15, 1.4, -0.05);
    }
  }

  // sand sliding / falling off a body: give world positions (array of [x,y,z]) and the body velocity
  shed(points, vel = [0, 0, 0], dustChance = 0.03) {
    const R = Math.random;
    for (const p of points) {
      this.grains.spawn(p[0], p[1], p[2], vel[0] + (R() - 0.5) * 1.2, vel[1] + R() * 0.8, vel[2] + (R() - 0.5) * 1.2,
        1.6 + R(), 0.025 + R() * 0.03, 0.025, 0.9, 1.05 + R() * 0.2, 0.6, 1.0);
      if (R() < dustChance) this.dust.spawn(p[0], p[1], p[2], vel[0] * 0.5, 0.2, vel[2] * 0.5, 1.6 + R(), 0.5, 1.6, 0.12, 1.0, 2.0, 0.05);
    }
  }

  update(dt, camera) {
    const H = this.groundHeight, W = this.wind;
    if (camera) {
      const s = (this.u.uRes.value.y > 1 ? this.u.uRes.value.y : (globalThis.innerHeight || 720)) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      this.grains.mat.uniforms.uScale.value = s; this.dust.mat.uniforms.uScale.value = s;
      this.u.uSunDirV.value.copy(this.sunDirection).transformDirection(camera.matrixWorldInverse);
      this.u.uNear.value = camera.near; this.u.uFar.value = camera.far;
    }
    for (const L of [this.grains, this.dust]) {
      const isGrain = L === this.grains;
      for (let i = 0; i < L.n; i++) {
        L.age[i] += dt;
        const j = i * 3;
        if (L.age[i] >= L.life[i]) { L.kill(i); i--; continue; }
        const d = Math.exp(-L.drag[i] * dt);
        L.vel[j] = (L.vel[j] - W.x) * d + W.x; L.vel[j + 2] = (L.vel[j + 2] - W.z) * d + W.z;
        L.vel[j + 1] = L.vel[j + 1] * d - 9.81 * L.grav[i] * dt;
        L.pos[j] += L.vel[j] * dt; L.pos[j + 1] += L.vel[j + 1] * dt; L.pos[j + 2] += L.vel[j + 2] * dt;
        if (isGrain && this.catchers.length && L.age[i] > 0.3) {
          let caught = false;
          for (const c of this.catchers) if (c(L.pos[j], L.pos[j + 1], L.pos[j + 2])) { caught = true; break; }
          if (caught) { L.kill(i); i--; continue; }
        }
        const g = H(L.pos[j], L.pos[j + 2]);
        if (L.pos[j + 1] < g + 0.03) {
          if (isGrain) { L.kill(i); i--; continue; }
          L.pos[j + 1] = g + 0.03; L.vel[j + 1] = Math.abs(L.vel[j + 1]) * 0.2;
        }
      }
      const t = L.n;
      for (let i = 0; i < t; i++) {
        const j = i * 3, u = L.age[i] / L.life[i];
        L.aPos.array[j] = L.pos[j]; L.aPos.array[j + 1] = L.pos[j + 1]; L.aPos.array[j + 2] = L.pos[j + 2];
        L.aSize.array[i] = L.size0[i] + (L.size1[i] - L.size0[i]) * Math.sqrt(u);
        const fadeIn = Math.min(1, u * (isGrain ? 20 : 5)), fadeOut = 1 - u * u;
        L.aAlpha.array[i] = L.alpha0[i] * fadeIn * fadeOut;
        L.aShade.array[i] = L.shade[i];
      }
      L.g.setDrawRange(0, t);
      for (const a of [L.aPos, L.aSize, L.aAlpha, L.aShade]) a.needsUpdate = true;
    }
  }
  dispose() { for (const L of [this.grains, this.dust]) { L.points.parent?.remove(L.points); L.g.dispose(); L.mat.dispose(); } }
}

// Draws the particle scene on top of the composed image, after ambient occlusion, depth-tested by hand
// against the main scene's depth (e.g. GTAOPass.depthTexture).
export class ParticlePass extends Pass {
  constructor(fxScene, camera, sand, depthTexture) {
    super(); this.fxScene = fxScene; this.camera = camera; this.sand = sand; this.depthTexture = depthTexture; this.needsSwap = false;
  }
  setSize(w, h) { this.w = w; this.h = h; }
  render(renderer, writeBuffer, readBuffer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sand.setDepth(this.depthTexture, size.x, size.y);
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(this.fxScene, this.camera);
    renderer.autoClear = ac;
  }
}
