// KB0035: the Draco encoder's input ceiling comes from its measured peak memory, and a 10M-triangle scan with float
// normals and UVs (280 MB packed) fits under it. Before, a 243 MB positions-only mesh passed the 256 MiB check and
// then trapped (`unreachable`) when the encoder's memory reached 4 GiB, at about 20.8 bytes per input byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DRACO_ENCODER_INPUT_LIMIT, encodeNativeMesh, loadNativeEncoder } from '../dist/draco-native-encode.js';

const wasm = new URL('../dist/draco-native-encoder.wasm', import.meta.url).href;
/** A side x side height-field grid, positions only: the most encoder memory per input byte measured. */
function grid(side) {
  const points = side * side,
    position = new Float32Array(points * 3),
    indices = new Uint32Array((side - 1) * (side - 1) * 6);
  for (let y = 0, v = 0; y < side; y++)
    for (let x = 0; x < side; x++, v++)
      position.set([x * 0.01, (Math.sin(x * 0.031) * Math.cos(y * 0.027) * 4 + Math.sin(x * 0.4 + y * 0.3) * 0.2) * 0.01, y * 0.01], v * 3);
  for (let y = 0, i = 0; y < side - 1; y++)
    for (let x = 0; x < side - 1; x++, i += 6) {
      const a = y * side + x;
      indices.set([a, a + side, a + 1, a + 1, a + side, a + side + 1], i);
    }
  const attributes = [{ semantic: 'POSITION', kind: 'POSITION', values: position, width: 3, normalized: false, bits: 14 }];
  return { points, indices, attributes, encodeSpeed: 5, decodeSpeed: 5 };
}

test('the input ceiling times the measured peak per input byte fits 90% of the encoder\'s 4 GiB', { timeout: 120000 }, async () => {
  const encoder = await loadNativeEncoder(wasm),
    job = grid(708), // 999,698 triangles, 18,011,568 B packed
    input = 16 + job.indices.byteLength + 8 + job.attributes[0].values.byteLength;
  encodeNativeMesh(encoder, job);
  const perInput = encoder.memory.buffer.byteLength / input;
  // 12.7 measured here (12.9 at 16M triangles, 3.78 GB at the ceiling); 20.8 before.
  assert.ok(perInput < 13, `peak ${perInput.toFixed(2)} bytes per input byte`);
  assert.ok(
    DRACO_ENCODER_INPUT_LIMIT * 13 <= 0.9 * 2 ** 32,
    `${DRACO_ENCODER_INPUT_LIMIT} B at 13 bytes per input byte passes 90% of 4 GiB`,
  );
});

test('a 10M-triangle scan with float normals and UVs passes the ceiling; one byte over it is refused', () => {
  // 5,004,169 points and 9,999,392 triangles: 16 + 119,992,704 + 3 x 8 + 60,050,028 x 2 + 40,033,352 = 280,126,152 B.
  const job = (extra) => ({
    points: 5004169,
    indices: { byteLength: 119992704 },
    attributes: [60050028, 60050028, 40033352 + extra].map((byteLength) => ({ values: { byteLength } })),
    encodeSpeed: 5,
    decodeSpeed: 5,
  });
  const asked = [],
    module = { encoder_alloc: (length) => (asked.push(length), 0) };
  assert.throws(() => encodeNativeMesh(module, job(0)), /could not allocate its input/);
  assert.deepEqual(asked, [280126152]);
  const over = DRACO_ENCODER_INPUT_LIMIT - 280126152 + 1;
  assert.throws(() => encodeNativeMesh(module, job(over)), /exceeds 280 MiB/);
  assert.equal(asked.length, 1);
});

test('the encoder frees the packet it read: the wrapper does not, and memory stays bounded', async () => {
  const encoder = await loadNativeEncoder(wasm),
    freed = [],
    counted = { ...encoder, memory: encoder.memory, encoder_free: (p, n) => (freed.push(n), encoder.encoder_free(p, n)) };
  for (const name of Object.keys(encoder)) if (typeof encoder[name] === 'function' && name !== 'encoder_free') counted[name] = encoder[name];
  const job = grid(40);
  for (let i = 0; i < 10; i++) encodeNativeMesh(counted, job);
  const memory = encoder.memory.buffer.byteLength;
  for (let i = 0; i < 100; i++) encodeNativeMesh(counted, job);
  assert.deepEqual(freed, []);
  assert.equal(encoder.memory.buffer.byteLength, memory);
});
