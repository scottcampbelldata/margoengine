// Node checks of @margoengine/sprites/aseprite. Files are built here byte by byte from the public format description.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { SpriteAnimation } from '../dist/animation.js';
import { clipsFromAsepriteJSON, encodeAseprite, parseAseprite } from '../dist/aseprite.js';

const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
const str = (s) => [...u16(s.length), ...Buffer.from(s)];
const chunk = (type, body) => [...u32(body.length + 6), ...u16(type), ...body];
const zeros = (n) => new Array(n).fill(0);

function file(frames, { width = 2, height = 1, depth = 32, flags = 1, transparent = 0 } = {}) {
  const body = frames.flatMap(({ chunks, ms = 50 }) => {
    const data = chunks.flat();
    return [
      ...u32(data.length + 16),
      ...u16(0xf1fa),
      ...u16(chunks.length),
      ...u16(ms),
      0,
      0,
      ...u32(chunks.length),
      ...data,
    ];
  });
  const header = [
    ...u32(128 + body.length),
    ...u16(0xa5e0),
    ...u16(frames.length),
    ...u16(width),
    ...u16(height),
    ...u16(depth),
    ...u32(flags),
    ...u16(100),
    ...zeros(8),
    transparent,
    ...zeros(3),
    ...zeros(128 - 32),
  ];
  return Uint8Array.from([...header, ...body]);
}
const layer = (name, { flags = 1, type = 0, level = 0, blend = 0, opacity = 255 } = {}) =>
  chunk(0x2004, [
    ...u16(flags),
    ...u16(type),
    ...u16(level),
    ...zeros(4),
    ...u16(blend),
    opacity,
    ...zeros(3),
    ...str(name),
  ]);
const celHead = (layerIndex, x, y, opacity, type, z = 0) => [
  ...u16(layerIndex),
  ...u16(x & 0xffff),
  ...u16(y & 0xffff),
  opacity,
  ...u16(type),
  ...u16(z & 0xffff),
  ...zeros(5),
];
const raw = (layerIndex, w, h, pixels, { x = 0, y = 0, opacity = 255, z = 0 } = {}) =>
  chunk(0x2005, [...celHead(layerIndex, x, y, opacity, 0, z), ...u16(w), ...u16(h), ...pixels]);
const compressed = (layerIndex, w, h, pixels) =>
  chunk(0x2005, [...celHead(layerIndex, 0, 0, 255, 2), ...u16(w), ...u16(h), ...deflateSync(Uint8Array.from(pixels))]);
const linked = (layerIndex, target) => chunk(0x2005, [...celHead(layerIndex, 0, 0, 255, 1), ...u16(target)]);
const tagsChunk = (...tags) =>
  chunk(0x2018, [
    ...u16(tags.length),
    ...zeros(8),
    ...tags.flatMap(([name, from, to, direction = 0, repeat = 0]) => [
      ...u16(from),
      ...u16(to),
      direction,
      ...u16(repeat),
      ...zeros(10),
      ...str(name),
    ]),
  ]);
const userData = (text) => chunk(0x2020, [...u32(1), ...str(text)]);
const RED = [255, 0, 0, 255],
  BLUE = [0, 0, 255, 255];

test('encode then parse gives the same frames, times, tags, slices and palette', async () => {
  const frames = [new Uint8Array([...RED, 1, 2, 3, 4]), new Uint8Array([...BLUE, 0, 0, 0, 0])],
    tags = [
      { name: 'a', from: 0, to: 1, direction: 'pingpong', repeat: 0 },
      { name: 'b', from: 1, to: 1, direction: 'reverse', repeat: 3 },
    ],
    slices = [
      {
        name: 'hit',
        keys: [
          {
            frame: 0,
            x: -1,
            y: 0,
            width: 2,
            height: 1,
            center: { x: 0, y: 0, width: 1, height: 1 },
            pivot: { x: 1, y: -1 },
          },
        ],
      },
      { name: 'plain', keys: [{ frame: 1, x: 0, y: 0, width: 1, height: 1 }] },
    ],
    palette = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]),
    out = await parseAseprite(
      await encodeAseprite({ width: 2, height: 1, frames, durations: [120, 80], tags, slices, palette }),
    );
  assert.deepEqual(out.frames, frames);
  assert.deepEqual(out.durations, [120, 80]);
  assert.deepEqual(out.tags, tags);
  assert.deepEqual(out.slices, slices);
  assert.deepEqual(out.palette, palette);
  assert.deepEqual(
    out.layers.map((l) => [l.name, l.visible, l.blend]),
    [['Layer 1', true, 0]],
  );
  assert.deepEqual(out.clips.a.mode, 'pingpong');
});

