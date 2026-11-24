import assert from 'node:assert/strict';
import test from 'node:test';
import { Cutscene, CutscenePlayer, validateCutscene } from '@margoengine/cutscene';
import {
  VfxDirector,
  activationTrack,
  activeOf,
  applyActivation,
  effectsOf,
  vfxTrack,
} from '@margoengine/cutscene/vfx';

const STEP = 1 / 60;
const doc = (tracks, extra = {}) => ({ format: 'margo-cutscene', version: 1, duration: 10, tracks, ...extra });
const types = [vfxTrack(), activationTrack()];
const build = (tracks, extra) => new Cutscene(doc(tracks, extra), { tracks: types });
const sparks = (clips, extra = {}) => ({ type: 'vfx', id: 'fx', target: 'sparks', clips, ...extra });
const door = (clips, extra = {}) => ({ type: 'activation', id: 'on', target: 'door', clips, ...extra });

/**
 * A stand-in for a GPU effect: a log of what the simulation would have done. Each frame it notes the rate in force and
 * the bursts waiting, so two runs that would give the same particles give the same log.
 */
function fakeEffect(rate = 100) {
  return {
    options: { rate },
    pending: 0,
    log: [],
    resets: 0,
    burst(count) {
      this.pending += count;
    },
    reset() {
      this.resets++;
      this.log = [];
      this.pending = 0;
    },
    frame() {
      this.log.push([this.options.rate, this.pending]);
      this.pending = 0;
    },
  };
}
const director = (cutscene, effect, options) =>
  new VfxDirector(cutscene, { sparks: effect }, { step: () => effect.frame(), ...options });
/** Plays frames from..to, as a game loop does: apply, then draw. */
const play = (cutscene, run, effect, from, to) => {
  for (let i = from; i < to; i++) {
    run.apply(cutscene.evaluate(i * STEP));
    effect.frame();
  }
};

test('the state says what runs and what shows at any time', () => {
  const cutscene = build([
    sparks([{ start: 1, duration: 2, rate: 50 }]),
    door([{ start: 2, duration: 1 }]),
    door([{ start: 0, duration: 1 }], { id: 'off', target: 'lamp', invert: true }),
  ]);
  const at = (t) => cutscene.evaluate(t);
  assert.equal(effectsOf(at(0.5)).sparks.running, false);
  assert.equal(effectsOf(at(0.5)).sparks.clip, -1);
  const during = effectsOf(at(1.5)).sparks;
  assert.deepEqual([during.running, during.clip, during.time, during.rate], [true, 0, 0.5, 50]);
  assert.equal(effectsOf(at(3)).sparks.running, false, 'the end is exclusive');
  assert.equal(effectsOf(at(3)).sparks.clip, 0);
  assert.deepEqual(activeOf(at(1.5)), { door: false, lamp: true });
  assert.deepEqual(activeOf(at(2.5)), { door: true, lamp: true });
  assert.deepEqual(activeOf(at(0.5)), { door: false, lamp: false });
  assert.deepEqual(effectsOf(new Cutscene(doc([])).evaluate(0)), {});
  assert.deepEqual(activeOf(new Cutscene(doc([])).evaluate(0)), {});
});

test('applyActivation sets visible on the objects you pass and no others', () => {
  const cutscene = build([door([{ start: 0, duration: 1 }]), door([{ start: 0, duration: 1 }], { id: 'x', target: 'other' })]);
  const mesh = { visible: false };
  applyActivation(cutscene.evaluate(0.5), { door: mesh });
  assert.equal(mesh.visible, true);
  applyActivation(cutscene.evaluate(2), { door: mesh });
  assert.equal(mesh.visible, false);
  assert.doesNotThrow(() => applyActivation(cutscene.evaluate(2), Object.create(null)));
});

test('the player fires a clip start and end and each burst, in order, and skip fires them all', () => {
  const cutscene = build([
    sparks([{ start: 1, duration: 2, bursts: [{ time: 0.5, count: 40 }] }]),
    door([{ start: 2, duration: 1 }]),
  ]);
  const fired = [];
  const player = new CutscenePlayer(cutscene);
  player.on('*', (event) => fired.push([event.kind, event.name, event.time, event.data?.count]));
  void player.play();
  player.skip();
  assert.deepEqual(fired, [
    ['enter', 'sparks', 1, undefined],
    ['event', 'sparks:burst', 1.5, 40],
    ['enter', 'door', 2, undefined],
    ['exit', 'sparks', 3, undefined],
    ['exit', 'door', 3, undefined],
  ]);
});

test('a nested timeline runs its effects on its own time', () => {
  const timelines = { fight: { duration: 2, tracks: [sparks([{ start: 1, duration: 1 }])] } };
  const cutscene = build([{ type: 'timeline', id: 't', clips: [{ start: 3, duration: 2, timeline: 'fight' }] }], { timelines });
  assert.equal(effectsOf(cutscene.evaluate(3.5)).sparks.running, false);
  assert.equal(effectsOf(cutscene.evaluate(4.5)).sparks.running, true);
  assert.equal(effectsOf(cutscene.evaluate(4.5)).sparks.time, 0.5);
});

