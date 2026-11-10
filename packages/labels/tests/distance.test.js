import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { LabelRenderer } from '@margoengine/labels';
import { DistanceLabels, evaluateLabelDistance } from '@margoengine/labels/distance';
import { Declutter } from '@margoengine/labels/declutter';
import { fakeEngine } from './fake-dom.js';
const policy = {
  near: 2,
  far: 10,
  opacity: { near: 2, nearValue: 1, far: 10, farValue: 0.2 },
  scale: { near: 2, nearValue: 2, far: 10, farValue: 0.5 },
};
test('distance curves clamp, interpolate independently, and include display endpoints', () => {
  assert.deepEqual(evaluateLabelDistance(2, policy), { opacity: 1, scale: 2, visible: true });
  const middle = evaluateLabelDistance(6, policy);
  assert.equal(middle.opacity, 0.6);
  assert.equal(middle.scale, 1.25);
  assert.equal(middle.visible, true);
  assert.equal(evaluateLabelDistance(1, policy).visible, false);
  assert.equal(evaluateLabelDistance(11, policy).visible, false);
  assert.equal(evaluateLabelDistance(10, policy).visible, true);
  assert.equal(evaluateLabelDistance(0).visible, true);
  assert.equal(evaluateLabelDistance(100, { opacity: policy.opacity }).opacity, 0.2);
  for (const p of [
    { near: -1 },
    { near: 10, far: 2 },
    { scale: { near: 1, far: 1, nearValue: 1, farValue: 0 } },
    { opacity: { near: 0, far: 1, nearValue: 2, farValue: 0 } },
  ])
    assert.throws(() => evaluateLabelDistance(3, p), RangeError);
  assert.throws(() => evaluateLabelDistance(NaN), RangeError);
});
test('renderer uses layout scaling without distanceScale; fades restore, limits recover and still frames write nothing', () => {
  const engine = fakeEngine(Camera),
    distance = new DistanceLabels(),
    renderer = new LabelRenderer({ layout: distance });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const element = engine.document.createElement('div');
  element.style.opacity = '0.5';
  const label = renderer.add(element, { position: [0, 0, 0] });
  distance.set(label, policy);
  engine.frame();
  assert.equal(label.distance, 5);
  assert.equal(label.scale, 1.4375);
  assert.match(element.style.transform, /scale\(1.4375\)/);
  assert.equal(Number(element.style.opacity), 0.35);
  const writes = element.styleWrites;
  engine.frame();
  assert.equal(element.styleWrites, writes, 'still frame makes no opacity or transform writes');
  assert.equal(label.scale, 1.4375, 'does not accumulate scale');
  label.setPosition([0, 0, -20]);
  engine.frame();
  assert.equal(label.onScreen, false);
  assert.equal(label.visible, true);
  label.setPosition([0, 0, 0]);
  engine.frame();
  assert.equal(label.onScreen, true);
  distance.delete(label);
  engine.frame();
  assert.equal(element.style.opacity, '0.5');
  assert.equal(label.scale, 1);
  assert.doesNotMatch(element.style.transform, /scale\(/);
  distance.set(label, policy);
  engine.frame();
  distance[Symbol.dispose]();
  assert.equal(element.style.opacity, '0.5');
  renderer.dispose();
});
test('a removed label drops its policy whether or not the policy fades opacity (review 5)', () => {
  // The cleanup only walked labels with a managed opacity, so a scale-only policy kept its removed label alive.
  const engine = fakeEngine(Camera),
    distance = new DistanceLabels(),
    renderer = new LabelRenderer({ layout: distance });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const faded = renderer.add(engine.document.createElement('div'), { position: [0, 0, 0] }),
    scaled = renderer.add(engine.document.createElement('div'), { position: [0, 0, 0] });
  distance.set(faded, policy).set(scaled, { scale: policy.scale });
  engine.frame();
  faded.remove();
  scaled.remove();
  engine.frame();
  assert.equal(distance.delete(faded), false);
  assert.equal(distance.delete(scaled), false, 'the scale-only policy still held the removed label');
  renderer.dispose();
});
test('nested declutter sees distance-scaled rectangles, after the distance filter', () => {
  const engine = fakeEngine(Camera),
    declutter = new Declutter(),
    distance = new DistanceLabels({
      defaults: { scale: { near: 0, far: 10, nearValue: 2, farValue: 2 } },
      layout: declutter,
    });
  const renderer = new LabelRenderer({ layout: distance });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  for (const x of [0, 0.5]) {
    const e = engine.document.createElement('div');
    Object.defineProperty(e, 'offsetWidth', { value: 30 });
    Object.defineProperty(e, 'offsetHeight', { value: 20 });
    renderer.add(e, { position: [x, 0, 0] });
  }
  engine.frame();
  assert.equal(declutter.hidden, 1);
  renderer.dispose();
});
