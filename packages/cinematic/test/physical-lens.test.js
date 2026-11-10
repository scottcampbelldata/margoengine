import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalLens } from '../dist/physical-lens.js';
import { CameraBrain, createPose } from '../dist/brain.js';
import { FocusTracker } from '../dist/lens.js';
import { PhysicalCamera } from '@margoengine/cameras/physical';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('millimetre lens and fitted sensor agree with independent pinhole geometry and camera lens', () => {
  for (const focalLength of [14, 35, 50, 200])
    for (const filmGauge of [17.3, 35, 36, 65])
      for (const aspect of [0.5, 1, 1.5, 2.4])
        for (const sensorFit of ['auto', 'horizontal', 'vertical']) {
          const lens = new PhysicalLens({ focalLength, filmGauge, sensorFit });
          const sensorHeight = filmGauge / (sensorFit === 'horizontal' || (sensorFit === 'auto' && aspect >= 1) ? aspect : 1);
          near(2 * focalLength * Math.tan(lens.fov(aspect) * Math.PI / 360), sensorHeight);
          if (sensorFit === 'auto') near(lens.fov(aspect), new PhysicalCamera({ focalLength, filmGauge }).fov(aspect));
        }
});

test('lens stages preserve tracked focus and write coherent live DOF settings with explicit units', () => {
  const lens = new PhysicalLens({ focalLength: 85, filmGauge: 36, fStop: 1.4 });
  const brain = new CameraBrain({ aspect: 1.5 });
  brain.add({ position: [0, 0, 10], stages: [new FocusTracker([0, 0, 7]), lens] });
  const pose = brain.update(0);
  const camera = { fov: 1 }, dof = { options: { filmGauge: 1, sensorFit: 'vertical', aperture: 99 } };
  lens.apply({ camera, dof, aspect: 1.5, focusDistance: pose.focusDistance });
  near(camera.fov, pose.fov);
  assert.deepEqual(dof.options, { focalLength: 0.085, filmGauge: 36, sensorFit: 'auto', aperture: 1.4, focalDistance: 3 });
  lens.focalLength = 35;
  lens.fStop = 8;
  lens.filmGauge = 24;
  lens.sensorFit = 'vertical';
  lens.apply({ camera, dof, aspect: 0.5 });
  near(camera.fov, 2 * Math.atan(24 / 70) * 180 / Math.PI);
  assert.equal(dof.options.aperture, 8);
  assert.equal(dof.options.filmGauge, 24);
  assert.equal(dof.options.sensorFit, 'vertical');
  assert.equal(dof.options.focalLength, 0.035);
});

test('default focus and f-number follow the thin-lens circle-of-confusion relationship', () => {
  const lens = new PhysicalLens(), pose = createPose(), dof = { options: {} };
  lens.update(pose, 0, { aspect: 2 });
  assert.equal(pose.focusDistance, 5);
  lens.apply({ dof });
  const blur = () => new PhysicalCamera({ focalLength: dof.options.focalLength * 1000,
    focusDistance: dof.options.focalDistance, aperture: dof.options.aperture }).blurDiameter(20);
  const wide = blur();
  lens.fStop *= 2;
  lens.apply({ dof });
  near(blur(), wide / 2);
});

test('invalid construction and live edits reject atomically with a help link', () => {
  for (const key of ['focalLength', 'filmGauge', 'fStop', 'focusDistance'])
    for (const value of [0, -1, NaN, Infinity]) assert.throws(() => new PhysicalLens({ [key]: value }), RangeError);
  assert.throws(() => new PhysicalLens({ sensorFit: 'diagonal' }), RangeError);
  const lens = new PhysicalLens(), camera = { fov: 60 }, dof = { options: {} };
  for (const aspect of [0, NaN, Infinity]) assert.throws(() => lens.apply({ camera, dof, aspect }), /https:\/\//);
  assert.throws(() => lens.apply({ camera, dof, focusDistance: 0.05 }), RangeError);
  assert.equal(camera.fov, 60);
  assert.deepEqual(dof.options, {});
  lens.fStop = 0;
  assert.throws(() => lens.apply({ camera, dof }), RangeError);
});
