import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectModule, MAX_MEMORY_PAGES, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../wave-transport-kernel/', import.meta.url));
const variant = process.argv[2];
if (variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared wave transport kernel.');
const shared = variant === 'shared';
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
if (result.code !== 0)
  throw new Error('Build the wave transport kernel with the pinned Rust toolchain and wasm32 target.');
const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_wave_transport_kernel.wasm');
const bytes = readFileSync(file);
const memory = new WebAssembly.Memory({ initial: 2, maximum: MAX_MEMORY_PAGES, shared });
const sentinel = new Uint8Array(memory.buffer).fill(0x4d);
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
if (
  inspectModule(bytes).active.length ||
  !sentinel.every((value) => value === 0x4d) ||
  typeof exports.wave_transport_thread_phase !== 'function'
)
  throw new Error('Build the stateless wave transport kernel with its native flux phase.');
const fileName = shared ? 'wave-transport-kernel-shared.wasm' : 'wave-transport-kernel.wasm';
copyFileSync(file, new URL('../src/waves/' + fileName, import.meta.url));
