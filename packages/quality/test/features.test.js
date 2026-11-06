import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureScaler, featureKnobs, optionKnob, watchFeatures } from '../dist/features.js';

/** A scene whose frame cost is `base` plus each knob's cost at its level. `table` is {name: [cost at level 0, 1, ...]}. */
function scene(table, base = 2, weights = {}) {
  const levels = Object.fromEntries(Object.keys(table).map((name) => [name, 0])),
    applied = [],
    knobs = Object.keys(table).map((name) => ({
      name,
      levels: table[name].length,
      weight: weights[name],
      apply(level) {
        levels[name] = level;
        applied.push([name, level]);
      },
    }));
  return {
    knobs,
    levels,
    applied,
    state: { base },
    cost() {
      return Object.keys(table).reduce((sum, name) => sum + table[name][levels[name]], this.state.base);
    },
    run(scaler, frames) {
      const changes = [];
      for (let i = 0; i < frames; i++) {
        const change = scaler.push(this.cost());
        if (change) changes.push(change);
      }
      return changes;
    },
  };
}
const quick = { window: 5, settle: 1 };

test('inside the budget nothing changes', () => {
  const s = scene({ a: [4, 1], b: [4, 1] }),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick });
  assert.deepEqual(s.run(scaler, 200), []);
  assert.deepEqual(scaler.levels, { a: 0, b: 0 });
});

test('over budget it lowers features until the frame fits, then stops', () => {
  const s = scene({ a: [6, 3, 1], b: [8, 2] }),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick });
  s.run(scaler, 200);
  assert.ok(s.cost() <= 12, `frame costs ${s.cost()}`);
  const settled = { ...s.levels };
  assert.deepEqual(s.run(scaler, 500), [], 'it settles');
  assert.deepEqual(s.levels, settled);
});

test('a step that saves nothing is measured, given back and left alone', () => {
  const s = scene({ useless: [0, 0], real: [20, 4] }),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick }),
    changes = s.run(scaler, 100);
  assert.deepEqual(changes.slice(0, 3), [
    { name: 'useless', level: 1 },
    { name: 'useless', level: 0 },
    { name: 'real', level: 1 },
  ]);
  assert.deepEqual(scaler.levels, { useless: 0, real: 1 }, 'no quality is lost for nothing');
  assert.deepEqual(scaler.costs, [
    { name: 'useless', level: 0, saved: 0 },
    { name: 'real', level: 0, saved: 16 },
  ]);
});

test('the cost is what was measured: the second time the step that covers it goes first', () => {
  const s = scene({ small: [2, 1], big: [12, 2] }, 6),
    scaler = new FeatureScaler(s.knobs, { budget: 16, ...quick }),
    changes = s.run(scaler, 100);
  assert.deepEqual(
    changes.slice(0, 2).map(({ name }) => name),
    ['small', 'big'],
    'with nothing known it tries them in order',
  );
  assert.deepEqual(scaler.levels, { small: 0, big: 1 }, 'the small step fits back in beside the big one');
  s.state.base = 0.1;
  s.run(scaler, 1000);
  assert.deepEqual(scaler.levels, { small: 0, big: 0 }, 'a light scene brings the big one back too');
  s.applied.length = 0;
  s.state.base = 6;
  s.run(scaler, 100);
  assert.deepEqual(s.applied[0], ['big', 1], 'the small step is known not to be enough');
  assert.deepEqual(scaler.levels, { small: 0, big: 1 });
});

test('of two steps that would do, the less visible one goes', () => {
  const s = scene({ loud: [6, 1], quiet: [6, 1] }, 18, { loud: 3, quiet: 1 }),
    scaler = new FeatureScaler(s.knobs, { budget: 20, ...quick });
  s.run(scaler, 100);
  assert.deepEqual(scaler.levels, { loud: 1, quiet: 1 });
  s.state.base = 0.1;
  s.run(scaler, 2000);
  assert.deepEqual(scaler.levels, { loud: 0, quiet: 0 });
  s.applied.length = 0;
  s.state.base = 11.9;
  s.run(scaler, 100);
  assert.deepEqual(s.applied[0], ['quiet', 1]);
  assert.deepEqual(scaler.levels, { loud: 0, quiet: 1 });
});

