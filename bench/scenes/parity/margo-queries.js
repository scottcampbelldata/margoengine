// Margo implementation of the parity query scenes (../parity.js, area 'queries'): the @margoengine/bvh Raycaster (the
// engine's raycaster; it builds and caches a BVH per geometry on first use) and core's GPU pick (`engine.pick`).
import { PbrMaterial } from '@margoengine/core';
import { engineFor, meshes, palette, single } from '../margo.js';

const W = 1280,
  H = 720;
/** The 40 x 25 pixel grid (pixel centres) of the 1280 x 720 canvas. */
const pixelGrid = () => {
  const out = [];
  for (let j = 0; j < 25; j++) for (let i = 0; i < 40; i++) out.push([((i + 0.5) * W) / 40, ((j + 0.5) * H) / 25]);
  return out;
};
const summary = (hits) => {
  let n = 0,
    distance = 0,
    ids = 0;
  for (const h of hits)
    if (h) {
      n++;
      distance += h.distance;
      ids += h.index;
    }
  return { rays: hits.length, hits: n, distanceSum: +distance.toFixed(3), indexSum: ids };
};

export const builders = {
  async 'p-raycast'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { Raycaster } = await import('@margoengine/bvh'),
      list = meshes(engine, data, palette(data)),
      index = new Map(list.map((m, i) => [m, i])),
      raycaster = Object.assign(new Raycaster(), { firstHitOnly: true }),
      pixels = pixelGrid();
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let hits = [];
    return {
      task() {
        hits = pixels.map(([x, y]) => {
          const [hit] = raycaster.setFromEngine(engine, x, y).intersectEngine(engine);
          return hit && { distance: hit.distance, index: index.get(hit.mesh) };
        });
      },
      output: () => summary(hits),
      info: () => ({ note: 'bvh Raycaster, firstHitOnly (nearest hit); per-geometry BVH built on the cold call' }),
    };
  },

  async 'p-raycast-mesh'(canvas, data, marks) {
    const camera = { fov: 45, near: 0.1, far: 100, target: [0.5, 0, 0.5], at: () => [0.5, 2, 2.5] },
      engine = await engineFor(canvas, camera, 16, marks),
      s = performance.now(),
      [{ Raycaster }, G] = await Promise.all([import('@margoengine/bvh'), import('@margoengine/geometry')]),
      g = data.grid,
      v = g.positions.length / 3,
      geometry = G.toGeometry(
        G.computeVertexNormals(
          G.geometryData(g.positions, new Float32Array(v * 3), new Float32Array(v * 2), g.indices),
        ),
      ),
      mesh = engine
        .createMesh()
        .setGeometry(geometry)
        .setMaterial(new PbrMaterial({ color: '#888888', ...single })),
      raycaster = Object.assign(new Raycaster(), { firstHitOnly: true }),
      // 1,000 rays straight down from y = 1 over a 40 x 25 grid of points inside the unit grid.
      origins = [];
    for (let j = 0; j < 25; j++) for (let i = 0; i < 40; i++) origins.push([(i + 0.5) / 40, 1, (j + 0.5) / 25]);
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let hits = [];
    return {
      task() {
        hits = origins.map((o) => {
          const [hit] = raycaster.set(o, [0, -1, 0]).intersectMeshes(engine, [mesh]);
          return hit && { distance: hit.distance, index: hit.faceIndex };
        });
      },
      output: () => {
        const { indexSum, ...rest } = summary(hits);
        return { ...rest, triangles: g.indices.length / 3 };
      },
      info: () => ({
        note: 'bvh Raycaster: the grid BVH (SAH) is built on the cold call and cached; rays down from y = 1 over a 40 x 25 grid',
      }),
    };
  },

  async 'p-gpu-pick'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      list = meshes(engine, data, palette(data)),
      index = new Map(list.map((m, i) => [m, i])),
      // 100 pixels: a 10 x 10 grid of whole pixels.
      pixels = [];
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) pixels.push([64 + 128 * i, 36 + 72 * j]);
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let picked = [];
    return {
      async task() {
        picked = await Promise.all(pixels.map(([x, y]) => engine.pick(x, y)));
      },
      output: () => {
        const ids = picked.filter(Boolean).map((m) => index.get(m));
        return { pixels: pixels.length, hits: ids.length, indexSum: ids.reduce((a, b) => a + b, 0) };
      },
      info: () => ({ note: 'core engine.pick per pixel (an ID pass and a readback each, answered in order)' }),
    };
  },
};
