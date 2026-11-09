// CPU correctness only. Recreate the unresampled 2048x2048 standard DEM from pinned tiles.
// Run through a process supervisor with a 20-minute hard limit.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { decodePNG } from '../../../tests/support/png.js';
import { createErosionKernel } from '../dist/erosion-wasm.js';

const manifest = JSON.parse(await readFile(new URL('./fixtures/erosion-dem.json', import.meta.url))),
  directory = resolve('test-results/skip-gaps/erosion-dem'),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(directory, { recursive: true });
const height = new Int32Array(manifest.nx * manifest.nz);
for (const tile of manifest.tiles) {
  const path = resolve(directory, `${tile.x}-${tile.y}.png`);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await fetch(tile.url, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `${response.status}: ${tile.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  assert.equal(hash(bytes), tile.sha256, tile.url);
  const image = await decodePNG(bytes);
  assert.equal(image.width, 256);
  assert.equal(image.height, 256);
  for (let z = 0; z < 256; z++)
    for (let x = 0; x < 256; x++) {
      const at = (z * 256 + x) * 4;
      height[((tile.y - 2880) * 256 + z) * manifest.nx + (tile.x - 1320) * 256 + x] = Math.round(
        (image.data[at] * 256 + image.data[at + 1] + image.data[at + 2] / 256 - 32768) * 1000,
      );
    }
}
assert.equal(hash(new Uint8Array(height.buffer)), manifest.gridSha256);
using kernel = await createErosionKernel();
const result = kernel.erode({ height, nx: manifest.nx, nz: manifest.nz, step: manifest.expected.step });
for (const [field, expected] of Object.entries(manifest.expected.hashes)) {
  assert.equal(hash(new Uint8Array(result[field].buffer)), expected, field);
}
assert.equal(result.outflow, manifest.expected.outflow);
assert.equal(result.vectorBlocks, height.length / 4);
const report = {
  cells: height.length,
  iterations: 32,
  exactReferenceHashes: true,
  memoryBytes: result.memoryBytes,
  vectorBlocks: result.vectorBlocks,
  inputBytes: height.byteLength,
  outputBytes: height.length * 17,
  totalBackingInputOutputBytes: result.memoryBytes + height.byteLength + height.length * 17,
  eliminatedKernelArrayBytes: height.length * 10,
  timingMeasured: false,
};
await writeFile(resolve(directory, 'integrated-result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
