// Bug KB-COMPAT-FRAMEALLOC1 (scripts/frame-alloc-browser.mjs under MARGO_COMPAT=1, shadowed scene, 2026-11-17): the
// nearest-depth route that runs on the WebGL2 layer (src/compat.ts) walked its dispatches with `for (const [i, group] of
// this.groups.entries())`, an iterator and a pair array for every level: 421 B a frame in the profile (192 B in the probe), against 860 B for
// the whole scene on native WebGPU. It now walks them by index and allocates nothing. The probe records the route's
// reduction (three dispatches) into a stand-in encoder in a fresh process (support/compat-alloc-probe.mjs); the code before
// the fix read 192 B a call, now 0 B.
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

test('the nearest-depth route records its reduction without allocating', () => {
  const { bytes } = JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', ...HEAP, fileURLToPath(new URL('./support/compat-alloc-probe.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  );
  const median = [...bytes].sort((a, b) => a - b)[bytes.length >> 1];
  assert.ok(median < 1, `encode allocated ${median} B a call (Node ${process.version}, V8 ${process.versions.v8})`);
});
