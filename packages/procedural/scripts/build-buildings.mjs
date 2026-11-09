import assert from 'node:assert/strict';
import { runBuild } from './run-build.mjs';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--test')) {
  await runBuild('cargo', ['test', '--locked', '--manifest-path', root + 'buildings-kernel/Cargo.toml']);
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
      root + 'buildings-kernel/Cargo.toml',
    ],
    { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
  );
  const artifact = root + 'buildings-kernel/target/wasm32-unknown-unknown/release/margo_procedural_buildings.wasm';
  assert.ok(WebAssembly.validate(readFileSync(artifact)));
  copyFileSync(artifact, root + 'src/buildings.wasm');
}
