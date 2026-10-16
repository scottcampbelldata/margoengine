// Core at 100k / 500k / 1M entities in Node (same Wasm as the browser, fake renderer): the CAD assembly built from the
// default 1,024-slot store, so the store doubles on demand. Records memory, build/growth/dispose time, kernel tick
// (static, 1% moving, full recompute) and batch collection.
// Run (repo root, after build:packages): node examples/package-benchmarks/cad/scale-node.mjs [--sizes=100000,500000,1000000] [--label=x] [--diagnostic]
// Without --diagnostic it waits for scripts/quiet-gate.mjs first; the JSON goes to results-scale-node[-label].json here.
import { writeFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { buildAssembly, ENTITIES_PER_MODULE, partShapes } from './assembly.js';
import { requireAC } from './power.mjs';
import { waitForQuiet } from '../../../scripts/quiet-gate.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const sizes = (arg('sizes') ?? '100000,500000,1000000').split(',').map(Number),
  diagnostic = process.argv.includes('--diagnostic');
const fake = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
  canvas = { width: 1432, height: 768, clientWidth: 1432, clientHeight: 768 };
const median = (v) => +v.sort((a, b) => a - b)[v.length >> 1].toFixed(3),
  time = (fn) => {
    const s = performance.now();
    fn();
    return +(performance.now() - s).toFixed(1);
  };
const run = (fn, n = 30) => {
  for (let i = 0; i < 5; i++) fn();
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
};
const mb = (bytes) => +(bytes / 2 ** 20).toFixed(1);
const result = {
  node: process.version,
  date: new Date().toISOString(),
  diagnostic,
  conditions: diagnostic ? 'diagnostic: no quiet gate' : await waitForQuiet(),
  acPower: requireAC(),
  cases: [],
};
const shapes = partShapes();
for (const target of sizes) {
  globalThis.gc?.();
  const heap0 = process.memoryUsage().heapUsed,
    modules = Math.round(target / (ENTITIES_PER_MODULE + 1 / 32));
  const e = new Engine(
    canvas,
    await TransformStore.create(1024),
    fake,
    { position: [10, 8, 12], target: [0, 0, 0] },
    null,
  );
  let built;
  const buildMs = time(() => {
    built = buildAssembly(e, modules, shapes);
  });
  const entities = e.meshes.size,
    capacity = e.store.capacity,
    wasm = e.store.matrices.buffer.byteLength;
  e.render();
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed - heap0;
  // Growth: time the last doubling's cost alone, on a copy of the inputs (a second store of the same capacity).
  const copy = await TransformStore.create(capacity / 2);
  copy.active.fill(1);
  const growMs = time(() => copy.grow(capacity));
  // Full recompute = the first tick of a store holding the same inputs (what the tick after every doubling costs).
  for (const key of Object.keys(e.store.transforms)) copy.transforms[key].set(e.store.transforms[key]);
  for (const key of ['parents', 'bounds', 'planes', 'active', 'hidden', 'constrained', 'rotations', 'limits'])
    copy[key].set(e.store[key]);
  const fullTickMs = time(() => copy.tick(true));
  copy.dispose();
  const staticTick = run(() => e.store.tick(true));
  const movers = built.parts.filter((_, i) => i % 100 === 0);
  let phase = 0;
  const moveTick = run(() => {
    phase++;
    for (const m of movers) m.position.y = (phase & 1) * 0.001;
    e.store.tick(true);
  });
  e.render();
  const fullFrame = run(() => {
      e.collected = -1;
      e.render();
    }, 15),
    reusedFrame = run(() => e.render(), 15);
  const disposeMs = time(() => e.dispose());
  result.cases.push({
    entities,
    parts: built.parts.length,
    capacity,
    visible: e.stats.visible,
    memory: {
      kernelWasmMB: mb(wasm),
      kernelBytesPerSlot: +(wasm / capacity).toFixed(1),
      engineTypedBytesPerSlot: 5,
      instanceStorageMB: mb(built.parts.length * 96),
      jsHeapMB: mb(heap),
      jsHeapBytesPerEntity: Math.round(heap / entities),
    },
    buildMs,
    lastDoublingGrowMs: growMs,
    tickFullRecomputeMs: fullTickMs,
    tickStaticMs: staticTick,
    tickMove1PercentMs: moveTick,
    fullCollectionFrameMs: fullFrame,
    reusedFrameMs: reusedFrame,
    collectionMs: +(fullFrame - reusedFrame).toFixed(3),
    disposeMs,
  });
  console.error(JSON.stringify(result.cases.at(-1)));
}
result.acPowerAtEnd = requireAC();
const out = new URL(`results-scale-node${arg('label') ? '-' + arg('label') : ''}.json`, import.meta.url);
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(out.pathname);
