import assert from 'node:assert/strict';
import test from 'node:test';
import { World, Relation } from '../dist/index.js';
import { RelationQuery } from '../dist/relation-query.js';

test('exact targets and wildcard pairs compose with source filters and return target rows', () => {
  const w = new World(10),
    childOf = new Relation(w),
    p = w.component({ x: Float32Array }),
    blocked = w.tag(),
    extra = w.tag();
  const a = w.create(),
    b = w.create(),
    c = w.create(),
    parent = w.create(),
    other = w.create();
  for (const [e, x] of [
    [a, 1],
    [b, 2],
    [c, 3],
    [parent, 4],
    [other, 5],
  ])
    p.add(e, { x });
  childOf.add(a, parent);
  childOf.add(a, other);
  childOf.add(b, parent);
  childOf.add(c, parent);
  blocked.add(c);
  extra.add(a);
  const terms = {
    with: [p],
    without: [blocked],
    optional: [extra],
    relations: [{ relation: childOf, target: parent, with: [p] }],
  };
  const q = new RelationQuery(w, terms),
    rows = [];
  terms.with.length = 0;
  q.forEach((e, r, t, tr) => rows.push([e, [...r], [...t], [...tr]]));
  assert.deepEqual(rows, [
    [a, [0, 0], [parent], [3]],
    [b, [1, -1], [parent], [3]],
  ]);
  const wildcard = new RelationQuery(w, {
    relations: [{ relation: childOf, target: '*', with: [p] }],
    without: [blocked],
  });
  const ids = new Uint32Array(3),
    targets = new Uint32Array(3);
  assert.equal(wildcard.run(ids, [targets]), 3);
  assert.deepEqual([...ids], [a, a, b]);
  assert.deepEqual([...targets], [parent, other, parent]);
  assert.throws(() => wildcard.run(new Uint32Array(2)), /small/);
  assert.throws(() => wildcard.run(ids, []), /column/);
  w.destroy(parent);
  assert.equal(wildcard.run(ids, [targets]), 1);
  assert.equal(targets[0], other);
});

test('multiple wildcard terms enumerate every combination without losing exclusive replacement', () => {
  const w = new World(6),
    likes = new Relation(w),
    eats = new Relation(w),
    parent = new Relation(w, { exclusive: true });
  const a = w.create(),
    b = w.create(),
    c = w.create(),
    d = w.create(),
    e = w.create();
  likes.add(a, b);
  likes.add(a, c);
  eats.add(a, d);
  eats.add(a, e);
  parent.add(a, b);
  parent.add(a, c);
  const q = new RelationQuery(w, { relations: [{ relation: likes }, { relation: eats }, { relation: parent }] });
  const found = [];
  q.forEach((s, r, t) => found.push([s, ...t]));
  assert.deepEqual(found, [
    [a, b, d, c],
    [a, b, e, c],
    [a, c, d, c],
    [a, c, e, c],
  ]);
});

test('iteration snapshots tuples but resolves live rows and refuses reentrancy', () => {
  const w = new World(6),
    relation = new Relation(w),
    p = w.component({ x: Float32Array });
  const a = w.create(),
    b = w.create(),
    c = w.create(),
    target = w.create();
  for (const e of [a, b, c, target]) p.add(e);
  relation.add(a, target);
  relation.add(b, target);
  const q = new RelationQuery(w, { with: [p], relations: [{ relation, with: [p] }] });
  const found = [];
  q.forEach((e) => {
    found.push(e);
    assert.throws(() => q.run(new Uint32Array(8)), /visiting/);
    relation.remove(b, target);
    relation.add(c, target);
    p.remove(target);
  });
  assert.deepEqual(found, [a]);
  assert.equal(q.run(new Uint32Array(8)), 0);
  p.add(target);
  q.forEach((e, r, t, tr) => {
    assert.equal(tr[0], p.index(target));
    if (e === a) p.remove(b);
  });
  assert.throws(
    () =>
      q.forEach(() => {
        throw new TypeError('visit');
      }),
    /visit/,
  );
  assert.equal(q.run(new Uint32Array(8)), 2);
  const foreign = new World(2);
  assert.throws(() => new RelationQuery(w, { relations: [] }), /Invalid/);
  assert.throws(() => new RelationQuery(w, { relations: [{ relation: new Relation(foreign) }] }), /Invalid/);
  assert.throws(() => new RelationQuery(w, { relations: [{ relation, target: -1 }] }), /Invalid/);
  assert.throws(() => new RelationQuery(w, { relations: [{ relation, with: [foreign.tag()] }] }), /Invalid/);
});
