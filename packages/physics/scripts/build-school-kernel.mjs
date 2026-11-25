import { copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../school-kernel/', import.meta.url));
const common = resolve(crate, '../kernel-common');
const flags = [
  '-C target-feature=+simd128',
  // Import the stack pointer as well as memory so each instance can use its own arena lease.
  '-C relocation-model=pic',
  '-C link-arg=--shared',
  '-C link-arg=--import-memory',
  '-C link-arg=-zstack-size=0',
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
if (result.code !== 0) throw new Error('School kernel build failed; check the pinned Rust toolchain.');

const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_school_kernel.wasm');
const module = new WebAssembly.Module(readFileSync(file));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536 });
const all = new Uint8Array(memory.buffer);
all.fill(0xa7);
let next = 64 * 1024;
const instance = new WebAssembly.Instance(module, {
  env: {
    memory,
    __memory_base: 4096,
    __table_base: 0,
    __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 32768),
    school_alloc: (size, alignment) => {
      const offset = Math.ceil(next / alignment) * alignment;
      next = offset + size;
      return next <= 131072 ? offset : 0;
    },
  },
});
instance.exports.__wasm_apply_data_relocs?.();
if (!all.subarray(0, 4096).every((value) => value === 0xa7) || !all.subarray(8192).every((value) => value === 0xa7))
  throw new Error('School kernel wrote outside its 4096-byte static data lease during instantiation.');
const body = new Float64Array(memory.buffer, 49152, 12);
body.set([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]);
new Float64Array(memory.buffer, 50304, 8).fill(0);
const status = instance.exports.school_intent(49152, 2, 50304, 50000, 0, 50112, 0.25, 2, 3, -1, 1, 2, 1);
const output = new Float64Array(memory.buffer, 50112, 6);
if (status !== 0 || output[2] !== 1 || output[3] !== 1 || all[0] !== 0xa7)
  throw new Error('School kernel did not run in its arena lease; check its shared memory ABI and stack.');
copyFileSync(file, new URL('../src/schooling/school-kernel.wasm', import.meta.url));
