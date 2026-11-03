// SandMaterial.js – physically lit desert ground for MX (three.js r150+).
//
// A MeshStandardMaterial with procedural world-space detail injected, so it keeps three.js lighting,
// shadows, fog and the environment map. Needs the terrain attributes from DesertTerrain.meshData():
//   aMask  (vec4, normalized u8): track, soft sand, rock, crest
//   aRoute (vec3): signed distance to the route centreline (m), arc length s (m), slip-face weight
//
// Surfaces
//   soft sand  – wind ripples (≈32 cm, asymmetric: gentle stoss, steep lee, sinuous with Y-junctions),
//                larger sand waves, colour drifts across the dune sea, lighter wind-sorted crests,
//                smooth slip faces with grain-flow streaks running downslope, glinting quartz grains
//   gravel     – desert pavement: varnished dark pebbles in a pale matrix, coarse granule ripples
//   track      – compacted, darker, worn with old tyre ruts along several racing lines
//   rock       – sandstone in strata bands with desert-varnish streaks down the faces
// Dynamic
//   drifting sand – bright saltation streaks racing downwind across soft sand, pulsing with gusts
//   (set material.userData.uniforms.uTime / uGust each frame, or call SandMaterial.update(t, gust))
//
//   const mat = createSandMaterial({ sunDir });
//   mat.userData.update(elapsed, gust);   // gust 0..1
import * as THREE from 'three';

const GLSL_COMMON = /* glsl */`
uniform float uTime; uniform float uGust; uniform vec2 uWind; uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform float uNearR; uniform float uDetail;
varying vec3 vWPos; varying vec3 vWN; varying vec4 vMask; varying vec3 vRoute;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm3(vec2 p){ float a = 0., w = .5; for (int i = 0; i < 3; i++){ a += w * vnoise(p); p = p * 2.03 + 17.1; w *= .5; } return a / .875; }
float fbm5(vec2 p){ float a = 0., w = .5; for (int i = 0; i < 5; i++){ a += w * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7; w *= .5; } return a / .96875; }
vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
// value noise with its analytic gradient: (value, d/dx, d/dy)
vec3 vnoised(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f), du = 6. * f * (1. - f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x)); }
vec3 fbm3d(vec2 p){ float a = 0., w = .5, s = 1.; vec2 g = vec2(0);
  for (int i = 0; i < 3; i++){ vec3 n = vnoised(p); a += w * n.x; g += w * s * n.yz; p = p * 2.03 + 17.1; s *= 2.03; w *= .5; }
  return vec3(a, g) / .875; }

// wind ripple height 0..1, lam = wavelength (m)
float rippleH(vec2 p, vec2 wd, float lam, float seed){
  vec2 q = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));              // along wind, across wind
  float warp = (fbm3(q * vec2(0.06, 0.16) / lam * 0.3 + seed) - 0.5) * 7.0 + (vnoise(q * vec2(0.35, 0.9) / lam * 0.3 - seed) - 0.5) * 1.6;
  float ph = q.x / lam + warp;
  float f = fract(ph);
  float h = f < 0.72 ? f / 0.72 : (1. - f) / 0.28;                   // gentle stoss, steep lee
  // crest heights vary along the crest → lines end and fork
  float amp = 0.55 + 0.45 * vnoise(vec2(floor(ph) * 3.1, q.y / lam * 0.35 + seed));
  return h * h * (3. - 2. * h) * amp;
}
// the same ripple with its exact slope: (height, dh/dx, dh/dz). One evaluation gives the lit normal, instead of
// three evaluations for a finite difference – the ripples cost a third as much and keep a crisp lee edge.
vec3 rippleHG(vec2 p, vec2 wd, float lam, float seed){
  vec2 wp = vec2(-wd.y, wd.x);
  vec2 q = vec2(dot(p, wd), dot(p, wp));
  vec2 A = vec2(0.06, 0.16) / lam * 0.3, B = vec2(0.35, 0.9) / lam * 0.3;
  vec3 f1 = fbm3d(q * A + seed), f2 = vnoised(q * B - seed);
  float ph = q.x / lam + (f1.x - 0.5) * 7.0 + (f2.x - 0.5) * 1.6;
  vec2 dph = vec2(1. / lam, 0.) + f1.yz * A * 7.0 + f2.yz * B * 1.6;
  float f = fract(ph);
  float h = f < 0.72 ? f / 0.72 : (1. - f) / 0.28, dhf = f < 0.72 ? 1. / 0.72 : -1. / 0.28;
  float S = h * h * (3. - 2. * h), dS = 6. * h * (1. - h) * dhf;
  vec3 an = vnoised(vec2(floor(ph) * 3.1, q.y / lam * 0.35 + seed));
  float amp = 0.55 + 0.45 * an.x;
  vec2 gq = dS * amp * dph + S * vec2(0., 0.45 * an.z * 0.35 / lam);
  return vec3(S * amp, gq.x * wd + gq.y * wp);
}
`;

