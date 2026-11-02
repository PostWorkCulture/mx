// TerrainWorker.js – bakes DesertTerrain physics tiles and render meshes off the main thread.
// Used by TerrainBaker (DesertRenderer.js). Messages:
//   { type: 'init', opts }                         → builds its own DesertTerrain (same seed/routes = same ground)
//   { type: 'phys', id, ix, iz }                   → { id, ix, iz, h, soft, trk, rk }
//   { type: 'mesh', id, x0, z0, size, n, skirt }   → { id, position, normal, mask, route, index }
import { DesertTerrain } from './DesertTerrain.js';
let T = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { T = new DesertTerrain(m.opts); self.postMessage({ type: 'ready' }); return; }
  if (m.type === 'phys') {
    const t = T.tileData(m.ix, m.iz);
    self.postMessage({ type: 'phys', id: m.id, ix: m.ix, iz: m.iz, h: t.h, soft: t.soft, trk: t.trk, rk: t.rk }, [t.h.buffer, t.soft.buffer, t.trk.buffer, t.rk.buffer]);
  } else if (m.type === 'mesh') {
    const d = T.meshData(m.x0, m.z0, m.size, m.n, m.skirt);
    self.postMessage({ type: 'mesh', id: m.id, ...d }, [d.position.buffer, d.normal.buffer, d.mask.buffer, d.route.buffer, d.index.buffer]);
  }
};
