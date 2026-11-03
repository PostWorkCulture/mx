// SprintRace.js – point-to-point sprint races on DesertTerrain routes (no dependencies).
//
//   const race = new SprintRace(terrain, 'dune-sea-dash', { checkpointEvery: 420 });
//   const slots = race.gridSlots(4);                       // [{ x, z, yaw }] behind the start line
//   race.addRacer('you', { name: 'You', player: true });
//   race.addRacer('ai1', { name: 'Stealth' });
//   race.onCheckpoint = (r, i, split) => …; race.onFinish = (r, time, place) => …;
//   race.start();                                           // 3-2-1 countdown, then race.state = 'racing'
//   // every frame, after physics:
//   race.update(dt, [{ id: 'you', pos: truck.pos, vel: truck.vel, forward: truck.forward }, …]);
//   race.respawnPoint('you')  → { x, z, yaw } at the last checkpoint passed, facing down the course
//
// Rules: pass every checkpoint gate in order (inside the gate width), then the finish line. Crossing a
// checkpoint outside its gate flags it as missed – drive back through it. Wrong-way and off-course
// warnings fire after a short grace period. Standings rank finishers by time, then everyone else by
// distance covered.
//
// SprintAI drives a TruckBody round a route: pure-pursuit steering on the centreline (with a lane
// offset), corner speeds from route curvature, and an unstick / respawn fallback.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class SprintRace {
  constructor(terrain, route, { checkpointEvery = 420, checkpoints = null, startS = 60, finishS = null, countdown = 3, gateSlack = 10 } = {}) {
    this.terrain = terrain;
    this.route = typeof route === 'object' ? route : terrain.routes.find((r) => r.id === route || r.index === route);
    if (!this.route) throw new Error('SprintRace: unknown route ' + route);
    const R = this.route;
    this.startS = startS; this.finishS = finishS ?? R.length - 50;
    if (checkpoints || R.checkpoints) this.checkpoints = (checkpoints || R.checkpoints).slice();
    else {
      const span = this.finishS - this.startS, n = Math.max(1, Math.round(span / checkpointEvery) - 1);
      this.checkpoints = Array.from({ length: n }, (_, i) => Math.round(this.startS + (span * (i + 1)) / (n + 1)));
    }
    this.gateHalf = R.halfWidth + gateSlack;
    this.countdown = countdown; this.state = 'grid'; this.clock = 0; this.racers = new Map();
    this.onCheckpoint = null; this.onFinish = null; this.onWrongWay = null; this.onMissed = null; this.onOffCourse = null; this.onGo = null;
  }

  get length() { return this.finishS - this.startS; }

  gridSlots(n, { rowGap = 9, laneGap = 6 } = {}) {
    const R = this.route, out = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2), lane = i % 2 ? -1 : 1;
      const s = this.startS - 12 - row * rowGap - (i % 2) * 3;
      const p = R.pointAt(s);
      const off = lane * laneGap / 2 * (n === 1 ? 0 : 1);
      out.push({ x: p.x + p.tz * off, z: p.z - p.tx * off, yaw: Math.atan2(p.tx, p.tz), s });
    }
    return out;
  }

  addRacer(id, { name = id, player = false } = {}) {
    const r = { id, name, player, s: this.startS - 20, d: 0, next: 0, missed: -1, finished: false, time: null, splits: [], wrongWay: false, _ww: 0, _off: 0, offCourse: false, lastCP: -1, place: 0, speed: 0 };
    this.racers.set(id, r); return r;
  }

  start() { this.state = 'countdown'; this.clock = -this.countdown; }

  // project (x, z) onto the route near arc length hint (local window), falling back to a full search
  project(x, z, hint = null) {
    const R = this.route, n = R.n, SAMPLE = R.length / (n - 1);
    let i0 = 0, i1 = n - 2;
    if (hint != null) { const hi = Math.round(hint / SAMPLE); i0 = clamp(hi - 30, 0, n - 2); i1 = clamp(hi + 60, 0, n - 2); }
    let best = Infinity, bi = 0, bt = 0;
    for (let i = i0; i <= i1; i++) {
      const ax = R.x[i], az = R.z[i], ex = R.x[i + 1] - ax, ez = R.z[i + 1] - az;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      const dx = x - (ax + ex * t), dz = z - (az + ez * t), d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (hint != null && Math.sqrt(best) > 60) return this.project(x, z, null);
    const tx = R.tx[bi], tz = R.tz[bi], px = R.x[bi] + (R.x[bi + 1] - R.x[bi]) * bt, pz = R.z[bi] + (R.z[bi + 1] - R.z[bi]) * bt;
    return { s: (bi + bt) * SAMPLE, d: (x - px) * tz - (z - pz) * tx, tx, tz, dist: Math.sqrt(best) };
  }

  update(dt, states) {
    if (this.state === 'countdown') {
      const before = this.clock; this.clock += dt;
      if (before < 0 && this.clock >= 0) { this.state = 'racing'; this.onGo?.(); }
    } else if (this.state === 'racing') this.clock += dt;
    for (const st of states) {
      const r = this.racers.get(st.id); if (!r) continue;
      const [x, , z] = st.pos;
      const prevS = r.s, prevD = r.d;
      const p = this.project(x, z, r.s);
      r.s = p.s; r.d = p.d; r.speed = Math.hypot(st.vel[0], st.vel[2]);
      if (this.state !== 'racing' || r.finished) continue;
      // checkpoint / finish crossing (forward or backward through the gate)
      const gates = [...this.checkpoints, this.finishS];
      const gi = r.next, gs = gates[gi];
      if (prevS < gs && r.s >= gs) {
        const t = (gs - prevS) / Math.max(1e-6, r.s - prevS), dAt = prevD + (r.d - prevD) * t;
        if (Math.abs(dAt) <= this.gateHalf * (gi === gates.length - 1 ? 2.5 : 1)) {   // finish is forgiving: a sideways arrival still counts
          r.missed = -1;
          if (gi === gates.length - 1) {
            r.finished = true; r.time = this.clock;
            r.place = [...this.racers.values()].filter((o) => o.finished).length;
            this.onFinish?.(r, r.time, r.place);
          } else {
            r.splits.push(this.clock); r.lastCP = gi; r.next++;
            this.onCheckpoint?.(r, gi, this.clock);
          }
        } else if (r.missed !== gi) { r.missed = gi; this.onMissed?.(r, gi); }
      }
      // wrong way
      const f = st.forward, along = f[0] * p.tx + f[2] * p.tz;
      const vAlong = st.vel[0] * p.tx + st.vel[2] * p.tz;
      r._ww = along < -0.35 && vAlong < -2 ? r._ww + dt : Math.max(0, r._ww - dt * 2);
      const ww = r._ww > 1.2;
      if (ww !== r.wrongWay) { r.wrongWay = ww; this.onWrongWay?.(r, ww); }
      // off course
      r._off = Math.abs(p.d) > 140 ? r._off + dt : 0;
      const off = r._off > 4;
      if (off && !r.offCourse) this.onOffCourse?.(r);
      r.offCourse = off;
    }
    // places
    const list = this.standings(); list.forEach((r, i) => { if (!r.finished) r.place = i + 1; });
  }

  progress(id) { const r = this.racers.get(id); if (!r) return 0; return r.finished ? 1 : clamp((r.s - this.startS) / this.length, 0, 1); }

  standings() {
    return [...this.racers.values()].sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.next !== b.next) return b.next - a.next;
      return b.s - a.s;
    });
  }

  respawnPoint(id) {
    const r = this.racers.get(id);
    const gates = [...this.checkpoints, this.finishS];
    const lastGate = r && r.lastCP >= 0 ? this.checkpoints[r.lastCP] : this.startS - 20;
    const nextGate = r ? gates[Math.min(r.next, gates.length - 1)] : this.startS;
    let s = r ? clamp(r.s - 25, lastGate + 5, Math.max(lastGate + 5, nextGate - 25)) : lastGate;
    const p = this.route.pointAt(s);
    return { x: p.x, z: p.z, yaw: Math.atan2(p.tx, p.tz), s };
  }

  static fmt(t) {
    if (t == null) return '--:--.--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
}

