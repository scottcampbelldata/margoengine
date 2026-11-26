import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const crate = fileURLToPath(new URL('../school-kernel/', import.meta.url));
const common = resolve(crate, '../kernel-common');
const slot = { name: 'school', slot: 4 };
const variant = process.argv[2];
if (variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared school build.');
const shared = variant === 'shared';
const flags = [
  rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,'),
  '--remap-path-prefix=' + common + '=physics/kernel-common',
  '--remap-path-prefix=' + join(common, 'src/neighbours.rs') + '=physics/kernel-common/src/neighbours.rs',
].join(' ');
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
if (result.code !== 0) throw new Error('School kernel build failed. Check the pinned Rust toolchain.');
const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_school_kernel.wasm');
const bytes = readFileSync(file);
const { imports, exports, active } = inspectModule(bytes);
const base = globalBase(slot);
const end = base + MODULE_WINDOW;
// The second import supplies a bounded slice of world scratch to the shared neighbour grid.
assert.equal(imports.length, 2);
assert.deepEqual(
  imports.find((entry) => entry.kind === 'function'),
  {
    module: 'env',
    field: 'school_alloc',
    kind: 'function',
  },
);
const memoryImport = imports.find((entry) => entry.kind === 'memory');
assert.equal(memoryImport.module, 'env');
assert.equal(memoryImport.field, 'memory');
assert.equal(memoryImport.shared, shared);
assert.equal(memoryImport.max, MAX_MEMORY_PAGES);
assert.equal(exports.__global_base?.value, base);
assert.ok(exports.__data_end?.value >= base && exports.__data_end.value <= end);
assert.ok(exports.__stack_pointer?.mutable);
assert.ok(active.every(({ offset, length }) => offset >= base && offset + length <= end));

const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE + 2, maximum: MAX_MEMORY_PAGES, shared });
const all = new Uint8Array(memory.buffer);
all.subarray(0, base).fill(0xa7);
all.subarray(end).fill(0xa7);
let next = DYNAMIC_BASE + PAGE;
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  env: {
    memory,
    school_alloc: (size, alignment) => {
      const offset = Math.ceil(next / alignment) * alignment;
      next = offset + size;
      return next <= all.length ? offset : 0;
    },
  },
});
assert.ok(all.subarray(0, base).every((value) => value === 0xa7));
assert.ok(all.subarray(end).every((value) => value === 0xa7));
instance.exports.__stack_pointer.value = DYNAMIC_BASE + PAGE - 512;
const body = new Float64Array(memory.buffer, DYNAMIC_BASE, 12);
body.set([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]);
new Float64Array(memory.buffer, DYNAMIC_BASE + 256, 8).fill(0);
const status = instance.exports.school_intent(
  DYNAMIC_BASE,
  2,
  DYNAMIC_BASE + 256,
  DYNAMIC_BASE + 128,
  0,
  DYNAMIC_BASE + 384,
  0.25,
  2,
  3,
  -1,
  1,
  2,
  1,
);
const output = new Float64Array(memory.buffer, DYNAMIC_BASE + 384, 6);
assert.equal(status, 0);
assert.equal(output[2], 1);
assert.equal(output[3], 1);
assert.ok(all.subarray(0, base).every((value) => value === 0xa7));
assert.ok(all.subarray(end, DYNAMIC_BASE).every((value) => value === 0xa7));
const name = shared ? 'school-kernel-shared.wasm' : 'school-kernel.wasm';
copyFileSync(file, new URL('../src/schooling/' + name, import.meta.url));
