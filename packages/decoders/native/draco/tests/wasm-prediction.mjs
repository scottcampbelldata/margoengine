import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/margoengine_draco.wasm', import.meta.url));
const { instance: { exports: m } } = await WebAssembly.instantiate(wasm);
const data = readFileSync(new URL('./fixtures/multi.bin', import.meta.url));
let at = 0;
const num = () => { const n = data.readUInt32LE(at); at += 4; return n; };
const blob = () => { const n = num(), b = data.subarray(at, at + n); at += n; return b; };
function decode(input) {
  const p = m.draco_alloc(input.length);
  assert.ok(p);
  let out = 0, n = 0;
  try {
    new Uint8Array(m.memory.buffer, p, input.length).set(input);
    out = m.draco_decode(p, input.length, 8192, 24576, 2097152);
    assert.ok(out);
    n = new DataView(m.memory.buffer).getUint32(out, true);
    const result = Buffer.from(new Uint8Array(m.memory.buffer, out, n));
    assert.ok(result.readUInt32LE(4) <= 6, 'uncoded error');
    return result;
  } finally {
    if (out) m.draco_free(out, n);
    m.draco_free(p, input.length);
  }
}
const count = num(), seeds = [];
let prefixes = 0;
assert.equal(count, 289);
for (let i = 0; i < count; i++) {
  const name = blob().toString(), input = blob(), expected = blob();
  assert.deepEqual(decode(input), expected, name);
  for (let end = 1; end < input.length; end++) {
    assert.ok(decode(input.subarray(0, end)).readUInt32LE(4) > 0, `${name}: prefix ${end}`);
    prefixes++;
  }
  if (i % 41 === 0) seeds.push(input);
}
assert.equal(at, data.length);
let random = 0x3318a7d9;
for (let i = 0; i < 16384; i++) {
  const input = Buffer.from(seeds[i % seeds.length]);
  for (let j = 0; j < 1 + i % 7; j++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    input[(random >>> 0) % input.length] ^= random >>> 24;
  }
  assert.deepEqual(decode(input), decode(input), `mutation ${i}`);
}
const memory = m.memory.buffer.byteLength;
for (let i = 0; i < 2000; i++) decode(seeds[i % seeds.length]);
assert.equal(m.memory.buffer.byteLength, memory);
console.log(JSON.stringify({ exactCases: count, truncatedPrefixes: prefixes, mutations: 16384, repeatedDecodeFree: 2000, peakWasmLinearBytes: memory }));
