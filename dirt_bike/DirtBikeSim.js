// DirtBikeSim.js – dirt bike physics for MX, running inside the monster trucks' TruckWorld (no dependencies).
//
// A BikeBody is a 6-DOF rigid body (bike + rider) on two wheels, built on TruckBody so it shares the
// world's ground, surfaces, statics and vehicle-vs-vehicle collisions:
//   • front fork and rear shock as independent sprung corners with light unsprung wheels
//   • thin knobby tyres: when the bike leans the contact moves out from under the hub, so gravity
//     really tries to tip it over; drive (rear), brakes (60 % front), lateral grip with a friction circle
//   • steer input = lean, like riding a real bike: the input asks for a cornering acceleration (up to the
//     grip limit, ~37° of lean), the rider leans the bike there (balance torque, limited – hit something
//     hard enough and you go down), and the front wheel turns to the angle that makes the lean a balanced
//     turn. A limited yaw assist makes the bike carve the turn its lean asks for and catches slides.
//     Below walking pace it's direct steering.
//   • friction circle with cornering priority (the rider feathers brakes/throttle in a lean), tyre load
//     sensitivity on hard landings, wheelie control (throttle eases off as the nose lifts)
//   • air control like a real rider: throttle lifts the nose, rear brake drops it, body English levels the roll
//   • crashes: the rider/bars touching the ground, or lying over past ~70°, ends the run → onCrash;
//     the bike is picked up after `crashRecover` seconds (onRecover). Big ones – fast, a hard hit, or
//     landing upside down – throw the rider off (bike.ejected; DirtBikeRig turns the rider into a ragdoll)
//     and take longer to recover from (`ejectRecover`)
//
//   import { TruckWorld } from '../monster_truck/MonsterTruckSim.js';
//   import { addBike } from '../dirt_bike/DirtBikeSim.js';
//   const bike = addBike(world, { x, z, yaw, autoRecoverAfter: 2 });
//   bike.input = { throttle, brake, steer };            // same as a truck (+steer = left)
//   world.step(dt);
//   rig.root.position.set(...bike.rootPosition); rig.root.quaternion.set(...bike.rootQuaternion);
//   rig.update(dt, { speed: bike.wheelSpeed, steer: bike.steerAngle, suspension: bike.travel });   // DirtBikeRig
//
// Same frame as the trucks: +Z forward, +X left, +Y up, origin on the ground between the axles.
import { TruckBody } from '../monster_truck/MonsterTruckSim.js';

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const qMulVec = (q, v) => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

export const BIKE_DEFAULTS = {
  // bike (~112 kg) + rider (~78 kg)
  mass: 190,
  inertia: [52, 46, 30],               // pitch, yaw, roll about the CG
  cgHeight: 0.84,
  wheelRadius: 0.346, tyreTube: 0.055, // tyre outer radius, and the tread's cross-section radius
  wheels: { F: [0, 0.74], R: [0, -0.74] },
  wheelbase: 1.48,
  wheelMass: 14,
  // suspension (along the bike's up axis; travel 0 = static sag)
  springRate: 11000, dampCompression: 1100, dampRebound: 1700,
  bumpStart: 0.14, bumpRate: 420000, bumpDamp: 5000,
  droop: 0.10, travelMax: 0.20, endStopRate: 4e5, endStopDamp: 9000, topOutForce: 0.25,
  // tyres
  tyreRate: 70000, tyreDamp: 450, tyreMaxForce: 26000,
  tyreBottom: 0.045, tyreBottomRate: 4e6, tyreBottomDamp: 6000,
  grip: 0.86, gripSideSat: 0.7, gripLoadCap: 2.5,
  rollingResistance: 0.02,
  longForceHeight: 0.42,               // anti-squat / anti-dive: drive & brake act this far above the patch (less pitch / weight transfer)
  // drive
  driveForce: 4700, topSpeed: 58, brakeForce: 1900, frontBrakeShare: 0.6,
  maxSteer: 0.6, aLatMax: 7.4, steerRate: 3.2, steerGainSpeed: 12,     // aLatMax: cornering accel (m/s²) at full lean → max lean ≈ 37°
  // rider balance
  yawAssist: 9, yawAssistMax: 900,
  leanMax: 0.95, balanceKp: 320, balanceKd: 36, balanceTorque: 9000,
  wheelieStart: 0.22, wheelieFull: 0.42,   // rider feathers the throttle as the nose lifts past these pitch angles (rad, vs the ground)
  // collision hull (bike + rider) – also used for vehicle-vs-vehicle contacts
  hullBox: { center: [0, 0.82, -0.05], half: [0.24, 0.42, 0.98] },
  hullStiffness: 260000, hullDamping: 7000, hullFriction: 0.7,
  // air control
  airPitchLevel: 4.5, airPitchDamp: 2.2, airPitchTarget: -0.05, airPitchThrottle: 0.32, airPitchBrake: 0.42,
  airRollLevel: 9.0, airRollDamp: 4.5,
  // crashes
  crashTilt: 1.2, crashSpeed: 2.5, crashRecover: 1.8,
  ejectSpeed: 20, ejectImpact: 6.5, ejectTilt: 2.1, ejectPitch: 0.6, ejectRecover: 3.2,   // throw the rider off: see _postStep
  rolloverTilt: 1.75, autoRecoverAfter: null,
};

