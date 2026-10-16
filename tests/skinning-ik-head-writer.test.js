import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';
import { RigScratch } from '../examples/skinning-ik/rig-scratch.ts';
import { cowlingHull } from '../examples/skinning-ik/head-aim-shape.ts';

const clearance = () => ({
  min: [-0.194, -0.039, -0.236],
  max: [0.194, 0.307, 0.134],
  targetRadius: 0.10465342044830322,
  margin: 0.003,
  chestFloor: -0.032,
  chestPoints: cowlingHull,
});

async function fixture(optIn = false, beforeAim) {
  const store = await TransformStore.create(8),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {},
    }),
    root = engine.createMesh(),
    body = engine.createMesh().setParent(root),
    head = engine.createMesh().setParent(body).setPosition([0, 1.15, 0]),
    scratch = new RigScratch(),
    writes = [];
  store.tick(false);
  beforeAim?.(head);
  const options = clearance();
  if (optIn) options.writeRotation = (rotation) => {
    assert.ok(Array.isArray(rotation), 'only controller-owned normal arrays reach this opt-in writer');
    writes.push(rotation);
    scratch.setQuaternion(head, rotation);
  };
  const aim = new HeadAim(head, [0, 0.19, -0.232], 1.3, options);
  return { store, engine, root, body, head, aim, scratch, writes };
}

