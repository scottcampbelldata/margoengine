import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hypot, hypotOf, hypotTerms } from '../packages/shared/hypot.js';
import { FLOORS, frameBytes, overFloor } from '../scripts/frame-alloc-browser.mjs';

// The probes run in a fresh process with --expose-gc: inside the test runner, other tests' timers, promises and JIT
// work share the heap (packages/lod/test/lod.test.js learned this). A 16 MB young generation keeps V8 from collecting
// inside a measured window, and the probes leave out any window it collected in (support/heap-windows.mjs). With
// --single-threaded-gc no sweeper thread frees pages while a window counts (Node 24 read a window as -387 B a call).
// --no-concurrent-recompilation compiles optimized code on the main thread the moment a function earns it, so the tier
// a window measures depends on the frames run, never on the machine's load: with compiler threads that a parallel
// package build starved, Turbofan's code arrived after the warm-up and the core frame read 300 B (its Maglev cost)
// against the 256 B limit. The tiers and their bytes are the same; only the wall-clock race is gone.
// --no-concurrent-sparkplug does the same for the baseline tier: V8 on macOS arm64 compiles Sparkplug code in batches
// on a background thread by default, and its code landed in whichever window was running when the thread finished, a
// page at a time (one window read 572 B a call against 72, an allocating frame 128 B against 680).
const HEAP = [
  '--min-semi-space-size=16',
  '--max-semi-space-size=16',
  '--single-threaded-gc',
  '--no-concurrent-recompilation',
  '--no-concurrent-sparkplug',
];
// `flags` go to V8 (before the script), `args` to the probe.
const probeWith = (flags, ...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        ...HEAP,
        ...flags,
        fileURLToPath(new URL('./support/core-frame-alloc-probe.mjs', import.meta.url)),
        ...args,
      ],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  ).bytes;
const probe = (...args) => probeWith([], ...args);
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
// Every message names the Node and V8 that measured it: the middle tier differs between V8 versions.
const host = `Node ${process.version}, V8 ${process.versions.v8}`,
  v8Major = Number(process.versions.v8.split('.')[0]);
