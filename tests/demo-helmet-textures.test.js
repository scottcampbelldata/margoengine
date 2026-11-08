// The demo helmets (examples/assets/flight-helmet.glb and flight-helmet-mobile.glb) keep the colours of their source,
// the Khronos FlightHelmet in examples/assets/khronos/FlightHelmet/. Their JPEG lens base colour had been composited over
// black (colour times alpha), so the goggle lenses drew near black once the transmission tint read the base colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { jpegTexture } from '../scripts/support/gltf-jpeg.mjs';

const root = new URL('../', import.meta.url),
  source = new URL('examples/assets/khronos/FlightHelmet/', root);

/** Raw RGB of an encoded image, optionally resized to exact dimensions first. */
async function rgb(input, size) {
  const image = sharp(input);
  if (size) image.resize(size.width, size.height, { fit: 'fill' });
  return image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function glbImages(path) {
  const bytes = readFileSync(new URL(path, root)),
    jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')),
    bin = 20 + jsonLength + 8;
  return doc.images.map((image, i) => {
    const view = doc.bufferViews[image.bufferView],
      texture = doc.textures.find((t) => t.source === i);
    return {
      name: texture.name,
      bytes: bytes.subarray(bin + (view.byteOffset ?? 0), bin + (view.byteOffset ?? 0) + view.byteLength),
    };
  });
}

test('a JPEG texture keeps the colour of a translucent texel instead of darkening it by its alpha', async () => {
  const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 0.25 } },
    })
      .png()
      .toBuffer(),
    { data } = await rgb(await jpegTexture(png, { maxSize: 16, quality: 90 }));
  for (let i = 0; i < data.length; i += 3) {
    assert.ok(Math.abs(data[i] - 200) <= 3, `red ${data[i]}`);
    assert.ok(Math.abs(data[i + 1] - 100) <= 3, `green ${data[i + 1]}`);
    assert.ok(Math.abs(data[i + 2] - 50) <= 3, `blue ${data[i + 2]}`);
  }
});

for (const glb of ['examples/assets/flight-helmet.glb', 'examples/assets/flight-helmet-mobile.glb'])
  test(`${glb}: every texture matches its source's colour`, async () => {
    const images = glbImages(glb);
    assert.equal(images.length, 15);
    for (const { name, bytes } of images) {
      const encoded = await rgb(bytes),
        original = await rgb(readFileSync(new URL(name, source)), encoded.info);
      // Mean of each channel over the whole map, 0 to 255. Composited over black, the lens map's red mean fell by 72
      // and 73 levels (126 to 53); resizing and JPEG move a mean by at most 1.5 (measured 2026-11-08, sharp 0.35.5).
      for (let c = 0; c < 3; c++) {
        let a = 0,
          b = 0;
        for (let i = c; i < encoded.data.length; i += 3) {
          a += encoded.data[i];
          b += original.data[i];
        }
        const pixels = encoded.data.length / 3,
          shift = Math.abs(a - b) / pixels;
        assert.ok(
          shift < 3,
          `${name} channel ${c}: mean ${(a / pixels).toFixed(1)} against ${(b / pixels).toFixed(1)}`,
        );
      }
    }
  });
