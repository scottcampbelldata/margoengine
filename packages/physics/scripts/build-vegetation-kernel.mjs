import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DYNAMIC_BASE, MAX_MEMORY_PAGES, PAGE, moduleProblems, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../vegetation-kernel/', import.meta.url));
const manifest = join(crate, 'Cargo.toml');
const slot = { name: 'vegetation', slot: 3 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose the plain or shared vegetation build.');

for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 300_000 },
  );
  if (result.code !== 0) throw new Error('Vegetation kernel build failed. Check the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_vegetation_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(slot, bytes, shared);
  if (problems.length) throw new Error('Vegetation kernel placement is invalid. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const arena = new Uint8Array(memory.buffer).fill(0xa7);
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (
    typeof exports.vegetation_step !== 'function' || exports.vegetation_step.length !== 11 ||
    typeof exports.vegetation_apply !== 'function' || exports.vegetation_apply.length !== 1 ||
    typeof exports.vegetation_thread_phase !== 'function' || exports.vegetation_thread_phase.length !== 4
  )
    throw new Error('Vegetation Wasm has the wrong modal ABI. Rebuild the native vegetation assets.');
  if (!arena.every((word) => word === 0xa7))
    throw new Error('Vegetation Wasm initializes reserved arena bytes. Keep all storage in world allocations.');
  const filename = shared ? 'vegetation-kernel-shared.wasm' : 'vegetation-kernel.wasm';
  copyFileSync(file, new URL('../src/' + filename, import.meta.url));
}
