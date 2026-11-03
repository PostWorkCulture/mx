// MonsterTruckSim.js – full 6-DOF physics for the MX monster trucks (no dependencies).
//
// Replaces the vertical-only MonsterTruckPhysics + MonsterTruckDrive pair. Each truck is a rigid
// body (position, velocity, quaternion orientation, angular velocity) with:
//   • four independent coil-over corners carrying heavy unsprung wheels on soft, bouncy tyres
//     (landing bounce scales with jump height; one-sided landings load that side)
//   • tyre forces at the contact patches (drive, brake, rolling, lateral grip with a friction circle)
//     – applied at ground level, so slides and trips create real roll moments
//   • a collision hull (body shell + cage) that hits the ground: bad landings, cartwheels, roll-overs,
//     sliding on the roof – all emerge from the same contacts
//   • truck-vs-truck collisions (body boxes + wheel spheres) and static obstacles (boxes / spheres)
//   • events: onLand, onImpact, onRollover, plus tilt / upsideDown / stuck flags and recover()
//
//   const world = new TruckWorld({ groundHeight: (x, z) => terrainHeight(x, z) });
//   // optional per-surface tyre behaviour (e.g. DesertTerrain.surface): (x, z) => { grip: ×μ, roll: coefficient }
//   const world = new TruckWorld({ groundHeight: terrain.height, surface: terrain.surface });
//   const truck = world.addTruck({ x: 0, z: 0, yaw: 0 });
//   world.addStaticBox({ center: [10, 1, 40], half: [2, 1, 2], yaw: 0.3 });   // rocks, walls, containers
//   // every frame:
//   truck.input = { throttle, brake, steer };            // throttle/brake 0..1, steer −1..1 (+ = left)
//   world.step(dt);
//   rig.root.position.set(...truck.rootPosition); rig.root.quaternion.set(...truck.rootQuaternion);
//   rig.update(dt, { speed: truck.wheelSpeed, steer: truck.steerAngle, suspension: truck.travel });
//
// Units: metres, kg, seconds. World: +Y up. Truck local frame (matches the GLB): +Z forward,
// +X left, +Y up, origin on the ground between the axles.

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
// quaternion [x,y,z,w]
const qMulVec = (q, v) => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const qFromYaw = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

export const TRUCK_DEFAULTS = {
  // mass & geometry
  mass: 3900,                         // chassis + body (wheels are separate below)
  inertia: [10500, 12500, 5200],      // about local X (pitch), Y (yaw), Z (roll) through the CG
  cgHeight: 1.25,                     // CG above the ground at rest (game-tuned low so it's hard to tip: static stability ≈ 1.25 g)
  wheelRadius: 0.919,
  wheels: { FL: [1.56, 1.62], FR: [-1.56, 1.62], RL: [1.56, -1.55], RR: [-1.56, -1.55] }, // [x (left +), z]
  wheelMass: 220,
  // suspension (per corner – two coil-overs)
  springRate: 40000, dampCompression: 3000, dampRebound: 4300,
  bumpStart: 0.30, bumpRate: 900000, bumpDamp: 16000,
  droop: 0.36, travelMax: 0.40, endStopRate: 1.5e6, endStopDamp: 90000, topOutForce: 0.3,
  // tyres on sand
  tyreRate: 180000, tyreDamp: 1400,
  tyreMaxForce: 320000,
  tyreBottom: 0.16, tyreBottomRate: 2.5e7, tyreBottomDamp: 60000,   // sidewall/rim bottoming past this deflection (m)
  grip: 0.78, gripSideSat: 1.1,       // μ, and the sideways slip speed (m/s) where grip saturates
  digIn: 0.3, digInStart: 6, digInFull: 10,   // sliding sideways fast, tyres dig into sand: side grip rises → trips / roll-overs (kept mild)
  rollingResistance: 0.02,
  // where tyre forces act on the chassis (m above the contact patch). 0 = raw geometry; higher values
  // model anti-squat / roll-centre geometry and make the truck less tippy. Lower latForceHeight for
  // a truck that rolls more easily in hard turns.
  longForceHeight: 0.6, latForceHeight: 0.9,
  antiRoll: 60000,                    // N/m per axle: anti-roll bar between left and right travel
  // drivetrain
  driveForce: 72000, topSpeed: 52, frontDriveShare: 0.42, brakeForce: 55000,   // ~185 km/h flat out
  maxSteer: 0.55, steerSpeedFalloff: 22, steerRate: 2.6,
  // collision hull (truck local frame)
  hullBox: { center: [0, 2.15, -0.05], half: [1.17, 0.85, 2.45] },
  hullStiffness: 380000, hullDamping: 70000, hullFriction: 0.6,
  // air control (driver throttle/brake in the air)
  airPitchLevel: 3.0, airPitchDamp: 1.6, airPitchTarget: -0.06, airRollLevel: 2.4, airRollDamp: 2.2, airControlTilt: 1.45,
  airYawAlign: 2.2, airYawDamp: 1.6,   // arcade: in the air the truck swings its nose round to where it's flying, so it lands straight
  // tip resistance (game assist, wheels or body on the ground): the wide stance and the driver's weight
  // shift resist rolling once the truck leans past ~17° to the ground; fades out by ~90° so a truck that
  // is really going over still goes over (bad landings, big T-bones, steep kickers)
  tipAssist: 5, tipAssistDamp: 4, tipAssistFrom: 0.3, tipAssistTo: 1.6,
  // events / recovery
  rolloverTilt: 1.75,                 // rad (~100°) past which onRollover fires
  autoRecoverAfter: null,             // seconds stuck on side / roof before auto recover (null = never)
};