// Middle-tier limits by V8 major, one row per major measured, the newest row for newer majors. Same limits where a
// version can reach them; V8 13 (Node 24, the minimum Node) gets its own row only where it provably cannot.
// V8 13's Maglev has no inline Math.sqrt (V8 14's does): every Math.sqrt of a fractional number is a call that boxes
// its argument and its result, 32 B. The shadowed frame takes 22 square roots past core's (hypotOf per caster in
// range(), the seven of fitCascades, two in viewMatrix: 704 B on their own, over 620) and the cascade fit takes 7
// (224 B, over 128). The results must stay those of Math.sqrt bit for bit, and a square root in JavaScript
// arithmetic would cost every engine and tier more time than V8 13's Maglev loses in garbage, so these two rows
// stay. Measured on Node 24.18.0 (V8 13.6.233.17) after the Node 24 fixes: shadows add 1,081 B per frame, the
// cascade fit 242 B per call; Node 26.12.0 (V8 14.6.202.34): 360 and 20.
const TIER = {
  13: { shadows: 1120, cascades: 256 },
  14: { shadows: 620, cascades: 128 },
};
const tier = TIER[Math.min(v8Major, 14)];
// Node 22's V8 12 ships without Maglev (--no-maglev): its tier between the baseline and Turbofan does not exist, so
// there is no middle tier to measure (scripts/frame-alloc-nodes.mjs reports it as skipped).
const noTier = tier ? false : `${host} has no Maglev tier by default`;
// The same probes with V8 stopped at Maglev (--max-opt=2), the tier a once-per-frame function runs in for its first
// thousands of frames in a browser: it boxes fractional numbers passed to calls it does not inline, and allocates a
// closure context on each call of a function whose locals an inner function captures.
// `opt` is V8's highest tier: 1 the baseline (Sparkplug), 2 Maglev.
const tierProbeAt = (opt, script, ...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', ...HEAP, `--max-opt=${opt}`, fileURLToPath(new URL(`./support/${script}`, import.meta.url)), ...args],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  ).bytes;
const tierProbe = (script, ...args) => tierProbeAt(2, script, ...args);

// Regression (item 53.1): core's steady frame allocated 1,055 B on the CPU alone (Node, stand-in GPU): a regex literal
// per resize, some() closures over the light, an array and every() in Camera.update, Math.hypot's argument arrays,
// Object.assign's literal in the renderer and an iterator per for...of over the batch Map, the plugins, the callbacks
// and the frame graph's passes. What is left (about 210 B) is V8 boxing the frame delta for each callback it calls.
test("core's steady-state frame allocates at most 256 bytes on the CPU", { timeout: 300_000 }, () => {
  const bytes = probe();
  assert.ok(median(bytes) <= 256, `core frame allocated ${bytes.join(', ')} B per frame (${host})`);
});

// Regression (item 53.1): Shadows' depth passes cleared and refilled Maps and Sets of every caster each pass, and
// emptied their batch lists with length = 0 (V8 then drops the storage and the next push allocates it again).
test('a shadowed frame (eight moving casters, four cascades) adds at most 512 bytes to it', {
  timeout: 300_000,
}, () => {
  const core = median(probe()),
    shadowed = median(probe('--shadows'));
  assert.ok(
    shadowed - core <= 512,
    `shadows added ${shadowed - core} B per frame (${shadowed} against ${core}; ${host})`,
  );
});

// Regression (item 53.1, part 2): in Maglev the frame allocated about 850 B on the CPU: Number.isFinite on every
// setter value and camera matrix element boxed each fractional value, and hypot's arguments and result were boxed.
// Regression (Node 24): on V8 13 it allocated 1,570 B: V8 13's Maglev also calls Math.max, Math.min and Math.fround
// with boxed numbers, and a loop sum feeding Math.sqrt was boxed on every step (camera planes, hypotOf).
test("core's steady-state frame in V8's middle tier allocates at most 780 bytes", {
  timeout: 300_000,
  skip: noTier,
}, () => {
  const bytes = tierProbe('core-frame-alloc-probe.mjs');
  assert.ok(median(bytes) <= 780, `core frame allocated ${bytes.join(', ')} B per frame at Maglev (${host})`);
});

// Regression (item 53.1, part 2): Shadows added about 715 B per frame in Maglev: a closure context on every draw call
// (an inner arrow captured draw's pipeline), Number.isFinite and hypot boxing in fitCascades and range(), and core's
// renderer allocated a some() closure per draw and emptied the plugin bindings list with length = 0.
// Regression (Node 24): Math.max and Math.min per caster in range() and worldSphere, Math.fround in validate, and
// viewMatrix's Math.max added about 1,000 B more on V8 13.
test(`a shadowed frame in the middle tier adds at most ${tier?.shadows} bytes to it`, {
  timeout: 300_000,
  skip: noTier,
}, () => {
  const core = median(tierProbe('core-frame-alloc-probe.mjs')),
    shadowed = median(tierProbe('core-frame-alloc-probe.mjs', '--shadows'));
  assert.ok(
    shadowed - core <= tier.shadows,
    `shadows added ${shadowed - core} B per frame at Maglev (${shadowed} against ${core}; ${host})`,
  );
});

// Regression (item 53.1, part 2): fitCascades boxed 64 matrix elements into Number.isFinite and seven hypot calls'
// numbers (about 530 B per frame); invertMatrixStable boxed its 48 finiteness checks (about 595 B per call).
// Regression (Node 24): on V8 13 the fit took 993 B (Math.max in hypotOf, Math.min in cascadeSplits) and the
// inverse 865 B (Math.max over the row scales, Math.fround over the result); both are calls there.
// Regression (2026-11-07): with --no-concurrent-recompilation the cascade probe read 273.5 B against 256. Its driver
// read near and far from its camera object to pass them to cascadeSplits, which Maglev does not inline, and boxed
// both on every call in the loop's on-stack replacement code; the probe now passes them as they are (241.5 B).
test('the cascade fit and the stable matrix inverse allocate little in the middle tier', {
  timeout: 300_000,
  skip: noTier,
}, () => {
  const cascades = median(tierProbe('tier-alloc-probe.mjs', 'cascades')),
    invert = median(tierProbe('tier-alloc-probe.mjs', 'invert'));
  assert.ok(
    cascades <= tier.cascades,
    `cascadeSplits + fitCascades allocated ${cascades} B per frame at Maglev (${host})`,
  );
  assert.ok(invert <= 450, `invertMatrixStable allocated ${invert} B per call at Maglev (${host})`);
});

// Regression (frame-alloc check on macOS, 2026-11-07): the post scene read 1,804 B a frame against its 1,528 B floor in
// Chrome, Edge and Chromium 156 on an M6 Mac mini, whatever the V8 compiler-thread flags. SceneTarget.copyDepth, three
// calls a frame, allocated 92 B a call there that the Windows measurement did not: a 28 B context for the closures of
// its once-only pipeline setup, made on every call, and a for-of iterator with its two results. At Maglev in Node the
// same code allocates 552 B a frame. Its setup now lives outside the method and it loops by index.
test('the three depth copies of a post-processed frame allocate nothing in the middle tier', {
  timeout: 300_000,
  skip: noTier,
}, () => {
  const bytes = median(tierProbe('tier-alloc-probe.mjs', 'copyDepth'));
  assert.ok(bytes < 1, `SceneTarget.copyDepth allocated ${bytes} B per frame at Maglev (${host})`);
});

// Regression (KB0378, 2026-11-11): the browser check's instanced scene (10,000 moving boxes) read 4,048 B a frame
// against its 292 B floor, 3,744 B of it in core's uploadRows on the Radeon 680M machine and then on the RTX A6000 (Edge
// 157). It read each dirty-row word from the Uint32Array: a full word is 4294967295, outside V8's small integers, so
// every tier that keeps the value tagged (the interpreter, the baseline, Maglev's loop) boxed it, 12 B for each of the
// 312 full words. It now reads the words through a Uint16Array view, made once per words array.
test('uploading 10,000 changed rows allocates nothing in the baseline and middle tiers', { timeout: 300_000 }, () => {
  for (const opt of noTier ? [1] : [1, 2]) {
    const bytes = median(tierProbeAt(opt, 'tier-alloc-probe.mjs', 'uploadRows'));
    assert.ok(bytes < 1, `uploadRows allocated ${bytes} B per call at --max-opt=${opt} (${host})`);
  }
});

// Regression (frame-alloc check, 2026-10-30): one late frame deoptimized core's frame loop. Its clamp tested
// `step < most || step !== step`, so the NaN compare first ran on a frame past maxDelta, had no type feedback, and the
// optimized loop deoptimized there; a once-per-frame function then runs thousands of frames in a tier that boxes
// numbers, and the browser check read every scene 24 to 84 B per frame over its floor, but only when check:merge ran
// other GPU tests beside it (a loaded machine has late frames). Both compares now run on every frame.
test("one late frame leaves core's frame loop optimized", { timeout: 120_000 }, () => {
  const status = (...flags) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['--allow-natives-syntax', ...flags, fileURLToPath(new URL('./support/late-frame-probe.mjs', import.meta.url))],
        { encoding: 'utf8', timeout: 100_000 },
      ),
    );
  // Default tiers, and V8 stopped at Maglev.
  for (const flags of [[], ...(noTier ? [] : [['--max-opt=2']])]) {
    const { before, after, statuses } = status(...flags);
    assert.ok(before, `the frame loop never got optimized (status ${statuses[0]}; ${flags.join(' ')} ${host})`);
    assert.ok(
      after,
      `a late frame deoptimized the frame loop (status ${statuses.join(' -> ')}; ${flags.join(' ')} ${host})`,
    );
  }
});

