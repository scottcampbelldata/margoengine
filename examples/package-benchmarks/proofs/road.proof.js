// Proof for @margoengine/road: the sweep writes each vertex, normal, UV and index straight into its typed array
// instead of building a temporary array literal per attribute.
// Run: node examples/package-benchmarks/proofs/road.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/road.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('road', ref, undefined, pin);
// Both sides sweep the same Spline (the candidate's), so only the road package differs.
const {Spline} = (await versions('splines', ref, undefined, pin)).candidate;
const outcome = (module, curve, options) => {
  try {const {geometry, uvs, section} = module.road(curve, options); return {vertices: geometry.vertices, indices: geometry.indices, bounds: geometry.bounds, uvs, section};}
  catch (error) {return `${error.constructor.name}: ${error.message}`;}
};
const demo = new Spline([[-2, 0, -8], [2, 0.2, -3], [-2, 0.3, 3], [2, 0, 8]], {divisions: 256});
const loop = new Spline(Array.from({length: 24}, (_, i) => [Math.cos(i / 24 * Math.PI * 2) * 60, Math.sin(i * 0.9) * 3, Math.sin(i / 24 * Math.PI * 2) * 40]), {closed: true, divisions: 2048});
const lane = [[-4, 0], [-3.5, 0.2], [-3.4, 0.02], [0, 0.08], [3.4, 0.02], [3.5, 0.2], [4, 0]];
// Defaults, the demo's options, a custom cross-section, and the rejections covered by packages/road/test.
for (const [curve, options] of [
  [new Spline([[0, 0, 0], [0, 0, 20]]), {segments: 4, uvMeters: 5}], [demo, undefined], [demo, {width: 2.4, curbWidth: 0.3, curbHeight: 0.35, segments: 128, uvMeters: 2}],
  [loop, {segments: 1024}], [loop, {segments: 513, crossSection: lane}], [demo, {segments: 1, crossSection: [[-1, 0], [1, 0]]}],
  [new Spline([[0, 0, 0], [0, 1, 0]]), undefined], [new Spline([[0, 0, 0], [0, 0, 2]]), {segments: 0}], [demo, {crossSection: [[0, 0], [0, 0]]}], [demo, {crossSection: [[0, 0]]}], [demo, {width: -1}],
]) assert.deepEqual(outcome(candidate, curve, options), outcome(baseline, curve, options));

const cases = [];
for (const [name, curve, options, sweeps] of [
  // The package demo re-sweeps this road every frame (examples/package-benchmarks/road.js, largest preset): one second at 60 FPS.
  ['demo road, 128 segments, resweep x 60', demo, {width: 2.4, curbWidth: 0.3, curbHeight: 0.35, segments: 128, uvMeters: 2}, 60],
  // A circuit-length road built once at load: 1,024 segments of the default curbed section, and a seven-point custom section.
  ['circuit, 1024 segments, default section x 10', loop, {segments: 1024}, 10],
  ['circuit, 1024 segments, custom section x 10', loop, {segments: 1024, crossSection: lane}, 10],
]) cases.push({case: name, vertices: (options.segments + 1) * ((options.crossSection ?? {length: 8}).length - 1) * 2, ...time(
  () => {for (let i = 0; i < sweeps; i++) baseline.road(curve, options);}, () => {for (let i = 0; i < sweeps; i++) candidate.road(curve, options);})});
await record('road', ref, cases, 'Timings include the spline arc-length queries and core Geometry construction that road() performs; vertices, indices, bounds and UVs are bit-identical.', pin);
