import { execFileSync } from 'node:child_process';
import test from 'node:test';
test('mixed fields type-check with all component query and tracking APIs', () => {
  execFileSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'esnext',
      '--module',
      'nodenext',
      'packages/ecs/test/objects-types.ts',
    ],
    { cwd: new URL('../../../', import.meta.url), timeout: 120000, stdio: 'pipe' },
  );
});
