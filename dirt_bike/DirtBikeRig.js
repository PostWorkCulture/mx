// DirtBikeRig.js – drives the white MX dirt bike GLB and puts a rider on it (three.js r150+).
//
//   const gltf = await loader.loadAsync('dirt_bike_white.glb');
//   const rig = new DirtBikeRig(gltf.scene, { kit: 'orange' });       // or kit: { jersey, pants, helmet, trim }
//   scene.add(gltf.scene);
//   // every frame, after the physics step (BikeBody from DirtBikeSim.js):
//   rig.root.position.set(...bike.rootPosition); rig.root.quaternion.set(...bike.rootQuaternion);
//   rig.update(dt, { speed: bike.wheelSpeed, steer: bike.steerAngle, suspension: bike.travel, bike });
//
// GLB hierarchy (see assets/dirt_bike.md): DirtBike → Body, Steering (raked; rotation.y steers) →
// ForkLower (slides along the fork, local +Y) → Wheel_F; Swingarm (rotation.x, + = wheel up) → Wheel_R.
// suspension = { F, R }: wheel travel in metres along the bike's up axis (+ = compressed).
// The rider is built from simple shapes (helmet, jersey, pants, boots) with two-bone IK: hands stay on the
// grips (which turn with the bars), feet on the pegs, and the body sinks with the suspension and leans
// into turns. In a big crash (bike.ejected) the rider is thrown off: the body becomes a Verlet ragdoll
// (13 joints, bone-length constraints, a stiff torso) that leaves with the bike's velocity, tumbles, bounces
// and slides to a stop on the terrain, then climbs back on when the bike is picked up. Pass
// `groundHeight` (x, z) => y so the ragdoll lands on the real ground.
import * as THREE from 'three';

export const RIDER_KITS = {
  orange: { jersey: 0xff6a13, pants: 0x23262b, helmet: 0xff6a13, trim: 0xf2f2f2 },
  blue: { jersey: 0x2f8fff, pants: 0x1d2633, helmet: 0xf2f2f2, trim: 0x2f8fff },
  yellow: { jersey: 0xffcf2e, pants: 0x262626, helmet: 0x262626, trim: 0xffcf2e },
  purple: { jersey: 0xa860ff, pants: 0x221c2b, helmet: 0xa860ff, trim: 0xffffff },
  lime: { jersey: 0x9be21d, pants: 0x1c1f1a, helmet: 0x1c1f1a, trim: 0x9be21d },
  red: { jersey: 0xe5322b, pants: 0x1f1f22, helmet: 0xffffff, trim: 0xe5322b },
};

const RAKE = 0.453, SWING_ARM = 0.528;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// solve a two-bone chain root → end with bone lengths l1, l2; the joint bends toward `pole`
function ik2(root, end, l1, l2, pole, outJoint) {
  const d = _a.subVectors(end, root); let L = d.length();
  L = Math.min(Math.max(L, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  const dir = d.normalize();
  const x = (l1 * l1 - l2 * l2 + L * L) / (2 * L), y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pv = _b.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  return outJoint.copy(root).addScaledVector(dir, x).addScaledVector(pv, y);
}

class Limb {   // a capsule of fixed length laid between two joints (IK keeps the joints that far apart)
  constructor(parent, r, mat, len) {
    this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 4, 10), mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; parent.add(this.mesh);
  }
  set(a, b) {
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, _c.subVectors(b, a).normalize());
  }
}

