import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { rasterSourceHash, binaryHash } from './raster-source.mjs';
const record = JSON.parse(readFileSync(new URL('../src/navmesh-raster.json', import.meta.url), 'utf8'));
assert.equal(
  record.sourceHash,
  rasterSourceHash(),
  'Raster source changed; run node packages/navmesh/scripts/build-raster.mjs',
);
assert.equal(
  record.wasmHash,
  binaryHash(readFileSync(new URL('../src/navmesh-raster.wasm', import.meta.url))),
  'Raster artifact changed; rebuild the kernel',
);
copyFileSync(
  new URL('../src/navmesh-raster.wasm', import.meta.url),
  new URL('../dist/navmesh-raster.wasm', import.meta.url),
);
