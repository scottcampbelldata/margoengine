import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasManifest, packAtlasFrames } from '@margoengine/exporters/atlas';

const seeded = (seed) => () => (seed = Math.imul(seed, 1664525) + 1013904223) >>> 24;

// An image with `border` transparent pixels around a block of distinct colours.
function sprite(width, height, border = 0, seed = 1, name) {
  const data = new Uint8Array(width * height * 4),
    random = seeded(seed);
  for (let y = border; y < height - border; y++)
    for (let x = border; x < width - border; x++) data.set([random(), random(), random(), 255], (y * width + x) * 4);
  return { data, width, height, ...(name ? { name } : {}) };
}
function many(count, seed = 3) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, i) =>
    sprite(1 + (random() % 40), 1 + (random() % 40), random() % 2 ? 0 : 0, i + 1),
  );
}
function assertLayout(atlas, padding = 0, extrude = 0) {
  for (const f of atlas.frames) {
    const page = atlas.pages[f.page];
    assert.ok(f.x >= extrude && f.y >= extrude, `${f.name} inside`);
    assert.ok(f.x + f.width + extrude <= page.width && f.y + f.height + extrude <= page.height, `${f.name} inside`);
  }
  atlas.frames.forEach((a, i) => {
    for (const b of atlas.frames.slice(i + 1)) {
      if (a.page !== b.page) continue;
      const room = padding + 2 * extrude,
        apart =
          a.x + a.width + room <= b.x ||
          b.x + b.width + room <= a.x ||
          a.y + a.height + room <= b.y ||
          b.y + b.height + room <= a.y;
      assert.ok(apart, `${a.name} and ${b.name} overlap`);
    }
  });
}
// The untrimmed image, rebuilt from the page: every pixel equal the source's.
function restore(atlas, f) {
  const page = atlas.pages[f.page],
    out = new Uint8Array(f.sourceWidth * f.sourceHeight * 4);
  for (let y = 0; y < f.height; y++)
    out.set(
      page.data.subarray((f.y + y) * page.width * 4 + f.x * 4, (f.y + y) * page.width * 4 + (f.x + f.width) * 4),
      ((y + f.offsetY) * f.sourceWidth + f.offsetX) * 4,
    );
  return out;
}

test('nothing overlaps and all is inside, across padding and extrude', () => {
  const frames = many(60);
  for (const [padding, extrude] of [
    [0, 0],
    [1, 0],
    [3, 0],
    [0, 2],
    [2, 1],
  ]) {
    const atlas = packAtlasFrames(frames, { padding, extrude });
    assert.equal(atlas.pages.length, 1);
    assertLayout(atlas, padding, extrude);
  }
});

test('trim restores the source pixel-exact, and the rects and offsets say where', () => {
  const sources = [sprite(9, 7, 2, 1), sprite(5, 5, 0, 2), sprite(12, 3, 1, 3)],
    atlas = packAtlasFrames(sources);
  sources.forEach((source, i) => assert.deepEqual(restore(atlas, atlas.frames[i]), source.data));
  const first = atlas.frames[0];
  assert.deepEqual(
    [first.width, first.height, first.offsetX, first.offsetY, first.sourceWidth, first.sourceHeight],
    [5, 3, 2, 2, 9, 7],
  );
  const whole = packAtlasFrames(sources, { trim: false }).frames[0];
  assert.deepEqual([whole.width, whole.height, whole.offsetX], [9, 7, 0]);
});

test('a fully transparent frame keeps one transparent pixel and still restores', () => {
  const empty = { data: new Uint8Array(4 * 6 * 4), width: 6, height: 4 },
    atlas = packAtlasFrames([empty]);
  assert.deepEqual([atlas.frames[0].width, atlas.frames[0].height], [1, 1]);
  assert.deepEqual(restore(atlas, atlas.frames[0]), empty.data);
});

test('the same sources give the same bytes', () => {
  const frames = many(40);
  assert.deepEqual(packAtlasFrames(frames, { padding: 1 }), packAtlasFrames(frames, { padding: 1 }));
});