export class Rider {
  constructor(parent, kit = 'orange') {
    const k = typeof kit === 'string' ? (RIDER_KITS[kit] || RIDER_KITS.orange) : kit;
    const M = (c, r = 0.75, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const jersey = M(k.jersey, 0.8), pants = M(k.pants, 0.85), trimM = M(k.trim, 0.6), black = M(0x16171a, 0.7);
    const helmetM = M(k.helmet, 0.32), bootM = M(0xf0f0f0, 0.55), visorM = M(0x0c0d10, 0.15, 0.6);
    this.group = new THREE.Group(); this.group.name = 'Rider'; parent.add(this.group);
    const g = this.group;
    // torso: flattened capsule + a chest-protector bulge
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.34, 4, 12), jersey);
    this.torso.scale.set(1.18, 1, 0.82); this.torso.castShadow = true; g.add(this.torso);
    this.number = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), trimM); this.torso.add(this.number);
    this.number.position.set(0, 0.04, -0.152); this.number.rotation.y = Math.PI;          // on the back
    // helmet: shell, peak, chin bar, goggles
    this.head = new THREE.Group(); g.add(this.head);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 16), helmetM); shell.scale.set(0.95, 1.0, 1.12); shell.castShadow = true; this.head.add(shell);
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.018, 0.13), trimM); peak.position.set(0, 0.085, 0.15); peak.rotation.x = -0.25; this.head.add(peak);
    const chin = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.08, 4, 8), helmetM); chin.rotation.z = Math.PI / 2; chin.position.set(0, -0.075, 0.12); this.head.add(chin);
    const gog = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.05, 0.05), visorM); gog.position.set(0, 0.02, 0.135); this.head.add(gog);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.012, 6, 24), black); strap.rotation.x = Math.PI / 2; strap.position.y = 0.02; strap.scale.set(1, 1.15, 1); this.head.add(strap);
    // limbs
    this.L = { uarm: 0.29, farm: 0.29, thigh: 0.44, shin: 0.45 };
    const two = (r, m, len) => [new Limb(g, r, m, len), new Limb(g, r, m, len)];
    this.uarm = two(0.052, jersey, this.L.uarm); this.farm = two(0.045, jersey, this.L.farm);
    this.thigh = two(0.078, pants, this.L.thigh); this.shin = two(0.064, pants, this.L.shin);
    this.hand = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), black); m.castShadow = true; g.add(m); return m; });
    // MX boots: a tall shaft up the shin + the foot on the peg
    this.boot = [0, 1].map(() => {
      const shaft = new Limb(g, 0.072, bootM, 0.3);
      const foot = new THREE.Group(); g.add(foot);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.085, 0.25), bootM); m.position.set(0, -0.005, 0.06); m.castShadow = true; foot.add(m);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.025, 0.27), black); sole.position.set(0, -0.055, 0.06); foot.add(sole);
      return { shaft, foot };
    });
    this.neck = new Limb(g, 0.05, black, 0.12);
    // rest pose (bike root frame: +Z forward, +X left, +Y up), metres
    this.rest = {
      hip: new THREE.Vector3(0, 1.10, -0.26), hipHalf: 0.115,
      shoulder: new THREE.Vector3(0, 1.49, 0.0), shoulderHalf: 0.19,
      peg: new THREE.Vector3(0.205, 0.47, -0.20),
    };
    this.crouch = 0; this.leanOff = 0;
    const v2 = () => [new THREE.Vector3(), new THREE.Vector3()];
    this.joints = { head: new THREE.Vector3(), sh: v2(), el: v2(), hd: v2(), hip: v2(), kn: v2(), ft: v2() };   // last pose, bike frame
    this.ragdoll = null;
  }

  // ---------------- ragdoll (thrown off the bike) ----------------
  // bikeRoot: the bike's root Object3D (its world matrix is current); pointVel(worldPos) → world velocity of
  // the bike at that point (Vector3); ground(x, z) → height. The rider group moves to the scene root.
  eject(bikeRoot, pointVel, ground, seed = Math.random()) {
    if (this.ragdoll) return;
    const J = this.joints, names = [], pts = [];
    const add = (name, v, r) => { names.push(name); pts.push({ p: bikeRoot.localToWorld(v.clone()), r }); };
    add('head', J.head, 0.14);
    for (let s = 0; s < 2; s++) {
      add('sh' + s, J.sh[s], 0.09); add('el' + s, J.el[s], 0.05); add('hd' + s, J.hd[s], 0.05);
      add('hip' + s, J.hip[s], 0.1); add('kn' + s, J.kn[s], 0.07); add('ft' + s, J.ft[s], 0.07);
    }
    const idx = Object.fromEntries(names.map((n, i) => [n, i]));
    // the rider keeps going: the bike's velocity at each joint, plus a hop up and over the bars and a bit of random tumble
    const rnd = (k) => Math.sin(seed * 12.9898 + k * 78.233) * 0.5;
    const h = 1 / 120, fwd = new THREE.Vector3(0, 0, 1).transformDirection(bikeRoot.matrixWorld);
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i], v = pointVel(P.p).clone();
      const sp = v.length();
      v.addScaledVector(fwd, 0.08 * sp).add(new THREE.Vector3(rnd(i) * 1.5, 1.6 + 0.08 * sp, rnd(i + 7) * 1.5));
      if (i === idx.head) v.addScaledVector(fwd, 0.6 + 0.05 * sp);     // head first over the bars
      P.prev = P.p.clone().addScaledVector(v, -h);
    }
    // constraints: bones (length from the pose) + a braced torso box so the body keeps its shape
    const links = [['head', 'sh0'], ['head', 'sh1'], ['sh0', 'sh1'], ['hip0', 'hip1'], ['sh0', 'hip0'], ['sh1', 'hip1'], ['sh0', 'hip1'], ['sh1', 'hip0'],
      ['sh0', 'el0'], ['el0', 'hd0'], ['sh1', 'el1'], ['el1', 'hd1'], ['hip0', 'kn0'], ['kn0', 'ft0'], ['hip1', 'kn1'], ['kn1', 'ft1'],
      ['head', 'hip0', 0.6], ['head', 'hip1', 0.6]];   // soft neck/spine braces (min-length only)
    const C = links.map(([a, b, soft]) => ({ a: idx[a], b: idx[b], len: pts[idx[a]].p.distanceTo(pts[idx[b]].p), soft: soft || 0 }));
    // move the rider group into the scene root so it is no longer carried by the bike
    let top = bikeRoot; while (top.parent) top = top.parent;
    this._home = this.group.parent; top.add(this.group);
    this.group.position.set(0, 0, 0); this.group.quaternion.identity(); this.group.scale.set(1, 1, 1);
    this.ragdoll = { pts, C, idx, ground: ground || (() => 0), acc: 0, settled: 0 };
    this._poseRagdoll();
  }

  stepRagdoll(dt) {
    const R = this.ragdoll; if (!R) return;
    const h = 1 / 120; R.acc = Math.min(R.acc + dt, 0.1);
    while (R.acc >= h) {
      R.acc -= h;
      for (const P of R.pts) {                                 // Verlet + gravity + a little air drag
        const vx = (P.p.x - P.prev.x) * 0.999, vy = (P.p.y - P.prev.y) * 0.999, vz = (P.p.z - P.prev.z) * 0.999;
        P.prev.copy(P.p);
        P.p.x += vx; P.p.y += vy - 9.81 * h * h; P.p.z += vz;
      }
      for (let it = 0; it < 8; it++) {
        for (const c of R.C) {
          const A = R.pts[c.a].p, B = R.pts[c.b].p;
          const d = _a.subVectors(B, A), L = d.length() || 1e-6;
          if (c.soft && L > c.len * c.soft) continue;           // braces only stop the spine folding up
          const k = c.soft ? 0.3 : 1, diff = ((L - (c.soft ? c.len * c.soft : c.len)) / L) * 0.5 * k;
          A.addScaledVector(d, diff); B.addScaledVector(d, -diff);
        }
        for (const P of R.pts) {                               // terrain: push out of the ground
          const g = R.ground(P.p.x, P.p.z) + P.r;
          if (P.p.y < g) { P.p.y = g; P.hit = true; }
        }
      }
      for (const P of R.pts) {                                 // once per substep: small bounce + sliding friction on sand
        if (!P.hit) continue; P.hit = false;
        const vy = P.p.y - P.prev.y;
        P.prev.y = P.p.y + (vy < 0 ? vy * 0.25 : vy * 0.3);   // vy > 0 here is the push-out: damp it so nothing pops up
        const dx = P.p.x - P.prev.x, dz = P.p.z - P.prev.z, d = Math.hypot(dx, dz);
        const keep = d > 1e-9 ? Math.max(0, d - 1.15 * 9.81 * h * h) / d : 0;   // Coulomb friction, μ ≈ 1.15 (gear digging into sand)
        P.prev.x = P.p.x - dx * keep; P.prev.z = P.p.z - dz * keep;
      }
    }
    this._poseRagdoll();
  }

  _poseRagdoll() {
    const R = this.ragdoll, P = (n) => R.pts[R.idx[n]].p;
    const shM = _b.addVectors(P('sh0'), P('sh1')).multiplyScalar(0.5).clone(), hipM = new THREE.Vector3().addVectors(P('hip0'), P('hip1')).multiplyScalar(0.5);
    const Y = new THREE.Vector3().subVectors(shM, hipM).normalize();
    const X = new THREE.Vector3().subVectors(P('sh0'), P('sh1')); X.addScaledVector(Y, -X.dot(Y)).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y);
    const basis = new THREE.Matrix4().makeBasis(X, Y, Z);
    this.torso.position.addVectors(shM, hipM).multiplyScalar(0.5); this.torso.quaternion.setFromRotationMatrix(basis);
    const hd = P('head'), hy = new THREE.Vector3().subVectors(hd, shM).normalize();
    const hx = X.clone().addScaledVector(hy, -X.dot(hy)).normalize(), hz = new THREE.Vector3().crossVectors(hx, hy);
    this.head.position.copy(hd); this.head.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(hx, hy, hz));
    this.neck.set(shM, hd.clone().addScaledVector(hy, -0.08));
    for (let s = 0; s < 2; s++) {
      const sh = P('sh' + s), el = P('el' + s), hand = P('hd' + s), hip = P('hip' + s), kn = P('kn' + s), ft = P('ft' + s);
      this.uarm[s].set(sh, el); this.farm[s].set(el, hand); this.hand[s].position.copy(hand);
      this.thigh[s].set(hip, kn); this.shin[s].set(kn, ft);
      this.boot[s].shaft.set(ft, ft.clone().lerp(kn, 0.62));
      const fy = new THREE.Vector3().subVectors(kn, ft).normalize();
      const fz = Z.clone().addScaledVector(fy, -Z.dot(fy)); if (fz.lengthSq() < 1e-6) fz.set(0, 0, 1); fz.normalize();
      this.boot[s].foot.position.copy(ft); this.boot[s].foot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(fy, fz), fy, fz));
    }
  }

  // back on the bike: re-attach to the bike root; the next update() poses the rider normally
  remount() {
    if (!this.ragdoll) return;
    this._home?.add(this.group);
    this.group.position.set(0, 0, 0); this.group.quaternion.identity();
    this.head.quaternion.identity(); this.boot.forEach((b) => b.foot.quaternion.identity());
    this.ragdoll = null;
  }

  // world position of the rider's pelvis while thrown (for cameras); null when on the bike
  focus(out = new THREE.Vector3()) {
    const R = this.ragdoll; if (!R) return null;
    return out.addVectors(R.pts[R.idx.hip0].p, R.pts[R.idx.hip1].p).multiplyScalar(0.5);
  }

  // grips: [left, right] points in the bike root frame
  update(dt, { grips, travel = 0, airborne = false, lean = 0, speed = 0 }) {
    const R = this.rest, k = 1 - Math.exp(-dt * 10), J = this.joints;
    // crouch with the suspension, stand up a little in the air, shift the body into turns
    const targetCrouch = THREE.MathUtils.clamp(travel * 0.6, -0.04, 0.12) - (airborne ? 0.03 : 0);
    this.crouch += (targetCrouch - this.crouch) * k;
    this.leanOff += (THREE.MathUtils.clamp(-lean, -0.6, 0.6) * 0.16 - this.leanOff) * k;
    const hipC = _d.set(R.hip.x + this.leanOff * 0.6, R.hip.y - this.crouch, R.hip.z - this.crouch * 0.3);
    const shC = new THREE.Vector3(R.shoulder.x + this.leanOff, R.shoulder.y - this.crouch * 0.8, R.shoulder.z + 0.02 * Math.min(1, speed / 20));
    // torso & head
    this.torso.position.addVectors(hipC, shC).multiplyScalar(0.5);
    this.torso.quaternion.setFromUnitVectors(UP, _c.subVectors(shC, hipC).normalize());
    const headP = shC.clone().add(new THREE.Vector3(this.leanOff * 0.3, 0.2, 0.1));
    this.head.position.copy(headP); this.head.rotation.set(0.12, 0, -this.leanOff * 0.5);
    J.head.copy(headP);
    this.neck.set(shC.clone().add(new THREE.Vector3(0, 0.02, 0.02)), headP.clone().add(new THREE.Vector3(0, -0.08, -0.02)));
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      const sh = new THREE.Vector3(shC.x + sx * R.shoulderHalf, shC.y - 0.03, shC.z);
      const hand = grips[s].clone().add(new THREE.Vector3(-sx * 0.03, 0.01, -0.01));
      const elbow = ik2(sh, hand, this.L.uarm, this.L.farm, new THREE.Vector3(sx * 0.9, 0.35, -0.5), new THREE.Vector3());
      this.uarm[s].set(sh, elbow); this.farm[s].set(elbow, hand); this.hand[s].position.copy(hand);
      J.sh[s].copy(sh); J.el[s].copy(elbow); J.hd[s].copy(hand);
      const hip = new THREE.Vector3(hipC.x + sx * R.hipHalf, hipC.y, hipC.z);
      const ankle = new THREE.Vector3(sx * R.peg.x, R.peg.y + 0.07, R.peg.z);
      const knee = ik2(hip, ankle, this.L.thigh, this.L.shin, new THREE.Vector3(sx * 0.15, 0.1, 1), new THREE.Vector3());
      this.thigh[s].set(hip, knee); this.shin[s].set(knee, ankle);
      J.hip[s].copy(hip); J.kn[s].copy(knee); J.ft[s].copy(ankle);
      const bootTop = ankle.clone().lerp(knee, 0.62);
      this.boot[s].shaft.set(ankle.clone().add(new THREE.Vector3(0, 0.02, 0)), bootTop);
      this.boot[s].foot.position.copy(ankle).add(new THREE.Vector3(0, -0.02, 0)); this.boot[s].foot.rotation.set(0.06, 0, 0);
    }
  }
}

