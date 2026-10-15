// Proof for @margoengine/exporters: number formatting, world-space baking and the per-format writers.
// Run: node examples/package-benchmarks/proofs/exporters.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/exporters.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('exporters', ref, undefined, pin);
// Number formatting is shared by every text format, so check it alone first through OBJ `v` lines under an identity
// transform: both neighbours of every power of ten and two, subnormals, integers, and two million random Float32 bit patterns.
const bits = new Uint32Array(1), float = new Float32Array(bits.buffer), samples = [0, -0, 0.1, 1 / 3, Math.PI, 1e-45, -1e-45, 3.4028234663852886e38, 16777216, 16777217, 0.5, 100, 1e9, 123456789];
for (let e = -45; e <= 38; e++) for (const base of [10 ** e, 2 ** Math.round(e * 3.3219)]) {float[0] = base; const at = bits[0]; for (let d = -3; d <= 3; d++) {bits[0] = at + d; if (Number.isFinite(float[0])) samples.push(float[0], -float[0]);}}
for (let i = 0, seed = 81733; i < 2_000_000; i++) {seed = Math.imul(seed, 1664525) + 1013904223 | 0; bits[0] = seed; if (Number.isFinite(float[0])) samples.push(float[0]);}
for (let i = 0; i < 200_000; i++) samples.push(Math.sin(i * 1.37) * 10 ** (i % 13 - 6), i % 4096, i / 64);
while (samples.length % 9) samples.push(0);
const numbers = {nodes: [{geometry: {positions: Float32Array.from(samples), normals: Float32Array.from(samples, (_, i) => +(i % 3 === 2))}}]};
assert.ok(candidate.exportOBJ(numbers).obj === baseline.exportOBJ(numbers).obj, 'number formatting differs');


// One 224 x 224 grid is 50,176 vertices and 99,458 triangles: a typical detailed single prop or scanned part.
function grid(side, extras) {
  const count = side * side, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2), indices = new Uint32Array((side - 1) * (side - 1) * 6);
  for (let y = 0, i = 0; y < side; y++) for (let x = 0; x < side; x++, i++) {
    const u = x / (side - 1), v = y / (side - 1), a = u * Math.PI * 2, b = (v - 0.5) * Math.PI, r = 1 + 0.15 * Math.sin(a * 7) * Math.cos(b * 5);
    positions.set([r * Math.cos(b) * Math.cos(a) * 3.7, r * Math.sin(b) * 2.1, r * Math.cos(b) * Math.sin(a) * 3.7], i * 3);
    // Every 97th normal is zero so the area-weighted fallback runs; the rest are deliberately not unit length.
    normals.set(i % 97 === 0 ? [0, 0, 0] : [Math.cos(b) * Math.cos(a) * 2, Math.sin(b) * 2, Math.cos(b) * Math.sin(a) * 2], i * 3);
    uvs.set([u, v], i * 2);
  }
  for (let y = 0, k = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) {const a = y * side + x; indices.set([a, a + 1, a + side, a + 1, a + side + 1, a + side], k); k += 6;}
  const out = {positions, normals, uvs, indices};
  if (extras) {
    out.tangents = Float32Array.from({length: count * 4}, (_, i) => i % 4 === 3 ? (i % 8 === 3 ? -2 : 0.5) : Math.sin(i * 0.7) + 1.5);
    out.colors = Float32Array.from({length: count * 3}, (_, i) => (Math.sin(i * 0.31) + 1) / 2);
  }
  return out;
}
const plain = grid(224, false), rich = grid(224, true), small = grid(12, false);
const material = {name: 'Painted steel', color: [0.8, 0.25, 0.1, 0.6], roughness: 0.4, metalness: 0.9, emissive: [0.1, 0.05, 0], alphaMode: 'BLEND', doubleSided: true};
// A rotated, non-uniformly scaled parent with a mirrored child (flipped winding) and a hidden node (skipped).
const hierarchy = geometry => ({nodes: [{name: 'Hull plate #1', translation: [1.3, -0.2, 0.7], rotation: [0.2, -0.1, 0.3, 0.9], scale: [1.5, 0.75, 2], geometry, material, children: [
  {name: 'Mirror', scale: [-1, 2, 0.5], translation: [0, 4, 0], geometry: small}, {name: 'Hidden', visible: false, geometry: small}]}, {geometry: small, rotation: [0, 0.7071068, 0, 0.7071068]}]});
