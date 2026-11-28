import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../hull-slamming-kernel/', import.meta.url));
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
  { env: blueprintRustEnv(crate, '-C target-feature=+simd128'), timeoutMs: 120_000 },
);
if (result.code !== 0) throw new Error('Build the hull slamming kernel with the pinned Rust toolchain.');
copyFileSync(
  join(crate, 'target/wasm32-unknown-unknown/release/margoengine_hull_slamming_kernel.wasm'),
  new URL('../src/seakeeping/hull-slamming-kernel.wasm', import.meta.url),
);
