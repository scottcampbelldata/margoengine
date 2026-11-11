import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SelectionStore, selectionOperation } from '@margoengine/sciviz/link';

// Stable row offsets into the real, public-domain 2MASS sample, not generated observations.
const bytes = gunzipSync(readFileSync(new URL('../../../examples/assets/sciviz/stars.bin', import.meta.url)));
const stars = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const keys = Array.from({ length: 40 }, (_, i) => i);
const red = keys.filter((i) => stars[2_000_000 + i] > 0.6);
const bright = keys.filter((i) => stars[3_000_000 + i] < 13);

test('open selection stores streaming predicates without a preallocated universe', () => {
  using store = new SelectionStore([], { universe: 'open', resolve: 'intersect' });
  const changes = [];
  store.subscribe((change) => changes.push(change));
  assert(store.has('unloaded/node/1'));
  assert.deepEqual(store.rowIds, []);
  store.select(['a', 'b'], { source: 'cloud' });
  store.select(['b', 'c'], { source: 'table' });
  assert.deepEqual(store.rowIds, ['b']);
  assert.deepEqual(changes.at(-1).rowIds, ['b']);
  assert(!store.has('a'));
  assert.throws(() => store.select([NaN]), /Unknown selection/);
  store.undo();
  assert.deepEqual(store.rowIds, ['a', 'b']);
  store.redo();
  assert.deepEqual(store.rowIds, ['b']);
  store.clear();
  assert(store.has('later/node/2'));
  assert.throws(() => new SelectionStore([], { universe: 'unknown' }), /universe/);
});

test('shared selection matches the published global, union and intersect truth tables', () => {
  for (const resolve of ['global', 'union', 'intersect']) {
    using store = new SelectionStore(keys, { resolve });
    store.select(red, { source: 'sky' });
    store.select(bright, { source: 'magnitude' });
    const expected = keys.filter((key) =>
      resolve === 'global'
        ? bright.includes(key)
        : resolve === 'union'
          ? red.includes(key) || bright.includes(key)
          : red.includes(key) && bright.includes(key),
    );
    assert.deepEqual(store.rowIds, expected);
    store.clear('magnitude');
    assert.deepEqual(store.rowIds, resolve === 'global' ? keys : red);
  }
});

test('operations, modifier keys, explicit empty, clear, undo and redo retain row identity', () => {
  using store = new SelectionStore(keys);
  const events = [];
  store.subscribe((event) => events.push(event));
  store.select(red);
  store.select(bright, { operation: 'union' });
  assert.deepEqual(
    store.rowIds,
    keys.filter((key) => red.includes(key) || bright.includes(key)),
  );
  store.select(bright, { operation: 'toggle' });
  assert.deepEqual(
    store.rowIds,
    red.filter((key) => !bright.includes(key)),
  );
  assert.equal(store.undo(), true);
  assert.deepEqual(
    store.rowIds,
    keys.filter((key) => red.includes(key) || bright.includes(key)),
  );
  assert.equal(store.redo(), true);
  store.select(bright, { operation: 'intersect' });
  assert.deepEqual(store.rowIds, []);
  store.clear();
  assert.deepEqual(store.rowIds, keys);
  store.select([]);
  assert.deepEqual(store.rowIds, []);
  assert.equal(store.active, true);
  assert.deepEqual(events[0].rowIds, red, 'event snapshot stays stable after later edits');
  assert.equal(selectionOperation({ shiftKey: true }), 'toggle');
  assert.equal(selectionOperation({ ctrlKey: true }), 'union');
  assert.equal(selectionOperation({ metaKey: true }), 'union');
  assert.equal(selectionOperation({ altKey: true }), 'intersect');
  assert.equal(selectionOperation({}), 'replace');
});

test('invalid rows cannot change state; typed keys, bounded history and cancellation', () => {
  using store = new SelectionStore([keys[0], String(keys[0]), keys[1]], { history: 1, empty: false });
  assert.deepEqual(store.rowIds, []);
  store.select([keys[0]]);
  const version = store.version;
  assert.throws(() => store.select([Infinity]), RangeError);
  assert.equal(store.version, version);
  store.select([String(keys[0])]);
  assert.equal(store.has(keys[0]), false);
  store.undo();
  assert.equal(store.undo(), false);
  store.select([keys[1]]);
  assert.equal(store.canRedo, false);
  const controller = new AbortController();
  let calls = 0;
  store.subscribe(() => calls++, { signal: controller.signal });
  controller.abort();
  store.clear();
  assert.equal(calls, 0);
  assert.throws(() => new SelectionStore([0, 0]), RangeError);
  assert.throws(() => new SelectionStore([NaN]), TypeError);
  assert.throws(() => new SelectionStore(keys, { resolve: 'wrong' }), RangeError);
});

test('a change event keeps its rows after the store is disposed (KB5588d)', () => {
  for (const open of [false, true]) {
    const store = new SelectionStore(['a', 'b', 'c'], open ? { universe: 'open' } : {});
    let detail;
    store.addEventListener('change', (event) => (detail = event.detail));
    store.select(['a', 'b']);
    store.dispose();
    assert.deepEqual([...detail.rowIds].sort(), ['a', 'b'], open ? 'open store' : 'fixed store');
  }
});
