// Every full-precision independent reference runs through actual Wasm SIMD decoding, not just scalar Rust.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const folder = resolve(root, 'packages/decoders/native/avif/tests/fixtures');
const target = resolve(root, 'test-results/batch203-avif/wasm-pixels');
await mkdir(target, { recursive: true });
const wasm = resolve(target, 'probe.wasm');
execFileSync(
  'rustc',
  [
    resolve(root, 'packages/decoders/scripts/avif-decode-probe.rs'),
    '--edition=2024',
    '-O',
    '--target',
    'wasm32-unknown-unknown',
    '--crate-type',
    'cdylib',
    '-C',
    'target-feature=+simd128',
    '-o',
    wasm,
  ],
  { timeout: 120000, windowsHide: true, stdio: 'inherit' },
);
const { instance } = await WebAssembly.instantiate(await readFile(wasm));
const module = instance.exports;
let samples = 0;
const references = JSON.parse(await readFile(resolve(folder, 'pixel-references.json'), 'utf8'));
for (const reference of references) {
  const bytes = await readFile(resolve(folder, reference.file));
  const input = module.probe_alloc(bytes.length);
  let output = 0,
    length = 0;
  try {
    new Uint8Array(module.memory.buffer, input, bytes.length).set(bytes);
    output = module.probe_run(input, bytes.length);
    const view = new DataView(module.memory.buffer);
    length = view.getUint32(output, true);
    assert.equal(view.getUint32(output + 4, true), 0, reference.file);
    const pixels = new Uint8Array(module.memory.buffer, output + 8, length - 8);
    assert.equal(createHash('sha256').update(pixels).digest('hex'), reference.decodedSha256, reference.file);
    samples += reference.samples;
  } finally {
    module.probe_free(input, bytes.length);
    if (output) module.probe_free(output, length);
  }
}
assert.equal(samples, 14_828_077);
console.log(`${references.length} actual Wasm SIMD frames match ${samples} independent YUV samples exactly`);