// Regression (2026-10-30): the core frame test failed only while a package build ran beside it. V8's compiler
// threads, starved, delivered Turbofan's code after the probe's fixed warm-up, so every window measured Maglev code
// (300 B against 256). --concurrent-recompilation-delay stands in for the starved threads: with it the probe must
// still measure the optimized frame.
test('the frame probe measures the same frame when the compiler threads are slow', { timeout: 300_000 }, () => {
  const bytes = probeWith(['--concurrent-recompilation-delay=1000']);
  assert.ok(median(bytes) <= 256, `core frame allocated ${bytes.join(', ')} B per frame with slow compiles (${host})`);
});

test('the frame probe notices a frame that allocates', { timeout: 300_000 }, () => {
  const bytes = probe('--allocate');
  assert.ok(Math.min(...bytes) > 256, `the probe saw only ${bytes.join(', ')} B per frame from an allocating frame`);
});

// Regression (Node 24): a window inside which V8 collected garbage read low, so a frame that allocated more could pass
// (a shadowed frame of about 2,300 B per frame read as 351 B). The probes leave such windows out and measure again,
// and fail when no window stays clean.
test('the probes leave out a window in which V8 collected garbage', { timeout: 60_000 }, () => {
  const windows = JSON.stringify(new URL('./support/heap-windows.mjs', import.meta.url).href),
    measure = (young, size) =>
      execFileSync(
        process.execPath,
        [
          '--expose-gc',
          '--single-threaded-gc',
          // As the probes (HEAP above): a compiler thread's work lands in a window at a time the machine's load decides.
          '--no-concurrent-recompilation',
          '--no-concurrent-sparkplug',
          `--max-semi-space-size=${young}`,
          '--input-type=module',
          '-e',
          `import { heapWindows } from ${windows};
let kept;
try {
  const bytes = heapWindows((calls) => { for (let i = 0; i < calls; i++) kept = new Array(${size}).fill(i); });
  console.log(JSON.stringify(bytes));
} catch (error) { console.log(error.message); }`,
        ],
        { encoding: 'utf8', timeout: 50_000 },
      );
  // 4 KB per call, 4 MB per window: a 1 MB young generation collects inside every window.
  assert.match(measure(1, 512), /collected garbage inside 6 of 6 windows/, host);
  // A one-element array a call (about 100 B with the loop's own work, unoptimized) stays clean in a 16 MB one, and
  // every window counts it.
  const bytes = JSON.parse(measure(16, 1));
  assert.equal(bytes.length, 5, host);
  for (const b of bytes) assert.ok(b >= 16 && b <= 256, `${bytes.join(', ')} B per call (${host})`);
});

