import assert from 'node:assert/strict';
import { runBuild } from './run-build.mjs';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--test')) {
  await runBuild('cargo', ['test', '--locked', '--manifest-path', root + 'poisson-kernel/Cargo.toml']);
  process.exit(0);
}
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
  { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
);
const path = root + 'poisson-kernel/target/wasm32-unknown-unknown/release/margo_procedural_poisson.wasm';
assert.ok(WebAssembly.validate(readFileSync(path)));
copyFileSync(path, root + 'src/poisson.wasm');