test('a file writes the header and frame fields the format describes', async () => {
  const bytes = await encodeAseprite({ width: 3, height: 2, frames: [new Uint8Array(24)], durations: [250] }),
    view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(0, true), bytes.length);
  assert.equal(view.getUint16(4, true), 0xa5e0);
  assert.equal(view.getUint16(8, true), 3);
  assert.equal(view.getUint16(12, true), 32);
  assert.equal(view.getUint16(128 + 4, true), 0xf1fa);
  assert.equal(view.getUint16(128 + 8, true), 250);
});

test('raw, compressed and linked cels place pixels, and z-index and opacity composite', async () => {
  const out = await parseAseprite(
    file([
      { chunks: [layer('a'), layer('b'), raw(0, 2, 1, [...RED, ...RED]), compressed(1, 1, 1, BLUE)], ms: 40 },
      { chunks: [linked(0, 0), raw(1, 1, 1, BLUE, { x: 1, opacity: 128 })] },
      { chunks: [raw(0, 1, 1, RED, { x: 1, z: 2 }), raw(1, 1, 1, BLUE, { x: 1 })] },
    ]),
  );
  assert.deepEqual([...out.frames[0]], [...BLUE, ...RED]);
  assert.deepEqual([...out.frames[1]], [...RED, Math.round((255 * 127) / 255), 0, 128, 255]);
  assert.deepEqual([...out.frames[2]], [0, 0, 0, 0, ...RED], 'a positive z-index draws layer 0 above layer 1');
  assert.deepEqual(out.durations, [40, 50, 50]);
});

test('cels clip at the sprite edge, hidden and reference layers and hidden groups do not draw', async () => {
  const out = await parseAseprite(
    file([
      {
        chunks: [
          layer('hidden', { flags: 0 }),
          layer('reference', { flags: 65 }),
          layer('group', { flags: 0, type: 1 }),
          layer('child', { level: 1 }),
          layer('shown'),
          raw(0, 1, 1, BLUE),
          raw(1, 1, 1, BLUE),
          raw(3, 1, 1, BLUE),
          raw(4, 2, 1, [...RED, ...RED], { x: 1, y: 0 }),
          raw(4, 2, 2, [...BLUE, ...BLUE, ...BLUE, ...BLUE], { x: -1, y: -1 }),
        ],
      },
    ]),
  );
  assert.deepEqual([...out.frames[0]], [...BLUE, ...RED]);
});

test('layer opacity counts only when the header says so, and a group opacity reaches its children', async () => {
  const build = (flags) =>
      file(
        [{ chunks: [layer('g', { type: 1, opacity: 51 }), layer('c', { level: 1, opacity: 51 }), raw(1, 1, 1, RED)] }],
        {
          width: 1,
          flags,
        },
      ),
    alpha = async (flags) => (await parseAseprite(build(flags))).frames[0][3];
  assert.equal(await alpha(0), 255);
  assert.equal(await alpha(1), 51);
  assert.equal(await alpha(3), 10);
});

test('indexed sprites use the palette and its transparent index, except on a background layer', async () => {
  const palette = chunk(0x2019, [
      ...u32(3),
      ...u32(0),
      ...u32(2),
      ...zeros(8),
      ...u16(0),
      1,
      2,
      3,
      255,
      ...u16(1),
      10,
      20,
      30,
      128,
      ...str('named'),
      ...u16(0),
      40,
      50,
      60,
      255,
    ]),
    out = await parseAseprite(
      file([{ chunks: [palette, layer('l'), raw(0, 2, 1, [2, 1])] }], { depth: 8, transparent: 2 }),
    );
  assert.deepEqual([...out.frames[0]], [0, 0, 0, 0, 10, 20, 30, 128]);
  assert.deepEqual([...out.palette.subarray(0, 4)], [1, 2, 3, 255]);
  const background = await parseAseprite(
    file([{ chunks: [palette, layer('l', { flags: 9 }), raw(0, 2, 1, [2, 0])] }], { depth: 8, transparent: 2 }),
  );
  assert.deepEqual([...background.frames[0]], [40, 50, 60, 255, 1, 2, 3, 255]);
});

test('grayscale pixels and both old palette chunks read', async () => {
  const gray = await parseAseprite(file([{ chunks: [layer('l'), raw(0, 1, 1, [77, 200])] }], { width: 1, depth: 16 }));
  assert.deepEqual([...gray.frames[0]], [77, 77, 77, 200]);
  const packet = [...u16(1), 1, 1, 63, 0, 32],
    old6 = await parseAseprite(
      file([{ chunks: [chunk(0x0011, packet), layer('l'), raw(0, 1, 1, [1])] }], { width: 1, depth: 8 }),
    );
  assert.deepEqual([...old6.frames[0]], [255, 0, 130, 255]);
  const old8 = await parseAseprite(
    file([{ chunks: [chunk(0x0004, packet), layer('l'), raw(0, 1, 1, [1])] }], { width: 1, depth: 8 }),
  );
  assert.deepEqual([...old8.frames[0]], [63, 0, 32, 255]);
});

