import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { rasterSourceHash, binaryHash } from './raster-source.mjs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
execFileSync(
  'cargo',
  [
    'build',
    '--locked',
    '--manifest-path',
    resolve(root, 'native/raster/Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ],
  {
    stdio: 'inherit',
    timeout: 180000,
    env: {
      ...process.env,
      RUSTFLAGS: '-C target-feature=+simd128',
      CARGO_TARGET_DIR: resolve(root, 'native/raster/target'),
    },
  },
);
copyFileSync(
  resolve(root, 'native/raster/target/wasm32-unknown-unknown/release/margoengine_navmesh_raster.wasm'),
  resolve(root, 'src/navmesh-raster.wasm'),
);
writeFileSync(
  resolve(root, 'src/navmesh-raster.json'),
  JSON.stringify(
    { sourceHash: rasterSourceHash(), wasmHash: binaryHash(readFileSync(resolve(root, 'src/navmesh-raster.wasm'))) },
    null,
    2,
  ) + '\n',
);
