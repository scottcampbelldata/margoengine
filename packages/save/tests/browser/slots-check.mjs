// Real proof of @margoengine/save/slots: a real WebGPU frame is taken as a thumbnail, slots are written to the browser's
// real IndexedDB and real localStorage, the page is reloaded, and a new SaveSlots lists them, loads the save and
// decodes the thumbnail with createImageBitmap. The picture must be the frame, compared with the frame itself.
// `npm run test:gpu --workspace @margoengine/save`.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const save = (title) => ({ format: 'margo-save', version: 1, meta: { title }, entities: [{ id: 'player', components: { hp: 3 } }] });
try {
  const written = await page.evaluate(async (first) => {
    const { Engine, box } = await import('/packages/core/dist/index.js'),
      { indexedDBStorage, webStorage } = await import('/packages/save/dist/index.js'),
      { SaveSlots, captureThumbnail } = await import('/packages/save/dist/slots.js');
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    canvas.style.cssText = 'width:256px;height:128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 64, exactSize: [256, 128] });
    engine.createMesh().setGeometry(box(2, 2, 2)).material.set({ color: [0.9, 0.2, 0.1] });
    Object.assign(engine.camera, { position: [0, 0, 5], target: [0, 0, 0] });
    engine.scene.background = '#103050';
    engine.render({ delta: 0 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    engine.render({ delta: 0 });
    const thumbnailing = captureThumbnail(canvas, { width: 64 }),
      frame = await createImageBitmap(canvas),
      flat = new OffscreenCanvas(64, 32).getContext('2d', { willReadFrequently: true });
    flat.drawImage(frame, 0, 0, 64, 32);
    const picture = await thumbnailing,
      slots = new SaveSlots(indexedDBStorage({ database: 'save-slots-check' }));
    await slots.save('slot-1', first, { thumbnail: picture, meta: { level: 3 }, playTime: 90 });
    for (let i = 0; i < 4; i++) await slots.autosave({ ...first, meta: { title: `auto ${i}` } });
    const web = new SaveSlots(webStorage());
    await web.save('slot-1', first, { thumbnail: picture });
    engine.dispose();
    return { type: picture.type, bytes: picture.size, pixels: [...flat.getImageData(0, 0, 64, 32).data] };
  }, save('Chapter 1'));
  await page.reload();
  const read = await page.evaluate(
    async ({ pixels }) => {
      const { indexedDBStorage, webStorage } = await import('/packages/save/dist/index.js'),
        { SaveSlots } = await import('/packages/save/dist/slots.js');
      const slots = new SaveSlots(indexedDBStorage({ database: 'save-slots-check' })),
        list = await slots.list(),
        loaded = await slots.load('slot-1'),
        blob = await slots.thumbnail('slot-1'),
        bitmap = await createImageBitmap(blob),
        flat = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
      flat.drawImage(bitmap, 0, 0);
      const data = flat.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let error = 0,
        red = 0,
        blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) error += Math.abs(data[i + c] - pixels[i + c]);
        if (data[i] > data[i + 2] + 40) red++;
        if (data[i + 2] > data[i] + 20) blue++;
      }
      const web = new SaveSlots(webStorage()),
        small = await web.thumbnail('slot-1');
      return {
        list: list.map((slot) => [slot.id, slot.title, slot.autosave]),
        meta: list.find((slot) => slot.id === 'slot-1').meta,
        title: loaded.meta.title,
        size: [bitmap.width, bitmap.height],
        type: blob.type,
        mean: error / (bitmap.width * bitmap.height * 3),
        red,
        blue,
        web: [(await web.load('slot-1')).meta.title, small.size],
      };
    },
    { pixels: written.pixels },
  );
  console.log(JSON.stringify({ ...written, pixels: undefined, ...read }));
  assert.deepEqual(errors, []);
  assert.deepEqual(read.list, [
    ['auto-0', 'auto 3', true],
    ['auto-2', 'auto 2', true],
    ['auto-1', 'auto 1', true],
    ['slot-1', 'Chapter 1', false],
  ]);
  assert.deepEqual(read.meta, { level: 3 });
  assert.equal(read.title, 'Chapter 1');
  assert.deepEqual(read.size, [64, 32]);
  assert.equal(read.type, written.type);
  assert.equal(written.type, 'image/webp');
  assert.ok(read.red > 50, `the box must show in the thumbnail, ${read.red} red pixels`);
  assert.ok(read.blue > 500, `the background must show in the thumbnail, ${read.blue} blue pixels`);
  assert.ok(read.mean < 8, `the thumbnail must be the frame, mean error ${read.mean} of 255`);
  assert.deepEqual(read.web, ['Chapter 1', written.bytes]);
} finally {
  await browser.close();
}
