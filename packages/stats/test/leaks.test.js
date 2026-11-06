import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';
import { GPUMemory } from '../dist/report.js';
import { LeakWatch } from '../dist/leaks.js';

const quiet = { intervalMilliseconds: 0, window: 8, warn: null };
// Samples `values` one second apart and gives every alert back.
function run(watch, values, set) {
  const alerts = [];
  for (const value of values) {
    set(value);
    alerts.push(...watch.sample((watch.samples + 1) * 1000));
  }
  return alerts;
}
function number(options) {
  let value = 0;
  const watch = new LeakWatch({ ...quiet, ...options }).watch('meshes', () => value, { min: 4 });
  return { watch, set: (next) => (value = next) };
}
const device = () => {
  const made = () => ({ destroy() {} });
  return { createBuffer: made, createTexture: made };
};

test('steady growth alerts once, with its size and rate', () => {
  const { watch, set } = number(),
    alerts = run(watch, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20], set);
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert.name, 'meshes');
  assert.equal(alert.from, 0);
  assert.equal(alert.to, 12);
  assert.equal(alert.at, 8000);
  assert.ok(Math.abs(alert.perMinute - (12 / 5.25) * 60) < 1e-9);
  assert.deepEqual(watch.leaking, ['meshes']);
  watch.dispose();
});

test('a full window is needed before anything alerts', () => {
  const { watch, set } = number();
  assert.deepEqual(run(watch, [0, 100, 200, 300, 400, 500, 600], set), []);
  watch.dispose();
});

test('one load, however large, is no leak', () => {
  const { watch, set } = number();
  assert.deepEqual(run(watch, [0, 0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], set), []);
  watch.dispose();
});

test('a pool that fills and empties is no leak, a pool that keeps some each time is', () => {
  const pool = number();
  assert.deepEqual(run(pool.watch, [0, 90, 0, 90, 0, 90, 0, 90, 0, 90, 0, 90], pool.set), []);
  const leak = number();
  assert.equal(run(leak.watch, [0, 90, 5, 95, 10, 100, 15, 105], leak.set).length, 1);
  pool.watch.dispose();
  leak.watch.dispose();
});

test('growth below the minimum is ignored', () => {
  const { watch, set } = number();
  assert.deepEqual(run(watch, [0, 0, 1, 1, 2, 2, 3, 3], set), []);
  watch.dispose();
});

test('an alert clears when the growth stops and can fire again', () => {
  const { watch, set } = number(),
    climb = (from) => Array.from({ length: 8 }, (_, i) => from + i * 2),
    flat = Array(8).fill(14);
  assert.equal(run(watch, climb(0), set).length, 1);
  assert.deepEqual(run(watch, flat, set), []);
  assert.deepEqual(watch.leaking, []);
  assert.equal(run(watch, climb(14), set).length, 1);
  assert.equal(watch.toJSON().alerts.length, 2);
  watch.dispose();
});

test('GPU memory: the totals and the label that grows are named, a released label is not', () => {
  const d = device(),
    memory = GPUMemory.attach(d),
    watch = LeakWatch.attach(memory, { ...quiet, minBytes: 1000, minCount: 4 });
  d.createTexture({ label: 'atlas', size: [4096, 4096], format: 'rgba8unorm' });
  const names = [];
  for (let i = 0; i < 8; i++) {
    d.createBuffer({ label: 'particles', size: 400 });
    d.createBuffer({ label: 'particles', size: 400 });
    d.createBuffer({ label: 'temporary', size: 1000 }).destroy();
    names.push(...watch.sample(i * 1000).map((alert) => alert.name));
  }
  assert.deepEqual(names.sort(), ['buffers', 'gpu bytes', 'label particles bytes', 'label particles count']);
  watch.dispose();
  memory.dispose();
});

test('labels stop at maxSeries and the totals keep their place', () => {
  const d = device(),
    memory = GPUMemory.attach(d),
    watch = LeakWatch.attach(memory, { ...quiet, maxSeries: 5, minCount: 4 });
  for (let i = 0; i < 8; i++) {
    for (let label = 0; label < 20; label++) d.createBuffer({ label: 'l' + label, size: 1 });
    watch.sample(i * 1000);
  }
  assert.ok(watch.leaking.includes('buffers'));
  assert.throws(() => watch.watch('more', () => 0), RangeError);
  watch.dispose();
  memory.dispose();
});

test('a watched number added late needs its own full window', () => {
  const { watch, set } = number();
  run(watch, [0, 0, 0, 0], set);
  let late = 0;
  watch.watch('late', () => (late += 10), { min: 1 });
  run(watch, [0, 0, 0, 0], set);
  assert.deepEqual(watch.leaking, []);
  run(watch, [0, 0, 0, 0], set);
  assert.deepEqual(watch.leaking, ['late']);
  watch.dispose();
});

test('warn defaults to console.warn, listeners hear it, and removers work', (t) => {
  const warned = t.mock.method(console, 'warn', () => {}),
    { watch, set } = number({ warn: undefined }),
    heard = [],
    remove = watch.onLeak((alert) => heard.push(alert.name));
  run(watch, [0, 2, 4, 6, 8, 10, 12, 14], set);
  assert.equal(warned.mock.callCount(), 1);
  assert.match(warned.mock.calls[0].arguments[0], /meshes keeps growing/);
  assert.deepEqual(heard, ['meshes']);
  remove();
  watch.dispose();
});

test('the timer samples on its interval and stops at dispose', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const watch = new LeakWatch({ intervalMilliseconds: 100, warn: null }).watch('n', () => reads++);
  t.mock.timers.tick(300);
  assert.equal(reads, 3);
  watch.dispose();
  t.mock.timers.tick(300);
  assert.equal(reads, 3);
  assert.throws(() => watch.sample(), { code: 'disposed' });
  assert.throws(() => watch.watch('m', () => 0), { code: 'disposed' });
});

test('options and watched numbers are checked', () => {
  for (const options of [
    { window: 6 },
    { window: 10 },
    { window: 8192 },
    { intervalMilliseconds: -1 },
    { minBytes: 0 },
    { minCount: 0 },
    { maxSeries: 0 },
  ])
    assert.throws(() => new LeakWatch({ ...quiet, ...options }), RangeError);
  const watch = new LeakWatch(quiet).watch('bad', () => NaN);
  assert.throws(() => watch.sample(), RangeError);
  assert.throws(() => watch.watch('bad', () => 0), TypeError);
  assert.throws(() => watch.watch('', () => 0), TypeError);
  assert.throws(() => watch.watch('n', () => 0, { min: 0 }), RangeError);
  watch.dispose();
});

test('view shows what is growing until dispose, and the report survives JSON', () => {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body }),
    { watch, set } = number();
  watch.view(stats).view(stats);
  assert.match(stats.element.textContent, /No leaks seen/);
  run(watch, [0, 2, 4, 6, 8, 10, 12, 14], set);
  const report = JSON.parse(JSON.stringify(watch));
  assert.deepEqual(report.leaking, ['meshes']);
  assert.equal(report.samples, 8);
  watch.dispose();
  assert.doesNotMatch(stats.element.textContent, /No leaks/);
  stats.dispose();
  dom.window.close();
});
