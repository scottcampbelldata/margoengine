// Proof for @margoengine/bvh: the triangle/triangle and triangle/box separating-axis tests no longer allocate edge
// arrays and a closure per call, and closestPointToPoint keeps each child's box distance instead of recomputing it.
// Run: node examples/package-benchmarks/proofs/bvh.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/bvh.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('bvh', ref, undefined, pin);
let seed = 2024; const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
// A lumpy sphere: an organic collision mesh with triangles of mixed size and orientation.
function blob(segments, rings, radius) {
  const positions = [], indices = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
    const v = r / rings * Math.PI, u = s / segments * Math.PI * 2, bump = radius * (1 + 0.15 * Math.sin(u * 5) * Math.sin(v * 7));
    positions.push(bump * Math.sin(v) * Math.cos(u), bump * Math.cos(v), bump * Math.sin(v) * Math.sin(u));
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {const a = r * (segments + 1) + s, b = a + segments + 1; indices.push(a, b, a + 1, a + 1, b, b + 1);}
  return {positions: new Float32Array(positions), indices: new Uint32Array(indices)};
}
function matrix(rx, ry, tx, ty, tz, scale = 1) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  return [cy * scale, 0, -sy * scale, 0, sx * sy * scale, cx * scale, sx * cy * scale, 0, cx * sy * scale, -sx * scale, cx * cy * scale, 0, tx, ty, tz, 1];
}
// 25,600 triangles is a detailed level prop or character; 1,600 is the low-detail collider tested against it.
const big = blob(160, 80, 2), small = blob(40, 20, 0.7);
const build = module => ({big: module.MeshBVH.build(big), small: module.MeshBVH.build(small)});
const a = build(baseline), b = build(candidate);
assert.deepEqual(new Uint8Array(b.big.nodes), new Uint8Array(a.big.nodes)); assert.deepEqual(b.big.index, a.big.index);

// Mesh against mesh: the small collider at 80 poses around the big surface (touching, inside, outside).
const poses = Array.from({length: 80}, (_, i) => {const u = random() * Math.PI * 2, v = random() * Math.PI, d = i % 8 === 0 ? 4 : i % 8 === 1 ? 0.2 : 1.6 + random() * 1.2; return matrix(random() * 3, random() * 3, d * Math.sin(v) * Math.cos(u), d * Math.cos(v), d * Math.sin(v) * Math.sin(u), 0.6 + random());});
const pairs = (bvh, other, m) => {const found = []; const any = bvh.intersectsBVH(other, m, (fa, fb) => {found.push(fa, fb);}); return {any, found};};
let touching = 0, pairCount = 0;
for (const pose of poses) {
  const expected = pairs(a.big, a.small, pose), actual = pairs(b.big, b.small, pose); assert.deepEqual(actual, expected); assert.equal(b.big.intersectsBVH(b.small, pose), expected.any);
  if (expected.any) touching++; pairCount += expected.found.length / 2;
}
assert.ok(touching > 20 && touching < poses.length && pairCount > 1000);
assert.deepEqual(pairs(b.small, b.small), pairs(a.small, a.small)); // identity matrix, every triangle against its neighbours
// Boxes: 2,000 oriented and 500 axis-aligned boxes scattered through and around the surface (trigger volumes, selection boxes).
const boxes = Array.from({length: 2500}, (_, i) => {
  const c = [random() * 5 - 2.5, random() * 5 - 2.5, random() * 5 - 2.5], h = [0.02 + random() * 0.3, 0.02 + random() * 0.3, 0.02 + random() * 0.3];
  return i < 2000 ? [{min: h.map(v => -v), max: h}, matrix(random() * 3, random() * 3, c[0], c[1], c[2])] : [{min: c.map((v, k) => v - h[k]), max: c.map((v, k) => v + h[k])}, undefined];
});
const boxHits = boxes.map(([box, m]) => a.big.intersectsBox(box, m)); assert.deepEqual(boxes.map(([box, m]) => b.big.intersectsBox(box, m)), boxHits);
assert.ok(boxHits.filter(Boolean).length > 100 && boxHits.includes(false));
// Closest points: 5,000 queries inside, on and outside the surface, some with distance limits.
const queries = Array.from({length: 5000}, (_, i) => [[random() * 6 - 3, random() * 6 - 3, random() * 6 - 3], i % 5 === 0 ? {maxDistance: 0.3} : i % 5 === 1 ? {minDistance: 0.5} : undefined]);
const closest = queries.map(([p, options]) => a.big.closestPointToPoint(p, options)); assert.deepEqual(queries.map(([p, options]) => b.big.closestPointToPoint(p, options)), closest);
assert.ok(closest.includes(null) && closest.filter(Boolean).length > 3000);
// Small fixed cases: coplanar and touching triangles, an empty box, a singular matrix, and the early-out callback.
for (const module of [baseline, candidate]) {
  const small = module.MeshBVH.build({positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 2, 2, 0], indices: [0, 1, 2, 3, 4, 5]});
  assert.equal(small.intersectsBox({min: [1, 1, 1], max: [0, 0, 0]}), false); assert.throws(() => small.intersectsBox({min: [0, 0, 0], max: [1, 1, 1]}, new Array(16).fill(0)), {name: 'RangeError', message: 'Box matrix is singular'});
  assert.throws(() => small.intersectsBVH({}), {name: 'TypeError'}); assert.throws(() => small.closestPointToPoint([0, 0, 0], {maxDistance: -1}), {name: 'RangeError'});
  assert.equal(small.intersectsBox({min: [0.25, 0.25, 0], max: [0.3, 0.3, 0]}), true); assert.equal(small.intersectsBVH(small), true);
  let calls = 0; small.intersectsBVH(small, undefined, () => {calls++; return true;}); assert.equal(calls, 1);
}

const cases = [];
cases.push({case: 'intersectsBVH, list every pair, 80 poses', pairs: pairCount, ...time(
  () => {for (const pose of poses) pairs(a.big, a.small, pose);},
  () => {for (const pose of poses) pairs(b.big, b.small, pose);})});
cases.push({case: 'intersectsBVH, first hit only, 80 poses', ...time(
  () => {for (let r = 0; r < 20; r++) for (const pose of poses) a.big.intersectsBVH(a.small, pose);},
  () => {for (let r = 0; r < 20; r++) for (const pose of poses) b.big.intersectsBVH(b.small, pose);})});
cases.push({case: 'intersectsBox, 2,500 boxes', ...time(
  () => {for (let r = 0; r < 4; r++) for (const [box, m] of boxes) a.big.intersectsBox(box, m);},
  () => {for (let r = 0; r < 4; r++) for (const [box, m] of boxes) b.big.intersectsBox(box, m);}, 30)});
cases.push({case: 'closestPointToPoint, 5,000 points', ...time(
  () => {for (const [p, options] of queries) a.big.closestPointToPoint(p, options);},
  () => {for (const [p, options] of queries) b.big.closestPointToPoint(p, options);}, 30)});
await record('bvh', ref, cases, 'triangleTriangle and triangleBox keep their vertices and edges in module scratch arrays with hoisted axis helpers; closestPointToPoint stores each child box distance on the traversal stack instead of recomputing it when the node is popped.', pin);
