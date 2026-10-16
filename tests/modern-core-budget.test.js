import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCoreBudget} from '../scripts/core-budget.js';
import {measureCoreStage} from '../scripts/measure-size.js';
test('core + stage gate rejects the ceiling and any excess', async () => {
  checkCoreBudget(19_999);
  checkCoreBudget(24_999);
  for (const value of [25_000, 25_001]) assert.throws(() => checkCoreBudget(value), /below/);
  for (const value of [NaN, -1, 19_999.5]) assert.throws(() => checkCoreBudget(value), /Invalid/);
  const {raw, gzip, modules} = await measureCoreStage();
  assert.ok(raw > gzip && gzip < 25_000);
  assert.ok(modules.some(path => path.includes('/packages/margoengine/')));
  assert.ok(modules.some(path => path.includes('/packages/core/')));
  assert.ok(modules.every(path => !path.replaceAll('\\', '/').includes('/packages/kinematics-constraints/')), 'Kinematics constraints entered core + stage');
  for (const name of ['decoders', 'gltf-pro'])
    assert.ok(modules.every(path => !path.replaceAll('\\', '/').includes(`/packages/${name}/`)), name + ' entered core + stage');
});
