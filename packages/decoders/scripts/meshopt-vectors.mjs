// Builds the KHR_meshopt_compression vectors (vertex codec v1, COLOR filter) with the repository's own test encoder
// (tests/support/meshopt-encode.js). Expected bytes come from the inputs, not from any decoder: the original data for the
// lossless case, and the quantised colour integers rescaled as the COLOR filter specifies for the colour cases. The run
// then checks the built decoder (dist/meshopt.js) against them.
// Run: node packages/decoders/scripts/meshopt-vectors.mjs          (check only)
//      node packages/decoders/scripts/meshopt-vectors.mjs --write  (also replace those cases in
//      tests/fixtures/meshopt-vectors.json; tests/fixtures/meshopt-views.json records their sizes and hashes, so
//      update it to match)
// The committed cases were recorded earlier and encode the same values; color8Raw (out-of-range YCoCg, whose decoding
// the specification leaves open) is kept as recorded.
import { readFile, writeFile } from 'node:fs/promises';
import { meshoptDecodeGltfBuffer } from '../dist/meshopt.js';
import { colorFilter, encodeAttributes, quantizeColor } from '../tests/support/meshopt-encode.js';

const file = new URL('../tests/fixtures/meshopt-vectors.json', import.meta.url),
  vectors = JSON.parse(await readFile(file, 'utf8'));
let seed = 5;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const b64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const vector = (name, encoded, expected, count, stride, filter) => ({
  name,
  count,
  stride,
  mode: 'ATTRIBUTES',
  filter,
  encoded: b64(encoded),
  expected: b64(expected),
});

// COLOR output for quantised integers: each K-bit value (alpha widened by one bit, repeating its low bit) times
// UINTN_MAX / (2^K - 1) in 32-bit float, rounded.
function colorCase(name, count, stride, bits, version) {
  const colors = Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 3 ? ((i >> 2) % 3) / 2 : random())),
    filtered = colorFilter(colors, count, stride, bits),
    expected = stride === 4 ? new Uint8Array(count * 4) : new Uint16Array(count * 4),
    scale = Math.fround((stride === 4 ? 255 : 65535) / ((1 << bits) - 1));
  for (let i = 0; i < count; i++) {
    const [r, g, b, a] = quantizeColor(...colors.subarray(i * 4, i * 4 + 4), bits);
    [r, g, b, (a << 1) | (a & 1)].forEach((v, k) => (expected[i * 4 + k] = Math.round(Math.fround(v * scale))));
  }
  const encoded = encodeAttributes(filtered, count, stride, { version });
  return vector(name, encoded, new Uint8Array(expected.buffer), count, stride, 'COLOR');
}

const smooth = Uint8Array.from({ length: 300 * 16 }, (_, i) => (i >> 4) * ((i & 15) + 1) + ((random() * 4) | 0));
const built = [
  vector('attributesV1', encodeAttributes(smooth, 300, 16, { version: 1 }), smooth, 300, 16, 'NONE'),
  colorCase('color4V1', 400, 4, 7, 1),
  colorCase('color8', 400, 8, 12, 0),
];
// The lossless case must match exactly. The specification allows COLOR output one unit off its formula, so a colour
// case within one unit passes the check, but only an exact match can be written: the tests compare bytes.
let failed = 0,
  exact = true;
for (const c of built) {
  const decoded = meshoptDecodeGltfBuffer(Buffer.from(c.encoded, 'base64'), c.count, c.stride, c.mode, c.filter),
    expected = Buffer.from(c.expected, 'base64'),
    wide = c.filter === 'COLOR' && c.stride === 8,
    read = (bytes, i) => (wide ? bytes[2 * i] | (bytes[2 * i + 1] << 8) : bytes[i]);
  let worst = 0,
    off = 0;
  for (let i = 0; i < decoded.length / (wide ? 2 : 1); i++) {
    const d = Math.abs(read(decoded, i) - read(expected, i));
    if (d) off++;
    worst = Math.max(worst, d);
  }
  if (off) exact = false;
  if (worst > (c.filter === 'NONE' ? 0 : 1)) failed++;
  console.log(
    `${c.name}: ${Buffer.from(c.encoded, 'base64').length} encoded bytes, ${off} values differ from the inputs (most ${worst})`,
  );
}
if (failed) process.exitCode = 1;
else if (process.argv.includes('--write') && !exact) {
  console.log('not written: the decoder rounds some colours one unit differently from the formula');
  process.exitCode = 1;
} else if (process.argv.includes('--write')) {
  vectors.cases = vectors.cases.map((c) => built.find((b) => b.name === c.name) ?? c);
  for (const b of built) if (!vectors.cases.includes(b)) vectors.cases.push(b);
  vectors.generator =
    'EXT cases: meshoptimizer 1.1.1; KHR cases: scripts/meshopt-vectors.mjs (repository test encoder)';
  await writeFile(file, JSON.stringify(vectors));
  console.log(`wrote ${vectors.cases.map((c) => c.name).join(', ')}`);
}
