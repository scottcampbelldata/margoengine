import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { decodeJPEG } from '@margoengine/decoders/jpeg';
import { decodeImage } from '@margoengine/decoders/image';
import { decodePNG } from '@margoengine/decoders/png';

const fixture = (name) =>
  new Uint8Array(readFileSync(new URL(`../../exporters/tests/fixtures/jpeg/${name}`, import.meta.url)));
for (const name of [
  'baseline-444',
  'baseline-422',
  'baseline-420',
  'progressive-444',
  'progressive-420',
  'restart-420',
  'optimized-420',
  'rgb-adobe',
  'grey',
  'grey-progressive',
]) {
  test(`JPEG entry and image dispatch decode ${name} with the existing reference bounds`, async () => {
    const bytes = fixture(`${name}.jpg`),
      expected = decodePNG(fixture(`${name}.png`));
    const image = decodeJPEG(bytes);
    assert.deepEqual(await decodeImage(bytes), image);
    assert.deepEqual([image.width, image.height], [expected.width, expected.height]);
    const bound = name.startsWith('grey') || name === 'rgb-adobe' ? 1 : name.endsWith('444') ? 4 : 6;
    let total = 0;
    for (let i = 0; i < image.data.length; i++) {
      if (i % 4 === 3) assert.equal(image.data[i], 255);
      else {
        const delta = Math.abs(image.data[i] - expected.data[i]);
        assert.ok(delta <= bound, `${name}: channel ${i}, error ${delta}`);
        total += delta;
      }
    }
    assert.ok(total / (image.width * image.height * 3) < 1);
  });
}

test('JPEG dispatch honors pixel limits and abort before decoding', async () => {
  const bytes = fixture('progressive-420.jpg');
  await assert.rejects(decodeImage(bytes, { maxPixels: 1 }), RangeError);
  const reason = new Error('cancelled JPEG');
  await assert.rejects(decodeImage(bytes, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
  const controller = new AbortController();
  const decoding = decodeImage(bytes, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(decoding, (error) => error === reason);
});

test('JPEG runs in a Node worker without a canvas or browser image API', { timeout: 15_000 }, async () => {
  const worker = new Worker(new URL('./support/jpeg-worker.mjs', import.meta.url), {
    workerData: fixture('progressive-420.jpg'),
  });
  try {
    const image = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.deepEqual(image, decodeJPEG(fixture('progressive-420.jpg')));
  } finally {
    await worker.terminate();
  }
});
