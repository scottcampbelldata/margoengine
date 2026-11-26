import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core/extension';
import { HologramRig, HologramOutput, HOLOGRAM_VIEWS } from '../dist/hologram.js';
import { CameraProjection } from '../dist/index.js';

const close = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${label}: ${a} vs ${b}`));

test('four cameras sit a quarter turn apart around the target at the source height and distance', () => {
  const source = new Camera({ position: [0, 3, 4], target: [0, 1, 0] }),
    rig = new HologramRig();
  rig.update(source);
  close(rig.front.position, [0, 3, 4], 'front');
  close(rig.back.position, [0, 3, -4], 'back');
  close(rig.right.position, [4, 3, 0], 'right');
  close(rig.left.position, [-4, 3, 0], 'left');
  for (const side of ['front', 'back', 'left', 'right']) {
    close(rig[side].target, [0, 1, 0], side + ' target');
    assert.equal(rig[side].fov, source.fov);
  }
  rig.options.distance = Math.hypot(4, 2) * 2;
  rig.update(source);
  close(rig.front.position, [0, 5, 8], 'scaled front');
  close(rig.right.position, [8, 5, 0], 'scaled right');
  assert.deepEqual(source.position, [0, 3, 4]);
});

test('a source projection is kept with a square aspect, and bad geometry fails with a help link', () => {
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] }),
    projection = new CameraProjection({ height: 4 });
  projection.attach(camera);
  const rig = new HologramRig();
  rig.update(camera);
  // Orthographic height 4: a point 1 above the target lands at y = 0.5 in every view, whatever aspect is passed.
  const y = (c, aspect) => {
    c.update(aspect, true);
    const m = c.matrix;
    return (m[5] + m[13]) / (m[7] + m[15]);
  };
  assert.ok(Math.abs(y(rig.left, 3) - 0.5) < 1e-9);
  assert.ok(Math.abs(y(camera, 1) - 0.5) < 1e-9);
  projection.dispose();
  for (const distance of [0, -1, NaN, Infinity])
    assert.throws(
      () => new HologramRig({ distance }).update(new Camera()),
      (e) => e instanceof RangeError && /errors#camera-hologram/.test(e.message),
    );
  const down = new Camera({ position: [0, 5, 0], target: [0, 0, 0] });
  down.up = [0, 0, -1];
  new HologramRig().update(down); // a top-down camera with a tilted up still works
});

test('orientations default to mirrored, outward-facing views and reject bad sides, turns, gaps and use after dispose', () => {
  const output = new HologramOutput({});
  assert.deepEqual(output.orientations(), HOLOGRAM_VIEWS);
  assert.deepEqual(HOLOGRAM_VIEWS.front, { rotation: 180, mirror: true });
  output.options.views = { left: { rotation: 0 } };
  assert.deepEqual(output.orientations().left, { rotation: 0, mirror: true });
  output.options.views = { top: {} };
  assert.throws(() => output.orientations(), TypeError);
  output.options.views = { front: { rotation: 45 } };
  assert.throws(() => output.orientations(), TypeError);
  output.options.views = undefined;
  for (const gap of [-0.1, 1, NaN]) {
    output.options.gap = gap;
    assert.throws(() => output.render(), RangeError);
  }
  output.options.gap = 0.2;
  // The shared hex parser (math/color) also reads alpha forms; the background takes only #rgb and #rrggbb.
  for (const background of ['black', '#ffffff80', '#ffff', '123456', '#12345g']) {
    output.options.background = background;
    assert.throws(() => output.render(), TypeError, background);
  }
  for (const background of ['#AbC', '#102030']) {
    output.options.background = background;
    assert.throws(
      () => output.render(),
      (e) => e.code === 'unsupported',
      background,
    );
  }
  output.options.background = false;
  assert.throws(
    () => output.render(),
    (e) => e.code === 'unsupported',
  );
  assert.throws(() => output.render(-1), RangeError);
  output.dispose();
  output.dispose();
  assert.throws(
    () => output.render(),
    (e) => e.code === 'disposed' && /errors#camera-hologram/.test(e.message),
  );
  const attached = HologramOutput.attach({}, { distance: 3 });
  assert.equal(attached.rig.options.distance, 3);
  attached[Symbol.dispose]();
});
