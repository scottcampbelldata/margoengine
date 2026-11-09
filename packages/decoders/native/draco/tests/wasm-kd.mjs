import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/margoengine_draco.wasm', import.meta.url));
const { instance: { exports: m } } = await WebAssembly.instantiate(wasm);
const data = readFileSync(new URL('./fixtures/kd.bin', import.meta.url));
let at = 0;
const num = () => { const n = data.readUInt32LE(at); at += 4; return n; };
const blob = () => { const n = num(), b = data.subarray(at, at + n); at += n; return b; };
function decode(input, bounded = false) {
  const p = m.draco_alloc(input.length);
  assert.ok(p);
  let out = 0, n = 0;
  try {
    new Uint8Array(m.memory.buffer, p, input.length).set(input);
    out = m.draco_decode(p, input.length, bounded ? 8192 : 16777216, bounded ? 24576 : 134217728, bounded ? 2097152 : 268435456);
    assert.ok(out);
    n = new DataView(m.memory.buffer).getUint32(out, true);
    return Buffer.from(new Uint8Array(m.memory.buffer, out, n));
  } finally {
    if (out) m.draco_free(out, n);
    m.draco_free(p, input.length);
  }
}
const selected = ['kd-buffers-level0-raw-n3-bits4', 'kd-buffers-level2-ans-n3-bits4', 'kd-buffers-level6-ans33-n3-bits4', 'kd-transform-order-floats-first'];
const count = num(), seeds = [];
let prefixes = 0;
assert.equal(count, 369);
for (let i = 0; i < count; i++) {
  const name = blob().toString(), input = blob(), expected = blob();
  assert.deepEqual(decode(input), expected, name);
  if (selected.includes(name)) seeds.push(input);
  if (selected.includes(name) || name.endsWith('pc_kd_color.drc')) {
    for (let end = 1; end < input.length; end++) {
      assert.ok(decode(input.subarray(0, end)).readUInt32LE(4) > 0, `${name}: prefix ${end}`);
      prefixes++;
    }
  }
}
assert.equal(at, data.length);
assert.equal(seeds.length, 4);
let random = 0xe613ab25;
for (let i = 0; i < 4096; i++) {
  const input = Buffer.from(seeds[i % seeds.length]);
  for (let j = 0; j < 1 + i % 7; j++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    input[(random >>> 0) % input.length] ^= random >>> 24;
  }
  assert.deepEqual(decode(input, true), decode(input, true), `mutation ${i}`);
}
const memory = m.memory.buffer.byteLength;
for (let i = 0; i < 2000; i++) decode(seeds[i % seeds.length]);
assert.equal(m.memory.buffer.byteLength, memory);
console.log(JSON.stringify({ exactCases: count, truncatedPrefixes: prefixes, mutations: 4096, repeatedDecodeFree: 2000, peakWasmLinearBytes: memory }));