const GLSL_DETAIL = /* glsl */`
// fine height detail (metres) at world xz. a = vec4(ripple, gravel, track, slip) weights, fades already applied
float gFw = 0.01;   // metres per pixel at this fragment (set before detailH is called)
float aaK(float lam){ return 1. - smoothstep(0.07 * lam, 0.25 * lam, gFw); }
// wind ripples, sand waves and granule ripples, with exact slopes: (height, dh/dx, dh/dz)
vec3 rippleDetail(vec2 p, vec4 a){
  vec3 hg = vec3(0.);
  if (a.x > 0.001) {
    float k1 = a.x * 0.009 * aaK(0.31), k2 = a.x * 0.035 * aaK(1.9);
    if (k1 > 1e-5) hg += k1 * rippleHG(p, uWind, 0.31, 0.0);
    if (k2 > 1e-5) { vec3 w = rippleHG(p * 0.97, normalize(uWind + vec2(0.0, 0.25)), 1.9, 7.0); hg += k2 * vec3(w.x, w.yz * 0.97); }   // sand waves
  }
  if (a.y > 0.001) { float k = a.y * 0.012 * aaK(0.9); if (k > 1e-5) hg += k * rippleHG(p, uWind, 0.9, 3.0); }   // granule ripples
  return hg;
}
// the rest of the fine detail (pebbles, ruts, grain-flow streaks), sampled for a finite-difference slope
float detailH(vec2 p, vec4 a, float dRoute, float sRoute, vec2 down){
  float h = 0.;
  if (a.y > 0.001) {
    h += a.y * 0.008 * aaK(0.12) * smoothstep(0.6, 0.8, vnoise(p * 12.0 + vnoise(p * 3.1) * 2.0));  // pebbles
  }
  if (a.z > 0.001) {
    // worn ruts: several racing lines that wander with s; each line = a pair of wheel tracks 3.1 m apart
    float r = 0.;
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float c = (fk - 1.0) * 3.2 + (vnoise(vec2(sRoute * 0.012, fk * 7.3)) - 0.5) * 6.0;
      float wl = 0.55 + 0.25 * vnoise(vec2(sRoute * 0.05, fk));
      r += exp(-pow((dRoute - c - 1.56) / wl, 2.)) + exp(-pow((dRoute - c + 1.56) / wl, 2.));
    }
    h -= a.z * 0.06 * min(r, 1.4);
    h += a.z * (0.006 * vnoise(p * 4.0) + 0.012 * vnoise(p * 0.9));
  }
  if (a.w > 0.001) {
    // grain-flow streaks: noise stretched along the downslope direction
    vec2 q = vec2(dot(p, down), dot(p, vec2(-down.y, down.x)));
    h += a.w * 0.03 * fbm3(vec2(q.x * 0.08, q.y * 0.9));
  }
  return h;
}
`;

