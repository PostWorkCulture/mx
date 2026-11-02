// MonsterTruckPhysics.js – vertical dynamics for the MX monster trucks (no dependencies).
//
// Handles what makes a monster truck *feel* right: chassis heave / pitch / roll on four
// coil-over corners, heavy unsprung wheels on bouncy tyres, soft under-damped springs,
// asymmetric damping, progressive bump stops and droop limits. Landing bounce therefore
// scales with jump height automatically: a hop settles in one soft bounce, a big jump
// slams into the bump stops, rebounds, can skip the tyres off the ground and settles
// over 2–3 bounces.
//
// You keep control of horizontal motion (position along the ground, yaw, speed) –
// e.g. from your own driving model – and this class adds the vertical behaviour.
//
//   const phys = new MonsterTruckPhysics({ groundHeight: (x, z) => terrainHeight(x, z) });
//   phys.reset({ x: 0, z: 0, yaw: 0 });
//   // every frame:
//   phys.x += vx * dt; phys.z += vz * dt; phys.yaw = heading;   // your driving model
//   phys.step(dt, { accelLong, accelLat });   // optional: body squat / dive / lean from your driving model
//   rig.root.position.copy(phys.position); rig.root.quaternion.copy(phys.quaternion);
//   rig.update(dt, { speed, steer, suspension: phys.travel });
//   phys.onLand = (impactSpeed, info) => { /* dust, camera shake, sound – impactSpeed in m/s;
//                                            info.perWheel {FL,FR,RL,RR} impact speeds, info.roll, info.pitch */ };
//
// Every corner is simulated on its own, so anything uneven shows up naturally: land rolled
// onto the right-hand wheels and the right-hand springs take the hit (they compress further,
// can hit the bump stops) while the left side catches up a moment later; land nose-first and
// the front axle loads before the rear.
//
// Units: metres, kg, seconds. Forward +Z, up +Y (matches the GLB).

export const MONSTER_TRUCK_DEFAULTS = {
  wheelRadius: 0.919,
  wheels: { FL: [1.56, 1.62], FR: [-1.56, 1.62], RL: [1.56, -1.55], RR: [-1.56, -1.55] }, // [x (left +), z]
  sprungMass: 3600,          // chassis + body
  wheelMass: 260,            // per corner (wheel, tyre, half axle)
  inertiaPitch: 9500,
  inertiaRoll: 2800,
  springRate: 38000,         // N/m per corner (two coil-overs) – ~1 Hz ride
  dampCompression: 3000,     // N·s/m – low = more bounce
  dampRebound: 4200,
  bumpStart: 0.30,           // m of compression where the bump stop starts
  bumpRate: 900000,          // progressive (N/m²)
  bumpDamp: 9000,
  droop: 0.36,               // max extension (m)
  travelMax: 0.40,           // hard compression limit (m)
  tyreRate: 180000,          // N/m – soft, bouncy monster tyres
  tyreDamp: 1400,
  gravity: 9.81,
  substeps: 8,
  airDragAngular: 0.15,      // slow spin damping in the air
  airLevel: 3.5,             // in-air self-levelling (driver throttle/brake control), 1/s² – 0 = none
  airLevelDamp: 1.8,         // 1/s
  airPitchTarget: -0.06,     // slight nose-down landing attitude (rad): front touches first, then the rear
  airRollLevel: 0.35,        // in-air roll correction (weak – a truck that leaves a lip tilted lands tilted)
  airRollDamp: 0.6,
  cgHeight: 1.25,            // effective height of the centre of mass above the axles, for load transfer
  topOutForce: 0.3,          // spring force left at full droop, as a fraction of static corner load
};

export class MonsterTruckPhysics {
  constructor(opts = {}) {
    this.p = { ...MONSTER_TRUCK_DEFAULTS, ...opts };
    this.groundHeight = opts.groundHeight || (() => 0);
    this.onLand = null;
    this.travel = { FL: 0, FR: 0, RL: 0, RR: 0 };
    this.contact = { FL: true, FR: true, RL: true, RR: true };
    this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.quaternion = { x: 0, y: 0, z: 0, w: 1 };
    this.reset();
  }

  reset({ x = 0, z = 0, yaw = 0 } = {}) {
    const p = this.p;
    this.x = x; this.z = z; this.yaw = yaw;
    this.pitch = 0; this.roll = 0; this.wp = 0; this.wr = 0; this.vy = 0;
    this.preload = (p.sprungMass * p.gravity) / 4 / p.springRate;
    this.tyreRest = ((p.sprungMass / 4 + p.wheelMass) * p.gravity) / p.tyreRate;
    this.y = this.groundHeight(x, z);
    this.w = {};
    for (const k in p.wheels) this.w[k] = { y: this.y + p.wheelRadius, v: 0, s: 0, ct: this.tyreRest };
    this.airborne = false; this.airTime = 0;
    this._sync();
  }

