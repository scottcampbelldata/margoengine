import test from 'node:test';
import assert from 'node:assert/strict';
import { Curvature } from '@margoengine/post/curvature';
import { harness, written, modules } from './support.js';
test('Curvature captures normals, rejects depth breaks and releases restored resources', async () => {
  const h = harness(),
    effect = Curvature.attach(h.engine, { ridge: 2, valley: 3, radius: 4 });
  const log = h.gpu.record(() => h.frame()),
    v = written(log, 64);
  assert.deepEqual([...v.slice(0, 4)], [2, 3, 4, 0]);
  assert.ok(modules(log).some((s) => s.includes('fn neighbour(') && s.includes('abs(away(q)-z)>u[2].w')));
  assert.ok(modules(log).some((s) => s.includes('dot(nx,u[1].xyz)-dot(ny,u[2].xyz)')));
  h.engine.restore();
  h.frame();
  effect.options.enabled = false;
  assert.equal(
    written(
      h.gpu.record(() => h.frame()),
      64,
    )[7],
    0,
  );
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});
test('Curvature validates strengths, normals, sampling and live options', () => {
  for (const o of [
    { ridge: 101 },
    { valley: NaN },
    { radius: 0 },
    { radius: 1.5 },
    { threshold: -1 },
    { depthThreshold: 0 },
    { normalSpace: 'object' },
  ])
    assert.throws(() => new Curvature(o), RangeError);
  assert.throws(() => new Curvature({ normal: 1 }), TypeError);
  const h = harness(),
    e = Curvature.attach(h.engine, { normal: () => undefined, normalSpace: 'view' });
  h.frame();
  e.options.radius = 17;
  assert.throws(() => h.frame(), RangeError);
  e.dispose();
});
