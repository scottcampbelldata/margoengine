import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_STAGE_GZIP_LIMIT, checkCoreBudget } from '../scripts/core-budget.js';
import { measureCoreStage } from '../scripts/measure-size.js';
test('core + stage gate rejects the ceiling and any excess', async () => {
  checkCoreBudget(19_999);
  checkCoreBudget(CORE_STAGE_GZIP_LIMIT - 1);
  // Never above the 30,000 B cap (AGENTS.md, Scott 2026-11-15).
  assert.ok(CORE_STAGE_GZIP_LIMIT <= 30_000);
  for (const value of [CORE_STAGE_GZIP_LIMIT, CORE_STAGE_GZIP_LIMIT + 1])
    assert.throws(() => checkCoreBudget(value), /below/);
  for (const value of [NaN, -1, 19_999.5]) assert.throws(() => checkCoreBudget(value), /Invalid/);
  const { raw, gzip, modules } = await measureCoreStage();
  assert.ok(raw > gzip && gzip < CORE_STAGE_GZIP_LIMIT);
  assert.ok(modules.some((path) => path.includes('/packages/stage/')));
  assert.ok(modules.some((path) => path.includes('/packages/core/')));
  assert.ok(
    modules.every((path) => !path.replaceAll('\\', '/').includes('/packages/kinematics-constraints/')),
    'Kinematics constraints entered core + stage',
  );
  for (const name of ['decoders', 'gltf'])
    assert.ok(
      modules.every((path) => !path.replaceAll('\\', '/').includes(`/packages/${name}/`)),
      name + ' entered core + stage',
    );
});