const quaternion = (f) => {
  const t = f.store.transforms, id = f.head.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const pose = (f) => [f.root, f.body, f.head].map((node) => ({
  id: node.id,
  quaternion: [f.store.transforms.qx[node.id], f.store.transforms.qy[node.id],
    f.store.transforms.qz[node.id], f.store.transforms.qw[node.id]],
  euler: [...node.euler], matrix: [...node.matrix],
}));
const snapshot = (f) => ({
  pose: pose(f), origin: [...f.aim.origin], forward: [...f.aim.forward],
  limited: f.aim.limited, angle: f.aim.angle, rayError: f.aim.rayError,
  rayDistance: f.aim.rayDistance, headClearance: f.aim.headClearance,
  clearanceResolved: f.aim.clearanceResolved,
});

test('explicit head writer matches the public setter bit-for-bit through transformed motion, clearance, reset and store growth', async () => {
  const a = await fixture(), b = await fixture(true);
  try {
    for (let i = 0; i < 360; i++) {
      if (i % 18 === 0) for (const f of [a, b]) {
        f.root.setPosition([1.2, -0.4, 2]).setRotation([0.2, i * 0.002, -0.15]).setScale([1.7, 1.7, 1.7]);
        f.body.setRotation([-0.1, 0.2, 0.1]);
      }
      if (i % 7 === 0) for (const f of [a, b]) f.head.setRotation([0.1, -0.15, 0.05]);
      if (i === 180) for (const f of [a, b]) {
        for (let j = 0; j < 40; j++) f.engine.createMesh();
        f.store.tick(false);
      }
      const target = [1 + Math.sin(i * 0.13), 1.2 + Math.cos(i * 0.07) * 0.7, 1.5 + Math.sin(i * 0.09)];
      if (i % 29 === 0) { a.aim.reset(target); b.aim.reset(target); }
      if (i % 31 === 0) { a.aim.checkClearance(target); b.aim.checkClearance(target); }
      a.aim.update(target); b.aim.update(target);
      assert.deepEqual(snapshot(b), snapshot(a), `frame ${i}`);
    }
    assert.ok(b.writes.length > 100, 'the opt-in must exercise real commits rather than only cache hits');
    assert.ok(new Set(b.writes).size <= 2, 'the writer receives the reused rest/output arrays');
  } finally { a.engine.dispose(); b.engine.dispose(); }
});

test('default head commits dispatch both pre-existing and later public setter replacements', async () => {
  let beforeCalls = 0, laterCalls = 0;
  const f = await fixture(false, (head) => {
    const original = head.setQuaternion;
    head.setQuaternion = function (rotation) { beforeCalls++; return original.call(this, rotation); };
  });
  try {
    f.aim.update([-0.48, 1.17, -0.23]);
    assert.equal(beforeCalls, 1, 'a replacement present before controller construction must be called');
    const previous = f.head.setQuaternion;
    f.head.setQuaternion = function (rotation) { laterCalls++; return previous.call(this, rotation); };
    f.head.setRotation([0.1, -0.15, 0.05]);
    f.aim.update([0.2, 1.5, -0.6]);
    assert.equal(laterCalls, 1, 'the current method is looked up on every commit');
    assert.equal(beforeCalls, 2);
  } finally { f.engine.dispose(); }
});

test('head writer is validated and captured once before any pose mutation', async () => {
  const f = await fixture();
  try {
    const before = snapshot(f);
    for (const invalid of [null, false, 1, 'writer', {}, []]) {
      assert.throws(() => new HeadAim(f.head, [0, 0.19, -0.232], 1.3,
        { ...clearance(), writeRotation: invalid }), /Invalid head rotation writer/);
      assert.deepEqual(snapshot(f), before);
    }
    let reads = 0, calls = 0;
    const options = clearance();
    Object.defineProperty(options, 'writeRotation', {
      get() {
        reads++;
        return (rotation) => { calls++; f.scratch.setQuaternion(f.head, rotation); };
      },
    });
    const aim = new HeadAim(f.head, [0, 0.19, -0.232], 1.3, options);
    assert.equal(reads, 1);
    aim.update([-0.48, 1.17, -0.23]);
    f.head.setRotation([0.1, 0.2, 0.3]);
    aim.reset([0, 1, -0.5]);
    assert.equal(reads, 1, 'later updates must not reread the caller-owned config');
    assert.equal(calls, 2);
  } finally { f.engine.dispose(); }
});

test('opt-in writer retains input, hierarchy, quaternion and disposed guards before committing', async () => {
  const a = await fixture(), b = await fixture(true), target = [-0.48, 1.17, -0.23];
  try {
    a.aim.update(target); b.aim.update(target);
    for (const invalid of [[NaN, 1, 0], [Infinity, 1, 0], ['0', 1, 0], [0, 1], [1e40, 1, 0]]) {
      const count = b.writes.length, before = snapshot(b);
      assert.throws(() => b.aim.update(invalid), /finite scene point/);
      assert.deepEqual(snapshot(b), before);
      assert.equal(b.writes.length, count, 'invalid requests must not reach the writer');
    }
    for (const invalid of [[0, 0, 0, 0], [NaN, 0, 0, 1], [Infinity, 0, 0, 1], [1e40, 0, 0, 1], [0, 0, 1]]) {
      const beforeA = snapshot(a), beforeB = snapshot(b);
      let publicError;
      try { a.aim.commit(invalid); } catch (error) { publicError = error; }
      assert.ok(publicError);
      assert.throws(() => b.aim.commit(invalid), { name: publicError.name, message: publicError.message });
      assert.deepEqual(snapshot(a), beforeA); assert.deepEqual(snapshot(b), beforeB);
    }
    for (const f of [a, b]) {
      const accepted = quaternion(f), writes = f.writes.length, t = f.store.transforms;
      t.sx[f.root.id] = 0;
      assert.throws(() => f.aim.update(target), /positive uniform/);
      assert.deepEqual(quaternion(f), accepted);
      t.sx[f.root.id] = 1;
      t.qw[f.body.id] = NaN;
      assert.throws(() => f.aim.update(target), /ancestor rotation/);
      assert.deepEqual(quaternion(f), accepted);
      assert.equal(f.writes.length, writes);
      t.qw[f.body.id] = 1;
      f.head.dispose();
      assert.throws(() => f.aim.update(target), /disposed|released|mesh/i);
      assert.equal(f.writes.length, writes);
    }
  } finally { a.engine.dispose(); b.engine.dispose(); }
});