let _id = 0;
const TYRE_SAMPLES = [-0.7, -0.35, 0, 0.35, 0.7];

export class TruckBody {
  constructor(world, o = {}) {
    this.world = world; this.id = ++_id; this.name = o.name || 'truck' + this.id;
    this.p = { ...TRUCK_DEFAULTS, ...o };
    const p = this.p;
    this.invI = p.inertia.map((v) => 1 / v);
    this.input = { throttle: 0, brake: 0, steer: 0 };
    this.onLand = null; this.onImpact = null; this.onRollover = null;
    // hull sample points (truck local, relative to root): box corners, edge mids, face centres + cab roof + wing
    const { center: c, half: h } = p.hullBox; this.hull = [];
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, -0.5, 0, 0.5, 1]) {
      if (sx === 0 && sy === 0) continue;
      this.hull.push([c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.hull.push([sx * 0.95, 3.12, sz * 0.9 - 0.2]); // cab roof
    this.hull.push([0, 3.2, -2.3], [0.9, 3.2, -2.3], [-0.9, 3.2, -2.3]);                                     // wing
    this.wheels = {};
    for (const k in p.wheels) this.wheels[k] = { key: k, s: 0, uv: 0, contact: false, Fn: 0, spin: 0, spinRate: 0, slipLong: 0, slipLat: 0, impact: 0 };
    this.reset(o);
  }

  reset({ x = 0, y = null, z = 0, yaw = 0 } = {}) {
    const p = this.p, g = this.world.groundHeight(x, z);
    this.q = qFromYaw(yaw);
    this.pos = [x, (y ?? g) + p.cgHeight, z];
    this.vel = [0, 0, 0]; this.w = [0, 0, 0];
    this.preload = (p.mass * this.world.gravity) / 4 / p.springRate;
    this.tyreRest = ((p.mass / 4 + p.wheelMass) * this.world.gravity) / p.tyreRate;
    for (const k in this.wheels) Object.assign(this.wheels[k], { s: 0, uv: 0, contact: true, spinRate: 0 });
    this.steerAngle = 0; this.airborne = false; this.airTime = 0; this.hullContact = false;
    this.rolledOver = false; this.stuckTime = 0; this._landing = null; this._contacts = new Map();
    this._sync();
  }

  // ---------- frames ----------
  toWorld(rLocal) { return V.add(this.pos, qMulVec(this.q, [rLocal[0], rLocal[1] - this.p.cgHeight, rLocal[2]])); }
  dirWorld(v) { return qMulVec(this.q, v); }
  pointVel(pw) { return V.add(this.vel, V.cross(this.w, V.sub(pw, this.pos))); }
  get up() { return qMulVec(this.q, [0, 1, 0]); }
  get forward() { return qMulVec(this.q, [0, 0, 1]); }
  get left() { return qMulVec(this.q, [1, 0, 0]); }
  get tilt() { return Math.acos(clamp(this.up[1], -1, 1)); }        // 0 upright, π/2 on its side, π on the roof
  get upsideDown() { return this.up[1] < 0; }
  get speed() { return V.len(this.vel); }

  _applyForce(F, at) { this._F = V.add(this._F, F); this._T = V.add(this._T, V.cross(V.sub(at, this.pos), F)); }

  // ---------- forces for one substep ----------
  _forces(h) {
    const p = this.p, W = this.world, G = W.gravity;
    this._F = [0, -p.mass * G, 0]; this._T = [0, 0, 0];
    const up = this.up, fwd = this.forward, left = this.left;
    // steering (speed-sensitive, rate-limited)
    const vLong = V.dot(this.vel, fwd);
    const steerTarget = clamp(this.input.steer, -1, 1) * p.maxSteer / (1 + Math.abs(vLong) / p.steerSpeedFalloff);
    this.steerAngle += clamp(steerTarget - this.steerAngle, -p.steerRate * h, p.steerRate * h);
    let touching = 0;
    const F0 = this.preload * p.springRate;
    for (const k in this.wheels) {
      const wh = this.wheels[k], [wx, wz] = p.wheels[k], front = k[0] === 'F';
      const mount = this.toWorld([wx, p.wheelRadius, wz]);
      const vMount = this.pointVel(mount);
      const ds = wh.uv - V.dot(vMount, up);                      // + = compressing
      const s = wh.s;
      // suspension force (pushes body up / wheel down along body-up)
      let Fs = Math.max(F0 * p.topOutForce, F0 + p.springRate * s) + (ds > 0 ? p.dampCompression : p.dampRebound) * ds;
      if (s > p.bumpStart) { const b = s - p.bumpStart; Fs += p.bumpRate * b * b + p.bumpDamp * Math.max(0, ds); }
      // hydraulic end stops: stiff and heavily damped both ways so a bottom-out absorbs energy instead of springing back
      if (s > p.travelMax) Fs += p.endStopRate * (s - p.travelMax) + p.endStopDamp * ds;
      if (s < -p.droop) Fs -= p.endStopRate * (-p.droop - s) - p.endStopDamp * 0.3 * ds;
      { const other = this.wheels[k[0] + (k[1] === 'L' ? 'R' : 'L')]; Fs += p.antiRoll * (s - other.s); }
      // tyre contact (tyre treated as a sphere of radius R around the hub)
      const c = V.add(mount, V.mul(up, s));
      const vHub = V.add(vMount, V.mul(up, ds));
      // tyre profile vs terrain: sample under the tread so lips, steps and ruts are felt correctly
      let pen = -1, n = [0, 1, 0];
      if (up[1] > 0.6) {
        let fh = [fwd[0], 0, fwd[2]]; const fl = Math.hypot(fh[0], fh[2]) || 1; fh = [fh[0] / fl, 0, fh[2] / fl];
        for (const f of TYRE_SAMPLES) {
          const dx = f * p.wheelRadius, sx = c[0] + fh[0] * dx, sz = c[2] + fh[2] * dx;
          const gs = W.groundHeight(sx, sz), ns = W.groundNormal(sx, sz);
          const ps = (gs - (c[1] - Math.sqrt(p.wheelRadius * p.wheelRadius - dx * dx)) + this.tyreRest) * ns[1];
          if (ps > pen) { pen = ps; n = ns; }
        }
      } else {   // on its side / roof: tyre behaves like a ball (a dead one – no big rebounds)
        const g = W.groundHeight(c[0], c[2]); n = W.groundNormal(c[0], c[2]);
        pen = p.wheelRadius + this.tyreRest - (c[1] - g) * n[1];
      }
      const tiltK = clamp((0.9 - up[1]) / 0.5, 0, 1);              // 0 upright … 1 on its side
      const tyreDamp = p.tyreDamp * (1 + 14 * tiltK);
      let Fa = 0; wh.contact = false; wh.slipLat = 0; wh.slipLong = 0;
      if (pen > 0) {
        wh.contact = true; touching++;
        const vn = V.dot(vHub, n);
        let Fn = p.tyreRate * pen - tyreDamp * vn;
        const deep = pen - this.tyreRest - p.tyreBottom;
        if (deep > 0) Fn += p.tyreBottomRate * deep * deep - p.tyreBottomDamp * vn;
        Fn = clamp(Fn, 0, p.tyreMaxForce);
        wh.Fn = Fn;
        // tyre heading on the ground plane
        const st = front ? this.steerAngle : 0, cs = Math.cos(st), sn = Math.sin(st);
        let fw = V.add(V.mul(fwd, cs), V.mul(left, sn));
        fw = V.norm(V.sub(fw, V.mul(n, V.dot(fw, n))));
        const lw = V.cross(n, fw);
        const vl = V.dot(vHub, fw), vlat = V.dot(vHub, lw);
        const sf = W.surface ? W.surface(c[0], c[2]) : null;   // optional terrain surface: { grip (×), roll }
        const mu = p.grip * (sf ? sf.grip : 1) * Fn;
        const rollRes = sf ? sf.roll : p.rollingResistance;
        const share = (front ? p.frontDriveShare : 1 - p.frontDriveShare) / 2;
        const drive = share * clamp(this.input.throttle, 0, 1) * p.driveForce * Math.max(0, 1 - vl / p.topSpeed);
        const brake = share * clamp(this.input.brake, 0, 1) * p.brakeForce;
        let Flong = drive - brake * clamp(vl / 0.4, -1, 1) - rollRes * Fn * clamp(vl / 0.4, -1, 1);
        const dig = 1 + p.digIn * clamp((Math.abs(vlat) - p.digInStart) / (p.digInFull - p.digInStart), 0, 1);
        let Flat = -mu * dig * clamp(vlat / p.gripSideSat, -1, 1);
        const Fmag = Math.hypot(Flong, Flat), cap = mu * dig;
        if (Fmag > cap) { Flong *= cap / Fmag; Flat *= cap / Fmag; }
        if (up[1] < 0.6) {   // on its side / roof: tyres just scrub, no rolling or drive
          const vt = V.sub(vHub, V.mul(n, vn)), vtl = V.len(vt);
          Flong = 0; Flat = 0; wh._scrub = vtl > 1e-4 ? V.mul(vt, -Math.min(0.7 * Fn, 20000 * vtl) / vtl) : [0, 0, 0];
        } else wh._scrub = null;
        const Ft = V.add(V.add(V.mul(n, Fn), V.mul(fw, Flong)), V.mul(lw, Flat));
        Fa = V.dot(Ft, up);
        const contactPt = V.sub(c, V.mul(n, p.wheelRadius));
        // everything not along the strut goes into the chassis: normal part at the patch,
        // drive/brake and side forces at their effective heights
        const Fnorm = V.mul(n, Fn), Fl = V.mul(fw, Flong), Fs2 = V.mul(lw, Flat);
        const perp = (F) => V.sub(F, V.mul(up, V.dot(F, up)));
        this._applyForce(perp(Fnorm), contactPt);
        this._applyForce(perp(Fl), V.add(contactPt, V.mul(up, p.longForceHeight)));
        this._applyForce(perp(Fs2), V.add(contactPt, V.mul(up, p.latForceHeight)));
        if (wh._scrub) this._applyForce(wh._scrub, contactPt);
        // effects data
        const avail = mu * 0.9;
        wh.slipLong = drive > avail ? Math.min(10, ((drive - avail) / Math.max(avail, 1)) * 7 + 1) : 0;
        wh.slipLat = vlat;
        wh.spinRate = (vl + wh.slipLong) / p.wheelRadius;
        if (!wh.wasContact) wh.impact = Math.max(wh.impact, -vn);
      } else {
        wh.Fn = 0;
        wh.spinRate += ((this.input.throttle * 7 - wh.spinRate * 0.5) * 0.8) * h; // free spin in the air
      }
      wh.wasContact = wh.contact;
      // wheel axial dynamics + reaction into the chassis
      const gAxis = -G * up[1];
      wh._acc = (Fa - Fs) / p.wheelMass + gAxis;
      wh._ds = ds;
      this._applyForce(V.mul(up, Fs), mount);
      const gPerp = V.sub([0, -p.wheelMass * G, 0], V.mul(up, p.wheelMass * gAxis));
      this._applyForce(gPerp, mount);
    }
    // hull vs ground
    let hullHits = 0, hullImpact = 0;
    for (const r of this.hull) {
      const pw = this.toWorld(r);
      const g = W.groundHeight(pw[0], pw[2]);
      if (pw[1] > g + 0.5) continue;
      const n = W.groundNormal(pw[0], pw[2]);
      const d = (pw[1] - g) * n[1];
      if (d >= 0) continue;
      const v = this.pointVel(pw), vn = V.dot(v, n);
      const Fn = Math.max(0, -p.hullStiffness * d - p.hullDamping * vn);
      const vt = V.sub(v, V.mul(n, vn)), vtl = V.len(vt);
      const Ff = vtl > 1e-4 ? V.mul(vt, -Math.min(p.hullFriction * Fn, 30000 * vtl) / vtl) : [0, 0, 0];
      this._applyForce(V.add(V.mul(n, Fn), Ff), pw);
      hullHits++; hullImpact = Math.max(hullImpact, -vn);
    }
    this._touching = touching; this._hullHits = hullHits; this._hullImpact = hullImpact;
    // air control: the driver can level pitch with the throttle/brake; roll is barely controllable
    if ((touching > 0 || hullHits > 0) && p.tipAssist > 0) {
      const n = W.groundNormal(this.pos[0], this.pos[2]);
      const rollRel = Math.asin(clamp(V.dot(left, n), -1, 1));            // + = left side up, relative to the ground
      const a = Math.abs(rollRel), a0 = p.tipAssistFrom, a1 = p.tipAssistTo;
      const k = clamp((a - a0) / 0.25, 0, 1) * clamp((a1 - a) / 0.4, 0, 1);
      if (k > 0) {
        const wz = V.dot(this.w, fwd);                                      // roll rate (+ = rolling left side up… see roll sign)
        const tz = (-p.tipAssist * (rollRel - Math.sign(rollRel) * a0) - p.tipAssistDamp * wz) * k * p.inertia[2];
        this._T = V.add(this._T, V.mul(fwd, tz));
      }
    }
    if (touching === 0 && hullHits === 0 && this.tilt < p.airControlTilt) {
      const pitch = Math.asin(clamp(fwd[1], -1, 1));
      const roll = Math.asin(clamp(left[1], -1, 1));
      const wl = qMulVec(qConj(this.q), this.w);                // angular velocity in the truck frame
      const tx = (-p.airPitchLevel * (-(pitch - p.airPitchTarget)) - p.airPitchDamp * wl[0]) * p.inertia[0];
      const tz = (-p.airRollLevel * roll - p.airRollDamp * wl[2]) * p.inertia[2];
      const vl = qMulVec(qConj(this.q), this.vel), vh = Math.hypot(vl[0], vl[2]);
      const yawErr = vh > 5 && vl[2] > 0 ? clamp(Math.atan2(vl[0], vl[2]), -0.8, 0.8) : 0;   // + = flying off to the left
      const ty = (p.airYawAlign * yawErr - p.airYawDamp * wl[1]) * p.inertia[1];
      this._T = V.add(this._T, qMulVec(this.q, [tx, ty, tz]));
    }
  }

  _integrate(h) {
    const p = this.p;
    this.vel = V.add(this.vel, V.mul(this._F, h / p.mass));
    this.pos = V.add(this.pos, V.mul(this.vel, h));
    // angular: ω̇ = I⁻¹(τ − ω × Iω), computed in the body frame
    const qi = qConj(this.q);
    const wl = qMulVec(qi, this.w), Tl = qMulVec(qi, this._T);
    const Iw = [p.inertia[0] * wl[0], p.inertia[1] * wl[1], p.inertia[2] * wl[2]];
    const gyro = V.cross(wl, Iw);
    const al = [(Tl[0] - gyro[0]) * this.invI[0], (Tl[1] - gyro[1]) * this.invI[1], (Tl[2] - gyro[2]) * this.invI[2]];
    this.w = V.add(this.w, V.mul(qMulVec(this.q, al), h));
    const [wx, wy, wz] = this.w, [x, y, z, w] = this.q;
    this.q = qNorm([x + 0.5 * h * (wx * w + wy * z - wz * y), y + 0.5 * h * (wy * w + wz * x - wx * z),
      z + 0.5 * h * (wz * w + wx * y - wy * x), w + 0.5 * h * (-wx * x - wy * y - wz * z)]);
    for (const k in this.wheels) {
      const wh = this.wheels[k];
      wh.uv += wh._acc * h;
      wh.s += wh._ds * h;
      wh.spin = (wh.spin + wh.spinRate * h) % (Math.PI * 2);
    }
  }

  _postStep(dt) {
    const p = this.p;
    const wasAir = this.airborne;
    this.airborne = this._touching === 0 && this._hullHits === 0;
    this.airTime = this.airborne ? this.airTime + dt : 0;
    this.hullContact = this._hullHits > 0;
    // landing event (first touchdown after ≥0.25 s in the air)
    if (wasAir && !this.airborne && this._airFor > 0.25 && this.onLand) {
      const perWheel = {}; let max = 0;
      for (const k in this.wheels) { perWheel[k] = this.wheels[k].impact; max = Math.max(max, perWheel[k]); }
      max = Math.max(max, this._hullImpact);
      this.onLand(max, { perWheel, hull: this._hullHits > 0, tilt: this.tilt, roll: this.roll, pitch: this.pitch });
    }
    this._airFor = this.airborne ? (this._airFor || 0) + dt : 0;
    if (this.airborne) for (const k in this.wheels) this.wheels[k].impact = 0;
    // roll-over / stuck
    const tilt = this.tilt;
    if (!this.rolledOver && tilt > p.rolloverTilt) { this.rolledOver = true; this.onRollover?.(this); }
    if (tilt < 0.6 && this.speed < 30) this.rolledOver = tilt > p.rolloverTilt;
    this.stuckTime = tilt > 1.0 && this.speed < 1.5 ? this.stuckTime + dt : 0;
    if (p.autoRecoverAfter != null && this.stuckTime > p.autoRecoverAfter) this.recover();
    this._sync();
  }

  get pitch() { return Math.asin(clamp(this.forward[1], -1, 1)); }   // + nose up
  get roll() { return Math.asin(clamp(this.left[1], -1, 1)); }       // + left side up
  get stuck() { return this.stuckTime > 1.5; }

  // put the truck back on its wheels where it is (keeps heading), e.g. after a roll-over
  recover(lift = 1.2) {
    const f = this.forward, yaw = Math.atan2(f[0], f[2]);
    const g = this.world.groundHeight(this.pos[0], this.pos[2]);
    this.reset({ x: this.pos[0], z: this.pos[2], yaw, y: g + lift });
  }

  _sync() {
    // GLB root (origin on the ground between the axles) for MonsterTruckRig
    const r = V.sub(this.pos, qMulVec(this.q, [0, this.p.cgHeight, 0]));
    this.rootPosition = r; this.rootQuaternion = this.q.slice();
    this.travel = {}; this.contact = {}; this.slip = {};
    for (const k in this.wheels) {
      const wh = this.wheels[k];
      this.travel[k] = clamp(wh.s, -this.p.droop, this.p.travelMax);
      this.contact[k] = wh.contact;
      this.slip[k] = { long: wh.slipLong, lat: wh.slipLat };
    }
    this.vLong = V.dot(this.vel, this.forward);
    this.wheelSpeed = (this.wheels.RL.spinRate + this.wheels.RR.spinRate) * 0.5 * this.p.wheelRadius;
  }
}

// ---------- collision helpers ----------
function boxOf(t) {   // world-space oriented box of a truck's hull
  const b = t.p.hullBox;
  return { c: t.toWorld(b.center), h: b.half, ax: [t.dirWorld([1, 0, 0]), t.dirWorld([0, 1, 0]), t.dirWorld([0, 0, 1])], body: t };
}
function staticBox(o) {
  const cy = Math.cos(o.yaw || 0), sy = Math.sin(o.yaw || 0);
  return { c: o.center, h: o.half, ax: [[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]], body: null };
}
function boxPoints(b) {   // corners, edge mids, face centres
  const pts = [];
  for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
    if (!sx && !sy && !sz) continue;
    pts.push(V.add(b.c, V.add(V.add(V.mul(b.ax[0], sx * b.h[0]), V.mul(b.ax[1], sy * b.h[1])), V.mul(b.ax[2], sz * b.h[2]))));
  }
  return pts;
}
function pointInBox(pt, b) {   // → {pen, n} with n pointing out of b toward the point
  const d = V.sub(pt, b.c); let best = null;
  for (let i = 0; i < 3; i++) {
    const di = V.dot(d, b.ax[i]), pen = b.h[i] - Math.abs(di);
    if (pen <= 0) return null;
    if (!best || pen < best.pen) best = { pen, n: V.mul(b.ax[i], di >= 0 ? 1 : -1) };
  }
  return best;
}
function sphereVsBox(c, r, b) {
  const d = V.sub(c, b.c); const loc = [0, 1, 2].map((i) => V.dot(d, b.ax[i]));
  const cl = loc.map((v, i) => clamp(v, -b.h[i], b.h[i]));
  const diffL = loc.map((v, i) => v - cl[i]); const dist = Math.hypot(...diffL);
  if (dist >= r) return null;
  if (dist > 1e-6) {
    const n = V.norm(V.add(V.add(V.mul(b.ax[0], diffL[0]), V.mul(b.ax[1], diffL[1])), V.mul(b.ax[2], diffL[2])));
    return { pen: r - dist, n, pt: V.sub(c, V.mul(n, dist)) };
  }
  const pb = pointInBox(c, b); return pb ? { pen: pb.pen + r, n: pb.n, pt: c } : null;
}