test('a feature comes back only when its measured cost fits, most visible first', () => {
  const s = scene({ quiet: [4, 0], loud: [4, 0] }, 12, { quiet: 1, loud: 3 }),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick });
  s.run(scaler, 100);
  assert.deepEqual(scaler.levels, { quiet: 1, loud: 1 });
  s.state.base = 7.5; // 62% of the budget, but one feature back would reach 96%, above the 90% margin
  assert.deepEqual(s.run(scaler, 400), []);
  s.state.base = 6;
  s.run(scaler, 400);
  assert.deepEqual(scaler.levels, { quiet: 1, loud: 0 }, 'one fits; the other would leave the frame at 83%, not under 70%');
});

test('a rise that had to be undone waits longer, so it settles', () => {
  const s = scene({ a: [8, 1] }, 8),
    scaler = new FeatureScaler(s.knobs, { budget: 10, window: 5, settle: 0, minSaving: 0 });
  s.run(scaler, 30);
  assert.equal(s.levels.a, 1);
  // The cost it remembers is too low for the scene now, so rises keep failing until the mean corrects.
  s.state.base = 4;
  const changes = s.run(scaler, 2000).length;
  assert.ok(changes < 12, `${changes} changes in 400 decisions`);
});

test('a lower budget is taken up at the next decision, and reset puts everything back', () => {
  const s = scene({ a: [6, 1] }),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick });
  s.run(scaler, 50);
  assert.equal(s.levels.a, 0);
  scaler.budget = 6;
  s.run(scaler, 50);
  assert.equal(s.levels.a, 1);
  scaler.reset();
  assert.deepEqual(s.applied.at(-1), ['a', 0]);
  assert.equal(scaler.levels.a, 0);
});

test('restart drops the window and the step on trial, keeping what was learned', () => {
  const s = scene({ a: [10, 1] }),
    scaler = new FeatureScaler(s.knobs, { budget: 10, ...quick });
  s.run(scaler, 6);
  assert.equal(s.levels.a, 1);
  scaler.restart();
  s.state.base = 100; // a new scene during the trial must not count as the step costing more
  s.run(scaler, 7);
  assert.equal(scaler.costs[0].saved, undefined);
});

test('bad samples are ignored and bad options refused', () => {
  const s = scene({ a: [6, 1] }),
    scaler = new FeatureScaler(s.knobs, { budget: 1, window: 2, settle: 0 });
  assert.equal(scaler.push(Number.NaN), undefined);
  assert.equal(scaler.push(-1), undefined);
  assert.equal(scaler.push(Infinity), undefined);
  assert.equal(scaler.push(9), undefined, 'first real sample of the window');
  for (const options of [{ budget: 0 }, { window: 0 }, { window: 1.5 }, { settle: -1 }, { minSaving: 1 }])
    assert.throws(() => new FeatureScaler([], options), RangeError, JSON.stringify(options));
  const apply = () => {};
  for (const knobs of [
    [{ name: 'a', levels: 1, apply }],
    [{ name: '', levels: 2, apply }],
    [{ name: 'a', levels: 2, apply, weight: 0 }],
    [
      { name: 'a', levels: 2, apply },
      { name: 'a', levels: 2, apply },
    ],
  ])
    assert.throws(() => new FeatureScaler(knobs), RangeError);
});

test('every lowered knob at the floor leaves the scaler quiet', () => {
  const s = scene({ a: [1, 0] }, 50),
    scaler = new FeatureScaler(s.knobs, { budget: 12, ...quick, minSaving: 0 });
  s.run(scaler, 50);
  assert.equal(s.levels.a, 1);
  assert.deepEqual(s.run(scaler, 200), []);
});

