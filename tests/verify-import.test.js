import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = `
  import assert from 'node:assert/strict';
  const plan = await import('./scripts/verify.mjs');
  assert.ok(plan.SERIAL.includes('npm run build:packages'));
  assert.ok(plan.PARALLEL.flat().includes('npm run api:check'));
  assert.equal(typeof plan.settle, 'function');
`;

for (const mode of ['eval', 'stdin', 'eval with argument']) {
  test(`verify plan imports from ${mode} without starting checks`, { timeout: 15_000 }, () => {
    const args = mode === 'stdin'
      ? ['--input-type=module']
      : ['--input-type=module', '--eval', source, ...(mode === 'eval with argument' ? ['consumer'] : [])];
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      input: mode === 'stdin' ? source : undefined,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
  });
}
