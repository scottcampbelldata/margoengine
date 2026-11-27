// KB-QUALITY-COUPLINGTESTS1: verify ran packages/*/tests/coupling/*.test.js, but the tests gate did not count them, so
// nine physics entries tested there read as unimported. Every folder verify runs tests from must count in the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testsGate } from '../scripts/quality/tests-floor.js';
import { PARALLEL } from '../scripts/verify.mjs';

const globs = PARALLEL.flat()
  .find((command) => command.includes(' --test ') && command.includes('tests/*.test.js'))
  .split(' ')
  .filter((word) => word.endsWith('*.test.js'));

test('the verify command names its test folders', () => assert.ok(globs.length >= 4, globs.join(' ')));

for (const glob of globs)
  test(`an entry imported by ${glob} counts as imported`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'margo-floor-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = glob.replace('packages/*', 'packages/sample').replace('*.test.js', 'one.test.js'),
      pkg = {
        name: '@margoengine/sample',
        dir: 'sample',
        entries: [{ specifier: '@margoengine/sample/part', dist: 'packages/sample/dist/part.js' }],
      };
    const run = (imported) => {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), imported ? "import '@margoengine/sample/part';\n" : '');
      return Object.keys(testsGate({ root, files: [file], packages: [pkg] }).items);
    };
    assert.deepEqual(
      run(true).filter((key) => key.startsWith('unimported')),
      [],
    );
    assert.ok(run(false).includes('unimported @margoengine/sample/part'));
  });
