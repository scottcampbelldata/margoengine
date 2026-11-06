import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQualityTier, LOWERED_KEY, watchQuality } from '../dist/index.js';
import { FrameDrift, watchPower } from '../dist/power.js';

const memory = (entries = {}) => {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
};
const tier = (stored, session, search = '') =>
  applyQualityTier({
    search,
    page: '/p',
    userAgent: 'desktop',
    session,
    storage: memory(stored ? { 'margoQuality:/p': stored } : {}),
  });

/** A battery that can be unplugged. */
function fakeBattery(charging = true, level = 1) {
  const listeners = new Map();
  return {
    charging,
    level,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    listeners,
    set(state) {
      Object.assign(this, state);
      for (const listener of listeners.values()) listener();
    },
  };
}
const nothing = { battery: null, pressure: null, queue: null, request: null };
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Pushes `count` readings of `ms` through a small drift, one window each. */
const readings = (drift, ms, count, size = 8) => {
  const changes = [];
  for (let i = 0; i < count; i++)
    for (let j = 0; j < size; j++) {
      const change = drift.push(ms);
      if (change !== undefined) changes.push(change);
    }
  return changes;
};

test('a slow creep that stays up reads as heat', () => {
  const drift = new FrameDrift({ window: 8, readings: 3 });
  readings(drift, 10, 3);
  assert.equal(drift.hot, false);
  const changes = [];
  for (const ms of [11, 12, 13, 14, 14, 14]) changes.push(...readings(drift, ms, 1));
  assert.deepEqual(changes, [true]);
  assert.equal(drift.hot, true);
});

test('a step up is a heavier scene, however long it stays', () => {
  const drift = new FrameDrift({ window: 8, readings: 3 });
  readings(drift, 10, 3);
  assert.deepEqual(readings(drift, 20, 30), []);
  assert.equal(drift.hot, false);
});

test('a short rise is not heat, and small noise is not a rise', () => {
  const drift = new FrameDrift({ window: 8, readings: 4 });
  readings(drift, 10, 3);
  for (const ms of [11, 12, 13, 12.9, 11.5, 10.5]) readings(drift, ms, 1);
  assert.equal(drift.hot, false);
  for (let i = 0; i < 40; i++) readings(drift, 10 + (i % 3) * 0.3, 1);
  assert.equal(drift.hot, false);
});

test('the median of a window ignores a few spikes', () => {
  const drift = new FrameDrift({ window: 8, readings: 1 });
  readings(drift, 10, 3);
  for (let i = 0; i < 5; i++) {
    for (const ms of [10, 10, 10, 10, 10, 10, 80, 80]) drift.push(ms);
  }
  assert.equal(drift.hot, false);
});

test('easing off drops the cost in one step, and hot holds through it', () => {
  const drift = new FrameDrift({ window: 8, readings: 2, hold: 5 });
  readings(drift, 10, 3);
  for (const ms of [11, 12, 13, 14]) readings(drift, ms, 1);
  assert.equal(drift.hot, true);
  assert.deepEqual(readings(drift, 7, 3), [], 'the step down is the easing off, not a cooler machine');
  assert.equal(drift.hot, true);
  assert.deepEqual(readings(drift, 7, 2), [false], 'after the hold it tries again');
});

test('a creep back down clears it sooner', () => {
  const drift = new FrameDrift({ window: 8, readings: 2 });
  readings(drift, 10, 3);
  for (const ms of [11, 12, 13, 14]) readings(drift, ms, 1);
  assert.equal(drift.hot, true);
  const changes = [];
  for (const ms of [13, 12, 11]) changes.push(...readings(drift, ms, 1));
  assert.deepEqual(changes, [false]);
});

test('restart forgets everything, and bad values are refused', () => {
  const drift = new FrameDrift({ window: 8, readings: 1 });
  readings(drift, 10, 3);
  for (const ms of [11, 12, 13]) readings(drift, ms, 1);
  assert.equal(drift.hot, true);
  drift.restart();
  assert.equal(drift.hot, false);
  assert.deepEqual(readings(drift, 13, 3), []);
  assert.equal(drift.push(Number.NaN), undefined);
  assert.equal(drift.push(-1), undefined);
  for (const options of [{ window: 7 }, { rise: 1 }, { readings: 0 }, { jump: 0 }, { hold: 0 }])
    assert.throws(() => new FrameDrift(options), RangeError, JSON.stringify(options));
});

test('on battery the frame rate caps and the budget shrinks; on mains both come back', async () => {
  tier(undefined, memory());
  const battery = fakeBattery(),
    pace = () => true,
    engine = { pace },
    features = { budget: 12 },
    told = [],
    watch = watchPower({
      ...nothing,
      battery: async () => battery,
      engine,
      features,
      onChange: (reading) => told.push(reading.level),
    });
  await settled();
  assert.equal(watch.reading.level, 0);
  assert.equal(engine.pace, pace);
  battery.set({ charging: false, level: 0.8 });
  assert.equal(watch.reading.level, 1);
  assert.notEqual(engine.pace, pace);
  assert.equal(features.budget, 9);
  battery.set({ level: 0.2 });
  assert.equal(watch.reading.level, 2, 'low battery is strain');
  assert.equal(features.budget, 6);
  assert.equal(watch.reading.battery, 0.2);
  battery.set({ charging: true });
  assert.equal(watch.reading.level, 0);
  assert.equal(engine.pace, pace);
  assert.equal(features.budget, 12);
  assert.deepEqual(told, [0, 1, 2, 0]);
  watch.dispose();
  assert.equal(battery.listeners.size, 0);
});

