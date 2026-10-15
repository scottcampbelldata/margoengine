// Adds the KHR_meshopt_compression vectors (vertex codec v1, COLOR filter) to tests/fixtures/meshopt-vectors.json, encoded
// and decoded by meshoptimizer's own encoder and Wasm decoder (installed with the repository's dev dependencies).
// Run: node packages/decoders/scripts/meshopt-vectors.mjs
import {readFile, writeFile} from 'node:fs/promises';
import {MeshoptDecoder} from 'meshoptimizer/decoder';
import {MeshoptEncoder} from 'meshoptimizer/encoder';

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const file = new URL('../tests/fixtures/meshopt-vectors.json', import.meta.url), vectors = JSON.parse(await readFile(file, 'utf8'));
let seed = 5; const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const b64 = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
function vector(name, data, count, stride, filter, version) {
  const encoded = MeshoptEncoder.encodeVertexBufferLevel(data, count, stride, 2, version), expected = new Uint8Array(count * stride);
  MeshoptDecoder.decodeVertexBuffer(expected, count, stride, encoded, filter === 'NONE' ? undefined : filter);
  return {name, count, stride, mode: 'ATTRIBUTES', filter, encoded: b64(encoded), expected: b64(expected)};
}
const colors = (count, stride, bits) => MeshoptEncoder.encodeFilterColor(Float32Array.from({length: count * 4}, (_, i) => i % 4 === 3 ? (i >> 2) % 3 / 2 : random()), count, stride, bits);
const smooth = Uint8Array.from({length: 300 * 16}, (_, i) => (i >> 4) * ((i & 15) + 1) + (random() * 4 | 0));
const added = [
  vector('attributesV1', smooth, 300, 16, 'NONE', 1),
  vector('color4V1', colors(400, 4, 7), 400, 4, 'COLOR', 1),
  vector('color8', colors(400, 8, 12), 400, 8, 'COLOR', 0),
  // Out-of-range YCoCg: the reference's float bit pattern, not a clamp.
  vector('color8Raw', Uint8Array.from({length: 200 * 8}, () => random() * 256), 200, 8, 'COLOR', 0),
];
vectors.generator = 'meshoptimizer 1.1.1 reference encoder and decoder (KHR cases: scripts/meshopt-vectors.mjs)';
vectors.cases = [...vectors.cases.filter(c => !added.some(a => a.name === c.name)), ...added];
delete vectors.vertexCodecV1;
await writeFile(file, JSON.stringify(vectors));
console.log(vectors.cases.map(c => c.name).join(', '));
