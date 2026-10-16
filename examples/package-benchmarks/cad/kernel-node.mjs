// Kernel tick in Node (same Wasm as the browser): the CAD assembly (5 levels) and the earlier 10-deep chain case.
// Run: node examples/package-benchmarks/cad/kernel-node.mjs
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { buildAssembly } from './assembly.js';
import { requireAC } from './power.mjs';
const median = (v) => +v.sort((a, b) => a - b)[v.length >> 1].toFixed(3),
  fake = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
const tick = (store, culling) => {
  for (let i = 0; i < 10; i++) store.tick(culling);
  const t = [];
  for (let i = 0; i < 60; i++) {
    const s = performance.now();
    store.tick(culling);
    t.push(performance.now() - s);
  }
  return median(t);
};
const result = { node: process.version, date: new Date().toISOString(), acPower: requireAC(), cases: [] };
for (const modules of [371, 1852, 3329]) {
  const capacity = Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1),
    e = new Engine(
      { width: 1432, height: 768, clientWidth: 1432, clientHeight: 768 },
      await TransformStore.create(capacity),
      fake,
      { position: [10, 8, 12], target: [0, 0, 0] },
      null,
    );
  const { parts } = buildAssembly(e, modules);
  e.render();
  result.cases.push({
    case: 'CAD assembly, 5 levels',
    parts: parts.length,
    entities: e.meshes.size,
    tickCullMs: tick(e.store, true),
    tickNoCullMs: tick(e.store, false),
  });
  e.dispose();
}
{
  const n = 100_000,
    e = new Engine(
      { width: 1432, height: 768, clientWidth: 1432, clientHeight: 768 },
      await TransformStore.create(n),
      fake,
      { position: [10, 8, 12], target: [0, 0, 0] },
      null,
    );
  let parent = null;
  for (let i = 0; i < n; i++) {
    parent = e.createMesh(i % 10 ? parent : null).setPosition([0.01, 0, 0]);
  }
  e.render();
  result.cases.push({
    case: '100,000 entities in 10-deep chains',
    entities: n,
    tickCullMs: tick(e.store, true),
    tickNoCullMs: tick(e.store, false),
  });
  e.dispose();
}
result.acPowerAtEnd = requireAC();
console.log(JSON.stringify(result, null, 1));
