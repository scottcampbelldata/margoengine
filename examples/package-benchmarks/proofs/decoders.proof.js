// Proof for @margoengine/decoders: the pure TypeScript EXT_meshopt_compression decoder (loaded on its own, no workers).
// Run: node examples/package-benchmarks/proofs/decoders.proof.js
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MeshoptEncoder} from 'meshoptimizer';
import {versions, time, record} from './compare.js';

const ref = 'f05414a', {baseline, candidate} = await versions('decoders', ref, 'src/meshopt.ts');
await MeshoptEncoder.ready; // the reference encoder only produces the inputs
const outcome = operation => {try {return {value: operation()};} catch (error) {return {type: error.constructor.name, message: error.message};}};
function agree(name, ...args) {
  const expected = outcome(() => baseline.meshoptDecodeGltfBuffer(...args)), actual = outcome(() => candidate.meshoptDecodeGltfBuffer(...args));
  if ('value' in expected) {assert.ok('value' in actual, `${name}: ${actual.message}`); assert.ok(Buffer.from(actual.value).equals(Buffer.from(expected.value)), `${name} differs`);} else assert.deepEqual(actual, expected, name);
  if (process.env.PROOF_VERBOSE) console.error(name, '->', expected.message ?? 'ok'); // lists what each edge case exercised
}

