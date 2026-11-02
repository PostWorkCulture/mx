// MonsterTruckDrive.js – a small arcade driving model for sand (example / starting point).
//
// Gives you horizontal motion plus the numbers the other modules need:
//   accelLong / accelLat  → MonsterTruckPhysics.step()  (squat, dive, body lean)
//   wheel slip per corner → SandFX.emitWheel()          (roost when spinning, spray when sliding)
//
//   const drive = new MonsterTruckDrive();
//   drive.update(dt, { throttle, brake, steer }, phys.airborne);
//   phys.x = drive.x; phys.z = drive.z; phys.yaw = drive.yaw;
//   phys.step(dt, { accelLong: drive.accelLong, accelLat: drive.accelLat });
//
// Sand model: grip μ≈0.7. Too much throttle at low speed spins the rear tyres (slipLong);
// steering harder than the grip allows makes the truck slide (slipLat) and drift.
// Forward +Z, left +X (matches the GLB); yaw 0 = facing +Z, + = turning left.

export class MonsterTruckDrive {
  constructor(o = {}) {
    Object.assign(this, {
      wheelbase: 3.17, maxSpeed: 26, engineAccel: 9.0, brakeDecel: 9, drag: 0.012, rolling: 0.35,
      grip: 0.7, gravity: 9.81, corneringStiffness: 7.5, spinOnset: 0.45,
    }, o);
    this.x = o.x || 0; this.z = o.z || 0; this.yaw = o.yaw || 0;
    this.vx = 0; this.vz = 0; this.speed = 0; this.vLong = 0; this.vLat = 0;
    this.accelLong = 0; this.accelLat = 0; this.yawRate = 0;
    this.slip = { FL: { long: 0, lat: 0 }, FR: { long: 0, lat: 0 }, RL: { long: 0, lat: 0 }, RR: { long: 0, lat: 0 } };
  }
  get forward() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }
  get left() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; }

  update(dt, { throttle = 0, brake = 0, steer = 0 } = {}, airborne = false) {
    const f = this.forward, l = this.left, mu = this.grip * this.gravity;
    let vLong = this.vx * f.x + this.vz * f.z, vLat = this.vx * l.x + this.vz * l.z;
    // engine / brakes (traction-limited on sand)
    const want = throttle * this.engineAccel * Math.max(0, 1 - vLong / this.maxSpeed) - brake * this.brakeDecel * Math.sign(vLong)
      - this.drag * vLong * Math.abs(vLong) - this.rolling * Math.sign(vLong);
    const aLong = airborne ? 0 : Math.max(-mu, Math.min(mu * 0.9, want));
    // wheel spin: demand beyond what the sand can take, strongest from low speed
    const spin = airborne ? throttle * 6 : Math.max(0, throttle * this.engineAccel - mu * this.spinOnset) * Math.max(0.15, 1 - vLong / 14) * 1.4;
    // yaw from steering (bicycle model), lateral tyre force saturates at the grip limit
    const yawRate = airborne ? this.yawRate * 0.98 : (vLong / this.wheelbase) * Math.tan(steer);
    const latForce = airborne ? 0 : Math.max(-mu, Math.min(mu, -this.corneringStiffness * vLat));
    this.yaw += yawRate * dt; this.yawRate = yawRate;
    this.vx += (f.x * aLong + l.x * latForce) * dt;
    this.vz += (f.z * aLong + l.z * latForce) * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;
    const f2 = this.forward, l2 = this.left;
    this.vLong = this.vx * f2.x + this.vz * f2.z; this.vLat = this.vx * l2.x + this.vz * l2.z;
    this.speed = Math.hypot(this.vx, this.vz);
    this.accelLong = aLong;
    this.accelLat = airborne ? 0 : latForce;   // actual sideways acceleration (grip-limited), + = toward the left
    // per-wheel slip for effects (m/s): long = tyre surface speed minus ground speed, lat = sideways scrub (+ = left)
    for (const k of ['FL', 'FR', 'RL', 'RR']) {
      const front = k[0] === 'F', zOff = front ? 1.62 : -1.55;
      this.slip[k].long = front ? spin * 0.35 : spin;                 // 4WD, rear-biased
      // contact-patch sideways velocity relative to where the tyre points
      const vPatch = this.vLat + yawRate * zOff, tyreDir = front ? this.vLong * Math.tan(steer) : 0;
      this.slip[k].lat = airborne ? 0 : vPatch - tyreDir;
    }
  }
}
