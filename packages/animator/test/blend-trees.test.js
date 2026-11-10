import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlendTree, blendGradient2D } from '../dist/blend-trees.js';
import { AnimatorGraph } from '../dist/graph.js';
import { animatorDocument, animatorRun } from '../../../tests/support/animator-rig.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
const points = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [-1, 0],
  [0, -1],
];
test('gradient bands reproduce samples, interpolate radial speeds and separate directional from cartesian', () => {
  for (const mode of ['cartesian', 'directional']) {
    points.forEach((p, index) =>
      assert.deepEqual(
        [...blendGradient2D(points, ...p, mode)],
        points.map((_, i) => +(i === index)),
      ),
    );
    for (let x = -2; x <= 2; x += 0.125)
      for (let y = -2; y <= 2; y += 0.125) {
        const w = blendGradient2D(points, x, y, mode);
        assert.ok([...w].every((n) => n >= 0 && n <= 1 && Number.isFinite(n)));
        close(
          w.reduce((a, b) => a + b),
          1,
        );
      }
  }
  assert.deepEqual([...blendGradient2D(points, 0, 1.5, 'directional')], [0, 0.5, 0.5, 0, 0, 0]);
  assert.notDeepEqual([...blendGradient2D(points, 0.6, 0.7, 'directional')], [...blendGradient2D(points, 0.6, 0.7)]);
  const reference = blendGradient2D(points, 0.6, 0.7, 'directional');
  const rotated = points.map(([x, y]) => [-y * 5, x * 5]);
  blendGradient2D(rotated, -3.5, 3, 'directional').forEach((v, i) => close(v, reference[i]));
  assert.deepEqual(
    [
      ...blendGradient2D(
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        0.5,
        0.5,
      ),
    ],
    [0.25, 0.25, 0.25, 0.25],
  );
});

const nested = () => ({
  type: 'direct',
  children: [
    { parameter: 'base', tree: 'A' },
    {
      parameter: 'motion',
      tree: {
        type: '1d',
        parameter: 'speed',
        samples: [
          { value: 0, tree: 'A' },
          { value: 1, tree: 'B' },
        ],
      },
    },
  ],
});
test('nested direct trees normalize locally, combine duplicate clips and retain zero-weight rest', () => {
  const tree = createBlendTree(nested());
  assert.deepEqual(tree.samples, [{ clip: 'A' }, { clip: 'B' }]);
  assert.deepEqual([...tree.weights({ base: 1, motion: 3, speed: 0.5 })], [0.625, 0.375]);
  assert.deepEqual([...tree.weights({ base: -1, motion: 0, speed: 0.5 })], [0, 0]);
  assert.deepEqual([...tree.weights({ base: 1e308, motion: 1e308, speed: 1 })], [0.5, 0.5]);
  assert.throws(() => tree.weights({ motion: NaN }), RangeError);
  const cycle = { type: 'direct', children: [] };
  cycle.children.push({ parameter: 'a', tree: cycle });
  assert.throws(() => createBlendTree(cycle), /acyclic/);
  assert.throws(
    () =>
      blendGradient2D(
        [
          [0, 0],
          [0, 0],
        ],
        1,
        1,
      ),
    /unique/,
  );
  assert.throws(
    () =>
      createBlendTree({
        type: '1d',
        parameter: 's',
        samples: [
          { value: 1, tree: 'A' },
          { value: 0, tree: 'B' },
        ],
      }),
    RangeError,
  );
});

test('compiled trees play in Animator and typed graphs, including duration and live parameters', async (t) => {
  const data = animatorDocument(
    { Root: [null, 0, 0, 0] },
    {
      A: { duration: 1, fps: 1, tracks: { 'Root.translation': () => [2, 0, 0] } },
      B: { duration: 2, fps: 1, tracks: { 'Root.translation': () => [6, 0, 0] } },
    },
  );
  const tree = createBlendTree(nested());
  const f = await animatorRun(data, {
    initial: 'blend',
    states: { blend: tree },
    parameters: { base: 1, motion: 3, speed: 0.5 },
  });
  t.after(() => f.release());
  f.step(0.5);
  close(f.translation(0)[0], 3.5);
  close(f.animator.normalizedTime, 0.25);
  f.animator.parameters.speed = 1;
  f.step(0);
  close(f.translation(0)[0], 5);
  f.animator.parameters.base = f.animator.parameters.motion = 0;
  f.step(0);
  close(f.translation(0)[0], 0);
  const graph = new AnimatorGraph(f.animation, {
    initial: 'blend',
    states: { blend: tree },
    parameters: { base: 'float', motion: 'float', speed: 'float' },
  });
  graph.set('base', 1).set('motion', 1).set('speed', 1);
  const pose = graph.animator.onPreUpdate(0, true);
  close(pose.position[0][0], 4);
  graph.dispose();
});
