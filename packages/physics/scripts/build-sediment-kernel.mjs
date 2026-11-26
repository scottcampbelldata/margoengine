import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
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

const crate = fileURLToPath(new URL('../sediment-kernel/', import.meta.url));
const slot = { name: 'sediment', slot: 9 };
const output = new URL('../src/sediment/', import.meta.url);
mkdirSync(output, { recursive: true });

const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose the plain or shared sediment build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const manifest = join(crate, 'Cargo.toml');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Sediment kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_sediment_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(slot, bytes, shared);
  if (problems.length) throw new Error('Sediment kernel placement is invalid. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  const start = globalBase(slot);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (
    !sentinel.subarray(0, start).every((value) => value === 0xd7) ||
    !sentinel.subarray(start + MODULE_WINDOW).every((value) => value === 0xd7)
  )
    throw new Error('Sediment initialization overwrote live world memory; use its reserved module slot.');
  copyFileSync(file, new URL(shared ? 'sediment-kernel-shared.wasm' : 'sediment-kernel.wasm', output));
}
