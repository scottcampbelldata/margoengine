// Correctness only: the same integer inputs run through native scalar and actual Wasm SIMD code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import binaryen from 'binaryen';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const target = resolve(root, 'test-results/batch203-avif/transform-probe');
await mkdir(target, { recursive: true });
const source = resolve(root, 'packages/decoders/scripts/avif-transform-probe.rs');
const common = [source, '--edition=2024', '-O', '--crate-name', 'avif_transform_probe'];
const native = resolve(target, process.platform === 'win32' ? 'scalar.exe' : 'scalar');
execFileSync('rustc', [...common, '-o', native], { timeout: 90_000, windowsHide: true, stdio: 'inherit' });
const expected = execFileSync(native, [], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
const wasmPath = resolve(target, 'simd.wasm');
execFileSync(
  'rustc',
  [
    ...common,
    '--target',
    'wasm32-unknown-unknown',
    '--crate-type',
    'cdylib',
    '-C',
    'target-feature=+simd128',
    '-o',
    wasmPath,
  ],
  { timeout: 90_000, windowsHide: true, stdio: 'inherit' },
);
const bytes = await readFile(wasmPath);
const module = binaryen.readBinary(bytes);
const text = module.emitText();
assert.match(text, /i32x4\.min_s/);
assert.match(text, /i32x4\.max_s/);
assert.match(text, /i32x4\.shr_s/);
module.dispose();
const { instance } = await WebAssembly.instantiate(bytes, {});
const { memory, probe_alloc, probe, probe_free } = instance.exports;
const pointer = probe_alloc();
const widths = [4, 8, 16, 32, 64, 4, 8, 8, 16, 16, 32, 32, 64, 4, 16, 8, 32, 16, 64];
const heights = [4, 8, 16, 32, 64, 8, 4, 16, 8, 32, 16, 64, 32, 16, 4, 32, 8, 64, 16];
let offset = 0;
let cases = 0;
for (let size = 0; size < 19; size++) {
  const width = widths[size];
  const count = width * heights[size];
  for (let tx = 0; tx < 16; tx++) {
    for (const depth of [8, 10, 12]) {
      const input = new Int32Array(memory.buffer, pointer, count);
      for (let i = 0; i < count; i++)
        input[i] = ((i * 17 + Math.floor(i / width) * 29 + 11 * size + tx * 7) % 1009) - 504;
      const length = probe(pointer, size, tx, depth, 0);
      assert.equal(length, expected.readUInt32LE(offset), `${size}/${tx}/${depth} result`);
      offset += 4;
      if (length) {
        const actual = new Int32Array(memory.buffer, pointer, length);
        for (let i = 0; i < length; i++)
          assert.equal(actual[i], expected.readInt32LE(offset + i * 4), `${size}/${tx}/${depth} coefficient ${i}`);
        offset += length * 4;
      }
      cases++;
    }
  }
}
probe_free(pointer);
assert.equal(offset, expected.length);
console.log(`AV1 inverse transforms: ${cases} native/Wasm contracts match exactly; SIMD add/shift/min/max verified.`);