test('user data attaches to the sprite, the layer, each tag in order and the slice', async () => {
  const paletteChunk = chunk(0x2019, [...u32(1), ...u32(0), ...u32(0), ...zeros(8), ...u16(0), 0, 0, 0, 255]),
    slice = chunk(0x2022, [
      ...u32(1),
      ...u32(0),
      ...u32(0),
      ...str('s'),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(1),
      ...u32(1),
    ]),
    out = await parseAseprite(
      file(
        [
          {
            chunks: [
              paletteChunk,
              userData('sprite'),
              layer('l'),
              userData('layer'),
              tagsChunk(['one', 0, 0], ['two', 0, 0]),
              userData('first'),
              userData('second'),
              slice,
              userData('slice'),
              raw(0, 1, 1, RED),
              userData('cel, kept off the others'),
            ],
          },
        ],
        { width: 1 },
      ),
    );
  assert.equal(out.data, 'sprite');
  assert.equal(out.layers[0].data, 'layer');
  assert.deepEqual(
    out.tags.map((t) => t.data),
    ['first', 'second'],
  );
  assert.equal(out.slices[0].data, 'slice');
});

test('tag direction and repeat give the play order, and the clips drive SpriteAnimation', async () => {
  const frames = Array.from({ length: 4 }, () => new Uint8Array(RED)),
    tag = (direction, repeat) => ({ name: 't', from: 1, to: 3, direction, repeat }),
    order = async (direction, repeat) => {
      const { clips } = await parseAseprite(
        await encodeAseprite({ width: 1, height: 1, frames, tags: [tag(direction, repeat)] }),
      );
      return [clips.t.mode, clips.t.frames.map((f) => f.rect[0])];
    };
  assert.deepEqual(await order('forward', 0), ['loop', [1, 2, 3]]);
  assert.deepEqual(await order('reverse', 0), ['loop', [3, 2, 1]]);
  assert.deepEqual(await order('pingpong', 0), ['pingpong', [1, 2, 3]]);
  assert.deepEqual(await order('pingpong_reverse', 0), ['pingpong', [3, 2, 1]]);
  assert.deepEqual(await order('forward', 2), ['once', [1, 2, 3, 1, 2, 3]]);
  assert.deepEqual(await order('pingpong', 1), ['once', [1, 2, 3]]);
  assert.deepEqual(await order('pingpong', 3), ['once', [1, 2, 3, 2, 1, 2, 3]]);
  assert.deepEqual(await order('pingpong_reverse', 2), ['once', [3, 2, 1, 2, 3]]);
  const parsed = await parseAseprite(
      await encodeAseprite({
        width: 8,
        height: 8,
        frames: [new Uint8Array(256), new Uint8Array(256)],
        durations: [100, 300],
      }),
      { columns: 1 },
    ),
    animation = new SpriteAnimation({ clips: parsed.clips });
  animation.play('default');
  assert.deepEqual(
    animation.update(0.15).rect,
    [0, 8, 8, 8],
    'no tags: one clip, rects from columns, times from the file',
  );
});

test('the JSON sheet in hash and array layout gives clips, rects and slices', () => {
  const entries = [
      { frame: { x: 0, y: 0, w: 8, h: 8 }, duration: 200 },
      { frame: { x: 8, y: 0, w: 8, h: 8 }, duration: 100 },
    ],
    meta = {
      frameTags: [{ name: 'walk', from: 0, to: 1, direction: 'pingpong_reverse', repeat: '2' }],
      slices: [
        {
          name: 's',
          keys: [
            {
              frame: 0,
              bounds: { x: 1, y: 2, w: 3, h: 4 },
              center: { x: 1, y: 1, w: 1, h: 1 },
              pivot: { x: 2, y: 3 },
            },
          ],
        },
      ],
    },
    array = clipsFromAsepriteJSON({ frames: entries, meta }),
    hash = clipsFromAsepriteJSON({ frames: { 'a 0.ase': entries[0], 'a 1.ase': entries[1] }, meta });
  assert.deepEqual(array, hash);
  assert.deepEqual(array.rects, [
    [0, 0, 8, 8],
    [8, 0, 8, 8],
  ]);
  assert.deepEqual(array.clips.walk, {
    frames: [
      { rect: [8, 0, 8, 8], duration: 0.1 },
      { rect: [0, 0, 8, 8], duration: 0.2 },
      { rect: [8, 0, 8, 8], duration: 0.1 },
    ],
    mode: 'once',
  });
  assert.deepEqual(array.slices[0].keys[0], {
    frame: 0,
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    center: { x: 1, y: 1, width: 1, height: 1 },
    pivot: { x: 2, y: 3 },
  });
  assert.deepEqual(Object.keys(clipsFromAsepriteJSON({ frames: entries }).clips), ['default']);
  assert.throws(() => clipsFromAsepriteJSON({ frames: [] }), TypeError);
  assert.throws(
    () => clipsFromAsepriteJSON({ frames: entries, meta: { frameTags: [{ name: 'x', from: 0, to: 9 }] } }),
    RangeError,
  );
  assert.throws(
    () =>
      clipsFromAsepriteJSON({ frames: entries, meta: { frameTags: [{ name: 'x', from: 0, to: 1, direction: 'up' }] } }),
    /direction up/,
  );
  assert.throws(
    () =>
      clipsFromAsepriteJSON({
        frames: entries,
        meta: {
          frameTags: [
            { name: 'x', from: 0, to: 1, repeat: 65535 },
            { name: 'y', from: 0, to: 1, repeat: 600000 },
          ],
        },
      }),
    /repeats to over/,
  );
  const safe = clipsFromAsepriteJSON({ frames: entries, meta: { frameTags: [{ name: '__proto__', from: 0, to: 1 }] } });
  assert.equal(Object.getPrototypeOf(safe.clips), Object.prototype, 'a tag name cannot replace the prototype');
  assert.ok(Object.hasOwn(safe.clips, '__proto__'));
});