export class DirtBikeRig {
  constructor(object, { kit = 'orange', rider = true, groundHeight = null } = {}) {
    this.groundHeight = groundHeight;
    this.root = object.getObjectByName('DirtBike') || object;
    const get = (n) => this.root.getObjectByName(n);
    this.steering = get('Steering'); this.forkLower = get('ForkLower'); this.swingarm = get('Swingarm');
    this.wheelF = get('Wheel_F'); this.wheelR = get('Wheel_R');
    this.wheelRadius = { F: this.root.userData.wheel_radius_front ?? 0.346, R: this.root.userData.wheel_radius_rear ?? 0.345 };
    this.forkRest = this.forkLower.position.y;
    this.swingRest = this.swingarm.rotation.x;
    this.steerBase = this.steering.quaternion.clone();
    this.baseF = this.wheelF.quaternion.clone(); this.baseR = this.wheelR.quaternion.clone();
    this.spinF = 0; this.spinR = 0;
    // grip points: found from the bar mesh's bounds, kept in the Steering frame so they turn with the bars
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const box = new THREE.Box3();
    const sm = get('Steering_Mesh');
    if (sm) { sm.geometry.computeBoundingBox(); box.copy(sm.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, sm.matrixWorld)); }
    const gy = box.isEmpty() ? 1.23 : box.max.y - 0.05, gx = box.isEmpty() ? 0.31 : Math.min(0.31, box.max.x - 0.04);
    const toSteer = (v) => this.steering.worldToLocal(this.root.localToWorld(v.clone()));
    this.gripsLocal = [toSteer(new THREE.Vector3(gx, gy, 0.255)), toSteer(new THREE.Vector3(-gx, gy, 0.255))];
    this.rider = rider ? new Rider(this.root, kit) : null;
    this._grips = [new THREE.Vector3(), new THREE.Vector3()];
    this._qx = new THREE.Quaternion(); this._ax = new THREE.Vector3(1, 0, 0);
  }

  // call before removing the bike from the scene: brings a thrown rider back so it goes with the bike
  release() { this.rider?.remount(); }
  // world position of the thrown rider (null while riding) – e.g. for the chase camera
  riderFocus(out) { return this.rider ? this.rider.focus(out) : null; }

  update(dt, { speed = 0, steer = 0, suspension = {}, bike = null } = {}) {
    // steering about the raked head (Euler order XYZ: rotation.y turns about the tilted axis)
    this.steering.quaternion.copy(this.steerBase).multiply(this._qx.setFromAxisAngle(UP, steer));
    const sF = suspension.F || 0, sR = suspension.R || 0;
    this.forkLower.position.y = this.forkRest + THREE.MathUtils.clamp(sF / Math.cos(RAKE), -0.02, 0.26);
    this.swingarm.rotation.x = this.swingRest + Math.asin(THREE.MathUtils.clamp(sR / SWING_ARM, -0.08, 0.44));
    const vF = bike ? bike.wheelSpeedFront : speed;
    this.spinF = (this.spinF + (vF * dt) / this.wheelRadius.F) % (Math.PI * 2);
    this.spinR = (this.spinR + (speed * dt) / this.wheelRadius.R) % (Math.PI * 2);
    this.wheelF.quaternion.copy(this.baseF).multiply(this._qx.setFromAxisAngle(this._ax, this.spinF));
    this.wheelR.quaternion.copy(this.baseR).multiply(this._qx.setFromAxisAngle(this._ax, this.spinR));
    if (this.rider && bike) {
      // thrown off in a big crash → ragdoll until the bike is picked up again
      if (bike.ejected && !this.rider.ragdoll) {
        this.root.updateMatrixWorld(true);
        const pv = (wp) => { const v = bike.pointVel([wp.x, wp.y, wp.z]); return new THREE.Vector3(v[0], v[1], v[2]); };
        this.rider.eject(this.root, pv, this.groundHeight, bike.id * 0.37 + (bike.crashTime || 0));
      } else if (!bike.ejected && this.rider.ragdoll) this.rider.remount();
      if (this.rider.ragdoll) { this.rider.stepRagdoll(dt); return; }
    }
    if (this.rider) {
      this.root.updateMatrixWorld(true);
      for (let i = 0; i < 2; i++) this.root.worldToLocal(this.steering.localToWorld(this._grips[i].copy(this.gripsLocal[i])));
      const t = ((bike?.travel?.F || sF) + (bike?.travel?.R || sR)) * 0.5;
      this.rider.update(dt, { grips: this._grips, travel: t, airborne: bike?.airborne, lean: bike ? bike.roll : 0, speed: Math.abs(speed) });
    }
  }
}
