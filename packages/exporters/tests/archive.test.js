// Capture archives: stored ZIPs read back by an independent reader, full-frame sprite atlases, PNG-sequence and atlas
// ZIPs with manifest hooks, progress and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAtlasZIP,
  encodeSequenceZIP,
  encodeZIP,
  packSpriteAtlas,
  spriteAtlasLayout,
} from '@margoengine/exporters/capture';
import { decodePNG, readZIP } from './helpers.js';

// Frame i: every pixel [i, x, y, 255].
const frame = (width, height) => (index) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([index, x, y, 255], (y * width + x) * 4);
  return { data, width, height };
};

test('encodeZIP: stored UTF-8 entries, deterministic bytes, checked before reading', async () => {
  const entries = [
    { name: 'model.glb', data: Uint8Array.of(1, 2, 3, 4, 5) },
    { name: 'textures/albedo.png', data: new Blob([Uint8Array.of(9, 8, 7)]) },
    { name: 'README.txt', data: 'Grüße\n' },
  ];
  const zip = await encodeZIP(entries),
    read = readZIP(zip);
  assert.deepEqual(
    read.map((e) => e.name),
    ['model.glb', 'textures/albedo.png', 'README.txt'],
  );
  assert.deepEqual([...read[0].data], [1, 2, 3, 4, 5]);
  assert.deepEqual([...read[1].data], [9, 8, 7]);
  assert.equal(new TextDecoder().decode(read[2].data), 'Grüße\n');
  assert.ok(read.every((e) => e.flags === 0x0800 && e.date === 33 && e.time === 0));
  assert.deepEqual(await encodeZIP(entries), zip, 'same files, same bytes');
  const progress = [];
  await encodeZIP(entries, { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(progress, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  for (const name of ['../x', '/x', 'a\\b', 'c:/x', 'a//b', '', 'a/./b', 'tab\t'])
    await assert.rejects(encodeZIP([{ name, data: 'x' }]), TypeError, name);
  await assert.rejects(encodeZIP([{ name: 'a', data: 1 }]), /Uint8Array, Blob or string/);
  await assert.rejects(
    encodeZIP([
      { name: 'a', data: 'x' },
      { name: 'a', data: 'y' },
    ]),
    /Duplicate/,
  );
  // The budget is checked from sizes before any entry is read.
  const unread = new Blob([new Uint8Array(1000)]);
  unread.arrayBuffer = () => assert.fail('read before the budget check');
  await assert.rejects(encodeZIP([{ name: 'big.bin', data: unread }], { maxBytes: 500 }), /exceed 500 bytes/);
  assert.equal((await encodeZIP([])).length, 22, 'an empty archive is its end record');
});

test('packSpriteAtlas: full frames at their grid cells, exact pixels', async () => {
  const progress = [],
    atlas = await packSpriteAtlas(5, frame(3, 2), { columns: 2, onProgress: (d, t) => progress.push(`${d}/${t}`) });
  assert.deepEqual(
    [atlas.columns, atlas.rows, atlas.width, atlas.height, atlas.frameWidth, atlas.frameHeight],
    [2, 3, 6, 6, 3, 2],
  );
  assert.deepEqual(atlas.frames[3], { index: 3, x: 3, y: 2, width: 3, height: 2 });
  assert.deepEqual(progress, ['1/5', '2/5', '3/5', '4/5', '5/5']);
  const at = (x, y) => [...atlas.pixels.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
  assert.deepEqual(at(4, 3), [3, 1, 1, 255], 'frame 3 pixel (1, 1)');
  assert.deepEqual(at(0, 4), [4, 0, 0, 255], 'frame 4 pixel (0, 0)');
  assert.deepEqual(at(5, 5), [0, 0, 0, 0], 'the empty sixth cell stays transparent');
  assert.deepEqual(spriteAtlasLayout(10, 64, 32), { columns: 4, rows: 3, width: 256, height: 96 });
  assert.throws(() => spriteAtlasLayout(4, 5000, 10, 2), /exceeds 8192/);
  assert.throws(() => spriteAtlasLayout(4, 10, 10, 5), /columns 5/);
  assert.equal(spriteAtlasLayout(2, 10000, 10, 1, 16384).height, 20);
  // The grid is checked on the first frame, before frame 1 is rendered.
  let rendered = 0;
  await assert.rejects(
    packSpriteAtlas(4, (i) => (rendered++, frame(5000, 10)(i)), { columns: 2 }),
    /exceeds 8192/,
  );
  assert.equal(rendered, 1);
  await assert.rejects(
    packSpriteAtlas(2, (i) => frame(3 + i, 2)(i)),
    /capture every frame at one size/,
  );
});

test('cancellation stops between frames and returns nothing partial', async () => {
  const controller = new AbortController(),
    seen = [];
  await assert.rejects(
    packSpriteAtlas(
      6,
      (i) => {
        seen.push(i);
        if (i === 2) controller.abort();
        return frame(2, 2)(i);
      },
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.deepEqual(seen, [0, 1, 2]);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(encodeSequenceZIP(2, frame(2, 2), { signal: stopped.signal }), { name: 'AbortError' });
  await assert.rejects(encodeZIP([{ name: 'a', data: 'x' }], { signal: stopped.signal }), { name: 'AbortError' });
});

test('encodeSequenceZIP: numbered PNGs, a manifest hook and extra files', async () => {
  const progress = [],
    zip = await encodeSequenceZIP(12, frame(4, 3), {
      name: 'walk_',
      manifest: (base) => ({ ...base, fps: 12, clip: 'walk' }),
      entries: [{ name: 'README.txt', data: 'Frames of the walk clip.\n' }],
      onProgress: (done, total) => progress.push(done === total),
    }),
    read = readZIP(zip);
  assert.equal(read.length, 14);
  assert.equal(read[0].name, 'frames/walk_00.png');
  assert.equal(read[11].name, 'frames/walk_11.png');
  const image = decodePNG(read[7].data);
  assert.deepEqual([image.width, image.height], [4, 3]);
  assert.deepEqual(image.data, frame(4, 3)(7).data);
  const manifest = JSON.parse(new TextDecoder().decode(read[12].data));
  assert.equal(read[12].name, 'manifest.json');
  assert.deepEqual(
    { ...manifest, frames: manifest.frames.length },
    { format: 'png-sequence', width: 4, height: 3, frames: 12, fps: 12, clip: 'walk' },
  );
  assert.deepEqual(manifest.frames[3], { index: 3, file: 'frames/walk_03.png' });
  assert.equal(read[13].name, 'README.txt');
  assert.equal(progress.filter(Boolean).length, 1);
  const bare = readZIP(await encodeSequenceZIP(2, frame(1, 1), { folder: '', pad: 3, manifest: false }));
  assert.deepEqual(
    bare.map((e) => e.name),
    ['frame000.png', 'frame001.png'],
  );
  let rendered = 0;
  await assert.rejects(
    encodeSequenceZIP(50, (i) => (rendered++, frame(64, 64)(i)), { maxBytes: 4000 }),
    /exceed 4000 bytes/,
  );
  assert.ok(rendered < 50, 'stops as soon as the budget is spent');
  await assert.rejects(
    encodeSequenceZIP(2, (i) => frame(2 + i, 2)(i)),
    /one size/,
  );
  await assert.rejects(encodeSequenceZIP(1, frame(1, 1), { manifest: () => undefined }), /JSON value/);
});

test('encodeAtlasZIP: one atlas PNG and the frame rectangles', async () => {
  const progress = [],
    zip = await encodeAtlasZIP(3, frame(2, 2), {
      columns: 3,
      image: 'sheet.png',
      manifest: (base) => ({ ...base, format: 'margo-sprite-atlas' }),
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    }),
    read = readZIP(zip);
  assert.deepEqual(
    read.map((e) => e.name),
    ['sheet.png', 'manifest.json'],
  );
  const image = decodePNG(read[0].data),
    atlas = await packSpriteAtlas(3, frame(2, 2), { columns: 3 });
  assert.deepEqual([image.width, image.height], [6, 2]);
  assert.deepEqual(image.data, atlas.pixels.data);
  const manifest = JSON.parse(new TextDecoder().decode(read[1].data));
  assert.deepEqual(manifest, {
    format: 'margo-sprite-atlas',
    image: 'sheet.png',
    columns: 3,
    rows: 1,
    width: 6,
    height: 2,
    frameWidth: 2,
    frameHeight: 2,
    frames: atlas.frames,
  });
  assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
});
