import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SwimSolver, swimPropulsion } from '@margoengine/physics/life';

test('swimming entry validates units and reports signed thrust across the wave speed', () => {
  const tail = { amplitude: 0.1, span: 0.2, wavelength: 1 };
  assert.ok(swimPropulsion(tail, 2, 1).thrust > 0);
  assert.ok(swimPropulsion(tail, 2, 3).thrust < 0);
  assert.throws(() => swimPropulsion(tail, 2, -1), /Set speed/);
  assert.throws(() => swimPropulsion({ ...tail, span: 0 }, 2, 1), /Set tail.span/);
});

test('a cancelled swimming load observes the reason before reading assets', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(SwimSolver.load({ signal: controller.signal }), { name: 'AbortError' });
});
