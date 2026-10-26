import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, blend1D, blend2D, solveTwoBoneIK } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

// Every animator error names its fix: a '; ' clause or a fix verb, so the message says what to do.
const namesFix = /;|\b(pass|use|give|set|call|create)\b/i;
const throwsFix = (fn, Class, pattern) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Class, `${error.name}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.match(error.message, namesFix);
    return true;
  });

test('blend helpers: weights, and errors that say what to pass', () => {
  assert.deepEqual([...blend1D([0, 1, 3], 2)], [0, 0.5, 0.5]);
  assert.deepEqual([...blend1D([0, 1], -5)], [1, 0]);
  assert.deepEqual(
    [
      ...blend2D(
        [
          [0, 0],
          [1, 0],
        ],
        0,
        0,
      ),
    ],
    [1, 0],
  );
  throwsFix(() => blend1D([1, 1], 0), RangeError, /Invalid 1D blend samples; pass .*increasing/);
  throwsFix(() => blend1D([], 0), RangeError, /Invalid 1D blend samples/);
  throwsFix(
    () =>
      blend2D(
        [
          [0, 0],
          [0, 0],
        ],
        0,
        0,
      ),
    RangeError,
    /Invalid 2D blend samples; pass .*without duplicates/,
  );
});

test('solveTwoBoneIK: reaches the target, and a zero-length bone says to give distinct positions', () => {
  const { ankle } = solveTwoBoneIK([0, 1, 0], [0, 0.5, 0.1], [0, 0, 0], [0, 0.4, 0], [0, 0.5, 1]);
  assert.ok(Math.hypot(ankle[0], ankle[1] - 0.4, ankle[2]) < 1e-6);
  throwsFix(
    () => solveTwoBoneIK([0, 1, 0], [0, 1, 0], [0, 0, 0], [0, 0.4, 0], [0, 0.5, 1]),
    RangeError,
    /IK bones have zero length; give .*distinct positions/,
  );
});

async function scene(options) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    { doc, buffers } = animatedTriangle(),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers)),
    animation = new Animation(model);
  return { engine, model, animation, animator: options && new Animator(animation, options) };
}

test('Animator constructor, transition, layer and foot IK errors name their fix', async (t) => {
  const f = await scene({ initial: 'a', states: { a: 'Move', b: 'Move' } });
  t.after(() => {
    f.animator.dispose();
    f.animation.dispose();
    f.model.dispose();
  });
  throwsFix(() => new Animator(f.animation, { initial: 'x', states: {} }), TypeError, /Invalid animator states; pass/);
  throwsFix(
    () => new Animator(f.animation, { initial: '', states: { '': 'Move' } }),
    TypeError,
    /Empty animator state; give/,
  );
  throwsFix(
    () => new Animator(f.animation, { initial: 'a', states: { a: 'Nope' } }),
    RangeError,
    /Unknown animator clip "Nope"; use a clip name from animation\.clips/,
  );
  throwsFix(
    () =>
      new Animator(f.animation, {
        initial: 'a',
        states: { a: 'Move' },
        transitions: [{ from: 'a', to: 'z', when: () => true }],
      }),
    TypeError,
    /Invalid animator transition; use/,
  );
  throwsFix(() => f.animator.transition('zzz'), RangeError, /Invalid animator transition; pass a state name/);
  throwsFix(
    () => f.animator.addLayer({ clip: 'Move', weight: 2, mask: [] }),
    RangeError,
    /Invalid animator layer; use a weight from 0 to 1/,
  );
  throwsFix(
    () => f.animator.addFootIK({ hip: 99, knee: 0, ankle: 0, pole: [0, 0, 1], raycast() {} }),
    TypeError,
    /Invalid foot IK; pass hip/,
  );
  throwsFix(
    () => f.animator.addFootIK({ hip: 0, knee: 0, ankle: 1, pole: [0, 0, 1], raycast() {} }),
    TypeError,
    /IK requires a direct hip\/knee\/ankle chain; pass/,
  );
  // The Animation is not an engine plugin yet, so setup fails with a coded state error.
  assert.throws(
    () => f.animator.setup(f.engine),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'state' &&
      /Attach Animation before its Animator; call Animation\.attach/.test(error.message),
  );
  f.animator.onPreUpdate(0);
  throwsFix(() => f.animator.onPreUpdate(-1), RangeError, /Invalid animator delta; pass a finite delta of 0 or more/);
  f.animator.parameters.speed = Number.NaN;
  throwsFix(() => f.animator.onPreUpdate(0.1), RangeError, /Invalid blend parameter; set every/);
});