export class TruckWorld {
  constructor({ groundHeight = () => 0, surface = null, gravity = 9.81, substeps = 12, contactStiffness = 650000, contactDamping = 9000, contactFriction = 0.35 } = {}) {
    this.groundHeight = groundHeight; this.surface = surface; this.gravity = gravity; this.substeps = substeps;
    this.kc = contactStiffness; this.cc = contactDamping; this.muc = contactFriction;
    this.trucks = []; this.statics = [];
  }
  groundNormal(x, z) {
    const e = 0.3, H = this.groundHeight;
    const dx = (H(x + e, z) - H(x - e, z)) / (2 * e), dz = (H(x, z + e) - H(x, z - e)) / (2 * e);
    return V.norm([-dx, 1, -dz]);
  }
  addTruck(o = {}) { const t = new TruckBody(this, o); this.trucks.push(t); return t; }
  addStaticBox({ center, half, yaw = 0 }) { const s = { type: 'box', center, half, yaw }; this.statics.push(s); return s; }
  addStaticSphere({ center, radius }) { const s = { type: 'sphere', center, radius }; this.statics.push(s); return s; }

  _contact(A, B, pt, n, pen, key, hits) {   // A pushed along +n; B (may be null = static) along −n
    const vA = A.pointVel(pt), vB = B ? B.pointVel(pt) : [0, 0, 0];
    const vr = V.sub(vA, vB), vn = V.dot(vr, n);
    const Fn = Math.max(0, this.kc * pen - this.cc * vn);
    if (Fn <= 0) return;
    const vt = V.sub(vr, V.mul(n, vn)), vtl = V.len(vt);
    const Ff = vtl > 1e-4 ? V.mul(vt, -Math.min(this.muc * Fn, 20000 * vtl) / vtl) : [0, 0, 0];
    const F = V.add(V.mul(n, Fn), Ff);
    A._applyForce(F, pt); if (B) B._applyForce(V.mul(F, -1), pt);
    const rec = hits.get(key) || { speed: 0, pt, other: B, A };
    if (-vn > rec.speed) { rec.speed = -vn; rec.pt = pt; }
    hits.set(key, rec);
  }

