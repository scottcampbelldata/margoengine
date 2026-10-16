// Proof for @margoengine/machinery at CAD scale, on the synthetic bolted-plate assembly of examples/package-benchmarks/cad.
// ExplodedView: flat typed arrays and one overflow flag per part instead of per-part closures, arrays and three fround checks.
// AssemblyBVH: one local-space BVH per distinct geometry plus a per-part sphere pass, instead of one world-space BVH over every
// instanced triangle (which also capped assemblies at 1M instanced triangles, about 7,800 parts here).
// Run: node examples/package-benchmarks/proofs/machinery-cad.proof.js [ref] [pin]
// Pinned: 7d5a5dd against deb4015, the commit that recorded results/machinery-cad.json (re-measured on AC).
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { buildAssembly } from '../cad/assembly.js';
import { refs, versions, time, record } from './compare.js';
import { requireAC } from '../cad/power.mjs';
const power = requireAC();

const { ref, pin } = refs('7d5a5dd', 'deb4015');
const exploded = await versions('machinery', ref, 'src/exploded.ts', pin),
  spatial = await versions('machinery', ref, 'src/spatial.ts', pin);
const scene = async (modules) => {
  const e = new Engine(
    { width: 1, height: 1, clientWidth: 1, clientHeight: 1 },
    await TransformStore.create(Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1)),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  const assembly = buildAssembly(e, modules);
  e.render({ culling: false });
  return { e, assembly };
};
const triangles = (parts) => parts.reduce((n, p) => n + p.geometry.indices.length / 3, 0),
  cases = [],
  errors = { baseline: 0, candidate: 0 };
let sameTriangle = '';

// ExplodedView at 10k and 50k parts: identical positions every step, then per-update cost.
for (const modules of [371, 1852]) {
  const { e, assembly } = await scene(modules),
    parts = assembly.parts,
    offsets = parts.map((node, i) => ({ node, offset: [(i % 7) * 0.01, 0.05, -(i % 5) * 0.02] }));
  const a = new exploded.baseline.ExplodedView(offsets),
    b = new exploded.candidate.ExplodedView(offsets),
    t = e.store.transforms;
  a.setup(e);
  b.setup(e);
  for (const amount of [0, 0.25, 0.5, 1, 0.3]) {
    a.amount = b.amount = amount;
    a.onPreUpdate();
    const want = parts.map((p) => [t.x[p.id], t.y[p.id], t.z[p.id]]);
    b.onPreUpdate();
    parts.forEach((p, i) => assert.deepEqual([t.x[p.id], t.y[p.id], t.z[p.id]], want[i]));
  }
  // While amount changes both write every part (same loop, same per-part liveness check); at rest the candidate skips the loop.
  let step = 0;
  const animating = time(
    () => {
      a.amount = (step++ % 10) / 10;
      a.onPreUpdate();
    },
    () => {
      b.amount = (step++ % 10) / 10;
      b.onPreUpdate();
    },
  );
  a.amount = b.amount = 0.5;
  cases.push({
    case: `ExplodedView.onPreUpdate at rest, ${parts.length} parts`,
    ...time(
      () => a.onPreUpdate(),
      () => b.onPreUpdate(),
    ),
    animatingBaselineMs: animating.baselineMs,
    animatingCandidateMs: animating.candidateMs,
  });
  e.dispose();
}

