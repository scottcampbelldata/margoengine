import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture } from '../dist/index.js';
import { captureMaterialLibrary, restoreMaterialLibrary } from '../dist/serialization.js';
import { hair } from '../dist/hair.js';
import { skin } from '../dist/skin.js';
import { stochasticTiling } from '../dist/stochastic.js';
import { objectNormal } from '../dist/object-normal.js';
test('owner codecs cover all fixed feature constants and exact non-finite typed texel bits', async () => {
  const bytes = new Uint32Array([0x7fc00001, 0x80000000, 0x3f800000, 0x3f800000]);
  const map = new Texture(
    { data: new Float32Array(bytes.buffer), width: 1, height: 1, format: 'rgba32float' },
    { colorSpace: 'linear', mipmaps: false },
  );
  const material = new Material({
    map,
    features: [
      hair({ width: 0.2 }),
      skin({ unitsPerMeter: 2 }),
      objectNormal({ up: 'z' }),
      stochasticTiling({ maps: ['map'] }),
    ],
  });
  const archive = await captureMaterialLibrary({ material });
  const restored = await restoreMaterialLibrary(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual(new Uint32Array(restored.material.map.source.data.buffer), bytes);
  assert.deepEqual(
    restored.material.features.map((f) => f.serialization()),
    material.features.map((f) => f.serialization()),
  );
});

test('different typed views retain their shared backing buffer and byte offsets', async () => {
  const buffer = new ArrayBuffer(16),
    bytes = new Uint8Array(buffer),
    first = new Uint8Array(buffer, 0, 4),
    second = new Uint8Array(buffer, 4, 4);
  bytes.set([1, 2, 3, 255, 4, 5, 6, 255]);
  const a = new Texture({ data: first, width: 1, height: 1 }),
    b = new Texture({ data: second, width: 1, height: 1 });
  const restored = await restoreMaterialLibrary(
    JSON.parse(
      JSON.stringify(await captureMaterialLibrary({ a: new Material({ map: a }), b: new Material({ map: b }) })),
    ),
  );
  const x = restored.a.map.source.data,
    y = restored.b.map.source.data;
  assert.equal(x.buffer, y.buffer);
  assert.equal(y.byteOffset, 4);
  assert.deepEqual(new Uint8Array(x.buffer), bytes);
});
