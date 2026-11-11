import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('built spline samples remain defined and satisfy PathControls', () => {
  const compiler = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
  const consumer = fileURLToPath(new URL('./declarations-consumer.mts', import.meta.url));
  const result = spawnSync(process.execPath, [
    compiler, '--noEmit', '--skipLibCheck', '--strict', '--target', 'esnext',
    '--module', 'nodenext', '--types', 'node', consumer,
  ], { encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