test('watchFeatures times submits, reports changes, and dispose restores the knob and the queue', async () => {
  let time = 0,
    done = [];
  const submit = () => 'submitted',
    queue = { submit, onSubmittedWorkDone: () => new Promise((resolve) => done.push(resolve)) },
    target = { samples: 32 },
    changes = [],
    watch = watchFeatures([optionKnob('samples', target, 'samples', [32, 8])], {
      budget: 10,
      window: 2,
      settle: 0,
      queue,
      now: () => time,
      onChange: (change) => changes.push(change),
    });
  for (let i = 0; i < 2; i++) {
    assert.equal(queue.submit([]), 'submitted');
    time += 20;
    for (const resolve of done.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.deepEqual(changes, [{ name: 'samples', level: 1 }]);
  assert.equal(target.samples, 8);
  watch.dispose();
  watch.dispose();
  assert.equal(target.samples, 32);
  assert.equal(queue.submit, submit);
  assert.deepEqual(watch.scaler.levels, { samples: 0 });
});

test('without a queue it times animation frames, ignoring long gaps', () => {
  const frames = [],
    target = { on: true },
    watch = watchFeatures([optionKnob('on', target, 'on', [true, false])], {
      budget: 10,
      window: 2,
      settle: 0,
      queue: null,
      request: (callback) => frames.push(callback),
    });
  let time = 0;
  const step = (gap) => {
    time += gap;
    frames.shift()(time);
  };
  step(16);
  step(5000);
  step(20);
  assert.equal(target.on, true, 'the long gap did not count');
  step(20);
  assert.equal(target.on, false);
  watch.dispose();
  assert.equal(frames.length, 1);
  step(16);
  assert.equal(frames.length, 0, 'the loop stops');
});

test('featureKnobs starts from what the app set and turns down what it can', () => {
  const bloom = { name: 'bloom', enabled: true },
    off = { name: 'dof', enabled: false },
    ssao = { enabled: true, options: { samples: 16 } },
    ssr = { enabled: true, options: {} },
    shadows = { options: { filter: 'pcf', distance: 100 } },
    lod = { bias: 2 },
    camera = { far: 1000, near: 0.1 },
    knobs = featureKnobs({ post: [bloom, off], ssao, ssr, shadows, lod, camera });
  assert.deepEqual(
    knobs.map(({ name, levels, weight }) => [name, levels, weight]),
    [
      ['bloom', 2, 1],
      ['ssao', 4, 1],
      ['ssr', 4, 1],
      ['shadow filter', 2, 1.5],
      ['shadow distance', 3, 1.5],
      ['level of detail', 3, 2],
      ['view distance', 3, 3],
    ],
  );
  const by = Object.fromEntries(knobs.map((knob) => [knob.name, knob]));
  by.bloom.apply(1);
  assert.equal(bloom.enabled, false);
  by.ssao.apply(2);
  assert.deepEqual([ssao.enabled, ssao.options.samples], [true, 4]);
  by.ssao.apply(3);
  assert.equal(ssao.enabled, false);
  by.ssao.apply(0);
  assert.deepEqual([ssao.enabled, ssao.options.samples], [true, 16]);
  by.ssr.apply(1);
  assert.equal(ssr.options.steps, 32, 'the package default is the start');
  by['shadow filter'].apply(1);
  assert.equal(shadows.options.filter, 'hard');
  by['shadow distance'].apply(2);
  assert.equal(shadows.options.distance, 50);
  by['level of detail'].apply(2);
  assert.equal(lod.bias, 4);
  by['view distance'].apply(1);
  assert.equal(camera.far, 750);
});

test('featureKnobs leaves out what cannot go lower', () => {
  assert.deepEqual(featureKnobs({}), []);
  assert.deepEqual(
    featureKnobs({
      ssao: { enabled: false, options: {} },
      shadows: { options: { filter: 'hard' } },
      camera: { far: 1, near: 0.9 },
    }),
    [],
  );
});
