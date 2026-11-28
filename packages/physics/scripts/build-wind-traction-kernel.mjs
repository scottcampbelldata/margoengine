import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalBase, inspectModule, moduleProblems, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../wind-traction-kernel/', import.meta.url));
const linker = { name: 'wind-traction', slot: -1 };
const variant = process.argv[2];
if (variant !== 'plain' && variant !== 'shared') throw new Error('Choose the plain or shared wind traction build.');
const shared = variant === 'shared';
const flags = rustFlags(linker, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
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
if (result.code !== 0) throw new Error('Build wind traction with the pinned Rust toolchain and wasm32 target.');
const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_wind_traction_kernel.wasm');
const bytes = readFileSync(file);
const problems = moduleProblems(linker, bytes, shared);
const { active, exports } = inspectModule(bytes);
if (active.length || exports.__data_end?.value !== globalBase(linker))
  problems.push('The wind traction module must use the caller’s private memory for all data.');
if (problems.length)
  throw new Error(
    'Invalid wind traction Wasm placement. Rebuild using the stateless linker flags. ' + problems.join('. '),
  );
const name = shared ? 'wind-traction-kernel-shared.wasm' : 'wind-traction-kernel.wasm';
copyFileSync(file, new URL('../src/aero/' + name, import.meta.url));
