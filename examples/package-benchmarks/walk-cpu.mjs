// CPU cost of WalkControls.update() per frame (HANDOFF 5l.t point 4). Node, one thread, fixed 1/60 s steps, no GPU.
// Scenes: the generated two-storey house walked along its scripted path; a 4 x 4 block of those houses (1,700+ meshes)
// walked through one of them; and the 62 MB conveyor GLB (570 primitives, 2.45M triangles; skipped when only the LFS
// pointer is checked out) with a straight walk across the machine. First-touch frames build BVHs synchronously, so each
// path runs twice and the second (warm) pass is reported; the cold pass maximum is reported separately.
// Run: node examples/package-benchmarks/walk-cpu.mjs [--no-gate]   (waits for scripts/quiet-gate.mjs first)
import { readFile, writeFile } from 'node:fs/promises';
import { Engine as Runtime, TransformStore } from '../../packages/core/dist/extension.js';
import { box } from '../../packages/core/dist/index.js';
import { PBRModel, parseGLTFAsync } from '../../packages/gltf-pro/dist/index.js';
import { WalkControls } from '../../packages/controls/dist/walk.js';
import { PATH, buildHouse } from '../../packages/controls/tests/house.js';
import { waitForQuiet } from '../../scripts/quiet-gate.mjs';

const machine = process.argv.includes('--no-gate') ? { gate: 'skipped' } : await waitForQuiet();
const canvas = () => ({
  clientWidth: 1280,
  clientHeight: 720,
  width: 1280,
  height: 720,
  style: {},
  addEventListener() {},
  removeEventListener() {},
});
const stub = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} };
const engineAt = async (capacity, position, target) =>
  new Runtime(canvas(), await TransformStore.create(capacity), stub, { position, target }, null);

/** Walks `path` (feet x, z waypoints) twice; returns per-frame update() milliseconds of the warm pass and the cold maximum. */
function measure(engine, walk, path, eye = 1.65) {
  const times = [],
    update = walk.update.bind(walk),
    stats = { candidates: 0, triangles: 0, rays: 0, substeps: 0 };
  walk.update = (delta) => {
    const t = performance.now();
    const moved = update(delta);
    times.push(performance.now() - t);
    if (process.env.SLOW && performance.now() - t > 1)
      console.error(
        (performance.now() - t).toFixed(2),
        JSON.stringify(walk.stats),
        engine.camera.position.map((v) => v.toFixed(2)).join(),
      );
    return moved;
  };
  const passes = [];
  for (let pass = 0; pass < 2; pass++) {
    engine.camera.position = [path[0][0], path[0][2] ?? eye, path[0][1]];
    engine.camera.target = [path[1][0], path[0][2] ?? eye, path[1][1]];
    walk.velocity.fill(0);
    times.length = 0;
    let target = 1,
      frames = 0,
      since = 0,
      reached = 0,
      sum = 0;
    for (const key in stats) stats[key] = 0;
    while (target < path.length) {
      const [x, , z] = engine.camera.position,
        [tx, tz] = path[target],
        dx = tx - x,
        dz = tz - z;
      if (Math.hypot(dx, dz) < 0.2 || since > 600) {
        reached += since <= 600;
        target++;
        since = 0;
        continue;
      } // 10 s per waypoint, then the next
      since++;
      engine.camera.target = [x + dx, engine.camera.position[1], z + dz];
      walk.axes.y = -1;
      engine.render({ delta: 1 / 60 });
      frames++;
      for (const key in stats) stats[key] = Math.max(stats[key], walk.stats[key]);
      sum += walk.stats.triangles;
    }
    const sorted = [...times].sort((a, b) => a - b),
      pick = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(4);
    passes.push({
      frames,
      waypoints: `${reached}/${path.length - 1}`,
      meanTrianglesTested: +(sum / frames).toFixed(1),
      medianMs: pick(0.5),
      p95Ms: pick(0.95),
      p99Ms: pick(0.99),
      maxMs: +sorted.at(-1).toFixed(3),
      meanMs: +(times.reduce((s, t) => s + t, 0) / times.length).toFixed(4),
      worstFrame: { ...stats },
    });
  }
  walk.update = update;
  return { warm: passes[1], coldMaxMs: passes[0].maxMs };
}

