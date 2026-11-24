// Ballistic debris (@margoengine/vfx/debris): the closed-form flight without drag, the ejecta speed law of Housen and
// Holsapple (2011), drag shortening the throw (Mastin 2001), determinism over film time, and the instances and landing
// puffs it draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Debris } from '../dist/debris.js';

const G = 9.80665;

test('without drag every piece lands after 2 v sin(elevation) / g on flat ground', () => {
  const d = new Debris({ count: 60, drag: 0, speed: 30, seed: 3 });
  const at = d.pieces(0);
  for (const [i, p] of at.entries()) {
    const v = d.pieces(p.launch)[i].velocity;
    const want = (2 * v[1]) / G;
    assert.ok(
      Math.abs(p.landing - p.launch - want) < 1e-3 * want + 1e-6,
      `piece ${i}: ${p.landing - p.launch} s, ${want}`,
    );
  }
});

test('launch speed falls as (x / R)^(-1 / mu) from the centre, capped at maxSpeed (Housen and Holsapple 2011)', () => {
  const d = new Debris({ count: 200, radius: 40, speed: 25, maxSpeed: 400, mu: 0.41, spread: 0, seed: 7 });
  let checked = 0;
  for (const [i, p] of d.pieces(0).entries()) {
    const start = d.pieces(p.launch)[i],
      x = Math.hypot(start.position[0], start.position[2]),
      v = Math.hypot(...start.velocity);
    if (v >= 400 - 1e-9) continue;
    assert.ok(Math.abs(v * (x / 40) ** (1 / 0.41) - 25) < 1e-6 * v, `piece ${i}`);
    checked++;
  }
  assert.ok(checked > 100);
});

test('drag shortens the throw (Mastin 2001)', () => {
  const reach = (drag) => {
    const d = new Debris({ count: 50, drag, speed: 60, size: [0.3, 0.3], seed: 2 });
    return d.pieces(200).reduce((s, p) => s + Math.hypot(p.position[0], p.position[2]), 0);
  };
  assert.ok(reach(1) < 0.9 * reach(0));
});

test('debris is a function of film time: seeks in any order and update give the same pieces', () => {
  const a = new Debris({ count: 80, seed: 9, start: 2 }),
    b = new Debris({ count: 80, seed: 9, start: 2 });
  a.seek(5.5);
  b.seek(30);
  b.seek(1);
  for (let i = 0; i < 9; i++) b.update(0.5);
  assert.deepEqual(a.pieces(), b.pieces());
  assert.ok(
    a.pieces(1).every((p) => p.state === 'waiting'),
    'nothing before the start',
  );
  assert.ok(
    a.pieces(200).every((p) => p.state === 'landed'),
    'everything down in the end',
  );
});

test('draw writes the flying and landed pieces; landing puffs grow and fade', () => {
  const d = new Debris({ count: 40, seed: 4, puffLife: 5 }),
    written = [];
  const target = {
    capacity: 100,
    count: 0,
    setMatrixAt(i, m) {
      written[i] = Array.from(m);
    },
    setColorAt() {},
  };
  d.seek(0.2);
  const early = d.draw(target);
  d.seek(60);
  assert.equal(d.draw(target), 40);
  assert.ok(early < 40, 'the outer pieces leave later');
  const first = Math.min(...d.pieces().map((p) => p.landing));
  assert.equal(d.puffs(first - 1e-6).length, 0);
  assert.ok(d.puffs(first + 0.5).length > 0, 'a puff where the first piece lands');
  const clouds = [];
  d.seek(first + 0.5);
  d.drawPuffs({
    add(o) {
      const c = { options: o, matrix: new Float32Array(16) };
      clouds.push(c);
      return c;
    },
    remove(c) {
      clouds.splice(clouds.indexOf(c), 1);
      return true;
    },
  });
  assert.equal(clouds.length, 1);
  d.clearPuffs();
  assert.equal(clouds.length, 0);
});

test('validation', () => {
  assert.throws(() => new Debris({ count: 0 }), RangeError);
  assert.throws(() => new Debris({ mu: 2 }), RangeError);
  assert.throws(() => new Debris({ size: [2, 1] }), RangeError);
  assert.throws(() => new Debris({ speed: 50, maxSpeed: 10 }), RangeError);
  assert.throws(() => new Debris({ ground: 3 }), TypeError);
  assert.throws(() => new Debris().seek(-1), RangeError);
});
