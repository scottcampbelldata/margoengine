import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceTime, seek } from '@margoengine/cutscene/seek';

// A clock as a time-driven plugin has one: drift integrates a wind that another clock rewrites each step, and a seeded
// generator draws one number per step. Neither has a closed form in t, so only a replay of the same steps matches.
class Drift {
  name;
  time = 0;
  drift = 0;
  seed = 12345;
  strikes = 0;
  calls = 0;
  constructor(name, wind) {
    this.name = name;
    this.wind = wind;
  }
  setup() {}
  advanceTime(delta) {
    this.calls++;
    this.time += delta;
    this.drift += delta * this.wind.speed;
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    if (this.seed % 97 === 0) this.strikes++;
  }
  onPreUpdate(delta) {
    this.advanceTime(delta);
    this.drawn = this.drift * 2; // derived state, from the clock only
  }
}
// Wind on a schedule: a change at 4 s, then a random walk.
class Wind {
  name = 'wind';
  time = 0;
  speed = 3;
  walk = 0.25;
  calls = 0;
  setup() {}
  advanceTime(delta) {
    this.calls++;
    this.time += delta;
    if (this.time > 4) this.speed = 9;
    this.walk = this.walk * 0.99 + Math.sin(this.time * 7.1) * 0.01;
    this.speed += this.walk * delta;
  }
  onPreUpdate(delta) {
    this.advanceTime(delta);
  }
}
// A plugin with a frame update and no clock: a seek leaves it alone and names it.
const still = { name: 'post', setup() {}, onPreUpdate() {} };

const world = () => {
  const wind = new Wind(),
    clouds = new Drift('clouds', wind),
    plugins = new Map([
      ['wind', wind],
      ['clouds', clouds],
      ['post', still],
    ]),
    machine = new Drift('machine', wind);
  return { engine: { scene: { plugins } }, wind, clouds, machine };
};
const live = (w, delta) => {
  for (const plugin of w.engine.scene.plugins.values()) plugin.onPreUpdate(delta);
  w.machine.advanceTime(delta);
};
const state = (w) => ({
  wind: { ...w.wind },
  clouds: { ...w.clouds, wind: undefined },
  machine: { ...w.machine, wind: undefined },
});

for (const n of [1, 600, 54_000])
  test(`seek to step ${n} then one live frame equals ${n + 1} live frames, bit for bit`, async () => {
    const fps = 60,
      a = world(),
      b = world();
    for (let i = 0; i <= n; i++) live(a, 1 / fps);
    const result = await seek(b.engine, n / fps, { fps, extra: [b.machine] });
    live(b, 1 / fps);
    assert.deepEqual(state(b), state(a));
    assert.equal(b.clouds.drawn, a.clouds.drawn);
    assert.equal(result.steps, n);
    assert.deepEqual(result.clocks, ['wind', 'clouds', 'machine']);
    assert.deepEqual(result.unseekable, ['post']);
    // Work count: steps x clocks advanceTime calls, then the live frame's one each.
    assert.equal(b.wind.calls + b.clouds.calls + b.machine.calls, 3 * n + 3);
  });

test('a closed form n x dt is not what stepping gives, which is why seek replays', () => {
  let t = 0;
  for (let i = 0; i < 54_000; i++) t += 1 / 60;
  assert.notEqual(t, 54_000 * (1 / 60));
});

test('advanceTime steps plugins in attach order, then extra, and checks the delta', () => {
  const order = [],
    clock = (name) => ({ name, time: 0, setup() {}, advanceTime: () => order.push(name) }),
    engine = {
      scene: {
        plugins: new Map([
          ['b', clock('b')],
          ['a', clock('a')],
        ]),
      },
    },
    other = { plugins: new Map([['c', clock('c')]]) };
  advanceTime(engine, 0.5, { extra: [clock('x')] });
  assert.deepEqual(order, ['b', 'a', 'x']);
  order.length = 0;
  advanceTime(engine, 0, { scenes: [other, engine.scene] });
  assert.deepEqual(order, ['c', 'b', 'a']);
  for (const bad of [-1, Number.NaN, 2, Infinity]) assert.throws(() => advanceTime(engine, bad), RangeError);
  assert.throws(() => advanceTime(engine, 0.1, { extra: [{}] }), /extra\[0\] needs advanceTime/);
});

test('seek needs a fresh start, a valid time and rate, and stops on abort', async () => {
  const w = world();
  live(w, 1 / 60);
  await assert.rejects(
    seek(w.engine, 1),
    (e) =>
      e.name === 'MargoError' &&
      e.code === 'state' &&
      /wind, clouds/.test(e.message) &&
      /errors#film-seek/.test(e.message),
  );
  const fresh = world();
  await assert.rejects(seek(fresh.engine, -1), RangeError);
  await assert.rejects(seek(fresh.engine, Number.NaN), RangeError);
  await assert.rejects(seek(fresh.engine, 1, { fps: 0.5 }), RangeError);
  const controller = new AbortController();
  const late = seek(fresh.engine, 100, {
    signal: controller.signal,
    onStep: (step) => step === 10 && controller.abort(new Error('stop')),
  });
  await assert.rejects(late, /stop/);
  assert.equal(fresh.wind.calls, 11);
  assert.deepEqual((await seek(world().engine, 0)).steps, 0);
});

test('onStep runs before each step with its film time', async () => {
  const w = world(),
    seen = [];
  await seek(w.engine, 0.05, { fps: 100, onStep: (step, time) => seen.push([step, time, w.wind.calls]) });
  assert.deepEqual(seen, [
    [0, 0, 0],
    [1, 0.01, 1],
    [2, 0.02, 2],
    [3, 0.03, 3],
    [4, 0.04, 4],
  ]);
});