// Regression: a read that caught about 210 KB of something else came off all five windows of a run, which then read
// about -118 B per call, 210 under the 92 B every other run gives. Run by run the windows stayed a fixed step apart.
// Regression (macOS arm64): V8 compiled baseline code on a background thread there by default, and this run's first window
// read 572 B (or 334 B) a call against 72 in 9 of 12 runs. Every run forces that thread on, as macOS has it, before the
// probes' own flags turn it off, so the race is tried on every system.
test('one heap read that catches something else does not shift every window', { timeout: 60_000 }, () => {
  const windows = JSON.stringify(new URL('./support/heap-windows.mjs', import.meta.url).href);
  for (let run = 0; run < 4; run++) {
    const out = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--concurrent-sparkplug',
        '--single-threaded-gc',
        '--no-concurrent-recompilation',
        '--no-concurrent-sparkplug',
        '--max-semi-space-size=16',
        '--input-type=module',
        '-e',
        `import v8 from 'node:v8';
import { syncBuiltinESMExports } from 'node:module';
const real = v8.getHeapStatistics;
let reads = 0;
v8.getHeapStatistics = () => {
  const statistics = real();
  if (++reads >= 3) statistics.used_heap_size += 210000;
  return statistics;
};
syncBuiltinESMExports();
const { heapWindows } = await import(${windows});
let kept;
console.log(JSON.stringify(heapWindows((calls) => { for (let i = 0; i < calls; i++) kept = new Array(1).fill(i); })));`,
      ],
      { encoding: 'utf8', timeout: 12_000 },
    );
    const bytes = JSON.parse(out);
    for (const b of bytes) assert.ok(b >= 16 && b <= 256, `run ${run + 1}: ${bytes.join(', ')} B per call (${host})`);
  }
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
  // Regression: an infinite term wins over a NaN one in either order, as in Math.hypot (Math.max made both NaN).
  assert.equal(hypot(2, Infinity, Number.NaN), Math.hypot(Infinity, Number.NaN));
  assert.equal(hypot(3, Number.NaN, 1, -Infinity), Infinity);
  assert.ok(Number.isNaN(hypot(3, 1, Number.NaN, 2)));
  assert.equal(Object.is(hypot(2, -0, -0), 0), true);
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
