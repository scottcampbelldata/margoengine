import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/ecs/scripts/bridge-bench.mjs')
)
  process.exit(0);
// MeshBridge.sync timed on 20,000 links, one process per case so one case's JIT state does not reach the next.
// Run: npm run build --workspace packages/ecs, then node packages/ecs/scripts/bridge-bench.mjs
// Prints the median of 300 calls after 300 calls of warm-up. "none after all" is a world that stopped moving.
import { spawnSync } from 'node:child_process';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { World } from '../dist/index.js';
import { MeshBridge, transformSchema } from '../dist/engine.js';

const kase = process.argv[2];
if (!kase) {
  for (const name of ['none', 'none after all', '1%', 'all']) {
    const { stdout, status } = spawnSync(process.execPath, [import.meta.filename, name], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (status !== 0) throw new Error(`Case ${name} failed`);
    process.stdout.write(stdout);
  }
} else {
  const links = 20000,
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    canvas = { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    engine = new Engine(canvas, await TransformStore.create(links), renderer),
    world = new World(links + 8),
    transform = world.component(transformSchema),
    bridge = new MeshBridge(transform),
    rows = [];
  for (let i = 0; i < links; i++) {
    const entity = world.create();
    bridge.link(entity, engine.createMesh());
    rows.push(transform.index(entity));
  }
  bridge.sync();
  const { x, qy, sx } = transform.fields;
  const moveAll = (frame) => {
    for (const row of rows) {
      x[row] = frame + row;
      qy[row] = (frame % 7) / 7;
      sx[row] = 1 + (frame % 3);
    }
  };
  const moveSome = (frame) => {
    for (let i = 0; i < links; i += 100) x[rows[i]] = frame;
  };
  const median = (move) => {
    for (let frame = 0; frame < 300; frame++) {
      move(frame);
      bridge.sync();
    }
    const samples = [];
    for (let frame = 300; frame < 600; frame++) {
      move(frame);
      const start = performance.now();
      bridge.sync();
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[150];
  };
  if (kase === 'none after all') median(moveAll);
  const time = median(kase === 'all' ? moveAll : kase === '1%' ? moveSome : () => {});
  console.log(`${kase}: ${time.toFixed(3)} ms`);
}
