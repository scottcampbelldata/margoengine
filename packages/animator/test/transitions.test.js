import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimatorGraph } from '../dist/graph.js';
import { animatorDocument, animatorRun } from '../../../tests/support/animator-rig.js';

async function fixture(t, source = 'next', offset = 0) {
  const data = animatorDocument(
    { Root: [null, 0, 0, 0] },
    Object.fromEntries(
      ['A', 'B', 'C', 'D'].map((name, i) => [
        name,
        { duration: 2, fps: 1, tracks: { 'Root.translation': (s) => [i * 10 + s, 0, 0] } },
      ]),
    ),
  );
  const f = await animatorRun(data, { initial: 'a', states: { a: 'A' } });
  f.animator.dispose();
  const graph = AnimatorGraph.attach(f.animation, {
    initial: 'a',
    states: { a: 'A', b: 'B', c: 'C', d: 'D' },
    parameters: { go: 'trigger', current: 'trigger', next: 'trigger', follow: 'trigger' },
    transitions: [
      { from: 'a', to: 'b', conditions: [['go']], duration: 1, offset, interruptionSource: source },
      // The next-state transition deliberately appears first: source ordering must override declaration order.
      { from: 'b', to: 'd', conditions: [['next']], duration: 0.5 },
      { from: 'a', to: 'c', conditions: [['current']], duration: 0.5, interruptionSource: 'current' },
      { from: 'a', to: 'd', conditions: [['follow']], duration: 0.5 },
    ],
    events: [
      { state: 'b', time: 0.75, name: 'start' },
      { state: 'b', time: 0.8, name: 'later' },
    ],
  });
  t.after(() => {
    graph.dispose();
    f.release();
  });
  return { ...f, graph, step: (s) => graph.animator.onPreUpdate(s) };
}

test('offset enters destination at normalized time and emits events from that point', async (t) => {
  const f = await fixture(t, 'none', 0.75),
    heard = [];
  f.graph.on('event', (e) => heard.push(e.name));
  f.graph.trigger('go');
  f.step(0.1);
  assert.equal(f.graph.animator.entryTime, 1.5);
  assert.equal(f.graph.animator.time, 1.6);
  assert.deepEqual(heard, ['start', 'later']);
  assert.ok(Math.abs(f.translation(0)[0] - 1.16) < 1e-6);
  f.graph.trigger('next');
  f.step(0.1);
  assert.equal(f.graph.state, 'b', 'large offset does not finish the one-second fade');
  for (let i = 0; i < 4; i++) f.step(0.25);
  f.step(0);
  assert.equal(f.graph.state, 'd');
});

test('interruption sources select current, next and either precedence order without consuming rejected triggers', async (t) => {
  for (const [source, expected] of [
    ['current', 'c'],
    ['next', 'd'],
    ['both', 'c'],
    ['current-next', 'c'],
    ['next-current', 'd'],
    ['none', 'b'],
  ]) {
    const f = await fixture(t, source);
    f.graph.trigger('go');
    f.step(0.2);
    f.graph.trigger('current').trigger('next');
    const before = f.translation(0)[0];
    f.step(0);
    assert.equal(f.graph.state, expected, source);
    assert.equal(f.translation(0)[0], before, 'interrupted fade starts at the visible blended pose');
    if (expected === 'c') assert.equal(f.graph.get('next'), true);
    if (expected === 'd') assert.equal(f.graph.get('current'), true);
  }
});

// KB5322: bools, triggers and the transition that rules an interruption live in the graph, outside AnimatorState, so
// restoring the Animator alone kept the decisions taken after the snapshot.
test('a graph snapshot rewinds bools, triggers and the interruption rule with playback', async (t) => {
  const f = await fixture(t, 'current');
  f.graph.trigger('go');
  f.step(0.2);
  const saved = f.graph.captureState();
  assert.equal(saved.version, 1);
  // After the snapshot: a different interruption is taken (its rule is next), and a trigger is left set.
  f.graph.trigger('follow');
  f.step(0);
  assert.equal(f.graph.state, 'd');
  f.graph.trigger('current');
  f.graph.restoreState(JSON.parse(JSON.stringify(saved)));
  assert.equal(f.graph.state, 'b');
  assert.equal(f.graph.get('current'), false, 'a trigger set after the snapshot is cleared');
  // The restored rule is go's: only the current source (a) may interrupt, so b -> d (next) is refused.
  f.graph.trigger('next');
  f.step(0);
  assert.equal(f.graph.state, 'b', 'the interruption rule came back with the fade');
  f.graph.trigger('current');
  f.step(0);
  assert.equal(f.graph.state, 'c', 'the saved source a still supplies the interruption');
  assert.deepEqual(f.graph.captureState().triggers, ['next']);
});

test('a graph snapshot of another graph or a malformed one is refused before anything changes', async (t) => {
  const f = await fixture(t);
  const saved = f.graph.captureState();
  f.graph.trigger('go');
  for (const bad of [
    { ...saved, version: 2 },
    { ...saved, triggers: ['missing'] },
    { ...saved, triggers: 'go' },
    { ...saved, bools: { go: true } },
    { ...saved, active: 9 },
    { ...saved, active: 0.5 },
    { ...saved, source: { state: 'nowhere', time: 0 } },
    { ...saved, source: { state: 'a', time: -1 } },
    { ...saved, animator: { ...saved.animator, state: 'nowhere' } },
  ])
    assert.throws(() => f.graph.restoreState(bad), { name: 'MargoError', code: 'state' });
  assert.equal(f.graph.get('go'), true, 'a refused restore leaves the graph as it was');
  f.graph.dispose();
  assert.throws(() => f.graph.captureState(), { code: 'disposed' });
});

test('invalid offsets and policies reject before installing a graph', async (t) => {
  const f = await fixture(t);
  for (const extra of [{ offset: -0.1 }, { offset: 1.1 }, { offset: NaN }, { interruptionSource: 'elsewhere' }])
    assert.throws(
      () =>
        new AnimatorGraph(f.animation, {
          initial: 'a',
          states: { a: 'A', b: 'B' },
          transitions: [{ from: 'a', to: 'b', exitTime: 0, ...extra }],
        }),
      /offset|interruption/i,
    );
});

test('chained interruptions keep the selected source and validate saved source clocks', async (t) => {
  const f = await fixture(t, 'current');
  f.graph.trigger('go');
  f.step(0.2);
  const saved = f.graph.animator.captureState();
  assert.equal(saved.fade.fromTime, 0);
  saved.fade.fromTime = NaN;
  assert.throws(() => f.graph.animator.restoreState(saved), { code: 'state' });
  f.graph.trigger('current');
  f.step(0.1);
  assert.equal(f.graph.state, 'c');
  f.graph.trigger('follow');
  f.step(0);
  assert.equal(f.graph.state, 'd', 'A supplies both interruptions although B was the first destination');
});