export function createSandMaterial({ sunDir = new THREE.Vector3(0.5, 0.4, 0.3), sunColor = new THREE.Color(1, 0.9, 0.78), wind = [1, 0.18], farField = false, nearRadius = 380 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const w = new THREE.Vector2(wind[0], wind[1]).normalize();
  const uniforms = {
    uTime: { value: 0 }, uGust: { value: 0.5 }, uWind: { value: w }, uSunDir: { value: sunDir.clone().normalize() },
    uSunColor: { value: sunColor.clone() }, uNearR: { value: nearRadius }, uDetail: { value: 1 },
  };
  mat.userData.uniforms = uniforms;
  mat.userData.update = (t, gust = 0.5) => { uniforms.uTime.value = t; uniforms.uGust.value = gust; };
  if (farField) mat.defines = { FAR_FIELD: '' };
  mat.customProgramCacheKey = () => 'mx-sand' + (farField ? '-far' : '');
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aMask; attribute vec3 aRoute;
        varying vec3 vWPos; varying vec3 vWN; varying vec4 vMask; varying vec3 vRoute;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * objectNormal);
        vMask = aMask; vRoute = aRoute;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON + GLSL_DETAIL)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        #ifdef FAR_FIELD
          if (length(vWPos.xz - cameraPosition.xz) < uNearR) discard;
        #endif
        vec3 P = vWPos; vec3 Ng = normalize(vWN);
        float camD = length(P - cameraPosition);
        float mTrack = vMask.x, mSoft = vMask.y, mRock = vMask.z, mCrest = vMask.w;
        float mSlip = clamp(vRoute.z, 0., 1.) * mSoft;
        float mGravel = clamp(1. - mSoft - mTrack - mRock, 0., 1.);
        float wsum = max(mSoft + mTrack + mRock + mGravel, 1e-3);
        vec2 down = length(Ng.xz) > 1e-3 ? normalize(Ng.xz) : vec2(1, 0);
        float steep = smoothstep(0.35, 0.6, length(Ng.xz));
        // ---- albedo (sRGB authored → linear)
        float n1 = fbm3(P.xz * 0.0025), n2 = fbm3(P.xz * 0.021 + 5.0), n3 = vnoise(P.xz * 0.35);
        vec3 sand = mix(srgb(vec3(0.79, 0.53, 0.31)), srgb(vec3(0.91, 0.72, 0.50)), smoothstep(0.25, 0.75, n1));
        sand *= 0.93 + 0.1 * n2 + 0.04 * n3;
        sand = mix(sand, srgb(vec3(0.95, 0.81, 0.62)), mCrest * 0.5);
        sand = mix(sand, sand * vec3(1.05, 0.99, 0.93), mSlip * 0.7);
        // Each surface's colour is only worked out where that surface is present (the masks are per vertex, so
        // whole screen regions skip the others) – same picture, far fewer noise lookups per pixel.
        float pk = 1. - smoothstep(0.012, 0.04, length(fwidth(P.xz)));   // derivatives stay outside the branches
        // drifting sand: bright saltation streaks racing downwind (dynamic)
        float driftK = (0.2 + 0.8 * uGust) * (1. - smoothstep(40., 120., camD)) * (1. - steep * 0.7) * mSoft / wsum;
        if (driftK > 0.002) {
          vec2 q = vec2(dot(P.xz, uWind), dot(P.xz, vec2(-uWind.y, uWind.x)));
          // long thin streamers (≈0.3–1 m wide) that braid and race downwind; strongest in gusts
          float braid = vnoise(vec2(q.x * 0.02 - uTime * 0.25, q.y * 0.04)) * 4.0;
          float drift = smoothstep(0.62, 0.9, fbm3(vec2(q.x * 0.06 - uTime * 1.1, q.y * 1.6 + braid)));
          drift *= smoothstep(0.3, 0.7, vnoise(vec2(q.x * 0.015 - uTime * 0.5, q.y * 0.02)));   // in patches
          sand = mix(sand, sand * vec3(1.12, 1.1, 1.06), drift * driftK * 0.6);
        }
        vec3 albedo = sand * mSoft;
        // gravel / desert pavement
        if (mGravel > 0.002) {
          float peb = smoothstep(0.6, 0.8, vnoise(P.xz * 12.0 + vnoise(P.xz * 3.1) * 2.0));
          vec3 grav = srgb(vec3(0.70, 0.54, 0.39)) * (0.88 + 0.2 * vnoise(P.xz * 0.9) + 0.1 * n2);
          grav = mix(grav, srgb(vec3(0.36, 0.26, 0.19)), mix(0.12, peb * 0.6, pk));
          grav = mix(grav, srgb(vec3(0.86, 0.74, 0.58)), pk * 0.3 * smoothstep(0.7, 0.85, vnoise(P.xz * 15.0 + 9.)));
          albedo += grav * mGravel;
        }
        // track: compacted, a touch darker and more saturated, loose sand thrown to the sides
        if (mTrack > 0.002) {
          vec3 trk = srgb(vec3(0.71, 0.52, 0.36)) * (0.9 + 0.12 * fbm3(P.xz * 0.08));
          float edge = smoothstep(4.0, 9.0, abs(vRoute.x));
          trk = mix(trk, sand, edge * 0.6);
          albedo += trk * mTrack;
        }
        // sandstone: strata + varnish streaks
        if (mRock > 0.002) {
          float strat = P.y * 0.42 + (fbm3(P.xz * 0.015) - 0.5) * 3.0 + (vnoise(P.xz * 0.2) - 0.5) * 0.4;
          float band = fract(strat);
          vec3 rk = mix(srgb(vec3(0.72, 0.42, 0.26)), srgb(vec3(0.84, 0.58, 0.38)), smoothstep(0.2, 0.5, band));
          rk = mix(rk, srgb(vec3(0.55, 0.30, 0.19)), smoothstep(0.75, 0.92, band) * 0.8);
          rk = mix(rk, srgb(vec3(0.85, 0.66, 0.48)), smoothstep(0.92, 0.98, band) * 0.6);
          float varnish = smoothstep(0.55, 0.85, vnoise(vec2((P.x + P.z) * 0.6, P.y * 0.05))) * steep;
          rk *= 1. - 0.45 * varnish;
          rk = mix(rk, sand, (1. - steep) * 0.8);       // sand collects on ledges and the plateau top
          albedo += rk * mRock;
        }
        albedo /= wsum;
        // ---- fine detail → perturbed normal
        float fadeD = 1. - smoothstep(22., 90., camD);
        vec4 amt = vec4(mSoft * (1. - mSlip) * (1. - steep * 0.7), mGravel, mTrack, mSlip) / wsum;
        amt *= vec4(fadeD, fadeD, 1. - smoothstep(60., 160., camD), 1. - smoothstep(60., 200., camD)) * uDetail;
        // route coordinate gradient (screen derivatives → world xz) so ruts can be sampled off-pixel
        vec2 dpx = dFdx(P.xz), dpy = dFdy(P.xz); float ddx = dFdx(vRoute.x), ddy = dFdy(vRoute.x);
        float det = dpx.x * dpy.y - dpx.y * dpy.x;
        vec2 gD = abs(det) > 1e-8 ? vec2(ddx * dpy.y - ddy * dpx.y, ddy * dpx.x - ddx * dpy.x) / det : vec2(0.);
        gFw = max(length(dFdx(P.xz)), length(dFdy(P.xz)));
        float e = 0.035;
        vec3 rg = rippleDetail(P.xz, amt);
        float r0 = 0., rx = 0., rz = 0.;
        if (amt.y + amt.z + amt.w > 0.001) {
          r0 = detailH(P.xz, amt, vRoute.x, vRoute.y, down);
          rx = detailH(P.xz + vec2(e, 0), amt, vRoute.x + gD.x * e, vRoute.y, down);
          rz = detailH(P.xz + vec2(0, e), amt, vRoute.x + gD.y * e, vRoute.y, down);
        }
        float h0 = rg.x + r0;
        vec2 g = rg.yz + vec2(rx - r0, rz - r0) / e;
        vec3 Tt = normalize(vec3(1, 0, 0) - Ng * Ng.x), Bt = normalize(vec3(0, 0, 1) - Ng * Ng.z);
        vec3 Nd = normalize(Ng - Tt * g.x - Bt * g.y);
        // micro grain + ripple troughs darker (fine sand collects coarse dark grains in troughs)
        albedo *= 1.0 - 0.18 * clamp(-h0 * 8.0, 0., 1.) * amt.z;
        albedo *= 1.0 + 0.08 * (hash12(floor(P.xz * 40.0)) - 0.5) * aaK(0.1);
        float rough = mix(0.97, 0.88, mTrack / wsum);
        rough = mix(rough, 0.82, mRock / wsum * steep);
        // quartz glints in soft sand near the camera
        vec3 glint = vec3(0);
        {
          vec2 cell = floor(P.xz * 55.0);
          float hc = hash12(cell);
          float near = 1. - smoothstep(6., 18., camD);
          if (hc > 0.965 && near > 0.0) {
            vec2 j = hash22(cell + 3.1) - 0.5;
            vec3 gn = normalize(Nd + vec3(j.x, 0.0, j.y) * 1.2);
            vec3 Vv = normalize(cameraPosition - P);
            float sp = pow(max(dot(reflect(-uSunDir, gn), Vv), 0.0), 600.0);
            glint = uSunColor * sp * 6.0 * near * (mSoft + mGravel * 0.4) / wsum * max(dot(Ng, uSunDir), 0.0);
          }
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= albedo;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = rough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(Nd, 0.0)).xyz);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += glint;`);
  };
  return mat;
}
