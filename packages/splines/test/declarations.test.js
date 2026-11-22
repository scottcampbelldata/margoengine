import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('built spline samples remain defined and satisfy PathControls', () => {
  const compiler = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
  const consumer = fileURLToPath(new URL('./declarations-consumer.mts', import.meta.url));
  // --ignoreConfig: npm test runs in packages/splines, whose tsconfig.json TypeScript 7 refuses to skip silently when
  // files are named on the command line (error TS5112), as packages/shader/test/shader.test.js does.
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target',
      'esnext',
      '--module',
      'nodenext',
      '--types',
      'node',
      consumer,
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
