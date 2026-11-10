import assert from 'node:assert/strict';
import test from 'node:test';
import { World, Query } from '../dist/index.js';
import { GrowableWorld } from '../dist/growable.js';
import { ReactiveQuery } from '../dist/reactive.js';
import { ObjectComponent, objectField } from '../dist/objects.js';

test('cached membership, source rows and events match uncached Query', () => {
  const w = new World(6),
    a = w.tag(),
    b = w.tag(),
    optional = w.tag();
  const one = w.create(),
    two = w.create();
  a.add(one);
  a.add(two);
  b.add(two);
  const q = new ReactiveQuery(w, { with: [a], without: [b], optional: [optional] });
  const fresh = new Query(w, { with: [a], without: [b] });
  const transitions = [];
  q.subscribe(
    { onEnter: (e) => transitions.push(['in', e]), onExit: (e) => transitions.push(['out', e]) },
    { initial: true },
  );
  assert.deepEqual(transitions, [['in', one]]);
  b.remove(two);
  optional.add(two);
  a.remove(one);
  assert.equal(q.size, 1);
  assert.equal(q.has(two), true);
  assert.deepEqual(transitions, [['in', one]]);
  assert.equal(q.flush(), 2);
  assert.deepEqual(transitions, [
    ['in', one],
    ['in', two],
    ['out', one],
  ]);
  q.forEach((e, rows) => {
    assert.equal(e, two);
    assert.deepEqual([...rows], [a.index(two), optional.index(two)]);
  });
  const x = new Uint32Array(6),
    y = new Uint32Array(6);
  assert.equal(q.run(x), fresh.run(y));
  assert.equal(x[0], y[0]);
  assert.throws(() => q.run(new Uint32Array(0)), /small/);
  q.stop();
  q.stop();
  assert.equal(a.observers.length, 0);
  assert.equal(b.observers.length, 0);
  assert.throws(() => q.run(x), /stopped/);
});

test('excluded-first destruction never creates phantom enters and generations stay distinct', () => {
  const w = new World(2),
    excluded = w.tag(),
    required = w.tag();
  const e = w.create();
  excluded.add(e);
  required.add(e);
  const q = new ReactiveQuery(w, { with: [required], without: [excluded] });
  const events = [];
  q.subscribe({ onEnter: (e) => events.push(['in', e]), onExit: (e) => events.push(['out', e]) });
  assert.equal(w.destroying(e), false);
  w.destroy(e);
  assert.equal(w.destroying(e), false);
  assert.equal(q.flush(), 0);
  assert.deepEqual(events, []);
  const next = w.create();
  required.add(next);
  w.destroy(next);
  q.flush();
  assert.deepEqual(events, [
    ['in', next],
    ['out', next],
  ]);
  assert.notEqual(next, e);
  q[Symbol.dispose]();
});

test('one shape change touches only that entity and cached reads never rescan', () => {
  const w = new World(1000),
    a = w.tag(),
    b = w.tag();
  const ids = Array.from({ length: 800 }, () => {
    const e = w.create();
    a.add(e);
    return e;
  });
  const q = new ReactiveQuery(w, { with: [a], without: [b] });
  let checks = 0;
  for (const c of [a, b]) {
    const has = c.has.bind(c);
    c.has = (e) => {
      checks++;
      assert.equal(e, ids[500]);
      return has(e);
    };
  }
  w.query = () => {
    throw new TypeError('world scan');
  };
  b.add(ids[500]);
  assert.equal(checks, 2);
  assert.equal(q.size, 799);
  const before = checks;
  assert.equal(q.run(new Uint32Array(1000)), 799);
  assert.equal(q.has(ids[0]), true);
  assert.equal(checks, before);
  assert.equal(q.flush(), 0);
  q.stop();
});

test('subscriptions, callback mutations and failures retain independent event windows', () => {
  const w = new World(5),
    a = w.tag(),
    q = new ReactiveQuery(w, { with: [a] });
  const one = w.create(),
    two = w.create(),
    three = w.create();
  const seen = [];
  const off = q.subscribe({
    onEnter: (e) => {
      seen.push(e);
      if (e === one) {
        a.add(two);
        assert.throws(() => q.flush(), /flushing/);
      }
    },
  });
  a.add(one);
  const late = [];
  q.subscribe({ onEnter: (e) => late.push(e) });
  assert.equal(q.flush(), 1);
  assert.deepEqual(seen, [one]);
  assert.deepEqual(late, []);
  q.flush();
  assert.deepEqual(seen, [one, two]);
  assert.deepEqual(late, [two]);
  off();
  const errorOff = q.subscribe({
    onEnter: () => {
      throw new TypeError('listener');
    },
  });
  a.add(three);
  a.remove(one);
  assert.throws(() => q.flush(), /listener/);
  errorOff();
  assert.equal(q.flush(), 1);
  assert.equal(q.flush(), 0);
  q.stop();
});

test('growable mixed fields, independent queries, iteration mutation and disposal', () => {
  const w = new GrowableWorld({ capacity: 1, limit: 10 });
  const c = new ObjectComponent(w, { name: objectField(() => '') });
  const q = new ReactiveQuery(w, { with: [c] }),
    second = new ReactiveQuery(w, { with: [c] });
  const a = w.create(),
    b = w.create(),
    d = w.create();
  c.add(a);
  c.add(b);
  const visited = [];
  q.forEach((e, rows) => {
    visited.push(e);
    assert.equal(rows[0], c.index(e));
    assert.throws(() => q.forEach(() => {}), /visiting/);
    if (e === a) {
      c.remove(b);
      c.add(d);
    }
  });
  assert.deepEqual(visited, [a]);
  assert.equal(q.size, 2);
  assert.equal(second.size, 2);
  assert.throws(
    () =>
      q.forEach(() => {
        throw new TypeError('visitor');
      }),
    /visitor/,
  );
  assert.equal(
    q.forEach(() => {}),
    2,
  );
  q.subscribe({ onExit: () => q.stop() });
  c.remove(a);
  q.flush();
  assert.equal(second.size, 1);
  second.stop();
  assert.throws(() => new ReactiveQuery(w, { with: [] }), /Invalid/);
  assert.throws(() => new ReactiveQuery(w, { with: [new World(2).tag()] }), /Invalid/);
});
