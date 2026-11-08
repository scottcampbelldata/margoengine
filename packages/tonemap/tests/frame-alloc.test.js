// Bug (test:frame-alloc:browser on the M6 Mac mini, 2026-11-08): the post scene's steady frame read 1,688 B against its
// 1,528 B floor. Tonemap's grading pass, recorded every frame, had come to allocate on each call: an empty extensions
// array when none were given, a flatMap result and the closures of flatMap, some and forEach over the extensions,
// a for-of iterator, and the pipeline key string. A frame without extensions now makes none of them, and the key is
// built only when what it names changes: the post scene reads 1,528 B on this Mac again. The probe runs the pass on
// the stand-in device in a fresh process (support/frame-alloc-probe.mjs); the code before the fix read 344 B a call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The V8 flags of tests/frame-alloc.test.js at the repository root, which gives the reason for each.
const HEAP = [
  '--min-semi-space-size=16',
  '--max-semi-space-size=16',
  '--single-threaded-gc',
  '--no-concurrent-recompilation',
  '--no-concurrent-sparkplug',
];

test('a steady Tonemap grading pass without extensions allocates nothing', () => {
  const { bytes } = JSON.parse(
      execFileSync(
        process.execPath,
        ['--expose-gc', ...HEAP, fileURLToPath(new URL('./support/frame-alloc-probe.mjs', import.meta.url))],
        { encoding: 'utf8', timeout: 240_000 },
      ),
    ),
    median = [...bytes].sort((a, b) => a - b)[bytes.length >> 1];
  assert.ok(
    median < 1,
    `Tonemap's pass allocated ${median} B a call (Node ${process.version}, V8 ${process.versions.v8})`,
  );
});
