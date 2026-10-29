import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hypot } from '../packages/shared/hypot.js';
import { FLOORS, frameBytes, overFloor } from '../scripts/frame-alloc-browser.mjs';

// The probes run in a fresh process with --expose-gc: inside the test runner, other tests' timers, promises and JIT
// work share the heap (packages/lod/test/lod.test.js learned this).
const probe = (...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', fileURLToPath(new URL('./support/core-frame-alloc-probe.mjs', import.meta.url)), ...args],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  ).bytes;
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

// Regression (item 53.1): core's steady frame allocated 1,055 B on the CPU alone (Node, stand-in GPU): a regex literal
// per resize, some() closures over the light, an array and every() in Camera.update, Math.hypot's argument arrays,
// Object.assign's literal in the renderer and an iterator per for...of over the batch Map, the plugins, the callbacks
// and the frame graph's passes. What is left (about 210 B) is V8 boxing the frame delta for each callback it calls.
test("core's steady-state frame allocates at most 256 bytes on the CPU", { timeout: 300_000 }, () => {
  const bytes = probe();
  assert.ok(median(bytes) <= 256, `core frame allocated ${bytes.join(', ')} B per frame`);
});

// Regression (item 53.1): Shadows' depth passes cleared and refilled Maps and Sets of every caster each pass, and
// emptied their batch lists with length = 0 (V8 then drops the storage and the next push allocates it again).
test('a shadowed frame (eight moving casters, four cascades) adds at most 512 bytes to it', {
  timeout: 300_000,
}, () => {
  const core = median(probe()),
    shadowed = median(probe('--shadows'));
  assert.ok(shadowed - core <= 512, `shadows added ${shadowed - core} B per frame (${shadowed} against ${core})`);
});

test('the frame probe notices a frame that allocates', { timeout: 300_000 }, () => {
  const bytes = probe('--allocate');
  assert.ok(Math.min(...bytes) > 256, `the probe saw only ${bytes.join(', ')} B per frame from an allocating frame`);
});

test('hypot gives Math.hypot bit for bit (V8) without allocating', () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const value = () => (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20);
  for (let i = 0; i < 20_000; i++) {
    const a = value(),
      b = value(),
      c = value(),
      d = value();
    assert.equal(hypot(3, a, b, c), Math.hypot(a, b, c));
    assert.equal(hypot(4, a, b, c, d), Math.hypot(a, b, c, d));
    assert.equal(hypot(2, a, b), Math.hypot(a, b));
  }
  assert.equal(hypot(3, 0, -0, 0), 0);
  assert.equal(hypot(3, Infinity, 1, 2), Infinity);
  assert.equal(hypot(3, 1e308, 1e308, 1e308), Math.hypot(1e308, 1e308, 1e308));
});

test('frame bytes leave out garbage-collection frames and subtract the read cost', () => {
  const r = frameBytes([100, 150, 200, 120, 170, 220], 10);
  assert.deepEqual(r, { median: 40, mean: 40, min: 40, max: 40, gcFrames: 1, frames: 5 });
  assert.throws(() => frameBytes([5, 4, 3], 0), /Every recorded frame collected garbage/);
});

test('every scene has a finite floor and a frame over it fails', () => {
  for (const [scene, floor] of Object.entries(FLOORS)) {
    assert.ok(Number.isInteger(floor.median) && floor.median > 0, `${scene} floor`);
    assert.equal(overFloor({ [scene]: { median: floor.median + 1 } }).length, 1);
    assert.deepEqual(overFloor({ [scene]: { median: floor.median } }), []);
  }
  assert.deepEqual(overFloor({ other: { median: 0, mean: 0 } }), ['other: no floor in FLOORS']);
});
