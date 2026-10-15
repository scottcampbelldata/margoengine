// Proof for @margoengine/gltf: the flat-normal expansion of primitives without NORMAL.
// Run: node examples/package-benchmarks/proofs/gltf.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/gltf.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {Engine, TransformStore, meshRuntime} from '@margoengine/core/extension';
import {refs, versions, time, record} from './compare.js';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('gltf', ref, undefined, pin);
// A real engine and transform store with a no-op renderer, so parseGLTF runs end to end without a GPU.
const engine = new Engine({width: 256, height: 256, clientWidth: 256, clientHeight: 256}, await TransformStore.create(64), {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}});
const bytesOf = view => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const outcome = operation => {try {return {value: operation()};} catch (error) {return {type: error.constructor.name, message: error.message};}};
/** Parses, returns every mesh's vertex and index arrays, and disposes the model again. */
const load = (api, input, buffers) => {const model = api.parseGLTF(engine, input, buffers); try {return model.meshes.flatMap(mesh => {const geometry = meshRuntime(mesh).geometry; return [geometry.vertices, geometry.indices];});} finally {model.dispose();}};
function agree(name, input, buffers) {
  const expected = outcome(() => load(baseline, input, buffers)), actual = outcome(() => load(candidate, input, buffers));
  if ('value' in expected) {
    assert.ok('value' in actual, `${name}: ${actual.message}`); assert.equal(actual.value.length, expected.value.length, name);
    expected.value.forEach((view, i) => assert.ok(bytesOf(actual.value[i]).equals(bytesOf(view)), `${name}: array ${i} differs`));
  } else assert.deepEqual(actual, expected, name);
  if (process.env.PROOF_VERBOSE) console.error(name, '->', expected.message ?? 'ok'); // lists what each edge case exercised
}

// 224 x 224 vertices and 99,458 triangles: one detailed static prop.
const side = 224, count = side * side, P = new Float32Array(count * 3), N = new Float32Array(count * 3), faces = [];
for (let y = 0, i = 0; y < side; y++) for (let x = 0; x < side; x++, i++) {
  const a = x / (side - 1) * Math.PI * 2, b = (y / (side - 1) - 0.5) * Math.PI, r = 1 + 0.15 * Math.sin(a * 7) * Math.cos(b * 5);
  P.set([r * Math.cos(b) * Math.cos(a) * 3.7, r * Math.sin(b) * 2.1, r * Math.cos(b) * Math.sin(a) * 3.7], i * 3); N.set([Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)], i * 3);
}
for (let y = 0; y < side - 1; y++) for (let x = 0; x < side - 1; x++) {const a = y * side + x; faces.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);}
/** A GLB with one mesh. `stride` interleaves position and normal; `Index` picks the index type (or none). */
function glb({normals = true, stride = false, Index = Uint32Array, vertices = count, indexList = faces} = {}) {
  const positions = P.subarray(0, vertices * 3), parts = [], views = [], accessors = [], attributes = {};
  const push = (data, extra = {}) => {const offset = parts.reduce((sum, part) => sum + part.length, 0), bytes = Buffer.alloc(Math.ceil(data.byteLength / 4) * 4); bytesOf(data).copy(bytes); parts.push(bytes); views.push({buffer: 0, byteOffset: offset, byteLength: data.byteLength, ...extra}); return views.length - 1;};
  if (stride) {
    const mixed = new Float32Array(vertices * 8); for (let i = 0; i < vertices; i++) {mixed.set(positions.subarray(i * 3, i * 3 + 3), i * 8); mixed.set(N.subarray(i * 3, i * 3 + 3), i * 8 + 4);}
    const view = push(mixed, {byteStride: 32}); accessors.push({bufferView: view, componentType: 5126, count: vertices, type: 'VEC3'}, {bufferView: view, byteOffset: 16, componentType: 5126, count: vertices, type: 'VEC3'});
    attributes.POSITION = 0; attributes.NORMAL = 1;
  } else {
    attributes.POSITION = accessors.push({bufferView: push(positions), componentType: 5126, count: vertices, type: 'VEC3'}) - 1;
    if (normals) attributes.NORMAL = accessors.push({bufferView: push(N.subarray(0, vertices * 3)), componentType: 5126, count: vertices, type: 'VEC3'}) - 1;
  }
  const primitive = {attributes};
  if (Index) primitive.indices = accessors.push({bufferView: push(Index.from(indexList)), componentType: {1: 5121, 2: 5123, 4: 5125}[Index.BYTES_PER_ELEMENT], count: indexList.length, type: 'SCALAR'}) - 1;
  const bin = Buffer.concat(parts), doc = {asset: {version: '2.0'}, buffers: [{byteLength: bin.length}], bufferViews: views, accessors, meshes: [{primitives: [primitive]}], nodes: [{name: 'Prop', mesh: 0, scale: [2, 2, 2]}], scenes: [{nodes: [0]}]};
  let json = Buffer.from(JSON.stringify(doc)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const out = Buffer.alloc(28 + json.length + bin.length); out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20); out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004e4942, 24 + json.length); bin.copy(out, 28 + json.length);
  return {glb: new Uint8Array(out), doc, bin: new Uint8Array(bin)};
}
const smooth = glb(), flat = glb({normals: false}), interleaved = glb({stride: true}), small = [0, 1, 2, 2, 1, 3, 250, 251, 252];
for (const [name, file] of [['indexed with normals', smooth], ['flat normals from indices', flat], ['interleaved', interleaved], ['16-bit indices', glb({vertices: 50000, indexList: faces.filter((_, i) => i < 9000).map(v => v % 50000), Index: Uint16Array})],
  ['8-bit indices', glb({vertices: 256, indexList: small, Index: Uint8Array})], ['8-bit indices, flat', glb({vertices: 256, indexList: small, Index: Uint8Array, normals: false})], ['non-indexed', glb({vertices: 9000, Index: null})],
  ['non-indexed, flat', glb({vertices: 9000, Index: null, normals: false})], ['flat with an index past the vertices', glb({vertices: 300, indexList: [0, 1, 2, 3, 4, 300], normals: false})], ['incomplete triangle', glb({vertices: 300, indexList: [0, 1, 2, 3]})],
  ['degenerate flat triangle', glb({vertices: 300, indexList: [5, 5, 5, 0, 1, 2], normals: false})]])
  agree(name, file.glb);
// The same document as an object with a supplied buffer, and one accessor that runs past its view.
agree('document with supplied buffer', smooth.doc, [smooth.bin]);
const past = structuredClone(flat.doc); past.accessors[0].count += 1; agree('accessor past its view', past, [flat.bin]);

const cases = [], mesh = {vertices: count, triangles: faces.length / 3};
const add = (name, file) => {cases.push({case: name, ...mesh, ...time(() => load(baseline, file.glb), () => load(candidate, file.glb), 40)}); console.error(JSON.stringify(cases.at(-1)));};
add('GLB without normals (flat normals computed)', flat);
// Files that carry normals take the unchanged accessor path; they are compared above and not timed.
engine.dispose();
await record('gltf', ref, cases, 'Flat normals are expanded with indexed writes instead of a subarray and an array per triangle.', pin);