test('limits and damage are refused with the fix named', async () => {
  const good = file([{ chunks: [layer('l'), raw(0, 2, 1, [...RED, ...RED])] }]);
  await assert.rejects(parseAseprite([]), TypeError);
  await assert.rejects(parseAseprite(good.subarray(0, 60)), /ends early/);
  const badMagic = good.slice();
  badMagic[4] = 0;
  await assert.rejects(parseAseprite(badMagic), /header magic/);
  await assert.rejects(parseAseprite(good.subarray(0, good.length - 3)), /frame outside/);
  await assert.rejects(parseAseprite(file([{ chunks: [] }], { depth: 24 })), /colour depth of 24/);
  await assert.rejects(parseAseprite(good, { maxPixels: 1 }), /over 1 pixels/);
  await assert.rejects(parseAseprite(good, { columns: 0 }), /columns 0/);
  await assert.rejects(parseAseprite(file([{ chunks: [raw(0, 1, 1, RED)] }])), /missing layer/);
  await assert.rejects(parseAseprite(file([{ chunks: [layer('l'), linked(0, 0)] }])), /points forward/);
  await assert.rejects(
    parseAseprite(file([{ chunks: [layer('l'), compressed(0, 2, 2, RED)] }])),
    /smaller than its size/,
  );
  await assert.rejects(
    parseAseprite(file([{ chunks: [layer('l'), compressed(0, 1, 1, [...RED, ...RED])] }])),
    /larger than its size/,
  );
  await assert.rejects(
    parseAseprite(file([{ chunks: [layer('l', { type: 2 }), chunk(0x2005, celHead(0, 0, 0, 255, 3))] }])),
    (error) => error.code === 'unsupported' && /tilemap/.test(error.message),
  );
  const big = chunk(0x2005, [
    ...celHead(0, 0, 0, 255, 2),
    ...u16(60000),
    ...u16(60000),
    ...deflateSync(new Uint8Array(4)),
  ]);
  await assert.rejects(
    parseAseprite(file([{ chunks: [layer('l'), big] }])),
    /pixels/,
    'a huge cel is refused before it allocates',
  );
  const aborted = AbortSignal.abort(new Error('stop'));
  await assert.rejects(parseAseprite(good, { signal: aborted }), /stop/);
  const one = new Uint8Array(4);
  await assert.rejects(encodeAseprite({ width: 0, height: 1, frames: [one] }), /size 0x1/);
  await assert.rejects(encodeAseprite({ width: 1, height: 1, frames: [] }), /frame count/);
  await assert.rejects(encodeAseprite({ width: 2, height: 1, frames: [one] }), /frame 0 has 4 bytes/);
  await assert.rejects(encodeAseprite({ width: 1, height: 1, frames: [one], durations: [0] }), /duration 0/);
  await assert.rejects(encodeAseprite({ width: 1, height: 1, frames: [one], palette: new Uint8Array(3) }), /palette/);
  await assert.rejects(
    encodeAseprite({ width: 1, height: 1, frames: [one], tags: [{ name: 't', from: 0, to: 1 }] }),
    /tag t/,
  );
  await assert.rejects(
    encodeAseprite({ width: 1, height: 1, frames: [one], tags: [{ name: 't', from: 0, to: 0, direction: 'up' }] }),
    /direction up/,
  );
});
