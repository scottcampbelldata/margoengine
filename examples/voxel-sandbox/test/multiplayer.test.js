import assert from 'node:assert/strict';
import test from 'node:test';
import { Keys } from '@margoengine/voxel-net';
import { limbSwing, PARTS, TAG_RANGE, writeFigure, yawOf } from '../src/figures.ts';
import { keyBits, parseJoin, plazaName, soloBanner } from '../src/multiplayer.ts';
import { isPlazaName } from '../src/names.ts';

test('keyBits turns the sandbox keys into input bits', () => {
  assert.equal(keyBits(new Set(), false), 0);
  assert.equal(keyBits(new Set(['KeyW', 'KeyD']), false), Keys.forward | Keys.right);
  assert.equal(keyBits(new Set(['ArrowUp', 'ArrowLeft']), false), Keys.forward | Keys.left);
  assert.equal(keyBits(new Set(['Space']), false), Keys.jump);
  assert.equal(keyBits(new Set(['ShiftLeft']), false), Keys.descend | Keys.sprint);
  assert.equal(keyBits(new Set(['ShiftLeft']), true), Keys.descend | Keys.fly);
  assert.equal(keyBits(new Set(['KeyC']), true), Keys.descend | Keys.fly);
});

test('/join answers: a shard, full, starting, or an error', () => {
  assert.deepEqual(
    parseJoin({ full: false, url: 'wss://plaza.example/s/1', shard: 1, world: 'w7', seed: 3, online: 2 }),
    {
      kind: 'shard',
      url: 'wss://plaza.example/s/1',
      shard: 1,
      world: 'w7',
    },
  );
  assert.equal(parseJoin({ url: 'ws://127.0.0.1:9', world: 12 }).world, '12');
  assert.deepEqual(parseJoin({ full: true, online: 400, retryIn: 30 }), { kind: 'full', online: 400 });
  assert.deepEqual(parseJoin({ full: false, starting: true, retryIn: 2 }), { kind: 'starting', retryIn: 2 });
  for (const bad of [null, {}, { url: 'http://x' }, { url: 3 }, { full: 'yes' }, 'full'])
    assert.throws(() => parseJoin(bad), TypeError);
});

test('the banner says why the page plays alone', () => {
  assert.equal(soloBanner('full', 400, true), 'Plaza is full, 400 people are in, building alone, retrying');
  assert.equal(soloBanner('full', undefined, true), 'Plaza is full, building alone, retrying');
  assert.equal(soloBanner('offline', undefined, true), 'Plaza is offline, building alone, retrying');
  assert.equal(soloBanner('offline', undefined, false), 'The server is offline, building alone');
});

test('the Plaza name is kept, replaced when it is not one, and works with storage blocked', () => {
  const held = new Map(),
    storage = { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) },
    first = plazaName(storage);
  assert.ok(isPlazaName(first));
  assert.equal(plazaName(storage), first);
  held.set([...held.keys()][0], '<b>bad</b>');
  const second = plazaName(storage);
  assert.ok(isPlazaName(second));
  assert.equal([...held.values()][0], second);
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.ok(isPlazaName(plazaName(blocked)));
  assert.ok(isPlazaName(plazaName(undefined)));
});

// A row: the 3 x 3 linear part by columns, then the translation.
const row = (out, i) => ({
  x: [out[i * 12], out[i * 12 + 1], out[i * 12 + 2]],
  y: [out[i * 12 + 3], out[i * 12 + 4], out[i * 12 + 5]],
  z: [out[i * 12 + 6], out[i * 12 + 7], out[i * 12 + 8]],
  t: [out[i * 12 + 9], out[i * 12 + 10], out[i * 12 + 11]],
});
const length = (v) => Math.hypot(...v),
  near = (a, b) => Math.abs(a - b) < 1e-5;

