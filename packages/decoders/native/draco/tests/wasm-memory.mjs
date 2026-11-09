// Run after building the release wasm32-unknown-unknown crate.
// The fixture order and ceiling come from the whole-corpus prebuilt measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wasm = process.argv[2] ?? new URL('../target/wasm32-unknown-unknown/release/margoengine_draco.wasm', import.meta.url);
const { instance: { exports: m } } = await WebAssembly.instantiate(readFileSync(wasm));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/memory.json', import.meta.url)));
for (let round = 0; round < 3; round++) {
  for (const fixture of fixtures) {
    const input = readFileSync(new URL('./fixtures/' + fixture.file, import.meta.url));
    assert.equal(hash(input), fixture.inputSha256);
    const ptr = m.draco_alloc(input.length);
    assert.ok(ptr);
    let out = 0, length = 0;
    try {
      new Uint8Array(m.memory.buffer, ptr, input.length).set(input);
      out = m.draco_decode(ptr, input.length, 16777216, 134217728, 268435456);
      assert.ok(out);
      length = new DataView(m.memory.buffer).getUint32(out, true);
      assert.equal(hash(new Uint8Array(m.memory.buffer, out, length)), fixture.outputSha256, fixture.file);
      assert.ok(m.memory.buffer.byteLength <= 20185088, `peak ${m.memory.buffer.byteLength} exceeds prebuilt 20185088`);
    } finally {
      if (out) m.draco_free(out, length);
      m.draco_free(ptr, input.length);
    }
  }
}
console.log(JSON.stringify({ fixtures: fixtures.length, rounds: 3, peakWasmLinearBytes: m.memory.buffer.byteLength }));
