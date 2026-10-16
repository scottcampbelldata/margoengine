import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';
import { cowlingHull } from '../examples/skinning-ik/head-aim-shape.ts';

async function fixture() {
  const store = await TransformStore.create(8),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    body = engine.createMesh().setParent(root),
    head = engine.createMesh().setParent(body).setPosition([0, 1.15, 0]);
  store.tick(false);
  const aim = new HeadAim(head, [0, 0.19, -0.232], 1.3, {
    min: [-0.194, -0.039, -0.236],
    max: [0.194, 0.307, 0.134],
    targetRadius: 0.10465342044830322,
    margin: 0.003,
    chestFloor: -0.032,
    chestPoints: cowlingHull,
  });
  return { store, engine, root, body, head, aim };
}
const quaternion = (f) => {
  const t = f.store.transforms,
    id = f.head.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const snapshot = (f) => ({
  quaternion: quaternion(f),
  matrix: [...f.head.matrix],
  euler: [...f.head.euler],
  origin: [...f.aim.origin],
  forward: [...f.aim.forward],
  limited: f.aim.limited,
  angle: f.aim.angle,
  rayError: f.aim.rayError,
  rayDistance: f.aim.rayDistance,
  headClearance: f.aim.headClearance,
  clearanceResolved: f.aim.clearanceResolved,
});

test('identical checked head requests reuse diagnostics while validating the hierarchy and repairing public diagnostic writes', async (t) => {
  const f = await fixture();
  try {
    const target = [-0.48, 1.17, -0.23];
    f.aim.update(target);
    const expected = snapshot(f),
      diagnostics = t.mock.method(f.aim, 'diagnostics'),
      restFrame = t.mock.method(f.aim, 'restFrame');
    for (let i = 0; i < 120; i++) {
      f.aim.origin[0] = 100;
      f.aim.forward[1] = -20;
      f.aim.angle = 99;
      f.aim.limited = true;
      f.aim.update(target);
      assert.deepEqual(snapshot(f), expected);
    }
    assert.equal(diagnostics.mock.callCount(), 0);
    assert.equal(
      restFrame.mock.callCount(),
      120,
      'cache hits still validate current scales, rotations, mesh lifetime and matrices',
    );
    for (let i = 0; i < 40; i++) f.engine.createMesh();
    f.aim.update(target);
    assert.deepEqual(snapshot(f), expected);
    assert.equal(diagnostics.mock.callCount(), 0, 'value caching must survive replaced matrix views');
  } finally {
    f.engine.dispose();
  }
});

test('head cache matches a fresh solve through external transforms, animation, signed zeros, resets and look-off checks', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    for (let i = 0; i < 180; i++) {
      if (i % 18 === 0)
        for (const f of [a, b]) {
          f.root
            .setPosition([1.2, -0.4, 2])
            .setRotation([0.2, i * 0.002, -0.15])
            .setScale([1.7, 1.7, 1.7]);
          f.body.setRotation([-0.1, 0.2, 0.1]);
        }
      if (i % 7 === 0) for (const f of [a, b]) f.head.setRotation([0.1, -0.15, 0.05]);
      const target = i % 6 < 3 ? [0, 1.17, -0.3] : [-0, 1.17, -0.3];
      if (i % 29 === 0) {
        a.aim.reset(target);
        b.aim.reset(target);
      }
      if (i % 31 === 0) {
        a.aim.checkClearance(target);
        b.aim.checkClearance(target);
      }
      a.aim.update(target);
      b.aim.aimCached = false;
      b.aim.update(target);
      assert.deepEqual(snapshot(a), snapshot(b), `fresh/cached pose ${i}`);
    }
  } finally {
    a.engine.dispose();
    b.engine.dispose();
  }
});

test('cached head aim retains finite-input, positive-uniform-scale, ancestor rotation and disposed-mesh guards', async () => {
  const f = await fixture(),
    target = [-0.48, 1.17, -0.23];
  try {
    f.aim.update(target);
    const accepted = quaternion(f),
      t = f.store.transforms;
    for (const invalid of [
      [NaN, 1, 0],
      [Infinity, 1, 0],
      ['0', 1, 0],
      [0, 1],
      [1e40, 1, 0],
    ]) {
      assert.throws(() => f.aim.update(invalid));
      assert.deepEqual(quaternion(f), accepted);
    }
    t.sx[f.root.id] = 0;
    assert.throws(() => f.aim.update(target), /positive uniform/);
    assert.deepEqual(quaternion(f), accepted);
    t.sx[f.root.id] = 1;
    t.sy[f.root.id] = 1.1;
    assert.throws(() => f.aim.update(target), /positive uniform/);
    assert.deepEqual(quaternion(f), accepted);
    t.sy[f.root.id] = 1;
    t.qw[f.body.id] = NaN;
    assert.throws(() => f.aim.update(target), /ancestor rotation/);
    assert.deepEqual(quaternion(f), accepted);
    t.qw[f.body.id] = 1;
    f.aim.update(target);
    assert.deepEqual(quaternion(f), accepted);
    f.head.dispose();
    assert.throws(() => f.aim.update(target), /disposed|released|mesh/i);
  } finally {
    f.engine.dispose();
  }
});

test('head requests read each coordinate once and retain the existing raw-number and Float32 rounding guards', async () => {
  const f = await fixture();
  try {
    const values = [-0.48, 1.17, -0.23],
      reads = [0, 0, 0],
      target = [];
    for (let i = 0; i < 3; i++)
      Object.defineProperty(target, i, {
        get() {
          reads[i]++;
          return values[i];
        },
      });
    target.length = 3;
    f.aim.update(target);
    assert.deepEqual(reads, [1, 1, 1], 'validation and copying must consume the same checked coordinates');
    const boundary = (2 - 2 ** -24) * 2 ** 127;
    for (const value of [
      0,
      -0,
      Number.MIN_VALUE,
      3.4028234663852886e38,
      boundary * (1 - Number.EPSILON),
      boundary,
      -boundary,
      Infinity,
      -Infinity,
      NaN,
      '0',
      null,
      false,
      new Number(1),
    ]) {
      const valid = Number.isFinite(value) && Number.isFinite(Math.fround(value));
      if (valid) assert.doesNotThrow(() => f.aim.update([value, 1.17, -0.3]));
      else {
        const before = quaternion(f),
          checked = [...f.aim.target];
        assert.throws(() => f.aim.update([value, 1.17, -0.3]), /finite scene point/);
        assert.deepEqual(quaternion(f), before);
        assert.deepEqual(f.aim.target, checked);
      }
    }
  } finally {
    f.engine.dispose();
  }
});
