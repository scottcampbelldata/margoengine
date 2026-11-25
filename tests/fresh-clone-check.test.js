// The fresh-clone check's verdict on a proof-runner run (scripts/fresh-clone-check.mjs): a fresh clone of main once failed
// `npm run verify` because 14 of the 20 --current proofs rebuilt their baselines with `git rev-parse` / `git show` on
// commits only one PC's pre-rewrite history held. Every way that showed up, or could show up, must count as a problem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkModules, MISSING_HISTORY, problems, scratchFolder } from '../scripts/fresh-clone-check.mjs';

const summary = (pass, historical, fail) => `\n${pass} pass, ${historical} historical, ${fail} fail in 0.3 min\n`;
const row = (name, result, note = '') => `${name.padEnd(24)} 57250a49 -> tree       ${result.padEnd(10)} 0   ${note}`;

test('a clean run has no problems', () => {
  assert.deepEqual(problems(row('post-stack', 'PASS') + summary(1, 0, 0), 0), []);
});

test('the failure the fresh clone hit: a proof that cannot resolve its baseline commit', () => {
  const out =
    row('post-stack', 'FAIL', 'Error: Command failed: git rev-parse --verify 57250a49^{commit}') +
    '\nfatal: Needed a single revision\n' +
    summary(0, 0, 1);
  const found = problems(out, 1);
  assert.ok(found.includes('the proof runner exited 1'), found.join('\n'));
  assert.ok(found.includes('post-stack: FAIL'), found.join('\n'));
  assert.ok(
    found.some((line) => line.startsWith('missing history:')),
    found.join('\n'),
  );
});

test('HISTORICAL fails --current (an ongoing guarantee always runs) and is allowed for pinned claims', () => {
  const out =
    row('procedural-deps', 'HISTORICAL', 'needs an install') + '\n' + row('water-ssr', 'HISTORICAL') + summary(0, 2, 0);
  assert.deepEqual(problems(out, 0), [
    'procedural-deps: HISTORICAL in --current (an ongoing guarantee must always run)',
    'water-ssr: HISTORICAL in --current (an ongoing guarantee must always run)',
  ]);
  const pinned =
    row(
      'lines-perspective',
      'HISTORICAL',
      'lines-perspective is pinned to 96edc75, a commit only in the pre-rewrite history',
    ) + summary(0, 1, 0);
  assert.deepEqual(problems(pinned, 0, true), []);
  assert.deepEqual(problems(row('geometry', 'FAIL') + summary(0, 0, 1), 1, true), [
    'the proof runner exited 1',
    'geometry: FAIL',
  ]);
});

test('missing-history messages count even when the runner exits 0', () => {
  for (const message of [
    'Error: post-stack --current asked Git for 57250a49; a --current run reads its baseline from baselines/ only',
    'AssertionError: golden: no stored baseline for water-ssr (--current against 57250a49); capture it ...',
    'HISTORICAL: lines-perspective is pinned to 2d192a71, a commit only in the pre-rewrite history (this clone ...',
    'fatal: bad object 6c20076d',
    'packages/math/src/mat4.ts does not exist at 2484971',
  ]) {
    assert.match(message, MISSING_HISTORY);
    assert.equal(problems(`${message}\n${summary(1, 0, 0)}`, 0).length, 1, message);
  }
});

test('no summary line (the runner crashed before its table) is a problem', () => {
  assert.deepEqual(problems('', 0), ['the proof runner printed no summary']);
});

// Regression (01047bfc5a): the clone lives in the temp folder, so its verify looked for the shared outside test inputs
// in <temp>/engine-bench and failed with "Missing Required test fixture". It now reads this checkout's cache.
test("the clone's verify reads this checkout's outside test inputs, wherever the clone sits", async () => {
  const { verifyEnv } = await import('../scripts/fresh-clone-check.mjs');
  const { externalAssetRoot } = await import('../scripts/support/external-test-assets.mjs');
  const env = verifyEnv({});
  assert.equal(externalAssetRoot(env), externalAssetRoot({}), 'the clone resolves the same folder as this checkout');
  assert.ok(env.MARGO_JUPYTER_VENV);
  const bench = { MARGO_ENGINE_BENCH: 'D:/bench' };
  assert.equal(
    externalAssetRoot(verifyEnv(bench)),
    externalAssetRoot(bench),
    'an override in this checkout carries over',
  );
});

// The 2026-11-15 nightly: every dev server in the clone answered 403 (Vite's allow list held the short 8.3 temporary
// path as given, the files their real path) and Next.js's Turbopack could not read next, @swc/helpers and the rest
// through junctions whose real paths lie outside the clone.
test('the clone folder sits under the real path of the temporary folder, not a link or short name to it', () => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'margo-fresh-test-')));
  try {
    const real = join(scratch, 'real');
    mkdirSync(real);
    symlinkSync(real, join(scratch, 'alias'), 'junction');
    const folder = scratchFolder(join(scratch, 'alias'));
    assert.equal(dirname(folder), real);
    assert.equal(realpathSync.native(folder), folder);
  } finally {
    rmSync(join(scratch, 'alias'));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('node_modules in the clone are its own files: real paths inside the clone, the same content', () => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'margo-fresh-test-')));
  try {
    const source = join(scratch, 'checkout', 'node_modules'),
      clone = join(scratch, 'clone');
    mkdirSync(join(source, 'next', 'dist'), { recursive: true });
    mkdirSync(join(source, '@swc', 'helpers'), { recursive: true });
    mkdirSync(join(source, 'shared'), { recursive: true });
    writeFileSync(join(source, 'next', 'package.json'), '{"name":"next"}');
    writeFileSync(join(source, 'next', 'dist', 'index.js'), 'export {};');
    writeFileSync(join(source, '@swc', 'helpers', 'package.json'), '{"name":"@swc/helpers"}');
    writeFileSync(join(source, 'shared', 'index.js'), 'export const shared = 1;');
    symlinkSync(join(source, 'shared'), join(source, 'next', 'linked'), 'junction');
    mkdirSync(join(clone, 'packages', 'core'), { recursive: true });
    writeFileSync(join(clone, 'packages', 'core', 'package.json'), '{"name":"@margoengine/core"}');
    linkModules(clone, source);
    const modules = join(clone, 'node_modules');
    for (const file of ['next/package.json', 'next/dist/index.js', '@swc/helpers/package.json']) {
      const path = join(modules, file);
      assert.equal(realpathSync.native(path), path, `${file} is reached by its own path in the clone`);
      assert.equal(readFileSync(path, 'utf8'), readFileSync(join(source, file), 'utf8'));
    }
    assert.equal(lstatSync(join(modules, 'next')).isSymbolicLink(), false);
    assert.equal(
      realpathSync.native(join(modules, 'next', 'linked')),
      join(source, 'shared'),
      'a link in the tree stays one',
    );
    assert.equal(realpathSync.native(join(modules, '@margoengine', 'core')), join(clone, 'packages', 'core'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
