import test from 'node:test';
import assert from 'node:assert/strict';
import { RadianceCascade2D } from '../dist/gi.js';
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
