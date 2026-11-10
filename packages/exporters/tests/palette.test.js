import test from 'node:test';
import assert from 'node:assert/strict';
import { quantizePalette, paletteTexture } from '@margoengine/exporters/palette';

test('shared palette entry keeps exact colours and its existing texture API', async () => {
  const source = { width: 3, height: 1, data: Uint8Array.of(10, 20, 30, 255, 10, 20, 30, 255, 40, 50, 60, 127) },
    result = quantizePalette(source);
  assert.deepEqual(result.palette, [0, 0, 0, 10, 20, 30]);
  assert.deepEqual([...result.indices], [1, 1, 0]);
  const texture = await paletteTexture([10, 20, 30, 255]);
  assert.equal(texture.size, 1);
  assert.equal(texture.texture.mimeType, 'image/png');
});

test('large palettes are deterministic and bounded, with validated input', () => {
  const data = new Uint8Array(1024 * 4);
  for (let i = 0; i < 1024; i++) data.set([i % 256, (i * 7) % 256, (i >> 2) % 256, 255], i * 4);
  const source = { width: 32, height: 32, data },
    a = quantizePalette(source, true),
    b = quantizePalette(source, true);
  assert.ok(a.palette.length <= 768);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.indices).size > 16, true);
  assert.throws(() => quantizePalette({ ...source, width: 1 }), RangeError);
  assert.throws(() => quantizePalette(source, 'yes'), TypeError);
});
