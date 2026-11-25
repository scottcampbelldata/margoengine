import test from 'node:test';
import assert from 'node:assert/strict';
import { ASCII } from '@margoengine/post/ascii';
import { Halftone } from '@margoengine/post/halftone';
import { harness, modules, written } from './support.js';

const calls = (log, name) => log.filter((e) => e[0] === name);
const ASCII_95 = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
/** The glyph atlas an effect with `options` uploads on its first frame. */
function glyphAtlas(options) {
  const h = harness(),
    effect = ASCII.attach(h.engine, options);
  try {
    const [upload] = calls(
        h.gpu.record(() => h.frame()),
        'writeTexture',
      ),
      [width] = upload[4];
    return { data: Buffer.from(upload[2].split(':')[1], 'hex'), width };
  } finally {
    effect.dispose();
  }
}
/** The pixels of glyph `i` in an atlas of `width` x `height` cells, row by row. */
const cell = (atlas, i, width, height) =>
  Array.from(
    { length: width * height },
    (_, p) =>
      atlas.data[(Math.floor(i / 16) * height + Math.floor(p / width)) * atlas.width + (i % 16) * width + (p % width)],
  );

test('ASCII draws the cell grid and the glyphs, rebuilds its atlas only on change, restores and releases', async () => {
  const h = harness(),
    effect = ASCII.attach(h.engine, { cellSize: [6, 8], color: '#f80', background: 'scene', edges: true });
  const first = h.gpu.record(() => h.frame());
  const values = written(first, 64);
  assert.deepEqual([...values.slice(0, 6)], [6, 8, 10, 1, 0, 1]);
  assert.equal(values[6], Math.fround((0.2 ** 2 * 14) / 4));
  assert.deepEqual([...values.slice(8, 16)], [1, Math.fround(0x88 / 255), 0, 0, 0, 0, 0, 1]);
  assert.ok(modules(first).some((s) => s.includes('let d=vec2f(j.x-j.y')));
  assert.equal(calls(first, 'writeTexture').length, 1);
  const grid = calls(first, 'texture').find((e) => e[2].format === 'rgba8unorm');
  assert.deepEqual(grid[2].size, [2 * Math.ceil(h.view.c.width / 6), Math.ceil(h.view.c.height / 8)]);
  h.frame();
  const steady = h.gpu.record(() => h.frame());
  assert.equal(calls(steady, 'writeTexture').length, 0);
  assert.equal(calls(steady, 'texture').length, 0);
  assert.equal(calls(steady, 'group').length, 0);
  effect.options.characters = ' #';
  effect.options.invert = true;
  const changed = h.gpu.record(() => h.frame());
  assert.equal(calls(changed, 'writeTexture').length, 1);
  assert.deepEqual([...written(changed, 64).slice(2, 5)], [2, 1, 1]);
  const fresh = h.lose();
  assert.equal(
    calls(
      fresh.record(() => h.frame()),
      'writeTexture',
    ).length,
    1,
  );
  effect.options.enabled = false;
  assert.equal(
    written(
      fresh.record(() => h.frame()),
      64,
    )[3],
    0,
  );
  await assert.rejects(effect.text(), { code: 'state' });
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});

test('a steady screen effect keeps its bind group although it passes a new buffer binding each frame', () => {
  const h = harness(),
    effect = Halftone.attach(h.engine);
  h.frame();
  h.frame();
  assert.equal(
    calls(
      h.gpu.record(() => h.frame()),
      'group',
    ).length,
    0,
  );
  effect.dispose();
});