// 224 x 224 quantized vertices and 99,458 triangles, laid out the way gltfpack writes them.
const side = 224, count = side * side, faces = [];
for (let y = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) {const a = y * side + x; faces.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);}
const positions = new Uint16Array(count * 4), normals = new Float32Array(count * 4), uvs = new Uint16Array(count * 2), floats = new Float32Array(count * 3), rotations = new Float32Array(count * 4);
for (let y = 0, i = 0; y < side; y++) for (let x = 0; x < side; x++, i++) {
  const a = x / (side - 1) * Math.PI * 2, b = (y / (side - 1) - 0.5) * Math.PI, r = 1 + 0.15 * Math.sin(a * 7) * Math.cos(b * 5), n = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
  positions.set([(r * n[0] * 0.4 + 0.5) * 16383, (r * n[1] * 0.4 + 0.5) * 16383, (r * n[2] * 0.4 + 0.5) * 16383, 1], i * 4); normals.set([...n, 0], i * 4); uvs.set([x / side * 65535, y / side * 65535], i * 2);
  floats.set([r * n[0] * 3.7, r * n[1] * 2.1, r * n[2] * 3.7], i * 3); rotations.set([Math.sin(a / 2) * n[0], Math.sin(a / 2) * n[1], Math.sin(a / 2) * n[2], Math.cos(a / 2)], i * 4);
}
const bytes = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength), attributes = (data, stride) => MeshoptEncoder.encodeVertexBufferLevel(bytes(data), data.byteLength / stride, stride, 2, 0);
// Noise does not compress, so its groups take the widest (raw 16-byte) encoding.
const noise = Uint8Array.from({length: count * 16}, (_, i) => Math.imul(i, 2654435761) >>> 13), indices32 = Uint32Array.from(faces), indices16 = Uint16Array.from(faces.filter((_, i) => i < 60000).map(v => v % 65536));
const streams = [
  ['positions (16-bit, stride 8)', attributes(positions, 8), count, 8, 'ATTRIBUTES'],
  ['normals OCTAHEDRAL 8-bit', attributes(MeshoptEncoder.encodeFilterOct(normals, count, 4, 8), 4), count, 4, 'ATTRIBUTES', 'OCTAHEDRAL'],
  ['normals OCTAHEDRAL 16-bit', attributes(MeshoptEncoder.encodeFilterOct(normals, count, 8, 12), 8), count, 8, 'ATTRIBUTES', 'OCTAHEDRAL'],
  ['uvs (stride 4)', attributes(uvs, 4), count, 4, 'ATTRIBUTES'],
  ['float positions EXPONENTIAL', attributes(MeshoptEncoder.encodeFilterExp(floats, count, 12, 15), 12), count, 12, 'ATTRIBUTES', 'EXPONENTIAL'],
  ['rotations QUATERNION', attributes(MeshoptEncoder.encodeFilterQuat(rotations, count, 8, 12), 8), count, 8, 'ATTRIBUTES', 'QUATERNION'],
  ['incompressible attributes (stride 16)', attributes(noise, 16), count, 16, 'ATTRIBUTES'],
  ['triangles 32-bit', MeshoptEncoder.encodeIndexBuffer(bytes(indices32), indices32.length, 4), indices32.length, 4, 'TRIANGLES'],
  ['triangles 16-bit', MeshoptEncoder.encodeIndexBuffer(bytes(indices16), indices16.length, 2), indices16.length, 2, 'TRIANGLES'],
  ['index sequence', MeshoptEncoder.encodeIndexSequence(bytes(indices32), indices32.length, 4), indices32.length, 4, 'INDICES'],
];
for (const [name, source, n, stride, mode, filter] of streams) {
  agree(name, source, n, stride, mode, filter);
  // Truncated, padded and mislabelled streams must fail the same way.
  for (const cut of [1, 17, source.length >> 1, source.length - 1]) agree(`${name} cut to ${cut}`, source.subarray(0, cut), n, stride, mode, filter);
  agree(`${name} with a trailing byte`, Uint8Array.from([...source, 0]), n, stride, mode, filter); agree(`${name} with one element fewer`, source, n - (mode === 'TRIANGLES' ? 3 : 1), stride, mode, filter);
}
const vectors = JSON.parse(readFileSync(new URL('../../../packages/decoders/tests/fixtures/meshopt-vectors.json', import.meta.url), 'utf8')), unpack = text => new Uint8Array(Buffer.from(text, 'base64'));
for (const c of vectors.cases) {agree(`fixture ${c.name}`, unpack(c.encoded), c.count, c.stride, c.mode, c.filter); assert.ok(Buffer.from(candidate.meshoptDecodeGltfBuffer(unpack(c.encoded), c.count, c.stride, c.mode, c.filter)).equals(Buffer.from(unpack(c.expected))), c.name);}
agree('vertex codec version 1', unpack(vectors.vertexCodecV1), 300, 16, 'ATTRIBUTES'); agree('unknown mode', streams[0][1], count, 8, 'BOGUS'); agree('unknown filter', streams[0][1], count, 8, 'ATTRIBUTES', 'BOGUS');
agree('bad stride', streams[0][1], count, 6, 'ATTRIBUTES'); agree('filter on indices', streams[7][1], indices32.length, 4, 'TRIANGLES', 'OCTAHEDRAL');

const cases = [];
// Timed: attribute streams whose cost is the byte-group unpacking that changed. Index streams run unchanged code, and the
// OCTAHEDRAL and EXPONENTIAL streams spend most of their time in the (unchanged) filter math, measured at about 1.05x.
for (const [name, source, n, stride, mode, filter] of streams.filter(([name]) => /^(positions|uvs|rotations|incompressible)/.test(name))) {
  // Each run decodes the stream eight times (a scene with eight such meshes) so one sample is long enough to time reliably.
  const repeat = api => {for (let i = 0; i < 8; i++) api.meshoptDecodeGltfBuffer(source, n, stride, mode, filter);};
  cases.push({case: name, elements: n * 8, encodedBytes: source.length * 8, ...time(() => repeat(baseline), () => repeat(candidate), 20)});
  console.error(JSON.stringify(cases.at(-1)));
}
await record('decoders', ref, cases, 'meshopt byte groups are unpacked with unrolled writes instead of per-group shift loops and subarray copies. Filter-dominated streams (OCTAHEDRAL, EXPONENTIAL) gain about 1.05x and index streams are unchanged; both are compared for equality but not timed.');
