// Shared by the KTX2 tests: the real Basis module and a check of decoded images against the hashes KTX-Software gave.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initBasis } from '../../dist/codec.js';

// Emscripten detects Node and reaches for CommonJS `require` while initializing.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('../', import.meta.url));

const dist = new URL('../../dist/', import.meta.url).href,
  folder = new URL('../fixtures/ktx2-layers/', import.meta.url),
  records = JSON.parse(await readFile(new URL('records.json', folder), 'utf8')).files;

export const fixture = async (name) => new Uint8Array(await readFile(new URL(name, folder)));
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Node's fetch has no file: scheme, and initBasis fetches the Wasm.
const networkFetch = globalThis.fetch;
globalThis.fetch = async (url, init) =>
  String(url).startsWith('file:') ? new Response(await readFile(new URL(url))) : networkFetch(url, init);

export const basis = async () =>
  (
    await initBasis(dist + 'basis/basis_transcoder.js', dist + 'basis/basis_transcoder.wasm', async (url) => {
      (0, eval)(await readFile(new URL(url), 'utf8'));
    })
  ).module;

// `ktx extract` names an image only by the axes the file has.
function imageName(levels, layers, faces, level, layer, face) {
  const parts = [];
  if (levels > 1) parts.push(`level${level}`);
  if (faces > 1) parts.push(`face${face}`);
  if (layers > 0) parts.push(`layer${layer}`);
  return parts.join('_') || 'image';
}

/** Every image of a decoded file hashes as the real tool extracted it, and none the tool wrote is left unchecked. */
export function assertImages(file, name, arrayLayers, faces) {
  const expected = records[name];
  let checked = 0;
  file.mipmaps.forEach((mip, level) => {
    const size = mip.byteLength / file.layers;
    for (let layer = 0; layer < Math.max(1, arrayLayers); layer++)
      for (let face = 0; face < faces; face++) {
        const at = (layer * faces + face) * size,
          key = imageName(file.mipmaps.length, arrayLayers, faces, level, layer, face);
        assert.ok(expected[key], `${name} has a record for ${key}`);
        assert.equal(sha(mip.data.subarray(at, at + size)), expected[key], `${name} ${key}`);
        checked++;
      }
  });
  assert.equal(checked, Object.keys(expected).length, `${name}: every image the real tool wrote was checked`);
}
