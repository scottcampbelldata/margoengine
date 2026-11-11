import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SliceLayer, SliceSprite, sliceParts } from '../dist/slice.js';
import { packSprites, Sprite, SPRITE_FLOATS } from '../dist/index.js';

const options = { rect: [2, 3, 8, 8], width: 20, height: 16, borders: [2, 2, 2, 2] };
test('smooth sampling evaluates derivatives before the mask can discard a fragment', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('let dx=dpdx(v.texel)') < source.indexOf('let m=frame.mask;'));
  assert.ok(source.includes('textureSampleGrad(atlas,filtered'));
});
test('nine regions retain corners, stretch edges, share a pivot and mirror as one image', () => {
  const s = new SliceSprite({ ...options, pivotX: 0.5, pivotY: 0.5, x: 17, rotation: 1 });
  const p = sliceParts(s);
  assert.equal(p.length, 9);
  assert.deepEqual(p[0].rect, [2, 3, 2, 2]);
  assert.deepEqual([p[0].scaleX, p[0].scaleY], [1, 1]);
  assert.deepEqual([p[4].scaleX, p[4].scaleY], [4, 3]);
  assert.ok(p.every((v) => v.x === 17 && v.rotation === 1));
  assert.equal(-p[0].pivotX * 2, -10);
  s.flipX = true;
  assert.equal(-sliceParts(s)[0].pivotX * 2, 8);
});
test('repeat counts, partial final tiles, negative scroll and scale require at most nine instances', () => {
  const s = new SliceSprite({ ...options, middle: 'repeat', scrollX: -3, tileScaleY: 2 });
  assert.deepEqual(sliceParts(s)[4].params, [4, 1.5, 0.75, 0]);
  s.width = 1000000;
  assert.equal(sliceParts(s).length, 9);
  const fill = sliceParts(new SliceSprite({ rect: [0, 0, 4, 4], width: 11, height: 7, middle: 'repeat' }));
  assert.equal(fill.length, 1);
  assert.deepEqual(fill[0].params, [2.75, 1.75, 0, 0]);
});
test('small targets shrink opposite borders together; empty targets are reversible without changing add order', () => {
  const l = new SliceLayer({ atlas: { width: 16, height: 16, data: new Uint8Array(1024) } });
  const s = l.addSlice(options),
    later = l.add({ z: 1 });
  const indices = l.sprites.slice(0, 9).map((v) => v.index);
  s.width = 2;
  s.height = 2;
  l.onPreUpdate(0);
  assert.equal(l.sprites.filter((v) => v.visible).length, 5);
  s.width = 0;
  l.onPreUpdate(0);
  assert.equal(l.sprites.filter((v) => v.visible).length, 1);
  s.width = 20;
  s.height = 16;
  l.onPreUpdate(0);
  assert.deepEqual(
    l.sprites.slice(0, 9).map((v) => v.index),
    indices,
  );
  assert.equal(l.sprites[9], later);
  assert.equal(l.removeSlice(s), true);
  assert.equal(l.removeSlice(s), false);
  assert.equal(l.sprites.length, 1);
  l.dispose();
});
test('bad sizes, borders, pattern scales and non-finite scroll reject', () => {
  for (const bad of [{ width: -1 }, { borders: [5, 2, 5, 2] }, { tileScaleX: 0 }, { scrollY: Infinity }])
    assert.throws(() => sliceParts(new SliceSprite({ ...options, ...bad })), RangeError);
});

test('KB6013a: under snap the parts of a squeezed or fractional slice share their edges, with no gap or overshoot', () => {
  const cases = [
    { rect: [0, 0, 8, 8], borders: [4, 0, 4, 0], width: 7, height: 8, x: 0 },
    { rect: [0, 0, 8, 8], borders: [3, 2, 3, 2], width: 9.5, height: 5.25, x: 0.3 },
    { rect: [0, 0, 8, 8], borders: [2, 2, 2, 2], width: 13.7, height: 6.1, x: 2.45, zoom: 1.5 },
  ];
  for (const { zoom = 1, ...options } of cases) {
    const s = new SliceSprite({ ...options, y: 0.4, pivotX: 0, pivotY: 0 }),
      parts = sliceParts(s).map((p) => new Sprite(p)),
      data = new Float32Array(parts.length * SPRITE_FLOATS);
    packSprites(parts, data, { x: 0, y: 0, zoom }, 8, 8, true);
    const spans = (axis) =>
      parts.map((_, i) => {
        const o = i * SPRITE_FLOATS,
          size = data[o + 2 + axis],
          corner = data[o + axis] - data[o + 4 + axis] * size;
        return [corner, corner + size];
      });
    for (const axis of [0, 1]) {
      const edges = new Set(spans(axis).flat().map((v) => Math.round(v * 1e6) / 1e6));
      for (const v of edges) assert.ok(Number.isInteger(v), `axis ${axis}: edge ${v} is a whole pixel`);
      const start = (axis ? 0.4 : options.x) * zoom,
        end = start + (axis ? options.height : options.width) * zoom;
      assert.deepEqual(
        [Math.min(...edges), Math.max(...edges)],
        [Math.round(start), Math.round(end)],
        `axis ${axis}: the parts cover the snapped slice exactly`,
      );
      // Every inner edge is shared: the left edge of one part is the right edge of another.
      const columns = spans(axis);
      for (const [a] of columns)
        if (a !== Math.min(...edges)) assert.ok(columns.some(([, b]) => Math.abs(b - a) < 1e-6), `axis ${axis}: gap at ${a}`);
    }
  }
});
