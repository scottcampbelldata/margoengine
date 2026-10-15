// Proof for @margoengine/geometry loopSubdivide: welding and corner merging use hashed numeric cells instead of a
// string per vertex, the edge table keeps counts and the first two opposite vertices instead of an array per edge, and
// neighbour rings are arrays in first-seen order instead of Sets. Smoothing sums run in the same order, so every
// output must match the baseline bit for bit.
// Run: node examples/package-benchmarks/proofs/geometry-subdivide.proof.js [ref] [pin]
// Pinned: bdb7521 against 96edc75, the commit that recorded results/geometry-subdivide.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('bdb7521', '96edc75'), {baseline, candidate} = await versions('geometry', ref, undefined, pin);
const outcome = run => {try {return run();} catch (error) {return `${error.constructor.name}: ${error.message}`;}};
const same = (label, run) => assert.deepStrictEqual(outcome(() => run(candidate)), outcome(() => run(baseline)), label);

// Inputs cover the code paths: non-indexed polyhedra (corner merging), UV seams and poles (sphere), an open grid
// (boundary rules), a torus knot (closed, high valence), a non-manifold fan (three faces on one edge), duplicate and
// degenerate triangles, and a tolerance coarse enough to weld distinct points.
const meshes = {
  icosahedron: g => g.icosahedronGeometry(1, 1),
  sphere: g => g.sphereGeometry(1, 24, 16),
  plane: g => g.planeGeometry(2, 2, 6, 6),
  knot: g => g.torusKnotGeometry(1, 0.3, 64, 8),
  box: g => g.boxGeometry(1, 1, 1, 2, 2, 2),
  fan: g => g.geometryData([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1], new Float32Array(15), new Float32Array(10), [0, 1, 2, 1, 0, 3, 0, 1, 4]),
  degenerate: g => g.geometryData([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -0], new Float32Array(12), [0, 0, 1, 0, 0, 1, 0.5, 0.5], [0, 1, 2, 0, 0, 1, 3, 1, 2, 0, 1, 2]),
};
for (const [name, mesh] of Object.entries(meshes)) for (const iterations of [1, 2, 3]) for (const tolerance of [1e-6, 0.05])
  same(`${name} x${iterations} tolerance ${tolerance}`, g => g.loopSubdivide(mesh(g), iterations, tolerance));
same('zero iterations', g => g.loopSubdivide(meshes.sphere(g), 0));
same('invalid iterations', g => g.loopSubdivide(meshes.sphere(g), NaN));

// Workloads: subdividing a modelling-scale mesh two levels, as an editor or procedural generator would.
const cases = [];
for (const [label, mesh, iterations] of [['torus knot 64x8, two levels', meshes.knot, 2], ['sphere 48x32, two levels', g => g.sphereGeometry(1, 48, 32), 2], ['icosahedron detail 2, three levels', g => g.icosahedronGeometry(1, 2), 3]]) {
  const a = mesh(baseline), b = mesh(candidate);
  cases.push({case: label, ...time(() => baseline.loopSubdivide(a, iterations), () => candidate.loopSubdivide(b, iterations), 8)});
}
await record('geometry-subdivide', ref, cases, 'loopSubdivide only; the rest of geometry is covered by geometry.proof.js against f05414a.', pin);
