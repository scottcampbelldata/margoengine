import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../dist/index.js';
import { Relation } from '../dist/relations.js';
import { Relation as RootRelation } from '../dist/index.js';

const list = (read, entity, size = 64) => {
  const output = new Uint32Array(size);
  return [...output.subarray(0, read(entity, output))];
};
const hierarchy = (capacity = 64) => {
  const world = new World(capacity);
  return { world, childOf: new Relation(world, { exclusive: true, cascade: true, acyclic: true }) };
};

test('the root entry exports the same Relation', () => {
  assert.equal(RootRelation, Relation);
});

test('pairs read both ways, in the order they were made', () => {
  const world = new World(8),
    likes = new Relation(world);
  const [a, b, c] = [world.create(), world.create(), world.create()];
  assert.equal(likes.add(a, b), true);
  assert.equal(likes.add(a, b), false);
  likes.add(a, c);
  likes.add(c, b);
  assert.equal(likes.size, 3);
  assert.equal(likes.has(a, b), true);
  assert.equal(likes.has(b, a), false);
  assert.equal(likes.target(a), b);
  assert.equal(likes.target(b), undefined);
  assert.deepEqual(list(likes.targets.bind(likes), a), [b, c]);
  assert.deepEqual(list(likes.sources.bind(likes), b), [a, c]);
  const pairs = [];
  likes.forEach((source, target) => pairs.push([source, target]));
  assert.deepEqual(pairs, [[a, b], [a, c], [c, b]]);
  assert.equal(likes.remove(a, b), true);
  assert.equal(likes.remove(a, b), false);
  assert.equal(likes.size, 2);
  assert.deepEqual(list(likes.sources.bind(likes), b), [c]);
});

test('an exclusive relation replaces the old pair', () => {
  const { world, childOf } = hierarchy();
  const [child, first, second] = [world.create(), world.create(), world.create()];
  childOf.add(child, first);
  childOf.add(child, second);
  assert.equal(childOf.target(child), second);
  assert.deepEqual(list(childOf.sources.bind(childOf), first), []);
  assert.equal(childOf.size, 1);
});

test('destroying ends the pairs of both sides without cascade', () => {
  const world = new World(8),
    likes = new Relation(world);
  const [a, b, c] = [world.create(), world.create(), world.create()];
  likes.add(a, b);
  likes.add(b, c);
  world.destroy(b);
  assert.equal(likes.size, 0);
  assert.equal(world.alive(a), true);
  assert.equal(world.alive(c), true);
  const reused = world.create();
  assert.deepEqual(list(likes.sources.bind(likes), reused), []);
});

test('cascade destroys everything below, components included, and leaves the rest', () => {
  const { world, childOf } = hierarchy();
  const position = world.component({ x: Float32Array });
  const [root, child, grandchild, other] = [world.create(), world.create(), world.create(), world.create()];
  childOf.add(child, root);
  childOf.add(grandchild, child);
  position.add(grandchild);
  world.destroy(root);
  assert.equal(world.alive(child), false);
  assert.equal(world.alive(grandchild), false);
  assert.equal(world.alive(other), true);
  assert.equal(position.size, 0);
  assert.equal(childOf.size, 0);
});

test('a hierarchy 100,000 deep cascades without overflowing the stack', () => {
  // No acyclic here: its walk on every add would make building this chain quadratic.
  const world = new World(100_000),
    childOf = new Relation(world, { exclusive: true, cascade: true });
  const root = world.create();
  let parent = root;
  for (let i = 1; i < 100_000; i++) {
    const child = world.create();
    childOf.add(child, parent);
    parent = child;
  }
  world.destroy(root);
  assert.equal(world.alive(parent), false);
  assert.equal(childOf.size, 0);
});

test('a loop of cascading relations destroys each entity once and frees each slot once', () => {
  const world = new World(2),
    first = new Relation(world, { cascade: true }),
    second = new Relation(world, { cascade: true });
  const a = world.create(),
    b = world.create();
  first.add(a, b);
  second.add(b, a);
  world.destroy(a);
  assert.equal(world.alive(a), false);
  assert.equal(world.alive(b), false);
  const x = world.create(),
    y = world.create();
  assert.notEqual(x % 2, y % 2);
  assert.throws(() => world.create(), /capacity/);
});