  _collide(hits) {
    const T = this.trucks;
    const boxes = T.map(boxOf);
    const wheelsOf = (t) => Object.keys(t.wheels).map((k) => {
      const [wx, wz] = t.p.wheels[k];
      return V.add(t.toWorld([wx, t.p.wheelRadius, wz]), V.mul(t.up, t.wheels[k].s));
    });
    const wheelPts = T.map(wheelsOf);
    const R = (t) => t.p.wheelRadius;
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
      const A = T[i], B = T[j], key = A.id + ':' + B.id;
      if (V.len(V.sub(A.pos, B.pos)) > 12) continue;
      for (const pt of boxPoints(boxes[i])) { const c = pointInBox(pt, boxes[j]); if (c) this._contact(A, B, pt, c.n, c.pen, key, hits); }
      for (const pt of boxPoints(boxes[j])) { const c = pointInBox(pt, boxes[i]); if (c) this._contact(B, A, pt, c.n, c.pen, key, hits); }
      for (const w of wheelPts[i]) { const c = sphereVsBox(w, R(A), boxes[j]); if (c) this._contact(A, B, c.pt, c.n, c.pen, key, hits); }
      for (const w of wheelPts[j]) { const c = sphereVsBox(w, R(B), boxes[i]); if (c) this._contact(B, A, c.pt, c.n, c.pen, key, hits); }
      for (const wa of wheelPts[i]) for (const wb of wheelPts[j]) {
        const d = V.sub(wa, wb), l = V.len(d), pen = R(A) + R(B) - l;
        if (pen > 0 && l > 1e-6) { const n = V.mul(d, 1 / l); this._contact(A, B, V.sub(wa, V.mul(n, R(A) - pen / 2)), n, pen, key, hits); }
      }
    }
    for (let i = 0; i < T.length; i++) for (const S of this.statics) {
      const A = T[i], key = A.id + ':s' + this.statics.indexOf(S);
      if (S.type === 'box') {
        const sb = staticBox(S);
        if (V.len(V.sub(A.pos, sb.c)) > 8 + Math.hypot(...S.half)) continue;
        for (const pt of boxPoints(boxes[i])) { const c = pointInBox(pt, sb); if (c) this._contact(A, null, pt, c.n, c.pen, key, hits); }
        for (const pt of boxPoints(sb)) { const c = pointInBox(pt, boxes[i]); if (c) this._contact(A, null, pt, V.mul(c.n, -1), c.pen, key, hits); }
        for (const w of wheelPts[i]) { const c = sphereVsBox(w, R(A), sb); if (c) this._contact(A, null, c.pt, c.n, c.pen, key, hits); }
      } else {
        if (V.len(V.sub(A.pos, S.center)) > 8 + S.radius) continue;
        const sc = sphereVsBox(S.center, S.radius, boxes[i]);
        if (sc) this._contact(A, null, sc.pt, V.mul(sc.n, -1), sc.pen, key, hits);
        for (const w of wheelPts[i]) {
          const d = V.sub(w, S.center), l = V.len(d), pen = R(A) + S.radius - l;
          if (pen > 0 && l > 1e-6) { const n = V.mul(d, 1 / l); this._contact(A, null, V.sub(w, V.mul(n, R(A))), n, pen, key, hits); }
        }
      }
    }
  }

  step(dt) {
    const n = this.substeps, h = dt / n;
    const hits = new Map();
    for (let s = 0; s < n; s++) {
      for (const t of this.trucks) t._forces(h);
      this._collide(hits);
      for (const t of this.trucks) t._integrate(h);
    }
    // impact events: fire once when a contact pair starts touching
    const now = new Set(hits.keys());
    for (const [key, rec] of hits) {
      if (!this._prevHits?.has(key) && rec.speed > 1.0) {
        rec.A.onImpact?.(rec.other, rec.speed, rec.pt);
        rec.other?.onImpact?.(rec.A, rec.speed, rec.pt);
      }
    }
    this._prevHits = now;
    for (const t of this.trucks) t._postStep(dt);
  }
}
