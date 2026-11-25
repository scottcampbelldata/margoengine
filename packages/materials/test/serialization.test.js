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

// A drawable source is captured as decoded rows (top row first) and restored as raw rows, which a Texture keeps at
// v = 0. The default flipY upload had put the image's top row at v = 1, so a restored bitmap came back upside down;
// and an image element was read at its layout width and height, not its natural pixel size.
test('a captured drawable texture restores with its flipY orientation and natural size', async () => {
  const top = [255, 0, 0, 255],
    bottom = [0, 0, 255, 255],
    sizes = [];
  globalThis.ImageBitmap = class {
    width = 1;
    height = 2;
  };
  globalThis.HTMLImageElement = class {
    width = 1;
    height = 1;
    naturalWidth = 1;
    naturalHeight = 2;
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      sizes.push([w, h]);
    }
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray([...top, ...bottom]) }),
      };
    }
  };
  try {
    const flipped = new Texture(new ImageBitmap()),
      kept = new Texture(new ImageBitmap(), { flipY: false }),
      element = new Texture(new HTMLImageElement());
    const archive = await captureMaterialLibrary({
      a: new Material({ map: flipped }),
      b: new Material({ map: kept }),
      c: new Material({ map: element }),
    });
    const restored = await restoreMaterialLibrary(JSON.parse(JSON.stringify(archive)));
    assert.deepEqual([...restored.a.map.source.data], [...bottom, ...top]);
    assert.deepEqual([...restored.b.map.source.data], [...top, ...bottom]);
    assert.deepEqual([...restored.c.map.source.data], [...bottom, ...top]);
    assert.deepEqual(sizes, [
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
  } finally {
    delete globalThis.ImageBitmap;
    delete globalThis.HTMLImageElement;
    delete globalThis.OffscreenCanvas;
  }
});

test('a material file cannot raise the texture download caps; only the caller of the restore sets them', async () => {
  const map = new Texture({ data: new Uint8Array(16), width: 2, height: 2, format: 'rgba8unorm' });
  const archive = JSON.parse(
    JSON.stringify(
      await captureMaterialLibrary(
        { material: new Material({ map }) },
        { textureURL: () => 'https://assets.test/a.png' },
      ),
    ),
  );
  const row = archive.objects.find((o) => o.type === 'texture');
  assert.ok(row, 'the archive holds one URL texture');
  row.data.options = { ...row.data.options, maxPixels: 1e12, maxBytes: 1e12 };
  const fetchBefore = globalThis.fetch,
    bitmapBefore = globalThis.createImageBitmap;
  let size = [8192, 4096];
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  globalThis.createImageBitmap = async () => ({ width: size[0], height: size[1], close() {} });
  try {
    await assert.rejects(
      restoreMaterialLibrary(archive),
      /size limit/,
      'the file asked for 1e12 pixels; the default holds',
    );
    await assert.rejects(restoreMaterialLibrary(archive, { limits: { maxBytes: 2 } }), /Texture download/);
    size = [4, 4];
    await assert.rejects(restoreMaterialLibrary(archive, { limits: { maxPixels: 8 } }), /size limit/);
    assert.ok((await restoreMaterialLibrary(archive)).material, 'a small image still restores');
    size = [8192, 4096];
    const raised = await restoreMaterialLibrary(archive, { limits: { maxPixels: 8192 * 4096 } });
    assert.ok(raised.material, 'the caller raises the cap');
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.createImageBitmap = bitmapBefore;
  }
});