const TYRE_SAMPLES = [-0.6, -0.3, 0, 0.3, 0.6];

export class BikeBody extends TruckBody {
  constructor(world, o = {}) {
    super(world, { ...BIKE_DEFAULTS, ...o });
    this.kind = 'bike';
    const p = this.p, { center: c, half: hh } = p.hullBox;
    // hull: bike box (skid plate, fenders, seat) + rider points (flag = crash if they touch the ground)
    this.hull = []; this.hullCrash = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, -0.5, 0, 0.5, 1]) {
      this.hull.push([c[0] + sx * hh[0] * (sy < 0 ? 0.55 : 1), c[1] + sy * hh[1], c[2] + sz * hh[2]]); this.hullCrash.push(false);
    }
    const rider = [[0.33, 1.22, 0.27], [-0.33, 1.22, 0.27],   // bar ends
      [0.22, 1.52, 0.02], [-0.22, 1.52, 0.02],                 // shoulders
      [0, 1.78, 0.12], [0.12, 1.68, 0.12], [-0.12, 1.68, 0.12], // helmet
      [0.2, 1.12, -0.2], [-0.2, 1.12, -0.2]];                  // hips
    for (const r of rider) { this.hull.push(r); this.hullCrash.push(true); }
    this.onCrash = null; this.onRecover = null;
  }

  reset(o = {}) {
    super.reset(o);
    const p = this.p;
    this.preload = (p.mass * this.world.gravity) / 2 / p.springRate;
    this.tyreRest = ((p.mass / 2 + p.wheelMass) * this.world.gravity) / p.tyreRate;
    this.crashed = false; this.crashTime = 0; this.lean = 0; this.ejected = false;
  }

  _forces(h) {
    const p = this.p, W = this.world, G = W.gravity;
    this._F = [0, -p.mass * G, 0]; this._T = [0, 0, 0];
    const up = this.up, fwd = this.forward, left = this.left;
    const vLong = V.dot(this.vel, fwd);
    const inp = this.crashed ? { throttle: 0, brake: 0.3, steer: 0 } : this.input;
    // steering. Like a real bike the rider leans and the front wheel follows the lean: the input sets a
    // target lean (deeper when faster, up to the grip limit), and the steer angle is the one that makes
    // that lean a balanced turn (tan δ = L·g·tan φ / v²). Below walking pace it's direct steering.
    const roll0 = Math.asin(clamp(left[1], -1, 1));
    const sp = Math.abs(vLong), v2 = Math.max(vLong * vLong, 1);
    // input → cornering acceleration; at speed a small input already asks for the full lean (like the trucks' steering)
    const aDes = p.aLatMax * clamp(clamp(inp.steer, -1, 1) * (1 + sp / p.steerGainSpeed), -1, 1) * clamp(sp / 6, 0.25, 1);
    this.lean = -Math.min(p.leanMax, Math.atan(Math.abs(aDes) / G)) * Math.sign(aDes);
    const dLean = Math.atan((p.wheelbase * G * Math.tan(-roll0)) / v2) * Math.sign(vLong || 1);
    const kd = clamp((sp - 3) / 4, 0, 1);
    const steerTarget = clamp(kd * dLean + (1 - kd) * clamp(inp.steer, -1, 1) * p.maxSteer, -p.maxSteer, p.maxSteer);
    this.steerAngle += clamp(steerTarget - this.steerAngle, -p.steerRate * h, p.steerRate * h);
    let touching = 0;
    const F0 = this.preload * p.springRate, Rr = p.wheelRadius, rt = p.tyreTube;
    // nose height vs the ground under the bike: feather the throttle before a wheelie loops it
    const fF = this.toWorld([0, 0, p.wheels.F[1]]), fR = this.toWorld([0, 0, p.wheels.R[1]]);
    const gPitch = Math.atan2(W.groundHeight(fF[0], fF[2]) - W.groundHeight(fR[0], fR[2]), p.wheelbase);
    this.pitchRel = Math.asin(clamp(fwd[1], -1, 1)) - gPitch;
    const wheelie = clamp((this.pitchRel - p.wheelieStart) / (p.wheelieFull - p.wheelieStart), 0, 1);
    for (const k in this.wheels) {
      const wh = this.wheels[k], [wx, wz] = p.wheels[k], front = k === 'F';
      const mount = this.toWorld([wx, Rr, wz]);
      const vMount = this.pointVel(mount);
      const ds = wh.uv - V.dot(vMount, up);
      const s = wh.s;
      let Fs = Math.max(F0 * p.topOutForce, F0 + p.springRate * s) + (ds > 0 ? p.dampCompression : p.dampRebound) * ds;
      if (s > p.bumpStart) { const b = s - p.bumpStart; Fs += p.bumpRate * b * b + p.bumpDamp * Math.max(0, ds); }
      if (s > p.travelMax) Fs += p.endStopRate * (s - p.travelMax) + p.endStopDamp * ds;
      if (s < -p.droop) Fs -= p.endStopRate * (-p.droop - s) - p.endStopDamp * 0.3 * ds;
      const c = V.add(mount, V.mul(up, s));
      const vHub = V.add(vMount, V.mul(up, ds));
      // tyre heading and wheel plane
      const st = front ? this.steerAngle : 0, cs = Math.cos(st), sn = Math.sin(st);
      const head = V.add(V.mul(fwd, cs), V.mul(left, sn));
      const axle = V.norm(V.cross(up, head));                 // wheel plane normal
      // lowest direction inside the wheel plane = world down with the axle component removed
      let dn = V.sub([0, -1, 0], V.mul(axle, -axle[1]));
      const cl = V.len(dn); dn = cl > 1e-4 ? V.mul(dn, 1 / cl) : [0, -1, 0];
      const rIn = Rr - rt;
      let fh = [head[0], 0, head[2]]; const fl = Math.hypot(fh[0], fh[2]) || 1; fh = [fh[0] / fl, 0, fh[2] / fl];
      let pen = -1, n = [0, 1, 0];
      for (const f of TYRE_SAMPLES) {
        const dx = f * Rr, sx = c[0] + fh[0] * dx, sz = c[2] + fh[2] * dx;
        const drop = Math.sqrt(Math.max(0, rIn * rIn - dx * dx)) * cl + rt;
        const gs = W.groundHeight(sx, sz), ns = W.groundNormal(sx, sz);
        const ps = (gs - (c[1] - drop) + this.tyreRest) * ns[1];
        if (ps > pen) { pen = ps; n = ns; }
      }
      let Fa = 0; wh.contact = false; wh.slipLat = 0; wh.slipLong = 0;
      if (pen > 0) {
        wh.contact = true; touching++;
        const vn = V.dot(vHub, n);
        let Fn = p.tyreRate * pen - p.tyreDamp * vn;
        const deep = pen - this.tyreRest - p.tyreBottom;
        if (deep > 0) Fn += p.tyreBottomRate * deep * deep - p.tyreBottomDamp * vn;
        Fn = clamp(Fn, 0, p.tyreMaxForce);
        wh.Fn = Fn;
        let fw = V.norm(V.sub(head, V.mul(n, V.dot(head, n))));
        const lw = V.cross(n, fw);
        const contactPt = V.add(V.add(c, V.mul(dn, rIn)), [0, -rt, 0]);
        const vP = this.pointVel(contactPt);
        const vl = V.dot(vHub, fw), vlat = V.dot(vP, lw);
        const sf = W.surface ? W.surface(c[0], c[2]) : null;
        // tyre load sensitivity: grip stops growing past ~2.5× static load (hard landings don't snap the bike sideways)
        const mu = p.grip * (sf ? sf.grip : 1) * Math.min(Fn, p.gripLoadCap * p.mass * G * 0.5);
        const rollRes = sf ? sf.roll : p.rollingResistance;
        const drive = front ? 0 : clamp(inp.throttle, 0, 1) * p.driveForce * Math.max(0, 1 - vl / p.topSpeed) * (1 - wheelie);
        const brake = clamp(inp.brake, 0, 1) * p.brakeForce * (front ? p.frontBrakeShare : 1 - p.frontBrakeShare);
        const sv = clamp(vl / 0.4, -1, 1);
        // friction circle with cornering priority: like a rider modulating the lever/throttle in a lean,
        // drive and brakes only get the grip the side force leaves over
        let Flat = -mu * clamp(vlat / p.gripSideSat, -1, 1);
        const longCap = Math.sqrt(Math.max(0, mu * mu * 0.97 - Flat * Flat)) + 0.12 * mu;
        let Flong = clamp(drive, 0, longCap) - clamp(brake, 0, longCap) * sv - rollRes * Fn * sv;
        const Fmag = Math.hypot(Flong, Flat);
        if (Fmag > mu) { Flong *= mu / Fmag; Flat *= mu / Fmag; }
        if (this.crashed || up[1] < 0.4) {   // down: the tyres just scrub
          const vt = V.sub(vP, V.mul(n, V.dot(vP, n))), vtl = V.len(vt);
          Flong = 0; Flat = 0; wh._scrub = vtl > 1e-4 ? V.mul(vt, -Math.min(0.8 * Fn, 3000 * vtl) / vtl) : [0, 0, 0];
        } else wh._scrub = null;
        const Ft = V.add(V.add(V.mul(n, Fn), V.mul(fw, Flong)), V.mul(lw, Flat));
        Fa = V.dot(Ft, up);
        const perp = (F) => V.sub(F, V.mul(up, V.dot(F, up)));
        this._applyForce(perp(V.mul(n, Fn)), contactPt);
        this._applyForce(perp(V.mul(fw, Flong)), V.add(contactPt, V.mul(up, p.longForceHeight)));
        this._applyForce(perp(V.mul(lw, Flat)), contactPt);
        if (wh._scrub) this._applyForce(wh._scrub, contactPt);
        const avail = longCap * 0.95;
        wh.slipLong = drive > avail ? Math.min(9, ((drive - avail) / Math.max(avail, 1)) * 6 + 1) : 0;
        wh.slipLat = vlat;
        wh.spinRate = (vl + wh.slipLong) / Rr;
        if (!wh.wasContact) wh.impact = Math.max(wh.impact, -vn);
      } else {
        wh.Fn = 0;
        wh.spinRate += (((front ? 0 : inp.throttle * 40) - wh.spinRate * 0.4) * 0.8) * h;
      }
      wh.wasContact = wh.contact;
      const gAxis = -G * up[1];
      wh._acc = (Fa - Fs) / p.wheelMass + gAxis;
      wh._ds = ds;
      this._applyForce(V.mul(up, Fs), mount);
      const gPerp = V.sub([0, -p.wheelMass * G, 0], V.mul(up, p.wheelMass * gAxis));
      this._applyForce(gPerp, mount);
    }
    // hull vs ground
    let hullHits = 0, hullImpact = 0, riderHit = 0;
    for (let i = 0; i < this.hull.length; i++) {
      const pw = this.toWorld(this.hull[i]);
      const g = W.groundHeight(pw[0], pw[2]);
      if (pw[1] > g + 0.4) continue;
      const n = W.groundNormal(pw[0], pw[2]);
      const d = (pw[1] - g) * n[1];
      if (d >= 0) continue;
      const v = this.pointVel(pw), vn = V.dot(v, n);
      const Fn = Math.max(0, -p.hullStiffness * d - p.hullDamping * vn);
      const vt = V.sub(v, V.mul(n, vn)), vtl = V.len(vt);
      const Ff = vtl > 1e-4 ? V.mul(vt, -Math.min(p.hullFriction * Fn, 2500 * vtl) / vtl) : [0, 0, 0];
      this._applyForce(V.add(V.mul(n, Fn), Ff), pw);
      hullHits++; hullImpact = Math.max(hullImpact, -vn);
      if (this.hullCrash[i]) riderHit = Math.max(riderHit, Math.max(-vn, vtl * 0.5, 0.01));
    }
    this._touching = touching; this._hullHits = hullHits; this._hullImpact = hullImpact; this._riderHit = riderHit;
    // ---- the rider
    const wl = qMulVec(qConj(this.q), this.w);              // body-frame angular velocity (x pitch, y yaw, z roll)
    const roll = Math.asin(clamp(left[1], -1, 1));          // + = left side up (leaning right)
    if (!this.crashed && touching > 0 && up[1] > 0.25) {
      // hold the lean the rider asked for (the front wheel follows it, see the steering above)
      const target = this.lean;
      const err = target - roll, rate = wl[2];
      const tq = clamp((p.balanceKp * err - p.balanceKd * rate) * p.inertia[2], -p.balanceTorque, p.balanceTorque) * (touching === 2 ? 1 : 0.7);
      this._T = V.add(this._T, V.mul(fwd, tq));
      // the rider makes the bike carve the turn its lean asks for and catches slides (an assist, limited, so big slides still happen)
      // target yaw rate: the turn the current lean balances (g·tan φ / v), or the steering's at walking pace
      const rLean = (G * Math.tan(-roll)) / Math.max(sp, 3) * Math.sign(vLong || 1);
      const rSteer = (vLong * Math.tan(this.steerAngle)) / p.wheelbase;
      const rKin = kd * rLean + (1 - kd) * rSteer;
      const yawErr = rKin - V.dot(this.w, up);
      const ty = clamp(p.yawAssist * yawErr * p.inertia[1], -p.yawAssistMax, p.yawAssistMax) * clamp(Math.abs(vLong) / 4, 0, 1);
      this._T = V.add(this._T, V.mul(up, ty));
    } else if (!this.crashed && touching === 0 && hullHits === 0 && this.tilt < 1.3) {
      // air: throttle lifts the nose (rear wheel gyro), rear brake drops it; body English levels the roll
      const pitch = Math.asin(clamp(fwd[1], -1, 1));
      const pt = p.airPitchTarget + p.airPitchThrottle * clamp(inp.throttle, 0, 1) - p.airPitchBrake * clamp(inp.brake, 0, 1);
      // torque about the bike's +X (left) axis rotates the nose down, so drive −(target − pitch)
      const tx = (-p.airPitchLevel * (pt - pitch) - p.airPitchDamp * wl[0]) * p.inertia[0];
      const tz = (-p.airRollLevel * roll - p.airRollDamp * wl[2]) * p.inertia[2];
      this._T = V.add(this._T, qMulVec(this.q, [tx, 0, tz]));
    }
  }

  _postStep(dt) {
    const p = this.p;
    if (!this.crashed) {
      const tilt = this.tilt;
      const down = (this._riderHit > p.crashSpeed) || (this._riderHit > 0 && this.speed > 4) || (tilt > p.crashTilt && (this._touching > 0 || this._hullHits > 0));
      if (down) {
        // how bad is it? The rider is thrown off when it's extreme: a hard hit on the rider/bike (> 6.5 m/s),
        // landing upside down, going over the bars (nose down > ~35° at speed), or any crash above ~72 km/h.
        // An ordinary low-side or tip-over keeps the rider with the bike.
        const hit = Math.max(this._riderHit, this._hullImpact), sp = this.speed;
        this.ejected = sp > p.ejectSpeed || hit > p.ejectImpact || (tilt > p.ejectTilt && sp > 4) || (this.pitch < -p.ejectPitch && sp > 9);
        this.crashed = true; this.crashTime = 0;
        this.onCrash?.(this, Math.max(this._riderHit, this.speed), { ejected: this.ejected });
      }
    } else {
      this.crashTime += dt;
      const wait = this.ejected ? p.ejectRecover : p.crashRecover;
      if (this.crashTime > wait && (this.speed < 3 || this.crashTime > wait + 2)) { this.recover(0.4); this.onRecover?.(this); }
    }
    super._postStep(dt);
  }

  recover(lift = 0.4) {
    // pick the bike up facing where it was travelling (or pointing), wheels on the ground
    const v = this.vel, f = this.forward;
    const yaw = Math.hypot(v[0], v[2]) > 3 ? Math.atan2(v[0], v[2]) : Math.atan2(f[0], f[2]);
    const g = this.world.groundHeight(this.pos[0], this.pos[2]);
    this.reset({ x: this.pos[0], z: this.pos[2], yaw, y: g + lift });
  }

  _sync() {
    const p = this.p;
    this.rootPosition = V.sub(this.pos, qMulVec(this.q, [0, p.cgHeight, 0])); this.rootQuaternion = this.q.slice();
    this.travel = {}; this.contact = {}; this.slip = {};
    for (const k in this.wheels) {
      const wh = this.wheels[k];
      this.travel[k] = clamp(wh.s, -p.droop, p.travelMax); this.contact[k] = wh.contact; this.slip[k] = { long: wh.slipLong, lat: wh.slipLat };
    }
    this.vLong = V.dot(this.vel, this.forward);
    this.wheelSpeed = this.wheels.R.spinRate * this.p.wheelRadius;
    this.wheelSpeedFront = this.wheels.F.spinRate * this.p.wheelRadius;
  }
}

// add a bike to a TruckWorld (it races, collides and is stepped exactly like a truck)
export function addBike(world, o = {}) { const b = new BikeBody(world, o); world.trucks.push(b); return b; }
