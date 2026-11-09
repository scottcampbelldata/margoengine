import { deferSpeed, isSpeedEntry } from '../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('examples/package-benchmarks/walk-cpu.mjs')
)
  process.exit(0);
// CPU cost of WalkControls.update() per frame. Node, one thread, fixed 1/60 s steps, no GPU.
// Scenes: the generated two-storey house walked along its scripted path; a 4 x 4 block of those houses (1,700+ meshes)
// walked through one of them. The 62 MB conveyor GLB scene went with the conveyor example (deleted 2026-10-24).
// First-touch frames build BVHs synchronously, so each path runs twice and the second (warm) pass is reported; the
// cold pass maximum is reported separately.
// Run: node examples/package-benchmarks/walk-cpu.mjs [--no-gate]   (waits for scripts/quiet-gate.mjs first)
import { writeFile } from 'node:fs/promises';
import { Engine as Runtime, TransformStore } from '../../packages/core/dist/extension.js';
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

await writeFile(new URL('results/walk-cpu.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results.scenes, null, 2));