  // world position of a chassis-local point (x left, z forward) at wheel-centre height
  _corner(wx, wz) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const h = this.y + this.p.wheelRadius + wz * Math.sin(this.pitch) + wx * Math.sin(this.roll);
    return { x: this.x + wx * cy + wz * sy, z: this.z - wx * sy + wz * cy, y: h };
  }

  // accelLong: forward acceleration (m/s², + = speeding up), accelLat: sideways acceleration toward
  // the truck's left (+X) in m/s² (+ when turning left). Both come from your driving model.
  step(dt, { accelLong = 0, accelLat = 0 } = {}) {
    const p = this.p, n = p.substeps, h = dt / n;
    const wasAir = this.airborne; let maxImpact = 0; const impact = { FL: 0, FR: 0, RL: 0, RR: 0 };
    for (let i = 0; i < n; i++) {
      let F = -p.sprungMass * p.gravity, Tp = 0, Tr = 0, touching = 0;
      for (const k in p.wheels) {
        const [wx, wz] = p.wheels[k], W = this.w[k];
        const c = this._corner(wx, wz);
        // velocity of the chassis attach point
        const va = this.vy + wz * Math.cos(this.pitch) * this.wp + wx * Math.cos(this.roll) * this.wr;
        let s = W.y - c.y;                       // + = compressed
        let ds = W.v - va;
        // hard travel limits: wheel is carried by the chassis
        if (s < -p.droop) { W.y = c.y - p.droop; if (W.v < va) W.v = va; s = -p.droop; ds = Math.max(0, ds); }
        if (s > p.travelMax) { W.y = c.y + p.travelMax; if (W.v > va) W.v = va; s = p.travelMax; ds = Math.min(0, ds); }
        const F0 = this.preload * p.springRate;
        let Fs = Math.max(F0 * p.topOutForce, p.springRate * s + F0) + (ds > 0 ? p.dampCompression : p.dampRebound) * ds;
        if (s > p.bumpStart) { const b = s - p.bumpStart; Fs += p.bumpRate * b * b + p.bumpDamp * Math.max(0, ds); }
        // tyre (compression only)
        const g = this.groundHeight(c.x, c.z);
        const ct = g + p.wheelRadius + this.tyreRest - W.y;
        const dct = (ct - W.ct) / h; W.ct = ct;
        let Ft = 0;
        if (ct > 0) {
          Ft = Math.max(0, p.tyreRate * ct + p.tyreDamp * dct); touching++;
          if (!this.contact[k]) { impact[k] = Math.max(impact[k], -W.v); if (-W.v > maxImpact) maxImpact = -W.v; }
        }
        this.contact[k] = ct > 0;
        // integrate the wheel (semi-implicit)
        W.v += ((Ft - Fs) / p.wheelMass - p.gravity) * h;
        W.y += W.v * h;
        W.s = s;
        F += Fs; Tp += Fs * wz; Tr += Fs * wx;
      }
      // load transfer from accelerating / braking / cornering (only through tyres that touch)
      const grip = touching / 4;
      Tp += p.sprungMass * accelLong * p.cgHeight * grip;
      Tr += p.sprungMass * accelLat * p.cgHeight * grip;
      this.vy += (F / p.sprungMass) * h; this.y += this.vy * h;
      this.wp += (Tp / p.inertiaPitch) * h; this.wr += (Tr / p.inertiaRoll) * h;
      if (touching === 0) {
        const d = 1 - p.airDragAngular * h; this.wp *= d; this.wr *= d;
        this.wp += (-p.airLevel * (this.pitch - p.airPitchTarget) - p.airLevelDamp * this.wp) * h;
        this.wr += (-p.airRollLevel * this.roll - p.airRollDamp * this.wr) * h;
      }
      this.pitch += this.wp * h; this.roll += this.wr * h;
      this.airborne = touching === 0;
    }
    this.airTime = this.airborne ? this.airTime + dt : 0;
    for (const k in p.wheels) this.travel[k] = Math.max(-p.droop, Math.min(p.travelMax, this.w[k].s));
    if (wasAir && this.onLand) this._landing = { impact: { FL: 0, FR: 0, RL: 0, RR: 0 }, max: 0, t: 0 };
    if (this._landing) {  // collect every wheel's touchdown over the next 0.4 s, then report once
      const L = this._landing; L.t += dt;
      for (const k in impact) if (impact[k] > L.impact[k]) L.impact[k] = impact[k];
      L.max = Math.max(L.max, maxImpact);
      if (!this.airborne && !L.reported) { L.reported = true; this.onLand(L.max, { perWheel: L.impact, roll: this.roll, pitch: this.pitch }); }
      if (L.t > 0.4 || (!this.airborne && L.reported && L.t > 0.4)) this._landing = null;
    }
    this._sync();
  }

  _sync() {
    this.position.set(this.x, this.y, this.z);
    // Euler order YXZ: yaw, then pitch (nose up = negative X rotation), then roll
    const hy = this.yaw / 2, hx = -this.pitch / 2, hz = this.roll / 2;
    const cy = Math.cos(hy), sy = Math.sin(hy), cx = Math.cos(hx), sx = Math.sin(hx), cz = Math.cos(hz), sz = Math.sin(hz);
    this.quaternion.x = cy * sx * cz + sy * cx * sz;
    this.quaternion.y = sy * cx * cz - cy * sx * sz;
    this.quaternion.z = cy * cx * sz - sy * sx * cz;
    this.quaternion.w = cy * cx * cz + sy * sx * sz;
  }
}
