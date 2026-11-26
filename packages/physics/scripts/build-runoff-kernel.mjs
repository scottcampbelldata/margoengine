import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_BASE,
  MAX_MEMORY_PAGES,
  globalBase,
  MODULE_WINDOW,
  PAGE,
  moduleProblems,
  rustFlags,
} from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../runoff-kernel/', import.meta.url));
const manifest = join(crate, 'Cargo.toml');
const slot = { name: 'runoff', slot: 6 };
const output = new URL('../src/runoff/', import.meta.url);
mkdirSync(output, { recursive: true });

const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared runoff build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Runoff kernel build failed. Check the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_runoff_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(slot, bytes, shared);
  if (problems.length) throw new Error('Runoff kernel placement is invalid. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0x75);
  const start = globalBase(slot);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (
    !sentinel.subarray(0, start).every((byte) => byte === 0x75) ||
    !sentinel.subarray(start + MODULE_WINDOW).every((byte) => byte === 0x75)
  )
    throw new Error('Runoff initialization reached another memory window. Link it with its reserved module slot.');
  const filename = shared ? 'runoff-kernel-shared.wasm' : 'runoff-kernel.wasm';
  copyFileSync(file, new URL(filename, output));
}