test('ASCII.text reads the character grid back, and honours an AbortSignal', async () => {
  const h = harness(),
    effect = ASCII.attach(h.engine, { cellSize: 64 });
  await assert.rejects(effect.text(), { code: 'state' });
  h.frame();
  const columns = Math.ceil(h.view.c.width / 64),
    rows = Math.ceil(h.view.c.height / 64),
    create = h.engine.gpu.createBuffer,
    made = [];
  h.engine.gpu.createBuffer = (d) => {
    const buffer = create(d),
      bytes = new Uint8Array(d.size);
    // Cell (x, y) holds ramp index (x + y) % 10 in the red byte of its second texel.
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) bytes[(y * d.size) / rows + x * 8 + 4] = (x + y) % 10;
    made.push(buffer);
    return Object.assign(buffer, { mapAsync: async () => {}, getMappedRange: () => bytes.buffer });
  };
  const ramp = ' .:-+=*%#@';
  const expected = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: columns }, (_, x) => ramp[(x + y) % 10]).join(''),
  ).join('\n');
  assert.equal(await effect.text(), expected);
  const abort = new AbortController(),
    pending = effect.text({ signal: abort.signal });
  abort.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  await assert.rejects(effect.text({ signal: abort.signal }), /stop/);
  assert.ok(made.length === 2 && made.every((b) => b.destroyed));
  effect.dispose();
});

test('the built-in glyphs are distinct, sharp at whole multiples, and the default ramp gains ink at any size', () => {
  const atlas = glyphAtlas({ characters: ASCII_95.join('') });
  assert.ok(atlas.data.every((v) => v === 0 || v === 255));
  assert.equal(new Set(ASCII_95.map((_, i) => cell(atlas, i, 12, 16).join())).size, 95);
  // '|' is the middle column of the 5 x 7 glyph, doubled: columns 4 and 5, rows 0..13.
  const bar = cell(atlas, '|'.charCodeAt(0) - 32, 12, 16);
  assert.ok(bar.every((v, p) => v === ((p % 12 === 4 || p % 12 === 5) && p < 14 * 12 ? 255 : 0)));
  for (const [w, h] of [
    [6, 8],
    [12, 16],
    [7, 13],
    [4, 4],
  ]) {
    const ramp = glyphAtlas({ cellSize: [w, h] });
    const ink = Array.from({ length: 10 }, (_, i) => cell(ramp, i, w, h).reduce((a, b) => a + b, 0));
    assert.equal(ink[0], 0);
    for (let i = 1; i < 10; i++) assert.ok(ink[i] > ink[i - 1], `${w}x${h} ramp ${i}: ${ink}`);
  }
});

test('a CSS font is drawn through OffscreenCanvas, and refused where there is none', () => {
  assert.throws(() => glyphAtlas({ font: 'monospace' }), { code: 'unsupported' });
  const drawn = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.size = [width, height];
    }
    getContext() {
      const [w, h] = this.size,
        context = {
          save() {},
          restore() {},
          beginPath() {},
          rect() {},
          clip() {},
          fillText: (...a) => drawn.push([context.font, ...a]),
          getImageData: () => ({ data: Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 7 : 0)) }),
        };
      return context;
    }
  };
  try {
    const atlas = glyphAtlas({ characters: 'a█', cellSize: [8, 10], font: 'serif', fontSize: 9 });
    assert.deepEqual(drawn.slice(0, 2), [
      ['9px serif', 'a', 4, 5],
      ['9px serif', '█', 12, 5],
    ]);
    assert.equal(drawn.length, 6, 'the ramp and the four edge characters');
    assert.ok(atlas.data.every((v) => v === 7));
  } finally {
    delete globalThis.OffscreenCanvas;
  }
});

test('ASCII validates its options at construction and when changed live', () => {
  for (const o of [
    { characters: '#' },
    { characters: ' █' },
    { characters: 'x'.repeat(251) },
    { edgeCharacters: '|/-' },
    { cellSize: 3 },
    { cellSize: 65 },
    { cellSize: 8.5 },
    { cellSize: [8] },
    { font: ' ' },
    { fontSize: 0 },
    { color: 'red' },
    { background: '#12' },
    { intensity: 2 },
    { edgeThreshold: NaN },
  ])
    assert.throws(() => new ASCII(o), RangeError, JSON.stringify(o));
  for (const o of [{ invert: 1 }, { edges: 'yes' }, { enabled: 0 }, { characters: 5 }, { color: 0xffffff }])
    assert.throws(() => new ASCII(o), TypeError, JSON.stringify(o));
  const h = harness(),
    effect = ASCII.attach(h.engine);
  effect.options.cellSize = 100;
  assert.throws(() => h.frame(), RangeError);
  effect.dispose();
});
