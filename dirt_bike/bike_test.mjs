// bike_test.mjs – headless checks for DirtBikeSim (node, no browser):
//   node dirt_bike/bike_test.mjs flat | brake | jump | race [route-id]
// flat: accelerate, full-lean turn, quick flick the other way · brake: full stop · jump: 20° kicker at 12/18/24 m/s
// race: 3 AI bikes per route with SprintAI – prints finish times, crashes and hardest landing
import { DesertTerrain } from '../desert/DesertTerrain.js';
import { SPRINT_ROUTES, BUTTES } from '../desert/routes.js';
import { TruckWorld } from '../monster_truck/MonsterTruckSim.js';
import { addBike } from './DirtBikeSim.js';
import { SprintRace, SprintAI } from '../desert/SprintRace.js';
const mode = process.argv[2] || 'flat';
const h = 1 / 60;
if (mode === 'flat') {
  const world = new TruckWorld({ groundHeight: () => 0 });
  const b = addBike(world, { x: 0, z: 0, yaw: 0 });
  let crashes = 0; b.onCrash = () => crashes++;
  const log = (t) => console.log(`t=${t.toFixed(1)} v=${b.speed.toFixed(1)} pos=${b.pos.map(x=>x.toFixed(2))} roll=${(b.roll*57.3).toFixed(1)} pitch=${(b.pitch*57.3).toFixed(1)} steer=${(b.steerAngle*57.3).toFixed(1)} sF=${b.wheels.F.s.toFixed(3)} sR=${b.wheels.R.s.toFixed(3)} crashed=${b.crashed}`);
  for (let i = 0; i <= 60 * 14; i++) {
    const t = i * h;
    b.input = { throttle: t < 8 ? 1 : 0.6, brake: 0, steer: t > 6 && t < 10 ? 1 : t >= 10 && t < 12 ? -0.6 : 0 };
    world.step(h);
    if (i % 60 === 0) log(t);
  }
  console.log('crashes', crashes);
}
if (mode === 'brake') {
  const world = new TruckWorld({ groundHeight: () => 0 });
  const b = addBike(world, { x: 0, z: 0, yaw: 0 });
  for (let i = 0; i <= 60 * 9; i++) { const t = i * h; b.input = { throttle: t < 6 ? 1 : 0, brake: t >= 6 ? 1 : 0, steer: 0 }; world.step(h);
    if (i % 30 === 0) console.log(`t=${t.toFixed(1)} v=${b.speed.toFixed(1)} pitch=${(b.pitch*57.3).toFixed(1)} sF=${b.wheels.F.s.toFixed(3)} sR=${b.wheels.R.s.toFixed(3)} crashed=${b.crashed}`); }
}
if (mode === 'jump') {
  // ramp: 20° kicker 4 m long ending at z=40, flat landing
  const ramp = (x, z) => (z > 36 && z < 40 ? (z - 36) * Math.tan(0.35) : 0) + (z > 60 ? -(z - 60) * 0 : 0);
  const world = new TruckWorld({ groundHeight: ramp });
  for (const v0 of [12, 18, 24]) {
    const b = addBike(world, { x: 0, z: 0, yaw: 0 });
    let land = 0, crash = 0, maxY = 0, air = 0; b.onLand = (v) => land = Math.max(land, v); b.onCrash = () => crash++;
    for (let i = 0; i < 60 * 8; i++) { b.input = { throttle: b.speed < v0 ? 1 : 0, brake: 0, steer: 0 }; world.step(h); maxY = Math.max(maxY, b.rootPosition[1]); if (b.airborne) air += h; }
    console.log(`v0=${v0} airtime=${air.toFixed(2)} maxY=${maxY.toFixed(2)} landing=${land.toFixed(1)} crashes=${crash} final z=${b.pos[2].toFixed(0)} pitch=${(b.pitch*57.3).toFixed(1)} roll=${(b.roll*57.3).toFixed(1)}`);
    world.trucks.splice(world.trucks.indexOf(b), 1);
  }
}
if (mode === 'race') {
  const terrain = new DesertTerrain({ routes: SPRINT_ROUTES, buttes: BUTTES });
  const world = new TruckWorld({ groundHeight: terrain.height, surface: terrain.surface });
  for (const route of (process.argv[3] ? [process.argv[3]] : SPRINT_ROUTES.map((r) => r.id))) {
    world.trucks.length = 0;
    const race = new SprintRace(terrain, route);
    const slots = race.gridSlots(3); const R = race.route;
    const rs = [];
    slots.forEach((sl, i) => {
      const b = addBike(world, { x: sl.x, z: sl.z, yaw: sl.yaw, autoRecoverAfter: 2 });
      const id = 'b' + i; race.addRacer(id, { name: id });
      const p = R.pointAt(sl.s), lane = (sl.x - p.x) * p.tz - (sl.z - p.z) * p.tx;
      const ai = new SprintAI(race, b, id, { skill: 0.72 + 0.1 * (i + 1), lane, seed: i * 1.7, world });
      const rec = { id, b, ai, crashes: 0, maxLand: 0, resp: 0 };
      b.onCrash = (bb, v, info) => { rec.crashes++; if (info?.ejected) rec.ejected = (rec.ejected || 0) + 1; if (rec.crashes <= +(process.env.NC||6)) console.log('    crash', id, 's=' + race.racers.get(id).s.toFixed(0), 'v=' + b.speed.toFixed(1), 'tilt=' + (b.tilt*57.3).toFixed(0), 'roll=' + (b.roll*57.3).toFixed(0), 'pitch=' + (b.pitch*57.3).toFixed(0), 'rider=' + b._riderHit.toFixed(2), 'touch=' + b._touching, 'hull=' + b._hullHits, 'steer=' + b.input.steer.toFixed(2), 'lean=' + (b.lean*57.3).toFixed(0), 'hullImp=' + b._hullImpact.toFixed(1), 'ej=' + (info?.ejected||false)); }; b.onLand = (v) => rec.maxLand = Math.max(rec.maxLand, v);
      rs.push(rec);
    });
    race.start();
    let t = 0; const t0 = Date.now();
    while (t < 300 && ![...race.racers.values()].every((r) => r.finished)) {
      for (const r of rs) { terrain.prefetch(r.b.pos[0], r.b.pos[2], 70, 50); r.ai.update(h); }
      world.step(h); t += h;
      if (process.env.PATH_LOG && Math.round(t * 60) % 30 === 0) { const r = rs[0], rr = race.racers.get(r.id); console.log('      p t=' + t.toFixed(1), 's=' + rr.s.toFixed(0), 'd=' + rr.d.toFixed(1), 'v=' + r.b.speed.toFixed(1), 'steer=' + r.b.input.steer.toFixed(2), 'roll=' + (r.b.roll*57.3).toFixed(0), 'next=' + rr.next, 'curv=' + race.route.at(race.route.curv, rr.s).toFixed(4)); }
      if (process.env.TRACE) { const r = rs[0], rr = race.racers.get(r.id); if (rr.s > +process.env.TRACE - 80 && rr.s < +process.env.TRACE + 20 && Math.round(t * 60) % 6 === 0) console.log('      tr s=' + rr.s.toFixed(0), 'y=' + r.b.pos[1].toFixed(2), 'g=' + terrain.height(r.b.pos[0], r.b.pos[2]).toFixed(2), 'v=' + r.b.speed.toFixed(1), 'air=' + r.b.airborne, 'roll=' + (r.b.roll*57.3).toFixed(0), 'pitch=' + (r.b.pitch*57.3).toFixed(0), 'w=' + r.b.w.map(x=>x.toFixed(1)), 'steer=' + r.b.input.steer.toFixed(2), 'thr=' + r.b.input.throttle.toFixed(2), 'tF=' + r.b.wheels.F.contact + r.b.wheels.R.contact, 'crashed=' + r.b.crashed); }
      race.update(h, rs.map((r) => ({ id: r.id, pos: r.b.pos, vel: r.b.vel, forward: r.b.forward })));
    }
    console.log(route, 'sim', t.toFixed(0) + 's', 'wall', ((Date.now() - t0) / 1000).toFixed(0) + 's');
    for (const r of rs) { const rr = race.racers.get(r.id); console.log('  ', r.id, rr.finished ? SprintRace.fmt(rr.time) : 'DNF s=' + rr.s.toFixed(0) + ' next=' + rr.next + '/' + (race.checkpoints.length) + ' missed=' + rr.missed + ' d=' + rr.d.toFixed(1) + ' finishS=' + race.finishS.toFixed(0) + ' v=' + r.b.speed.toFixed(1) + ' crashed=' + r.b.crashed + ' tilt=' + (r.b.tilt*57.3).toFixed(0), 'crashes', r.crashes, 'thrown', r.ejected || 0, 'max landing', r.maxLand.toFixed(1)); }
  }
}
