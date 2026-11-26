import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DYNAMIC_BASE, MAX_MEMORY_PAGES, PAGE, moduleProblems, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../thermal-kernel/', import.meta.url));
const manifest = join(crate, 'Cargo.toml');
const slot = { name: 'thermal', slot: 2 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose the plain or shared thermal build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 300_000 },
  );
  if (result.code !== 0) throw new Error('Thermal kernel build failed. Check the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_thermal_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(slot, bytes, shared);
  if (problems.length) throw new Error('Thermal kernel placement is invalid. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xa7);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (!sentinel.every((value) => value === 0xa7))
    throw new Error('The thermal kernel initializes arena bytes. Keep mutable data in regions allocated by the host.');
  const filename = shared ? 'thermal-kernel-shared.wasm' : 'thermal-kernel.wasm';
  copyFileSync(file, new URL('../src/thermal/' + filename, import.meta.url));
}