// AssemblyBVH at 7,560 parts (973k instanced triangles, just under the old 1M cap): same node, triangle and distance for rays aimed at
// triangle centroids, then create, rebuild and raycast cost.
{
  const { e, assembly } = await scene(280),
    parts = assembly.parts,
    a = await spatial.baseline.AssemblyBVH.create(parts),
    b = await spatial.candidate.AssemblyBVH.create(parts),
    rays = [];
  for (let i = 0; i < 400; i++) {
    const p = parts[(i * 7919) % parts.length],
      f = (i * 104729) % (p.geometry.indices.length / 3),
      v = p.geometry.vertices,
      m = p.matrix,
      c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const at = p.geometry.indices[f * 3 + k] * 6;
      for (let r = 0; r < 3; r++) c[r] += (m[r] * v[at] + m[4 + r] * v[at + 1] + m[8 + r] * v[at + 2] + m[12 + r]) / 3;
    }
    const origin = [c[0] + 0.7, c[1] + 2, c[2] + 0.4];
    rays.push([origin, [c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]], p, f]);
  }
  // When a ray hits the triangle it was aimed at, the exact distance is |d| (float64): compare both versions against it.
  let agree = 0;
  for (const [o, d, part, face] of rays) {
    const x = a.raycast(o, d),
      y = b.raycast(o, d);
    assert.equal(!!y, !!x);
    if (!x) continue;
    assert.ok(Math.abs(x.distance - y.distance) <= 1e-4 * Math.max(1, x.distance), `${x.distance} != ${y.distance}`);
    if (x.node === y.node && x.triangle === y.triangle) agree++;
    else assert.ok(Math.abs(x.distance - y.distance) <= 1e-4, 'different surface');
    if (y.node === part && y.triangle === face) {
      const exact = Math.hypot(...d);
      errors.baseline = Math.max(
        errors.baseline,
        x.node === part && x.triangle === face ? Math.abs(x.distance - exact) : 0,
      );
      errors.candidate = Math.max(errors.candidate, Math.abs(y.distance - exact));
    }
  }
  // Rays that hit coincident faces (washer on plate, nut on washer) may pick either face at the same distance.
  assert.ok(agree >= rays.length * 0.95, `same triangle for ${agree}/${rays.length}`);
  sameTriangle = `${agree}/${rays.length}`;
  // Raycast cost is about equal at this size (one world BVH vs sphere pass + shared local BVHs), so it is reported, not asserted.
  let r = 0;
  const rays100 = time(
    () => {
      for (let i = 0; i < 100; i++) a.raycast(...rays[r++ % rays.length].slice(0, 2));
    },
    () => {
      for (let i = 0; i < 100; i++) b.raycast(...rays[r++ % rays.length].slice(0, 2));
    },
  );
  cases.push({
    case: `AssemblyBVH.rebuild, ${parts.length} parts, ${triangles(parts)} instanced triangles`,
    ...time(
      () => a.rebuild(),
      () => b.rebuild(),
      4,
    ),
    raycast100BaselineMs: rays100.baselineMs,
    raycast100CandidateMs: rays100.candidateMs,
  });
  const created = [];
  for (const kind of [spatial.baseline, spatial.candidate]) {
    const s = performance.now();
    (await kind.AssemblyBVH.create(parts)).dispose();
    created.push(performance.now() - s);
  }
  cases.push({
    case: 'AssemblyBVH.create (once each)',
    baselineMs: +created[0].toFixed(2),
    candidateMs: +created[1].toFixed(2),
    speedup: +(created[0] / created[1]).toFixed(1),
  });
  a.dispose();
  b.dispose();
  e.dispose();
}
// 89,883 parts, 11.6M instanced triangles: the baseline refuses; the candidate builds and picks.
{
  const { e, assembly } = await scene(3329),
    parts = assembly.parts;
  await assert.rejects(spatial.baseline.AssemblyBVH.create(parts), /1\.\.1000000/);
  let s = performance.now();
  const b = await spatial.candidate.AssemblyBVH.create(parts);
  const createMs = performance.now() - s,
    rebuild = [],
    ray = [];
  for (let i = 0; i < 5; i++) {
    s = performance.now();
    b.rebuild();
    rebuild.push(performance.now() - s);
  }
  let hits = 0;
  for (let i = 0; i < 50; i++) {
    const p = parts[(i * 7919) % parts.length].matrix;
    s = performance.now();
    if (b.raycast([p[12] + 0.3, p[13] + 2, p[14] + 0.2], [-0.3, -2, -0.2])) hits++;
    ray.push(performance.now() - s);
  }
  assert.ok(hits >= 45);
  const med = (v) => +v.sort((x, y) => x - y)[v.length >> 1].toFixed(3);
  cases.push({
    case: `AssemblyBVH ${parts.length} parts, ${triangles(parts)} instanced triangles (baseline refuses)`,
    baselineMs: null,
    candidateMs: med(ray),
    speedup: null,
    createMs: +createMs.toFixed(1),
    rebuildMs: med(rebuild),
    raycastMs: med(ray),
  });
  b.dispose();
  e.dispose();
}
// record() requires speedup >= 1 for measured pairs; the capacity case has no baseline.
await record(
  'machinery-cad',
  ref,
  cases.map((c) => (c.speedup === null ? { ...c, speedup: Infinity } : c)),
  `AC power: ${power} at start, ${requireAC()} at end. Node, fake renderer; ExplodedView positions identical; BVH hit distances agree within 1e-4 relative (same node and triangle for ${sameTriangle} rays, the rest hit a coincident face at the same distance); largest error against the exact float64 distance: baseline ${errors.baseline.toExponential(2)} m, candidate ${errors.candidate.toExponential(2)} m.`,
  pin,
);
