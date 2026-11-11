import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// KB4824a: a fresh process decoding one real 19,860-byte glTF Draco primitive peaked up to 5.7 MB above the opaque
// prebuilt. The excess was the engine's optimizing compiler (V8 TurboFan) compiling the clean-room decoder's hot
// functions, which held every predictor, traversal and setup path in a few 5 to 12 KB bodies. Hot loops now run in
// small functions of their own. The engine prints each optimizing compile's peak and total working bytes, a
// deterministic byte count for one engine version, Wasm and input (no clocks).
const wasm = fileURLToPath(new URL('../dist/draco-native.wasm', import.meta.url));
const input = fileURLToPath(new URL('../native/draco/tests/fixtures/car-concept-body.drc', import.meta.url));
const child = `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [wasm, input] = process.argv.slice(1);
const { instance: { exports: m } } = await WebAssembly.instantiate(readFileSync(wasm));
const bytes = readFileSync(input), at = m.draco_alloc(bytes.length);
new Uint8Array(m.memory.buffer, at, bytes.length).set(bytes);
const out = m.draco_decode(at, bytes.length, 16777216, 134217728, 268435456, 0);
const size = new DataView(m.memory.buffer).getUint32(out, true);
console.log('output ' + createHash('sha256').update(new Uint8Array(m.memory.buffer, out, size)).digest('hex'));
`;

test('optional Draco hot loops stay small: optimizing-compiler peak bytes on a real glTF primitive (KB4824a)', () => {
  const run = spawnSync(
    process.execPath,
    ['--trace-wasm-compilation-times', '--input-type=module', '-e', child, wasm, input],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  assert.equal(run.status, 0, run.stderr);
  // Same output bytes as before the restructure, which the resource campaign also matched to the opaque decoder.
  assert.match(run.stdout, /^output 1e49b28a1aaeb03deb3bac702ab6db131094e98837a45ed38125e3efafeb05cf$/m);
  const compiles = [...run.stdout.matchAll(/using TurboFan, .* and (\d+) \/ (\d+) max\/total bytes; bodysize (\d+)/g)];
  assert.ok(compiles.length > 0, 'the decode must run long enough to reach the optimizing tier, or nothing is measured');
  const peak = compiles.reduce((sum, m) => sum + Number(m[1]), 0);
  // Node 26.12: 7,683,216 B before (six compiles, bodies up to 12,171 B), 3,241,160 B after. The opaque prebuilt
  // needs 1,626,064 B but starts 1.6 to 1.7 MB higher (16 MiB initial linear memory against 1.4 MiB), so 3,300,000 B
  // is where the native process peak stays at or below the prebuilt's. Re-measure with node
  // --trace-wasm-compilation-times on an engine update; never raise this to pass (docs/limits.md, KB4824a).
  assert.ok(peak <= 3_300_000, `optimizing-compiler peak ${peak} B over 3,300,000 B: keep hot loops in small functions`);
});