test('acyclic refuses loops and changes nothing; a plain relation may hold them', () => {
  const { world, childOf } = hierarchy();
  const [a, b, c] = [world.create(), world.create(), world.create()];
  childOf.add(b, a);
  childOf.add(c, b);
  const fixes = (error) => error instanceof TypeError && /;/.test(error.message);
  assert.throws(() => childOf.add(a, c), fixes);
  assert.throws(() => childOf.add(a, a), fixes);
  assert.equal(childOf.target(a), undefined);
  assert.equal(childOf.size, 2);
  childOf.add(c, a);
  assert.equal(childOf.target(c), a);
  const plain = new Relation(world);
  plain.add(a, b);
  plain.add(b, a);
  assert.equal(plain.size, 2);
});

test('descendants are breadth first, once each, even around a loop', () => {
  const world = new World(8),
    edges = new Relation(world);
  const [a, b, c, d] = [world.create(), world.create(), world.create(), world.create()];
  edges.add(b, a);
  edges.add(c, a);
  edges.add(d, b);
  edges.add(d, c);
  edges.add(a, d);
  assert.deepEqual(list(edges.descendants.bind(edges), a), [b, c, d]);
  assert.throws(() => edges.descendants(a, new Uint32Array(2)), RangeError);
});

test('stale entities and small outputs are refused', () => {
  const world = new World(8),
    likes = new Relation(world);
  const a = world.create(),
    b = world.create(),
    c = world.create(),
    dead = world.create();
  world.destroy(dead);
  const stale = (error) => error.code === 'state';
  assert.throws(() => likes.add(a, dead), stale);
  assert.throws(() => likes.add(dead, a), stale);
  likes.add(a, b);
  likes.add(c, b);
  const small = (error) => error instanceof RangeError && /;/.test(error.message);
  assert.throws(() => likes.sources(b, new Uint32Array(1)), small);
  assert.equal(likes.targets(b, new Uint32Array(0)), 0);
});

test('stop ends the pairs and the world forgets the relation', () => {
  const world = new World(8);
  const a = world.create(),
    b = world.create();
  {
    using likes = new Relation(world, { cascade: true });
    likes.add(a, b);
    likes.stop();
    assert.equal(likes.size, 0);
  }
  world.destroy(b);
  assert.equal(world.alive(a), true);
});

test('seeded work matches a list of pairs', () => {
  let seed = 7;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  const world = new World(24),
    relation = new Relation(world);
  const entities = [];
  let pairs = [];
  for (let step = 0; step < 5000; step++) {
    const pick = () => entities[random(entities.length)];
    const action = random(4);
    if ((action === 0 || entities.length < 2) && entities.length < 24) entities.push(world.create());
    else if (action === 1 && entities.length > 2) {
      const entity = entities.splice(random(entities.length), 1)[0];
      world.destroy(entity);
      pairs = pairs.filter(([s, t]) => s !== entity && t !== entity);
    } else if (action === 2 && entities.length > 1) {
      const s = pick(),
        t = pick();
      const fresh = !pairs.some((p) => p[0] === s && p[1] === t);
      assert.equal(relation.add(s, t), fresh);
      if (fresh) pairs.push([s, t]);
    } else if (pairs.length) {
      const [s, t] = pairs.splice(random(pairs.length), 1)[0];
      assert.equal(relation.remove(s, t), true);
    }
    assert.equal(relation.size, pairs.length);
    if (entities.length) {
      const entity = pick(),
        sorted = (values) => values.sort((a, b) => a - b);
      assert.deepEqual(
        sorted(list(relation.sources.bind(relation), entity)),
        sorted(pairs.filter((p) => p[1] === entity).map((p) => p[0])),
      );
      assert.deepEqual(
        sorted(list(relation.targets.bind(relation), entity)),
        sorted(pairs.filter((p) => p[0] === entity).map((p) => p[1])),
      );
    }
  }
});
