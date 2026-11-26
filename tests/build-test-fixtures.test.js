// Test files run straight after build:packages (CI's test and Node 22 jobs, test:changed). A built test fixture they
// import, such as physics' Rapier-backed oracle in tests/oracle/dist, must come from build:packages too: built only by
// the package's own `npm test`, it was missing in CI (29 ERR_MODULE_NOT_FOUND in the Node 22 job, KB-CI-ORACLE1).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every package whose tests import a built oracle has it built by build:packages', () => {
  const build = readFileSync(resolve(root, 'scripts/build-modern.js'), 'utf8');
  const missing = [];
  for (const pkg of readdirSync(resolve(root, 'packages'))) {
    const dir = resolve(root, 'packages', pkg, 'tests');
    if (!existsSync(dir)) continue;
    const imports = readdirSync(dir)
      .filter((file) => file.endsWith('.js'))
      .some((file) => /['"][^'"]*oracle\/dist\/[^'"]*['"]/.test(readFileSync(join(dir, file), 'utf8')));
    if (imports && !build.includes(`packages/${pkg}/scripts/build-oracle.js`)) missing.push(pkg);
  }
  assert.deepEqual(missing, [], 'build these oracles in scripts/build-modern.js');
});

test('the physics oracle builder writes the file the tests import', () => {
  const builder = readFileSync(resolve(root, 'packages/physics/scripts/build-oracle.js'), 'utf8');
  assert.match(builder, /outDir: resolve\(root, 'tests\/oracle\/dist'\)/);
  assert.match(builder, /fileName: \(\) => 'index\.js'/);
});
