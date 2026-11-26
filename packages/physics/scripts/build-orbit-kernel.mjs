import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_BASE,
  globalBase,
  MAX_MEMORY_PAGES,
  MODULE_WINDOW,
  moduleProblems,
  PAGE,
  rustFlags,
} from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../orbit-kernel/', import.meta.url));
const slot = { name: 'orbit', slot: 8 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared orbit build.');

for (const shared of variant ? [variant === 'shared'] : [false, true]) {
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
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Orbit kernel build failed. Check the pinned Rust toolchain.');
  const path = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_orbit_kernel.wasm');
  const bytes = readFileSync(path);
  const problems = moduleProblems(slot, bytes, shared);
  if (problems.length)
    throw new Error('Orbit kernel layout is invalid. Rebuild its reserved module slot. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0x75);
  const start = globalBase(slot);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (
    !sentinel.subarray(0, start).every((byte) => byte === 0x75) ||
    !sentinel.subarray(start + MODULE_WINDOW).every((byte) => byte === 0x75)
  )
    throw new Error('Orbit initialization changed other memory windows. Link it into its reserved slot.');
  const output = shared ? 'orbit-kernel-shared.wasm' : 'orbit-kernel.wasm';
  copyFileSync(path, new URL('../src/orbit/' + output, import.meta.url));
}
