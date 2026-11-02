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
- `dirt_bike/` – white dirt bike GLBs (the chosen bike).
- `red_monster_truck_hero.glb` / `_lod1.glb` – original red truck (v2.2).

## Conventions
- Units metres / kg / seconds. +Y up. Vehicle local frame: +Z forward, +X left, origin on the ground between the axles.
- Terrain is a height function `(x, z) => y`; physics reads it through `DesertTerrain.height` (0.5 m cached tiles).
- Wind blows toward +X (east): dunes have gentle windward slopes facing west and slip faces facing east.
- Race format: point-to-point sprints (start → checkpoints → finish), not circuits.

## Assets
- Only runtime assets go in the repo (each GLB ≲ 15 MB; no Git LFS – GitHub Pages can't serve LFS files).
- Raw exports (Tripo GLBs ~65 MB), `.blend`, `.mp4`, concepts and test renders stay local – see `.gitignore`.
