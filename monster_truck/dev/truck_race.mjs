// truck_race.mjs – headless roll-over audit for MonsterTruckSim (node, no browser):
//   node monster_truck/dev/truck_race.mjs race [route-id]   – 4 AI trucks per route, logs every roll-over with context
//   node monster_truck/dev/truck_race.mjs flat               – player-style abuse on flat sand: full lock / flicks at speed
// env: SKILL (AI skill offset), N (trucks), SECS (time limit)
import { DesertTerrain } from '../../desert/DesertTerrain.js';
import { SPRINT_ROUTES, BUTTES } from '../../desert/routes.js';
import { TruckWorld } from '../MonsterTruckSim.js';
import { SprintRace, SprintAI } from '../../desert/SprintRace.js';
const mode = process.argv[2] || 'race', h = 1 / 60, D = (r) => (r * 57.3).toFixed(0);
const ctx = (t, w) => `v=${t.speed.toFixed(1)} vLong=${t.vLong.toFixed(1)} roll=${D(t.roll)} pitch=${D(t.pitch)} air=${t.airborne ? 1 : 0} hull=${t._hullHits} touch=${t._touching} steer=${t.input.steer.toFixed(2)} slope=${D(Math.acos(w.groundNormal(t.pos[0], t.pos[2])[1]))}`;
function track(t, w, tag, log) {
  // history ring so a roll-over can be traced back to its cause (landing, slope, slide, contact)
  t._hist = []; t._why = []; t._maxTilt = 0; t._nRoll = 0; t._near = 0; let hi = false;
  t.onRollover = () => { t._nRoll++; if (log) console.log(`    ROLL ${tag}`, ctx(t, w), '\n      before:', t._hist.slice(-4).join(' | ')); };
  t.onImpact = (o, v) => { if (v > 4) t._hist.push(`imp ${o ? 'truck' : 'static'} ${v.toFixed(1)}`); };
  t.onLand = (v, i) => t._hist.push(`land ${v.toFixed(1)} roll=${D(i.roll)} pitch=${D(i.pitch)}`);
  t._tick = () => { const a = t.tilt; t._maxTilt = Math.max(t._maxTilt, a); if (a > 0.7 && !hi) { t._near++; hi = true; t._hist.push(`tilt>40 ${ctx(t, w)}`); } if (a < 0.4) hi = false; if (t._hist.length > 12) t._hist.shift(); };
}
if (mode === 'race') {
  const terrain = new DesertTerrain({ routes: SPRINT_ROUTES, buttes: BUTTES });
  const world = new TruckWorld({ groundHeight: terrain.height, surface: terrain.surface });
  let tot = 0, totNear = 0, totT = 0;
  for (const route of (process.argv[3] ? [process.argv[3]] : SPRINT_ROUTES.map((r) => r.id))) {
    world.trucks.length = 0;
    const race = new SprintRace(terrain, route), R = race.route, N = +(process.env.N || 4);
    const rs = race.gridSlots(N).map((sl, i) => {
      const t = world.addTruck({ x: sl.x, z: sl.z, yaw: sl.yaw, autoRecoverAfter: 2, ...JSON.parse(process.env.OPTS || '{}') }), id = 't' + i;
      race.addRacer(id, { name: id });
      const p = R.pointAt(sl.s), lane = (sl.x - p.x) * p.tz - (sl.z - p.z) * p.tx;
      const ai = new SprintAI(race, t, id, { skill: 0.72 + 0.1 * (i + 1) + +(process.env.SKILL || 0), lane, seed: i * 1.7, world });
      track(t, world, id, !process.env.QUIET); return { id, t, ai };
    });
    race.start();
    let t = 0; const t0 = Date.now(), lim = +(process.env.SECS || 300);
    while (t < lim && ![...race.racers.values()].every((r) => r.finished)) {
      for (const r of rs) { terrain.prefetch(r.t.pos[0], r.t.pos[2], 70, 50); r.ai.update(h); }
      world.step(h); t += h; for (const r of rs) r.t._tick();
      race.update(h, rs.map((r) => ({ id: r.id, pos: r.t.pos, vel: r.t.vel, forward: r.t.forward })));
    }
    console.log(route, 'sim', t.toFixed(0) + 's', 'wall', ((Date.now() - t0) / 1000).toFixed(0) + 's');
    for (const r of rs) { const rr = race.racers.get(r.id); tot += r.t._nRoll; totNear += r.t._near; totT += t;
      console.log('  ', r.id, rr.finished ? SprintRace.fmt(rr.time) : 'DNF s=' + rr.s.toFixed(0), 'rolls', r.t._nRoll, 'tilt>40°', r.t._near, 'maxTilt', D(r.t._maxTilt)); }
  }
  console.log(`TOTAL rolls ${tot}  tilt>40° ${totNear}  truck-minutes ${(totT / 60).toFixed(1)}`);
}
if (mode === 'flat') {
  // [label, speed m/s, steer program]
  const cases = [];
  for (const v of [10, 15, 20, 30, 40, 50]) {
    cases.push([`full lock @${v}`, v, (t) => (t > 0.3 ? 1 : 0)]);
    cases.push([`flick @${v}`, v, (t) => (t < 0.3 ? 0 : t < 1.1 ? 1 : t < 2.2 ? -1 : 0)]);
    cases.push([`lock+brake @${v}`, v, (t) => (t > 0.3 ? 1 : 0), true]);
  }
  for (const [label, v0, steer, brk] of cases) {
    const w = new TruckWorld({ groundHeight: () => 0 }); const t = w.addTruck({});
    for (let i = 0; i < 120; i++) w.step(h);         // settle
    t.vel = [0, 0, v0]; track(t, w, label, false);
    for (let i = 0; i < 60 * 4; i++) { const s = i * h; t.input = { throttle: brk && s > 0.3 ? 0 : t.vLong < v0 ? 1 : 0.4, brake: brk && s > 0.3 ? 1 : 0, steer: steer(s) }; w.step(h); t._tick(); }
    console.log(label.padEnd(18), 'rolled', t._nRoll, 'maxTilt', D(t._maxTilt));
  }
}
