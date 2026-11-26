import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleProblems, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';
import { WASM_TARGET, wasmBuildArgs } from '../../../scripts/support/wasm-kernel.mjs';

const crate = fileURLToPath(new URL('../falling-kernel/', import.meta.url));
const manifest = join(crate, 'Cargo.toml');
const slot = { name: 'falling', slot: 7 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Pass plain or shared to build one falling bodies kernel.');

for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(slot, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const result = await runWithTimeout(['cargo', ...wasmBuildArgs(manifest)], {
    env: blueprintRustEnv(crate, flags),
    timeoutMs: 120_000,
  });
  if (result.code !== 0) throw new Error('Falling bodies kernel failed to build. Check the pinned Rust toolchain.');
  const file = join(crate, 'target', WASM_TARGET, 'release', 'margoengine_falling_kernel.wasm');
  const problems = moduleProblems(slot, readFileSync(file), shared);
  if (problems.length) throw new Error('Falling bodies kernel placement is invalid. ' + problems.join('. '));
  const filename = shared ? 'falling-kernel-shared.wasm' : 'falling-kernel.wasm';
  copyFileSync(file, new URL('../src/falling/' + filename, import.meta.url));
}
