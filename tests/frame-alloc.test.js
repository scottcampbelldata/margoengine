import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hypot, hypotOf, hypotTerms } from '../packages/shared/hypot.js';
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
// The same probes with V8 stopped at Maglev (--max-opt=2), the tier a once-per-frame function runs in for its first
// thousands of frames in a browser: it boxes fractional numbers passed to calls it does not inline, and allocates a
// closure context on each call of a function whose locals an inner function captures.
const tierProbe = (script, ...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', '--max-opt=2', fileURLToPath(new URL(`./support/${script}`, import.meta.url)), ...args],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  ).bytes;

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

// Regression (item 53.1, part 2): in Maglev the frame allocated about 850 B on the CPU: Number.isFinite on every
// setter value and camera matrix element boxed each fractional value, and hypot's arguments and result were boxed.
test("core's steady-state frame in V8's middle tier allocates at most 780 bytes", { timeout: 300_000 }, () => {
  const bytes = tierProbe('core-frame-alloc-probe.mjs');
  assert.ok(median(bytes) <= 780, `core frame allocated ${bytes.join(', ')} B per frame at Maglev`);
});

// Regression (item 53.1, part 2): Shadows added about 715 B per frame in Maglev: a closure context on every draw call
// (an inner arrow captured draw's pipeline), Number.isFinite and hypot boxing in fitCascades and range(), and core's
// renderer allocated a some() closure per draw and emptied the plugin bindings list with length = 0.
test('a shadowed frame in the middle tier adds at most 620 bytes to it', { timeout: 300_000 }, () => {
  const core = median(tierProbe('core-frame-alloc-probe.mjs')),
    shadowed = median(tierProbe('core-frame-alloc-probe.mjs', '--shadows'));
  assert.ok(
    shadowed - core <= 620,
    `shadows added ${shadowed - core} B per frame at Maglev (${shadowed} against ${core})`,
  );
});

// Regression (item 53.1, part 2): fitCascades boxed 64 matrix elements into Number.isFinite and seven hypot calls'
// numbers (about 530 B per frame); invertMatrixStable boxed its 48 finiteness checks (about 595 B per call).
test('the cascade fit and the stable matrix inverse allocate little in the middle tier', { timeout: 300_000 }, () => {
  const cascades = median(tierProbe('tier-alloc-probe.mjs', 'cascades')),
    invert = median(tierProbe('tier-alloc-probe.mjs', 'invert'));
  assert.ok(cascades <= 128, `cascadeSplits + fitCascades allocated ${cascades} B per frame at Maglev`);
  assert.ok(invert <= 450, `invertMatrixStable allocated ${invert} B per call at Maglev`);
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
  // hypotOf: the same bits through hypotTerms, no number crossing a call.
  for (let i = 0; i < 20_000; i++) {
    const a = value(),
      b = value(),
      c = value();
    hypotTerms[0] = a;
    hypotTerms[1] = b;
    hypotTerms[2] = c;
    hypotOf(3);
    assert.equal(hypotTerms[4], Math.hypot(a, b, c));
  }
  hypotTerms[0] = Infinity;
  hypotTerms[1] = -1;
  hypotOf(2);
  assert.equal(hypotTerms[4], Infinity);
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