test('playing starts, stops and bursts the effect on time', () => {
  const effect = fakeEffect(100),
    cutscene = build([sparks([{ start: 1, duration: 1, rate: 30, bursts: [{ time: 0.5, count: 7 }] }])]),
    run = director(cutscene, effect);
  assert.equal(effect.options.rate, 0, 'the director holds it off until a clip');
  play(cutscene, run, effect, 0, 180);
  assert.equal(effect.resets, 1, 'the clip found it empty and started it fresh, and nothing else did');
  const rates = effect.log.map(([rate]) => rate);
  assert.equal(rates[0], 30, 'frame 60 is the first since the fresh start');
  assert.equal(rates[59], 30);
  assert.equal(rates[60], 0, 'stopped at the end of the clip; live particles finish by themselves');
  assert.equal(effect.log.reduce((sum, [, bursts]) => sum + bursts, 0), 7, 'the burst fired once');
  assert.equal(effect.log[30][1], 7, 'at its frame');
});

test('a clip with no rate gives the effect back the rate it had', () => {
  const effect = fakeEffect(250),
    cutscene = build([sparks([{ start: 0, duration: 1 }])]),
    run = director(cutscene, effect);
  run.apply(cutscene.evaluate(0));
  assert.equal(effect.options.rate, 250);
});

/** Frames 0 to `frames` played, then the same time reached by a seek on a second effect: the two logs must match. */
function sameAsPlaying(cutscene, frames, makeEffect = () => fakeEffect()) {
  const straight = makeEffect(),
    run = director(cutscene, straight);
  play(cutscene, run, straight, 0, frames + 1);
  const sought = makeEffect(),
    other = director(cutscene, sought);
  other.apply(cutscene.evaluate(frames * STEP));
  sought.frame();
  assert.deepEqual(sought.log, straight.log);
  assert.equal(sought.pending, straight.pending);
  // And both play on alike.
  play(cutscene, run, straight, frames + 1, frames + 60);
  play(cutscene, other, sought, frames + 1, frames + 60);
  assert.deepEqual(sought.log, straight.log);
  return sought;
}

test('a seek replays to the same frames as playing there', () => {
  const clips = [{ start: 1, duration: 3, rate: 30, bursts: [{ time: 0.25, count: 5 }, { time: 0.5, count: 9 }, { time: 2, count: 3 }] }];
  const sought = sameAsPlaying(build([sparks(clips)]), 150);
  assert.equal(sought.resets, 2, 'the seek wiped it, and the clip started it fresh');
});

test('a burst or clip between two frames lands on the same frame in a seek as in play', () => {
  // A quarter and three quarters of a frame past frame 15 of the clip: a replay rounding to the nearest tick would differ.
  const clips = [{ start: 1.004, duration: 3, rate: 30, bursts: [{ time: 0.2542, count: 5 }, { time: 0.2625, count: 9 }] }];
  sameAsPlaying(build([sparks(clips)]), 120);
});

test('a seek brings back what lingers: after the clip, and from an earlier clip into a later one', () => {
  const clips = [
    { start: 1, duration: 1, rate: 30, bursts: [{ time: 0.5, count: 5 }] },
    { start: 2.5, duration: 1, rate: 60 },
  ];
  const lives = () => Object.assign(fakeEffect(), { options: { rate: 100, lifetime: [0.5, 1] } });
  // Half a second after the first clip ended, inside the longest life of 1 s.
  sameAsPlaying(build([sparks(clips)]), 150, lives);
  // In the second clip: the gap is shorter than a life, so the replay reaches back through the first.
  const through = sameAsPlaying(build([sparks(clips)]), 180, lives);
  assert.ok(through.log.some(([, bursts]) => bursts === 5), 'the first clip ran again');
  // A gap longer than a life is a fresh start: the replay leaves the first clip out, as nothing of it is left.
  const apart = [clips[0], { start: 4, duration: 1, rate: 60 }];
  const fresh = sameAsPlaying(build([sparks(apart)]), 270, lives);
  assert.ok(fresh.log.every(([, bursts]) => bursts !== 5));
});

test('seeking backward replays, and forward by a frame or two does not', () => {
  const effect = fakeEffect(),
    cutscene = build([sparks([{ start: 0, duration: 5 }])]),
    run = director(cutscene, effect);
  play(cutscene, run, effect, 0, 120);
  const { resets } = effect;
  run.apply(cutscene.evaluate(122 * STEP));
  assert.equal(effect.resets, resets, 'a dropped frame is not a seek');
  run.apply(cutscene.evaluate(60 * STEP));
  assert.ok(effect.resets > resets);
  assert.equal(effect.log.length, 60);
});