const plainScene = hierarchy(plain), richScene = hierarchy(rich);
// Shear (rotation under non-uniform scale) makes flatten bake vertices, normals and tangents.
const sheared = {nodes: [{scale: [1, 3, 1], children: [{rotation: [0.3, 0.2, 0.1, 0.9], scale: [-1, 1, 1], geometry: rich}]}]};

const formats = [
  ['STL binary', api => api.exportSTL(plainScene)],
  ['STL ASCII', api => api.exportSTL(plainScene, {binary: false, name: 'hull plate'})],
  ['OBJ with UVs and MTL', api => {const {obj, mtl} = api.exportOBJ(plainScene, {materials: true}); return obj + '\0' + mtl;}],
  ['OBJ with vertex colors', api => api.exportOBJ(richScene, {colors: true}).obj],
  ['PLY ASCII', api => api.exportPLY(plainScene)],
  ['PLY ASCII with colors', api => api.exportPLY(richScene, {colors: true})],
  ['PLY binary with colors', api => api.exportPLY(richScene, {binary: true, colors: true})],
  ['PLY binary', api => api.exportPLY(plainScene, {binary: true})],
  ['GLB with tangents and colors (unchanged path, compared only)', api => api.exportGLB(richScene)],
  ['GLB flattened with baked shear (unchanged path, compared only)', api => api.exportGLB(sheared, {flatten: true})],
  ['glTF JSON with embedded base64', api => api.exportGLTF(richScene).text],
  ['glTF JSON with separate bin (unchanged path, compared only)', api => {const out = api.exportGLTF(plainScene, {embed: false}); return out.text + '\0' + Buffer.from(out.bin).toString('latin1');}],
  ['USDZ', api => api.exportUSDZ(plainScene)],
];
const cases = [];
for (const [name, run] of formats) {
  const expected = run(baseline), actual = run(candidate);
  if (typeof expected === 'string') assert.ok(actual === expected, `${name} text differs`);
  else assert.ok(Buffer.compare(actual, expected) === 0, `${name} bytes differ`);
  if (name.includes('unchanged')) continue;
  // Slow text formats get fewer rounds so the whole proof finishes in a few minutes.
  const start = performance.now(); run(baseline); const rounds = performance.now() - start > 400 ? 3 : 12;
  cases.push({case: name, triangles: 99458, bytes: expected.length, ...time(() => run(baseline), () => run(candidate), rounds)});
  console.error(JSON.stringify(cases.at(-1)));
}
// Base64 padding: small buffers whose byte lengths cover every remainder of three (the 16-byte image shifts it by one).
const remainders = new Set(), image = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8);
for (let n = 2; n < 10; n++) for (const textured of [false, true]) {
  const tiny = {nodes: [{geometry: grid(n, n % 2 === 0), ...(textured ? {material: {baseColorTexture: {image, mimeType: 'image/png'}}} : {})}]}, expected = baseline.exportGLTF(tiny);
  assert.ok(candidate.exportGLTF(tiny).text === expected.text, `embedded glTF of a ${n} x ${n} grid differs`); remainders.add(expected.json.buffers[0].byteLength % 3);
}
assert.equal(remainders.size, 3);
// Validation and unsupported-feature errors keep their type and message.
const outcome = operation => {try {operation(); return null;} catch (error) {return {type: error.constructor.name, message: error.message};}};
for (const bad of [api => api.exportUSDZ({nodes: []}), api => api.exportUSDZ(richScene), api => api.exportUSDZ({nodes: [{geometry: small, material: {alphaMode: 'MASK'}}]}),
  api => api.exportSTL({nodes: [{geometry: {...small, positions: Float32Array.from(small.positions, (v, i) => i === 4 ? NaN : v)}}]}),
  api => api.exportGLB({nodes: [{geometry: {...small, tangents: new Float32Array(small.positions.length / 3 * 4)}}]}),
  api => api.exportGLB({nodes: [{geometry: {...small, colors: new Float32Array(small.positions.length).fill(2)}}]}),
  api => api.exportOBJ({nodes: [{geometry: small, scale: [0, 1, 1]}]}), api => api.exportPLY({nodes: [{geometry: {...small, indices: [0, 1, 99999]}}]})]) {
  const expected = outcome(() => bad(baseline)); assert.ok(expected); assert.deepEqual(outcome(() => bad(candidate)), expected);
}
await record('exporters', ref, cases, 'num() finds the shortest Float32 decimal with exact integer arithmetic (string search kept as the fallback); writers stream values instead of building per-vertex arrays; base64 encodes bytes; USDZ CRC uses a table.', pin);
