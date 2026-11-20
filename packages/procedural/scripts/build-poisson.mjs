import assert from 'node:assert/strict';
import { runBuild } from './run-build.mjs';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--test')) {
  await runBuild('cargo', ['test', '--locked', '--manifest-path', root + 'poisson-kernel/Cargo.toml']);
} else {
  await runBuild(
    'cargo',
    [
      'build',
      '--locked',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      root + 'poisson-kernel/Cargo.toml',
    ],
    blueprintRustEnv(root + 'poisson-kernel', '-C target-feature=+simd128'),
  );
  const path = root + 'poisson-kernel/target/wasm32-unknown-unknown/release/margo_procedural_poisson.wasm';
  assert.ok(WebAssembly.validate(readFileSync(path)));
  copyFileSync(path, root + 'src/poisson.wasm');
}
