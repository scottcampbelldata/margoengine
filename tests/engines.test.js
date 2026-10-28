// Bug 23 (2026-10-27): the root package.json declared Node >=22.12.0, but 14 test files use `using` declarations, which
// Node 22.22.1 cannot parse (106 to 110 unit tests failed on the Windows Beelink), and the packed React tests need
// Node 24's mock.module timing (bug 18). The repository now declares the minimum its tests need (24.18.0) and the
// packages keep theirs (22.12.0: every shipped file parses and every entry imports there). scripts/check-engines.mjs
// keeps the fields, CI and the syntax the files use in step; CI runs its --run checks on each minimum.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { check, compare, version } from '../scripts/check-engines.mjs';

const root = resolve(import.meta.dirname, '..');

test('the declared Node minimums match the syntax the files use and the CI jobs', async () => {
  assert.deepEqual(await check(), []);
});

test('ranges are ">=x.y.z" and compare by number', () => {
  assert.deepEqual(version('>=22.12.0'), [22, 12, 0]);
  assert.deepEqual(version('v24.18.0'), [24, 18, 0]);
  assert.throws(() => version('^22'), /must be ">=x\.y\.z"/);
  assert.ok(compare([24, 0, 0], [22, 12, 0]) > 0 && compare([22, 9, 0], [22, 12, 0]) < 0);
});

test('a test with `using` under an older repository minimum, and CI off the minimum, are reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-engines-'));
  try {
    const write = (file, text) => {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    write('package.json', JSON.stringify({ private: true, engines: { node: '>=22.12.0' } }));
    write('packages/a/package.json', JSON.stringify({ name: '@x/a', engines: { node: '>=22.12.0' } }));
    write('packages/a/dist/index.js', 'export const a = 1;\n');
    write('packages/a/tests/a.test.js', 'const s = "using x = y";\n{ using handle = open(); }\n');
    write('tests/plain.test.js', '// using x = y in a comment is fine\nexport {};\n');
    cpSync(join(root, '.github/workflows/ci.yml'), join(dir, '.github/workflows/ci.yml'));
    const problems = await check(dir);
    assert.deepEqual(
      problems.map((p) => p.replaceAll('\\', '/')),
      [
        "ci.yml's test job must run on node-version '22.12.0', the root engines minimum",
        'packages/a/tests/a.test.js uses `using` / `await using` declarations, which needs Node 24.0.0, but its scope (repo) declares >=22.12.0',
      ],
    );
    // Shipped code may not use it either while the packages declare 22.12. (The packages' dist is lowered by the build;
    // this proves a file that escaped the lowering is caught.)
    write('package.json', JSON.stringify({ private: true, engines: { node: '>=24.18.0' } }));
    write('packages/a/dist/index.js', 'export async function f() { await using r = g(); }\n');
    assert.deepEqual(
      (await check(dir)).map((p) => p.replaceAll('\\', '/')),
      [
        'packages/a/dist/index.js uses `using` / `await using` declarations, which needs Node 24.0.0, but its scope (packages) declares >=22.12.0',
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the node-compat job must run the end-user proof on the minimum and the latest of its major line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-engines-'));
  try {
    const write = (file, text) => {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    write('package.json', JSON.stringify({ private: true, engines: { node: '>=24.18.0' } }));
    write('packages/a/package.json', JSON.stringify({ name: '@x/a', engines: { node: '>=22.12.0' } }));
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
      .replace("node: ['22.12.0', '22', '26']", "node: ['22.12.0', '26']")
      .replace('npm run modern:test:packages -- --consumer', 'npm run modern:test:packages');
    write('.github/workflows/ci.yml', ci);
    assert.deepEqual(await check(dir), [
      "ci.yml's node-compat matrix must include '22', the latest 22.x",
      "ci.yml's node-compat job must run `npm run modern:test:packages -- --consumer`",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