test('a seek to where nothing is left wipes the effect, and a replay is capped at longest', () => {
  const effect = fakeEffect(),
    cutscene = build([sparks([{ start: 0, duration: 5, bursts: [{ time: 0.1, count: 2 }, { time: 4.5, count: 3 }] }])]),
    run = director(cutscene, effect, { longest: 1 });
  run.apply(cutscene.evaluate(4.75));
  assert.equal(effect.log.length, 60, 'one second of steps');
  assert.equal(effect.log.reduce((sum, [, bursts]) => sum + bursts, 0), 3, 'only bursts inside what ran');
  effect.options.lifetime = [1, 1];
  run.apply(cutscene.evaluate(7));
  assert.deepEqual(effect.log, [], 'two seconds past the end of the clip, a life of 1 s has left nothing');
  assert.equal(effect.options.rate, 0);
  const late = build([sparks([{ start: 2, duration: 1 }])]),
    second = fakeEffect(),
    run2 = director(late, second);
  run2.apply(late.evaluate(2.5));
  run2.apply(late.evaluate(0));
  assert.deepEqual(second.log, [], 'back before the clip wipes it');
  assert.equal(second.options.rate, 0);
});

test('two effects seek together, one step drawing both', () => {
  const a = fakeEffect(),
    b = fakeEffect(),
    track = (target, id, start) => ({ type: 'vfx', id, target, clips: [{ start, duration: 5, rate: 10 }] }),
    cutscene = build([track('a', 'one', 0), track('b', 'two', 1)]);
  let steps = 0;
  const run = new VfxDirector(cutscene, { a, b }, {
    step() {
      steps++;
      a.frame();
      b.frame();
    },
  });
  run.apply(cutscene.evaluate(2));
  assert.equal(steps, 120);
  assert.equal(a.log.length, 120);
  assert.equal(a.log.filter(([rate]) => rate === 10).length, 120);
  // b's clip began at 1 s and found it empty, so it started fresh there: one second of steps.
  assert.equal(b.log.length, 60);
  assert.equal(b.log.filter(([rate]) => rate === 10).length, 60);
});

test('a nested timeline fires its bursts at their place on the top timeline', () => {
  const timelines = { fx: { duration: 2, tracks: [sparks([{ start: 0.5, duration: 1, bursts: [{ time: 0.25, count: 4 }] }])] } },
    cutscene = build([{ type: 'timeline', id: 'act', clips: [{ start: 1, duration: 2, timeline: 'fx' }] }], { timelines }),
    effect = fakeEffect(),
    run = director(cutscene, effect);
  play(cutscene, run, effect, 0, 180);
  assert.equal(effect.log[15][1], 4, 'a quarter second into a clip that starts at 1.5 s');
});

test('effects the director does not hold are ignored', () => {
  const effect = fakeEffect(),
    cutscene = build([{ type: 'vfx', id: 'x', target: 'unknown', clips: [{ start: 0, duration: 1, bursts: [{ time: 0, count: 1 }] }] }]),
    run = director(cutscene, effect);
  assert.doesNotThrow(() => run.apply(cutscene.evaluate(0.5)));
});

test('options and tracks are checked', () => {
  const scene = build([]);
  assert.throws(() => new VfxDirector({}, {}, { step() {} }), /the Cutscene/);
  assert.throws(() => new VfxDirector(scene, {}, {}), /needs step/);
  assert.throws(() => new VfxDirector(scene, {}, { step() {}, stepSize: 0 }), /stepSize/);
  assert.throws(() => new VfxDirector(scene, {}, { step() {}, longest: -1 }), /longest/);
  const issues = (bad) =>
    validateCutscene(doc([bad]), new Set(), new Map(types.map((type) => [type.type, type]))).map((issue) => `${issue.path}: ${issue.message}`);
  const expect = (bad, pattern) => {
    const found = issues(bad);
    assert.ok(found.some((row) => pattern.test(row)), `${pattern} in ${found.join(' | ')}`);
  };
  assert.deepEqual(issues(sparks([{ start: 0, duration: 1, bursts: [{ time: 0, count: 1 }] }])), []);
  assert.deepEqual(issues(door([{ start: 0, duration: 1 }])), []);
  expect({ ...sparks([]), target: '' }, /target/);
  expect(sparks([{ start: 0, duration: 1, rate: -1 }]), /rate/);
  expect(sparks([{ start: 0, duration: 1, bursts: 3 }]), /bursts: must be an array/);
  expect(sparks([{ start: 0, duration: 1, bursts: [{ time: 2, count: 1 }] }]), /bursts\[0\]\.time/);
  expect(sparks([{ start: 0, duration: 1, bursts: [{ time: 0, count: 0.5 }] }]), /bursts\[0\]\.count/);
  expect(sparks([{ start: 0, duration: 1, bursts: [{ time: 1, count: 1 }, { time: 0, count: 1 }] }]), /is earlier/);
  expect({ ...door([]), target: 3 }, /target/);
  expect(door([], { invert: 'yes' }), /invert: must be true or false/);
  expect(door([{ start: 0, duration: -1 }]), /duration/);
});