test('a standing figure stands on its feet, 1.78 blocks tall, head on top', () => {
  const out = new Float32Array(PARTS * 12);
  writeFigure(out, 0, 10, 20, 30, 0, 0);
  let bottom = Infinity,
    top = -Infinity;
  for (let i = 0; i < PARTS; i++) {
    const { y, t } = row(out, i),
      half = length(y) / 2;
    bottom = Math.min(bottom, t[1] - half);
    top = Math.max(top, t[1] + half);
  }
  assert.ok(near(bottom, 20));
  assert.ok(near(top, 21.78));
  assert.ok(near(row(out, 0).t[1] + length(row(out, 0).y) / 2, 21.78), 'the first part is the head');
  // Arms at either side, mirrored about the body.
  assert.ok(near(row(out, 2).t[0] - 10, 10 - row(out, 3).t[0]));
});

test('yaw turns the figure about its feet, with no mirror or skew', () => {
  const out = new Float32Array(PARTS * 12),
    yaw = 1.1,
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  writeFigure(out, 0, 0, 0, 0, yaw, 0.5);
  const still = new Float32Array(PARTS * 12);
  writeFigure(still, 0, 0, 0, 0, 0, 0.5);
  for (let i = 0; i < PARTS; i++) {
    const a = row(still, i),
      b = row(out, i);
    assert.ok(near(b.t[0], c * a.t[0] + s * a.t[2]));
    assert.ok(near(b.t[2], -s * a.t[0] + c * a.t[2]));
    assert.ok(near(b.t[1], a.t[1]));
    const det =
      b.x[0] * (b.y[1] * b.z[2] - b.y[2] * b.z[1]) -
      b.x[1] * (b.y[0] * b.z[2] - b.y[2] * b.z[0]) +
      b.x[2] * (b.y[0] * b.z[1] - b.y[1] * b.z[0]);
    assert.ok(det > 0, `part ${i} is not mirrored`);
  }
});

test('limbs swing about their top, opposite each other; the head and body do not', () => {
  const still = new Float32Array(PARTS * 12),
    moving = new Float32Array(PARTS * 12),
    angle = 0.6;
  writeFigure(still, 0, 0, 0, 0, 0, 0);
  writeFigure(moving, 0, 0, 0, 0, 0, angle);
  for (const i of [0, 1]) assert.deepEqual(row(moving, i), row(still, i));
  for (const i of [2, 3, 4, 5]) {
    const a = row(still, i),
      b = row(moving, i),
      half = length(a.y) / 2;
    // The top of the limb (its centre plus half its Y axis) stays where it was.
    for (let k = 0; k < 3; k++) assert.ok(near(a.t[k] + a.y[k] / 2, b.t[k] + b.y[k] / 2), `part ${i} axis ${k}`);
    assert.ok(near(length(b.y) / 2, half));
  }
  // The left arm and the left leg swing opposite ways, and so do the two legs.
  assert.ok(row(moving, 4).t[2] * row(moving, 5).t[2] < 0);
  assert.ok(row(moving, 2).t[2] * row(moving, 4).t[2] < 0);
});

test('writeFigure writes only its own rows', () => {
  const out = new Float32Array(PARTS * 3 * 12).fill(7);
  writeFigure(out, PARTS, 1, 2, 3, 0.3, 0.2);
  for (let i = 0; i < out.length; i++) {
    const inside = i >= PARTS * 12 && i < PARTS * 2 * 12;
    if (!inside) assert.equal(out[i], 7, `float ${i}`);
  }
});

test('limbs rest at speed 0 and their swing has a limit', () => {
  assert.equal(limbSwing(1.2, 0), 0);
  assert.ok(Math.abs(limbSwing(Math.PI / 2, 100)) <= 0.8);
  assert.ok(limbSwing(Math.PI / 2, 2) > limbSwing(Math.PI / 2, 1));
});

test('yawOf reads the heading the server sends', () => {
  const q = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  for (const yaw of [0, 0.5, -1.2, 3]) assert.ok(near(yawOf(q(yaw)), yaw));
});

test('writeFigure allocates nothing', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, () => {
  const out = new Float32Array(PARTS * 12);
  for (let i = 0; i < 20_000; i++) writeFigure(out, 0, i, 0, 0, i, 0.2); // warm up
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200_000; i++) writeFigure(out, 0, i, 0, 0, i, 0.2);
  assert.ok(process.memoryUsage().heapUsed - before < 256 * 1024);
});

test('tags are for players close enough to read', () => {
  assert.equal(TAG_RANGE, 24);
});
