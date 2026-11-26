import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectModule, MAX_MEMORY_PAGES, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../forest-kernel/', import.meta.url));
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared forest build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  // A zero static base is safe only for a data-free module. The release hook verifies both variants.
  const flags = rustFlags({ slot: -1 }, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
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
  if (result.code !== 0) throw new Error('Forest kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_forest_kernel.wasm');
  const bytes = readFileSync(file);
  const variant = shared ? 'forest-kernel-shared.wasm' : 'forest-kernel.wasm';
  const runtime = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  new WebAssembly.Instance(runtime, { env: { memory } });
  const inspected = inspectModule(bytes);
  if (inspected.active.length || !sentinel.every((v) => v === 0xd7))
    throw new Error(
      `${variant} must be data-free so it can share the world without a static window: ${JSON.stringify(inspected)}`,
    );
  copyFileSync(file, new URL(`../src/${variant}`, import.meta.url));
}
