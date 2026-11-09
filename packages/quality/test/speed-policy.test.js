import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { speedBudget } from '../../../scripts/speed/budgets.mjs';

test('Quality GPU timestamp budget stays deferred and preserves its original exact boundary', () => {
  const previous = process.env.MARGO_SPEED_PHASE;
  try {
    process.env.MARGO_SPEED_PHASE = 'deferred';
    speedBudget('quality-triangle', {
      get milliseconds() {
        assert.fail('deferred timing assertion ran');
      },
    });
    process.env.MARGO_SPEED_PHASE = 'active';
    speedBudget('quality-triangle', { milliseconds: 6.999 });
    for (const milliseconds of [0, 7, NaN])
      assert.throws(() => speedBudget('quality-triangle', { milliseconds }), assert.AssertionError);
  } finally {
    if (previous === undefined) delete process.env.MARGO_SPEED_PHASE;
    else process.env.MARGO_SPEED_PHASE = previous;
  }
});

test('the Quality speed workload remains named and wall-clock instrumentation is opt-in', () => {
  const suites = JSON.parse(readFileSync(new URL('../../../scripts/speed/suites.json', import.meta.url), 'utf8'));
  assert.ok(suites.some((suite) => suite.id === 'packages/quality/test/browser-check.mjs'));
  const page = readFileSync(new URL('../../../packages/quality/test/browser-check.html', import.meta.url), 'utf8');
  assert.match(page, /pass\.draw\(3,400\)/);
  assert.match(page, /canvas\.width=640;canvas\.height=360/);
  assert.match(page, /start=speed\?performance\.now\(\):0/);
  assert.match(page, /if\(speed\)device\.queue\.onSubmittedWorkDone/);
  const runner = readFileSync(new URL('../../../packages/quality/test/browser-check.mjs', import.meta.url), 'utf8');
  assert.match(runner, /if \(speedEnabled\(\)\) query\.set\('speed', ''\)/);
  assert.match(runner, /first\.milliseconds < FAST_GPU_MS/);
  assert.match(runner, /speedBudget\('quality-triangle'/);
});
