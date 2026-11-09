import test from 'node:test';
import assert from 'node:assert/strict';
import { RadianceCascade2D } from '../dist/gi.js';
import { Light2D } from '../dist/index.js';
import { rcCases, radialCases } from './gi-scenes.js';
const orders = [];
for (const c of rcCases)
  test(c.name, () => {
    const value = new RadianceCascade2D(c.options).evaluateAt(c.point, undefined, c.scene);
    if (c.exact) assert.deepEqual(value, c.exact);
    if (c.positive) assert.ok(value[0] > 0);
    if (c.bounded !== undefined) assert.ok(value.every((v) => v >= 0 && v <= c.bounded));
    if (c.bounceOrder !== undefined) orders.push(value[0]);
  });
test('F6 orders 0,1,2,4 transport additional reflected energy', () => {
  assert.equal(orders.length, 4);
  for (let i = 1; i < orders.length; i++) assert.ok(orders[i] > orders[i - 1], `${orders}`);
});

for (const c of radialCases)
  test(c.name, () => {
    const value = new RadianceCascade2D(c.options).evaluateAt(c.point, undefined, c.scene)[0];
    assert.ok(Math.abs(value - c.analytic) / c.analytic < 0.05, `${value} vs ${c.analytic}`);
  });

test('a ray through a wall end within f32 rounding still meets the wall, as on Metal', () => {
  // GI F3 on the GPU: the one 5pi/4 ray from (0.5, 0.5) meets the wall exactly at its end (-10, -10).
  // Metal lands either side of that endpoint in f32, so both forms count a hit within the patch-end margin.
  const options = { cascades: 2, baseRays: 1, baseDistance: 32, bounces: 1 };
  const lights = [new Light2D({ x: 20, y: 0, color: '#ff0000' })];
  const at = (from) =>
    new RadianceCascade2D(options).evaluateAt([0.5, 0.5], undefined, {
      occluders: [{ shape: 'segment', from, to: [-10, 10] }],
      lights,
      layer: 1,
    })[0];
  const exact = at([-10, -10]);
  assert.ok(exact > 0);
  assert.ok(Math.abs(at([-10, -10 + 1e-5]) - exact) < 1e-6, 'the wall end just past the ray');
  assert.equal(at([-10, -9.9]), 0, 'a clear miss gathers nothing');
});
