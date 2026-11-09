import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { engine, model } from './support/models.js';
import { animatorGLB, animatorRun, RIGGED_FIGURE } from '../../../tests/support/animator-rig.js';

const robot = new URL('../../../examples/assets/robot-expressive.glb', import.meta.url);

test('RobotExpressive root morph diagnostic names actual mesh nodes and does not mutate weights', async () => {
  using e = await engine();
  const m = model(e, animatorGLB(robot)),
    a = new Animation(m),
    before = m.primitives.map((p) => p.weights.slice());
  const morphed = m.primitives.find((p) => p.weights.length);
  assert.ok(morphed && morphed.nodeIndex !== 0);
  assert.throws(
    () => a.setMorph(0, 0, 0.8),
    (error) =>
      error instanceof RangeError &&
      error.message.includes(`node ${morphed.nodeIndex}: ${morphed.weights.length} targets`) &&
      /https:\/\/margoengine.com\/errors#geometry/.test(error.message),
  );
  assert.deepEqual(
    m.primitives.map((p) => p.weights),
    before,
  );
  a.setMorph(morphed.nodeIndex, 0, 0.8);
  assert.equal(morphed.weights[0], Math.fround(0.8));
  a.dispose();
  m.dispose();
});

test('RiggedFigure unnamed clip uses its documented indexed name; explicit empty names survive', async () => {
  using e = await engine();
  const data = animatorGLB(RIGGED_FIGURE);
  assert.equal(data.doc.animations[0].name, undefined);
  const m = model(e, data),
    a = new Animation(m);
  assert.equal(a.clips[0].name, 'Animation 0');
  a.play('Animation 0');
  a.seek(0.1);
  a.dispose();
  m.dispose();
  data.doc.animations[0].name = '';
  const named = model(e, data),
    b = new Animation(named);
  assert.equal(b.clips[0].name, '');
  b.play('');
  b.dispose();
  named.dispose();
});

test('Khronos MorphStressTest target names resolve across mesh nodes and missing names do not change weights', async () => {
  using e = await engine();
  const m = model(
    e,
    animatorGLB(new URL('../../../examples/assets/khronos/MorphStressTest/MorphStressTest.glb', import.meta.url)),
  );
  const a = new Animation(m),
    p = m.primitives.find((p) => p.weights.length);
  assert.equal(p.targetNames.length, 8);
  const name = p.targetNames[3];
  a.setMorph(name, 0.75);
  assert.equal(p.weights[3], 0.75);
  const before = m.primitives.map((p) => p.weights.slice());
  assert.throws(() => a.setMorph('not a target', 1), /available node/);
  assert.throws(() => a.setMorph(name, Infinity), RangeError);
  assert.deepEqual(
    m.primitives.map((p) => p.weights),
    before,
  );
  a.dispose();
  m.dispose();
});

test('RobotExpressive disconnected foot chain is rejected before installing any IK', async () => {
  const data = animatorGLB(robot),
    clip = data.doc.animations[0].name ?? 'Animation 0';
  const f = await animatorRun(data, { initial: 'idle', states: { idle: clip } });
  try {
    assert.throws(
      () =>
        f.animator.addFootIK({
          hip: 55,
          knee: 57,
          ankle: 3,
          pole: [0, 0, 1],
          raycast() {
            return null;
          },
        }),
      { name: 'MargoError', code: 'unsupported', message: /hip\/knee\/ankle ancestry/ },
    );
    f.step(); // Rejection leaves the existing animator usable.
  } finally {
    f.release();
  }
});

test('native WebGL2 preview rejects PBR setup explicitly rather than installing an empty drawing pass', async () => {
  using e = await engine();
  const m = model(e, animatorGLB(RIGGED_FIGURE));
  assert.throws(() => e.use(m), { name: 'MargoError', code: 'unsupported', message: /WebGPU/ });
  assert.equal(e.hasPlugin(m.name), false);
  m.dispose();
});
