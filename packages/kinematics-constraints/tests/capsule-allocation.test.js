// The measurement runs in a fresh process (support/capsule-allocation-probe.mjs): other tests install overrides that
// make the solver's calls megamorphic, and the flags below must be set before V8 starts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Results written to tuples ([0, 0, 0] points) still allocate about 12 B per call; the README says to reuse typed arrays.
// The public evaluate() and segmentClearance() return a fractional number, which is a heap allocation by itself; the
// solver uses internal destination-passing paths for built-in capsules, which is what this measures.
//
// Regression (2026-11-07): the closest points shape failed under a full verify run at about 100 KB per window. The
// kernel allocated nothing; the test's own driver did. Each window called run() again, so it started in the
// interpreter and boxed every fractional input it computed until on-stack replacement landed, and on a loaded machine
// the compiler threads delivered that code some 6,000 iterations in. The probe now runs each driver until it has
// Turbofan code before measuring, and --no-concurrent-recompilation compiles on the main thread the moment a function
// earns it, so the tier a window measures depends on the calls run, never on the machine's load.
const probe = () =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--allow-natives-syntax',
        '--no-concurrent-recompilation',
        fileURLToPath(new URL('./support/capsule-allocation-probe.mjs', import.meta.url)),
      ],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  );

test('capsule solves and segment kernels allocate nothing per call', { timeout: 300_000 }, (t) => {
  for (const { name, clean, windows, status } of probe()) {
    // Bit 64 of %GetOptimizationStatus: the driver runs Turbofan code, so the windows measured the kernel's steady state.
    assert.ok(status & 64, `${name}: the driver never reached Turbofan (status ${status})`);
    assert.ok(clean, `${name}: every window of 20,000 allocated: ${JSON.stringify(windows)}`);
    t.diagnostic(`${name}: ${windows.at(-1).grown} B over 20,000`);
  }
});