test('the cap holds the rate asked for', async () => {
  tier(undefined, memory());
  const battery = fakeBattery(false, 0.1),
    engine = {},
    watch = watchPower({ ...nothing, battery: async () => battery, engine });
  await settled();
  assert.equal(watch.reading.level, 2);
  let drawn = 0;
  for (let i = 0; i < 120; i++) drawn += engine.pace(i * (1000 / 60));
  assert.ok(drawn >= 58 && drawn <= 62, `${drawn} frames of 120 on 60 Hz at a 30 FPS cap`);
  watch.dispose();
  assert.equal(engine.pace, undefined, 'an engine with no pace gets none back');
});

test('CPU pressure strains at serious and critical only', () => {
  tier(undefined, memory());
  let send,
    connected = true,
    source;
  const watch = watchPower({
    ...nothing,
    pressure: (callback) => {
      send = callback;
      return {
        observe: async (name) => {
          source = name;
        },
        disconnect: () => {
          connected = false;
        },
      };
    },
  });
  assert.equal(source, 'cpu');
  send([{ state: 'fair' }]);
  assert.deepEqual([watch.reading.level, watch.reading.pressure], [0, 'fair']);
  send([{ state: 'fair' }, { state: 'serious' }]);
  assert.equal(watch.reading.level, 2);
  send([{ state: 'nominal' }]);
  assert.equal(watch.reading.level, 0);
  watch.dispose();
  assert.equal(connected, false);
});

test('a browser that refuses a source leaves the others working', async () => {
  tier(undefined, memory());
  const watch = watchPower({
    ...nothing,
    battery: () => Promise.reject(new Error('blocked by policy')),
    pressure: () => ({ observe: () => Promise.reject(new Error('NotSupportedError')), disconnect() {} }),
  });
  await settled();
  assert.deepEqual(watch.reading, { level: 0, hot: false });
  watch.dispose();
});

test('heat from frame times reaches level 2, and restart clears it', async () => {
  tier(undefined, memory());
  let time = 0;
  const done = [],
    queue = { submit() {}, onSubmittedWorkDone: () => new Promise((resolve) => done.push(resolve)) },
    watch = watchPower({ ...nothing, queue, now: () => time, window: 8, readings: 2 }),
    frame = async (ms) => {
      queue.submit();
      time += ms;
      done.shift()();
      await Promise.resolve();
      await Promise.resolve();
    };
  for (const ms of [10, 10, 10, 11, 12, 13, 14]) for (let i = 0; i < 8; i++) await frame(ms);
  assert.deepEqual([watch.reading.level, watch.reading.hot], [2, true]);
  watch.restart();
  assert.deepEqual([watch.reading.level, watch.reading.hot], [0, false]);
  watch.dispose();
});

test('the full tier cannot change while running, so the next load of this tab starts light', async () => {
  const session = memory();
  assert.equal(tier('high', session), 'high');
  const battery = fakeBattery();
  let reloads = 0;
  const watch = watchPower({ ...nothing, battery: async () => battery, session, reload: () => reloads++ });
  await settled();
  assert.equal(session.values.has(LOWERED_KEY), false);
  battery.set({ charging: false, level: 0.9 });
  assert.equal(session.values.has(LOWERED_KEY), true);
  assert.equal(reloads, 1);
  battery.set({ level: 0.1 });
  assert.equal(reloads, 1, 'one reload however far it falls');
  assert.equal(tier('high', session), 'light', 'the measured high stays stored, this tab runs light');
  assert.equal(tier('high', session, '?quality=high'), 'high', 'the URL still wins');
  battery.set({ charging: true });
  assert.equal(session.values.has(LOWERED_KEY), false, 'back on mains the next load is high again');
  assert.equal(reloads, 1, 'and the page is not reloaded for that');
  assert.equal(tier('high', session), 'high');
  watch.dispose();
});

test('no reload unless the app asks for one', async () => {
  const session = memory();
  tier('high', session);
  const battery = fakeBattery(false, 0.9),
    watch = watchPower({ ...nothing, battery: async () => battery, session });
  await settled();
  assert.equal(session.values.has(LOWERED_KEY), true);
  watch.dispose();
});

test('a light page is not marked', async () => {
  const session = memory();
  tier(undefined, session);
  const battery = fakeBattery(false, 0.9),
    watch = watchPower({ ...nothing, battery: async () => battery, session });
  await settled();
  assert.equal(watch.reading.level, 1);
  assert.equal(session.values.size, 0);
  watch.dispose();
});

test('a tab lowered for power takes no reading: unplugged is no evidence of what the page costs', () => {
  const session = memory({ [LOWERED_KEY]: '1' });
  assert.equal(tier('high', session), 'light');
  let requested = 0;
  watchQuality({ request: () => requested++, queue: {}, device: {}, store: () => assert.fail('nothing is stored') });
  assert.equal(requested, 0);
});

test('dispose gives everything back and later events do nothing', async () => {
  tier(undefined, memory());
  const battery = fakeBattery(false, 0.9),
    pace = () => true,
    engine = { pace },
    features = { budget: 10 },
    told = [],
    watch = watchPower({
      ...nothing,
      battery: async () => battery,
      engine,
      features,
      onChange: (reading) => told.push(reading.level),
    });
  await settled();
  assert.equal(features.budget, 7.5);
  watch.dispose();
  watch.dispose();
  assert.equal(engine.pace, pace);
  assert.equal(features.budget, 10);
  const count = told.length;
  battery.charging = true;
  assert.equal(told.length, count);
});

test('invalid options are refused', () => {
  for (const options of [{ rates: [0, 30] }, { budgets: [1.5, 0.5] }, { budgets: [0, 0.5] }, { lowBattery: 2 }])
    assert.throws(() => watchPower({ ...nothing, ...options }), RangeError, JSON.stringify(options));
});
