import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createBoneMask, addWeightedLayer } from '../dist/masks.js';
import { StateLayer } from '../dist/layers.js';
import { animatorDocument, animatorRun } from '../../../tests/support/animator-rig.js';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
const quat = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
async function rig(t) {
  const data = animatorDocument(
    { Root: [null, 0, 0, 0], Spine: ['Root', 0, 0, 0], Hand: ['Spine', 0, 0, 0] },
    {
      Base: {
        duration: 2,
        fps: 1,
        tracks: {
          'Root.translation': (s) => [s, 0, 0],
          'Root.weights': () => [0.2, 0.4],
          'Spine.translation': () => [0, 2, 0],
          'Spine.scale': () => [2, 2, 2],
          'Spine.rotation': () => quat(Math.PI / 6),
        },
      },
      Pose: {
        duration: 2,
        fps: 1,
        tracks: {
          'Root.translation': () => [9, 0, 0],
          'Root.weights': () => [0.6, 0.8],
          'Spine.translation': () => [0, 4, 0],
          'Spine.scale': () => [3, 5, 7],
          'Spine.rotation': () => quat(Math.PI / 2),
          'Hand.translation': () => [0, 8, 0],
          'Hand.scale': () => [5, 5, 5],
          'Hand.rotation': () => quat(Math.PI),
        },
      },
    },
  );
  data.doc.meshes[0].weights = [0.1, 0.2];
  data.doc.meshes[0].primitives[0].targets = [{ POSITION: 0 }, { POSITION: 0 }];
  const f = await animatorRun(data, { initial: 'base', states: { base: 'Base' } });
  t.after(() => f.release());
  return f;
}
test('soft masks multiply layer strength for translation, scale, shortest-arc rotation and live edits', async (t) => {
  const f = await rig(t),
    mask = createBoneMask(3, [
      [1, 0.25],
      [2, 0.75],
    ]);
  const layer = addWeightedLayer(f.animator, { clip: 'Pose', mask, weight: 0.5 });
  assert.ok(layer instanceof StateLayer, 'optional entries share the same layer identity');
  f.step(0.25);
  close(f.translation(0)[0], 0.25);
  close(f.translation(1)[1], 2.25);
  close(f.translation(2)[1], 3);
  close(f.node(1).scale.x, 2.125);
  close(f.node(2).scale.x, 2.5);
  close(f.rotation(1)[2], Math.sin((37.5 * Math.PI) / 360));
  close(f.rotation(2)[2], Math.sin((67.5 * Math.PI) / 360));
  mask[1] = 1;
  layer.weight = 1;
  f.step(0);
  close(f.translation(1)[1], 4);
  close(f.node(1).scale.x, 3);
  close(f.rotation(1)[2], Math.SQRT1_2);
  mask[1] = 0;
  f.step(0);
  close(f.translation(1)[1], 2);
  layer.dispose();
  f.step(0);
  close(f.translation(2)[1], 0);
});
test('additive graph masks apply per-bone deltas and include morph weights', async (t) => {
  const f = await rig(t),
    mask = createBoneMask(3, [
      [0, 0.5],
      [1, 0.25],
      [2, 0.75],
    ]);
  const layer = addWeightedLayer(f.animator, {
    graph: { initial: 'pose', states: { pose: 'Pose' } },
    mask,
    weight: 0.5,
    blend: 'additive',
  });
  f.step(0.25);
  close(f.translation(1)[1], 2.5);
  close(f.node(1).scale.x, 2.5);
  close(f.rotation(1)[2], Math.sin((41.25 * Math.PI) / 360));
  close(f.model.primitives[0].weights[0], 0.325);
  close(f.model.primitives[0].weights[1], 0.55);
  layer.blend = 'override';
  f.step(0);
  close(f.model.primitives[0].weights[0], 0.3);
  close(f.model.primitives[0].weights[1], 0.5);
});
test('invalid masks reject at creation or the next frame without changing stored transforms', async (t) => {
  for (const entries of [
    [[0, -1]],
    [[0, 1.1]],
    [[0, NaN]],
    [[3, 1]],
    [
      [0, 1],
      [0, 0.5],
    ],
  ])
    assert.throws(() => createBoneMask(3, entries), RangeError);
  const f = await rig(t);
  assert.throws(() => addWeightedLayer(f.animator, { clip: 'Pose', mask: new Float32Array(2) }), RangeError);
  const mask = createBoneMask(3, [], 1),
    layer = addWeightedLayer(f.animator, { clip: 'Pose', mask });
  f.step(0.1);
  const before = f.translation(1);
  mask[1] = Infinity;
  assert.throws(() => f.step(0), RangeError);
  assert.deepEqual(f.translation(1), before);
  layer.dispose();
  assert.equal(f.animation.playing, false);
});

test('mask builder alone tree-shakes graph playback and pose composition', async () => {
  const path = fileURLToPath(new URL('../dist/masks.js', import.meta.url)).replaceAll('\\', '/');
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'mask-builder-only',
        resolveId(id) {
          if (id.replaceAll('\\', '/').endsWith('mask-builder-only')) return '\0mask-builder-only';
        },
        load(id) {
          if (id === '\0mask-builder-only') return `export {createBoneMask} from ${JSON.stringify(path)};`;
        },
      },
    ],
    build: { write: false, minify: true, target: 'es2022', lib: { entry: 'mask-builder-only', formats: ['es'] } },
  });
  const code = result[0].output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n');
  assert.ok(code.includes('Bone mask entries'));
  assert.ok(
    !code.includes('State layer needs') && !code.includes('Animator graph') && !code.includes('Invalid animator'),
  );
});
