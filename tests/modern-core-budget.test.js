import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCoreBudget} from '../scripts/core-budget.js';
import {measureCoreStage} from '../scripts/measure-size.js';
test('core + stage gate allows the ceiling and rejects any excess', async () => {
  checkCoreBudget(20_480);
  assert.throws(() => checkCoreBudget(20_481), /exceed/);
  for (const value of [NaN, -1, 20_480.5]) assert.throws(() => checkCoreBudget(value), /Invalid/);
  const {raw, gzip, modules} = await measureCoreStage();
  assert.ok(raw > gzip && gzip <= 20_480);
  assert.ok(modules.some(path => path.includes('/packages/margoengine/')));
  assert.ok(modules.some(path => path.includes('/packages/core/')));
});
