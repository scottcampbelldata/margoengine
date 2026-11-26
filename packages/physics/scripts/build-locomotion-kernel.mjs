import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_BASE,
  globalBase,
  inspectModule,
  MAX_MEMORY_PAGES,
  MODULE_WINDOW,
  PAGE,
  rustFlags,
} from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../locomotion-kernel/', import.meta.url));
const slot = { name: 'locomotion', slot: 13 };
const variant = process.argv[2];
assert.ok(variant === 'plain' || variant === 'shared', 'Pass plain or shared to build the locomotion kernel.');
const shared = variant === 'shared';
const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
const result = await runWithTimeout(
  [
    'cargo',
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    join(crate, 'Cargo.toml'),
  ],
  { env: blueprintRustEnv(crate, flags), timeoutMs: 300_000 },
);
if (result.code !== 0) throw new Error('Locomotion kernel build failed. Check the pinned Rust toolchain.');

const bytes = readFileSync(join(crate, 'target/wasm32-unknown-unknown/release/margoengine_locomotion_kernel.wasm'));
const { imports, exports, active } = inspectModule(bytes);
const base = globalBase(slot);
const end = base + MODULE_WINDOW;
assert.equal(imports.length, 1);
const [memoryImport] = imports;
assert.equal(memoryImport.kind, 'memory');
assert.equal(memoryImport.module, 'env');
assert.equal(memoryImport.field, 'memory');
assert.equal(memoryImport.shared, shared);
assert.equal(memoryImport.max, MAX_MEMORY_PAGES);
assert.equal(exports.__global_base?.value, base);
assert.ok(exports.__data_end?.value >= base && exports.__data_end.value <= end);
assert.ok(exports.__stack_pointer?.mutable);
assert.ok(active.every(({ offset, length }) => offset >= base && offset + length <= end));

const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE + 1, maximum: MAX_MEMORY_PAGES, shared });
const all = new Uint8Array(memory.buffer);
all.subarray(0, base).fill(0xa7);
all.subarray(end).fill(0xa7);
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
assert.ok(all.subarray(0, base).every((byte) => byte === 0xa7));
assert.ok(all.subarray(end).every((byte) => byte === 0xa7));
assert.equal(typeof instance.exports.locomotion_prepare, 'function');
assert.equal(typeof instance.exports.locomotion_step, 'function');

const target = fileURLToPath(
  new URL('../src/locomotion/locomotion-kernel' + (shared ? '-shared' : '') + '.wasm', import.meta.url),
);
writeFileSync(target, bytes);
console.log('Locomotion ' + variant + ' Wasm: ' + bytes.length + ' B; imports world memory in slot 13.');
