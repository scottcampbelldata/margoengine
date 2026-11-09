import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Light2D,
  lightAt,
  inLightMask,
  lightAffectsLayer,
  Lighting2D,
} from '../dist/index.js';

test('Light layers bitmask and layer filtering', () => {
  const lightAll = new Light2D({ x: 0, y: 0, radius: 50 });
  assert.equal(lightAll.layers, 0xffffffff);
  assert.ok(lightAffectsLayer(lightAll, 1));
  assert.ok(lightAffectsLayer(lightAll, 2));

  const lightForeground = new Light2D({ x: 0, y: 0, radius: 50, layers: 0b01 });
  const lightBackground = new Light2D({ x: 0, y: 0, radius: 50, layers: 0b10 });

  assert.ok(lightAffectsLayer(lightForeground, 0b01));
  assert.ok(!lightAffectsLayer(lightForeground, 0b10));
  assert.ok(lightAffectsLayer(lightForeground, 0b11));

  assert.ok(!lightAffectsLayer(lightBackground, 0b01));
  assert.ok(lightAffectsLayer(lightBackground, 0b10));

  // lightAt respects layer filter
  const litAtFg = lightAt(lightForeground, 0, 0, [0, 0, 1], 0b01);
  assert.ok(litAtFg[0] > 0);
  const litAtBg = lightAt(lightForeground, 0, 0, [0, 0, 1], 0b10);
  assert.deepEqual(litAtBg, [0, 0, 0]);
});

test('Light masks: rect, circle, and polygon masks', () => {
  // Rect mask
  const rectMask = { kind: 'rect', minX: 10, minY: 10, maxX: 30, maxY: 30 };
  assert.ok(inLightMask(rectMask, 20, 20));
  assert.ok(!inLightMask(rectMask, 5, 20));
  assert.ok(!inLightMask(rectMask, 35, 20));

  // Inverted rect mask
  const invertRect = { ...rectMask, invert: true };
  assert.ok(!inLightMask(invertRect, 20, 20));
  assert.ok(inLightMask(invertRect, 5, 20));

  // Circle mask
  const circleMask = { kind: 'circle', radius: 15, center: [20, 20] };
  assert.ok(inLightMask(circleMask, 20, 20));
  assert.ok(inLightMask(circleMask, 30, 20)); // dist 10 <= 15
  assert.ok(!inLightMask(circleMask, 40, 20)); // dist 20 > 15

  // Polygon mask (triangle)
  const polyMask = {
    kind: 'polygon',
    points: [
      [0, 0],
      [40, 0],
      [20, 40],
    ],
  };
  assert.ok(inLightMask(polyMask, 20, 10)); // inside triangle
  assert.ok(!inLightMask(polyMask, 0, 40));  // outside triangle

  // lightAt with mask
  const maskedLight = new Light2D({
    x: 20,
    y: 20,
    radius: 100,
    color: '#ffffff',
    mask: rectMask,
  });

  const insideLit = lightAt(maskedLight, 20, 20);
  assert.ok(insideLit[0] > 0);

  const outsideLit = lightAt(maskedLight, 5, 20);
  assert.deepEqual(outsideLit, [0, 0, 0]);
});

test('Light layer and mask validation', () => {
  assert.throws(
    () => new Light2D({ layers: -1 }),
    /Invalid light value/,
  );
  assert.throws(
    () => new Light2D({ layers: 1.5 }),
    /Invalid light value/,
  );
  assert.throws(
    () => new Light2D({ mask: { kind: 'rect', minX: 30, maxX: 10, minY: 0, maxY: 10 } }),
    /Invalid light value/,
  );
  assert.throws(
    () => new Light2D({ mask: { kind: 'circle', radius: -5 } }),
    /Invalid light value/,
  );
  assert.throws(
    () => new Light2D({ mask: { kind: 'polygon', points: [[0, 0], [1, 1]] } }),
    /Invalid light value/,
  );
});

test('Lighting2D pass layer filtering', () => {
  const fakeTarget = { width: 32, height: 16, format: 'rgba8unorm', createView: () => ({}) };
  const pass = new Lighting2D({ target: fakeTarget, layer: 0b01 });
  assert.equal(pass.layer, 0b01);

  const fgLight = pass.addLight({ x: 10, y: 10, layers: 0b01 });
  const bgLight = pass.addLight({ x: 20, y: 20, layers: 0b10 });

  assert.ok(lightAffectsLayer(fgLight, pass.layer));
  assert.ok(!lightAffectsLayer(bgLight, pass.layer));
});