test('extruded pixels equal the frame edge, corners included', () => {
  const source = sprite(4, 3, 0, 9),
    atlas = packAtlasFrames([source], { extrude: 2 }),
    f = atlas.frames[0],
    page = atlas.pages[0],
    at = (x, y) => [...page.data.subarray((y * page.width + x) * 4, (y * page.width + x) * 4 + 4)],
    src = (x, y) => [...source.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual([f.x, f.y], [2, 2]);
  assert.deepEqual([page.width, page.height], [8, 7]);
  for (let y = -2; y < 5; y++)
    for (let x = -2; x < 6; x++)
      assert.deepEqual(
        at(f.x + x, f.y + y),
        src(Math.min(3, Math.max(0, x)), Math.min(2, Math.max(0, y))),
        `${x},${y}`,
      );
});

test('padding leaves empty pixels between frames and none at the far edge', () => {
  const atlas = packAtlasFrames([sprite(4, 4, 0, 1), sprite(4, 4, 0, 2)], { padding: 2 });
  assertLayout(atlas, 2);
  const [page] = atlas.pages;
  assert.equal(Math.max(page.width, page.height), 10);
  assert.equal(Math.min(page.width, page.height), 4);
});

test('power-of-two rounds page sides up; pages stay as small as the frames need', () => {
  assert.deepEqual(
    (({ width, height }) => [width, height])(packAtlasFrames([sprite(5, 3)], { powerOfTwo: true }).pages[0]),
    [8, 4],
  );
  const tight = packAtlasFrames([sprite(5, 3)]).pages[0];
  assert.deepEqual([tight.width, tight.height], [5, 3]);
  const frames = many(200),
    atlas = packAtlasFrames(frames),
    used = frames.reduce((sum, _, i) => sum + atlas.frames[i].width * atlas.frames[i].height, 0);
  assert.ok(used / (atlas.pages[0].width * atlas.pages[0].height) > 0.6, 'a good packer fills over 60 percent');
});

test('frames spill onto further pages only when maxSize forces it, and in order', () => {
  const frames = Array.from({ length: 5 }, (_, i) => sprite(10, 10, 0, i + 1)),
    atlas = packAtlasFrames(frames, { maxSize: 20, pages: 2 });
  assert.equal(atlas.pages.length, 2);
  assertLayout(atlas);
  frames.forEach((source, i) => assert.deepEqual(restore(atlas, atlas.frames[i]), source.data));
  assert.equal(packAtlasFrames(frames, { maxSize: 64, pages: 4 }).pages.length, 1);
});

test('pivots come from the frame, then the option, then the centre', () => {
  const atlas = packAtlasFrames([{ ...sprite(4, 4), pivot: { x: 0.25, y: 1 } }, sprite(4, 4, 0, 2)], {
    pivot: { x: 0, y: 0.5 },
  });
  assert.deepEqual(atlas.frames[0].pivot, { x: 0.25, y: 1 });
  assert.deepEqual(atlas.frames[1].pivot, { x: 0, y: 0.5 });
  assert.deepEqual(packAtlasFrames([sprite(2, 2)]).frames[0].pivot, { x: 0.5, y: 0.5 });
});

test('the manifest is the JSON hash layout, with names, trim, pivots and pages', () => {
  const atlas = packAtlasFrames([sprite(6, 6, 1, 1, 'a'), sprite(6, 6, 0, 2, 'b')], { maxSize: 6, pages: 2 }),
    manifest = atlasManifest(atlas, { image: 'hero.png' });
  assert.deepEqual(Object.keys(manifest.frames), ['a', 'b']);
  assert.deepEqual(manifest.frames.a.spriteSourceSize, { x: 1, y: 1, w: 4, h: 4 });
  assert.deepEqual(manifest.frames.a.sourceSize, { w: 6, h: 6 });
  assert.equal(manifest.frames.a.trimmed, true);
  assert.equal(manifest.frames.b.trimmed, false);
  assert.deepEqual(manifest.frames.b.frame, { x: atlas.frames[1].x, y: atlas.frames[1].y, w: 6, h: 6 });
  assert.deepEqual(
    manifest.meta.pages.map((p) => p.image),
    ['hero.png', 'hero-1.png'],
  );
  assert.equal(manifest.meta.image, 'hero.png');
  assert.equal(JSON.parse(JSON.stringify(manifest)).frames.a.pivot.x, 0.5);
  assert.equal(atlasManifest(atlas, { image: (i) => `p${i}.webp` }).meta.pages[1].image, 'p1.webp');
  assert.equal(atlasManifest(packAtlasFrames([sprite(1, 1)])).meta.image, 'atlas.png');
});

test('limits are refused with the fix named', () => {
  const one = sprite(1, 1);
  assert.throws(() => packAtlasFrames([]), /at least one frame/);
  assert.throws(() => packAtlasFrames([one], { padding: -1 }), /padding -1/);
  assert.throws(() => packAtlasFrames([one], { extrude: 0.5 }), /extrude 0.5/);
  assert.throws(() => packAtlasFrames([one], { maxSize: 16385 }), /maxSize 16385/);
  assert.throws(() => packAtlasFrames([one], { pages: 0 }), /pages 0/);
  assert.throws(() => packAtlasFrames([one], { pivot: { x: NaN, y: 0 } }), /pivot/);
  assert.throws(() => packAtlasFrames([{ data: new Uint8Array(3), width: 1, height: 1 }]), /3 bytes/);
  assert.throws(() => packAtlasFrames([{ data: new Uint8Array(0), width: 0, height: 1 }]), /size 0x1/);
  assert.throws(
    () =>
      packAtlasFrames([
        { ...one, name: 'x' },
        { ...one, name: 'x' },
      ]),
    /used twice/,
  );
  assert.throws(() => packAtlasFrames([sprite(5, 5)], { maxSize: 4 }), /over maxSize 4/);
  assert.throws(() => packAtlasFrames([sprite(3, 3)], { maxSize: 4, extrude: 1 }), /over maxSize 4/);
  assert.throws(() => packAtlasFrames([sprite(4, 4), sprite(4, 4, 0, 2)], { maxSize: 4 }), /do not fit 1 page/);
});