const results = { machine, node: process.version, date: new Date().toISOString(), scenes: {} };

{
  const engine = await engineAt(1024, [PATH[0][0], 1.65, PATH[0][1]], [PATH[0][0], 1.65, PATH[0][1] + 1]);
  const house = buildHouse(engine),
    walk = new WalkControls(engine);
  results.scenes.house = {
    meshes: house.meshes.length,
    triangles: house.meshes.length * 12,
    ...measure(engine, walk, PATH),
  };
}
{
  const engine = await engineAt(4096, [PATH[0][0], 1.65, PATH[0][1]], [PATH[0][0], 1.65, PATH[0][1] + 1]);
  let meshes = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const house = buildHouse(engine);
      for (const mesh of house.meshes)
        mesh.setPosition([mesh.position.x + (i - 1) * 24, mesh.position.y, mesh.position.z + (j - 1) * 24]);
      meshes += house.meshes.length;
    }
  const walk = new WalkControls(engine);
  results.scenes.houseBlock = { houses: 16, meshes, ...measure(engine, walk, PATH) };
}
const conveyor = await readFile(new URL('../conveyor-simulator/Untitled.glb', import.meta.url)).catch(() => null);
if (conveyor?.length > 12 && conveyor.readUInt32LE(0) === 0x46546c67) {
  const setup = PBRModel.prototype.setup;
  PBRModel.prototype.setup = () => {};
  try {
    const engine = await engineAt(4096, [0, 0, 0], [0, 0, 1]),
      t0 = performance.now();
    const model = await parseGLTFAsync(
      engine,
      new Uint8Array(conveyor.buffer, conveyor.byteOffset, conveyor.byteLength),
    );
    const parseMs = performance.now() - t0;
    engine.render({ delta: 0 });
    const b = model.bounds,
      floorY = b[1],
      cx = (b[0] + b[3]) / 2,
      cz = (b[2] + b[5]) / 2,
      half = Math.max(b[3] - b[0], b[5] - b[2]) / 2 + 2;
    engine
      .createMesh()
      .setGeometry(box())
      .setPosition([cx, floorY - 0.1, cz])
      .setScale([half * 2 + 4, 0.2, half * 2 + 4]);
    const walk = new WalkControls(engine),
      eye = floorY + 1.65;
    walk.speed = 4;
    // Through the centres of the parts that reach below head height, in order around the machine: the walker runs into and slides along them.
    const centres = model.primitives
      .map((p) => {
        const m = p.node.matrix,
          v = p.vertices,
          lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 20 * 64)
          for (let k = 0; k < 3; k++) {
            const w = m[k] * v[i] + m[4 + k] * v[i + 1] + m[8 + k] * v[i + 2] + m[12 + k];
            lo[k] = Math.min(lo[k], w);
            hi[k] = Math.max(hi[k], w);
          }
        return { x: (lo[0] + hi[0]) / 2, z: (lo[2] + hi[2]) / 2, low: lo[1] < floorY + 1.8 };
      })
      .filter((c) => c.low);
    centres.sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx));
    const path = [
      [cx - half, cz - half, eye],
      ...centres.filter((_, i) => i % Math.ceil(centres.length / 24) === 0).map((c) => [c.x, c.z]),
    ];
    results.scenes.conveyor = {
      primitives: model.primitives.length,
      waypointParts: path.length - 1,
      triangles: model.primitives.reduce((s, p) => s + p.indices.length / 3, 0),
      parseMs: Math.round(parseMs),
      bounds: [...b].map((v) => +v.toFixed(2)),
      ...measure(engine, walk, path),
    };
  } finally {
    PBRModel.prototype.setup = setup;
  }
} else results.scenes.conveyor = 'skipped: examples/conveyor-simulator/Untitled.glb is an LFS pointer';

await writeFile(new URL('results/walk-cpu.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results.scenes, null, 2));