export class SprintAI {
  // world: the TruckWorld (optional) – lets the AI steer round other trucks
  constructor(race, truck, id, { skill = 0.85, lane = 0, aggression = 0.5, seed = 1, world = null } = {}) {
    Object.assign(this, { race, truck, id, skill, lane, aggression, world });
    this._seed = seed; this._stuck = 0; this._laneT = 0; this._avoid = 0;
  }
  update(dt) {
    const { race, truck } = this, R = race.route, r = race.racers.get(this.id);
    if (!r) return;
    if (race.state !== 'racing' && !r.finished) { truck.input = { throttle: 0, brake: 1, steer: 0 }; return; }
    const v = Math.hypot(truck.vel[0], truck.vel[2]);
    // lane drifts slowly so AI trucks don't follow each other nose to tail
    this._laneT += dt;
    // traffic: move over for trucks alongside / just ahead, ease off if one is right in front
    let avoid = 0, blocked = false;
    const f0 = truck.forward, l0 = truck.left;
    for (const o of this.world?.trucks || []) {
      if (o === truck) continue;
      const rx = o.pos[0] - truck.pos[0], rz = o.pos[2] - truck.pos[2];
      const along = rx * f0[0] + rz * f0[2], side = rx * l0[0] + rz * l0[2];
      if (along > -6 && along < 22 && Math.abs(side) < 6) {
        avoid -= Math.sign(side || 1) * (6 - Math.abs(side)) * 1.2;
        if (along > 0 && along < 14 && Math.abs(side) < 3.8) blocked = true;
      }
    }
    this._avoid += (clamp(avoid, -7, 7) - this._avoid) * Math.min(1, dt * 2);
    const half = R.halfWidth - 2.5;
    const lane = clamp(this.lane + Math.sin(this._laneT * 0.13 + this._seed) * 2.5 - this._avoid, -half, half);
    let look = 16 + v * (truck.kind === 'bike' ? 0.95 : 0.7);   // bikes take ~0.5 s to roll into a turn: look further ahead
    if (this._wide) look += 12;                     // target was off to the side last frame: aim further out (no orbiting)
    const p = R.pointAt(Math.min(r.s + look, R.length));
    const tx = p.x + p.tz * lane, tz = p.z - p.tx * lane;
    // target in truck frame (x left, z forward)
    const f = truck.forward, l = truck.left;
    const dx = tx - truck.pos[0], dz = tz - truck.pos[2];
    const lx = dx * l[0] + dz * l[2], lz = dx * f[0] + dz * f[2];
    const ang = Math.atan2(lx, lz);
    this._wide = Math.abs(ang) > 1.0;
    // trucks: steering gets gentler with speed. Bikes: input = lean (proportional, see DirtBikeSim), so the AI asks
    // for the same lean the old speed-boosted mapping gave it
    const sg = truck.kind === 'bike' ? (truck.p.steerGainSpeed > 0 ? 1 : 1 + v / 12) : 1;
    let steer = clamp(ang * 2.4 * sg / (1 + v / 14), -1, 1);
    this._air = truck.airborne ? 0.6 : Math.max(0, (this._air || 0) - dt);
    if (this._air > 0) steer *= truck.airborne ? 0 : 0.35;   // straight wheels for the landing
    // corner speed: look 20–140 m ahead for the tightest curvature
    // scale with the vehicle's top speed (AI riders hold bikes a bit under flat out: they crash less)
    const vMax = Math.min(truck.p?.topSpeed ?? 27, truck.kind === 'bike' ? 40 : 1e9) - 1, pace = vMax / 26;
    let vT = vMax;
    for (let a = 10; a <= 140; a += 10) {
      const k = Math.abs(R.at(R.curv, Math.min(r.s + a, R.length)));
      const vc = Math.sqrt((4.2 + 2.5 * this.skill) / Math.max(k, 1e-4));
      const brakeDist = a - 6;
      vT = Math.min(vT, Math.sqrt(vc * vc + 2 * 5.5 * Math.max(0, brakeDist)));
    }
    vT *= 0.82 + 0.18 * this.skill;
    for (const f of R.features || []) if (f.type === 'whoops' && r.s > f.s0 - 40 && r.s < f.s1) vT = Math.min(vT, (15 + 4 * this.skill) * Math.sqrt(pace));
    if (Math.abs(ang) > 0.6) vT = Math.min(vT, 7);
    let throttle = clamp((vT - v) * 0.5 + 0.3, 0, 1), brake = v > vT + 2 ? clamp((v - vT) * 0.25, 0, 1) : 0;
    if (blocked) throttle *= 0.4;
    if (r.finished) { throttle = 0; brake = v > 6 ? 0.25 : 0; }   // cool-down lap: coast, keep steering
    if (truck.airborne) { throttle = 0.3; brake = 0; }
    // unstick: no progress for a while → respawn on the course
    const live = race.state === 'racing' && !r.finished;
    this._stuck = v < 1.2 && live ? this._stuck + dt : 0;
    // …or circling / wedged without gaining ground, or a gate missed (the AI doesn't turn back for it)
    if (r.s > (this._bestS ?? -1e9) + 3) { this._bestS = r.s; this._noProg = 0; } else this._noProg = live ? (this._noProg || 0) + dt : 0;
    this._missT = live && r.missed >= 0 ? (this._missT || 0) + dt : 0;
    if (this._stuck > 3.5 || this._noProg > 6 || this._missT > 2.5 || r.offCourse || (truck.tilt > 1.3 && truck.stuckTime > 2.5)) {
      const sp = race.respawnPoint(this.id); truck.reset({ x: sp.x, z: sp.z, yaw: sp.yaw }); this._stuck = 0; r._off = 0;
      this._bestS = sp.s; this._noProg = 0; this._missT = 0; r.missed = -1;   // placed back before the gate it missed
      return;
    }
    truck.input = { throttle, brake, steer };
  }
}
