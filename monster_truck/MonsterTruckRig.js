// MonsterTruckRig.js – drives the MX monster truck GLB (three.js r150+).
//
//   const gltf = await loader.loadAsync('monster_truck_lime_black.glb');
//   scene.add(gltf.scene);
//   const rig = new MonsterTruckRig(gltf.scene);
//   // every frame (after your physics step):
//   rig.update(dt, { speed, steer, suspension: { FL, FR, RL, RR } });
//
// Put your physics body transform on rig.root (the "MonsterTruck" node).
// speed      – forward speed in m/s (spins the wheels; negative = reverse)
// steer      – front wheel steer angle in radians (+ = turn left / toward +X)
// suspension – per-wheel vertical travel in metres relative to the modelled rest pose
//              (+ = wheel pushed up / compressed, − = drooping, e.g. in the air).
//              Typical range −0.35 … +0.35. With a raycast-vehicle, use
//              suspension[w] = restLength − currentLength.
//
// Forward is +Z, up is +Y, units are metres. Wheel radius is in rig.wheelRadius.
//
// For realistic jump landings (bounce that scales with jump height) pair this with
// MonsterTruckPhysics.js and pass phys.travel as `suspension` – see that file.
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class MonsterTruckRig {
  constructor(object) {
    this.root = object.getObjectByName('MonsterTruck') || object;
    const get = (n) => this.root.getObjectByName(n);
    const ud = this.root.userData || {};
    this.wheelRadius = ud.wheelRadius ?? 0.919;
    this.trackHalf = ud.trackHalf ?? 1.56;
    this.body = get('Body');
    this.axles = { F: get('Axle_F'), R: get('Axle_R') };
    this.axleRest = { F: this.axles.F.position.clone(), R: this.axles.R.position.clone() };
    this.wheels = {};
    for (const k of ['FL', 'FR', 'RL', 'RR']) {
      const w = get('Wheel_' + k);
      w.rotation.order = 'YXZ';
      this.wheels[k] = w;
    }
    // parts that aim at a *_target node (shock bodies/shafts, links, driveshafts)
    this.aimers = [];
    this.root.traverse((o) => {
      if (!o.name.endsWith('_target')) return;
      const part = get(o.name.slice(0, -'_target'.length));
      if (!part) return;
      const stretch = /^(Link_|Driveshaft_)/.test(part.name);
      this.aimers.push({ part, target: o, stretch, rest: part.userData.restLength || 1 });
    });
    // springs live under each Shock_*_Body and stretch between the perches
    this.springs = [];
    this.root.traverse((o) => {
      if (/^Shock_.*_Spring$/.test(o.name)) {
        const shockBody = o.parent;
        const target = get(shockBody.name + '_target');
        this.springs.push({ spring: o, shockBody, target, rest: o.userData.restLength || 1 });
      }
    });
    this.spin = 0;
    this.travel = { FL: 0, FR: 0, RL: 0, RR: 0 };
  }

  update(dt, { speed = 0, steer = 0, suspension = null } = {}) {
    const s = suspension || this.travel;
    // solid axles: heave = mean of the two wheels, roll from their difference
    for (const [ax, l, r] of [['F', 'FL', 'FR'], ['R', 'RL', 'RR']]) {
      const axle = this.axles[ax];
      axle.position.copy(this.axleRest[ax]);
      axle.position.y += (s[l] + s[r]) * 0.5;
      axle.rotation.z = Math.atan2(s[r] - s[l], 2 * this.trackHalf);
    }
    this.spin = (this.spin + (speed * dt) / this.wheelRadius) % (Math.PI * 2);
    for (const k in this.wheels) {
      const w = this.wheels[k];
      w.rotation.x = this.spin;
      w.rotation.y = k[0] === 'F' ? steer : 0;
    }
    this.root.updateMatrixWorld(true);
    for (const a of this.aimers) {
      a.target.getWorldPosition(_b);
      a.part.lookAt(_b);
      if (a.stretch) {
        a.part.getWorldPosition(_a);
        a.part.scale.z = _a.distanceTo(_b) / a.rest;
      }
    }
    this.root.updateMatrixWorld(true);
    for (const sp of this.springs) {
      sp.shockBody.getWorldPosition(_a);
      sp.target.getWorldPosition(_b);
      sp.spring.scale.z = Math.max(0.35, (_a.distanceTo(_b) - 0.19) / sp.rest);
    }
  }
}
