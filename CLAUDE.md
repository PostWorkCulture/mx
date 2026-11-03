# MX – 3D desert racing game

Browser game: three.js r170, plain ES modules, no build step. Hosted on GitHub Pages from `main` (root).
Entry point: `index.html` → `desert/desert_sprint.html`.

## Run locally
Serve the repo root over HTTP (module workers and GLBs don't load from `file://`):
`npx serve` or `python -m http.server`, then open http://localhost:<port>/

## Layout
- `monster_truck/` – `MonsterTruckSim.js` (6-DOF physics: TruckWorld/TruckBody), `MonsterTruckRig.js` (drives the GLB),
  `SandFX.js` (tyre sand + `ParticlePass`), `TruckDirt.js`, game GLBs (hero + `_lod1`). `MonsterTruckPhysics.js` / `MonsterTruckDrive.js` are legacy.
- `desert/` – `DesertTerrain.js` (height function, surfaces, route grading, physics tile cache), `TerrainWorker.js`,
  `routes.js` (sprint routes + buttes), `DesertMap.js` (streaming ground, sky, race dressing), `SandMaterial.js`,
  `SandTracks.js`, `WindSand.js`, `SprintRace.js` (race rules + AI), `desert_sprint.html` (playable demo).
- `dirt_bike/` – `DirtBikeSim.js` (`BikeBody` / `addBike`: two-wheel physics that runs inside `TruckWorld`, so bikes share
  ground, surfaces, statics and collisions with trucks), `DirtBikeRig.js` (drives the GLB: steering, fork, swingarm, wheels,
  plus a procedural rider with IK that is thrown off as a Verlet ragdoll in extreme crashes; `RIDER_KITS`), `bike_test.mjs` (headless node checks + 3-bike AI races per route),
  white dirt bike GLBs (hero + `_lod1`).
- `red_monster_truck_hero.glb` / `_lod1.glb` – original red truck (v2.2).

## Conventions
- Units metres / kg / seconds. +Y up. Vehicle local frame: +Z forward, +X left, origin on the ground between the axles.
- Terrain is a height function `(x, z) => y`; physics reads it through `DesertTerrain.height` (0.5 m cached tiles).
- Wind blows toward +X (east): dunes have gentle windward slopes facing west and slip faces facing east.
- Race format: point-to-point sprints (start → checkpoints → finish), not circuits.
- Menu: Vehicle (Monster truck / Dirt bike) and Livery / Rider (lime / stealth truck, or the bike's rider kit) rows –
  ← → changes them – then Roam (free drive, no clock) or Race (next route in rotation, 3 rivals). Opponents use the same
  vehicle type. Best times are stored per route and vehicle (`mx.best.<route>` for trucks, `mx.best.<route>.bike`).
  URL: `?roam` or `?route=<id>&vehicle=truck|bike&truck=lime|stealth&kit=orange|red|lime|blue` (old `truck=` links still work).

## Performance
- Render scale adapts to frame rate (`adaptResolution` in `desert_sprint.html`, 50–150 % of the window); press F in game to
  show fps and scale. The sand shader is fill-rate heavy, so resolution is the main lever.
- Physics runs at a fixed 60 Hz; frame dt is capped at 0.1 s (below 10 fps the game slows rather than tunnelling).
- Keep the scene lean: terrain LODs 96/48/24 per 64 m tile, 2048 PCF sun shadow, scatter split into 300 m instanced
  chunks so it culls. Trucks are the biggest remaining cost (hero 218k tris, LOD1 80k).

## Assets
- Only runtime assets go in the repo (each GLB ≲ 15 MB; no Git LFS – GitHub Pages can't serve LFS files).
- Raw exports (Tripo GLBs ~65 MB), `.blend`, `.mp4`, concepts and test renders stay local – see `.gitignore`.
