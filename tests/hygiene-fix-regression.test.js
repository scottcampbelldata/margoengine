import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertFixCommitsHaveRegression, fixCommitsWithoutRegression } from '../scripts/support/fix-regression.mjs';

test('hygiene rejects fix commits with no test change and no real Regression path', () => {
  const home = resolve(import.meta.dirname, '..', 'test-results');
  mkdirSync(home, { recursive: true });
  const root = mkdtempSync(join(home, 'hygiene-fix-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_COMMITTER_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 }).trim();
  const put = (file, text) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const commit = (message, files) => {
    for (const [f, t] of Object.entries(files)) put(f, t);
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD').slice(0, 10);
  };
  try {
    git('init', '--quiet');
    put('packages/post/test/heat-haze.test.js', 'x\n');
    const base = commit('feat(post): base', { 'a.txt': '0' });
    // Empty range: skipped cleanly.
    assert.deepEqual(fixCommitsWithoutRegression(root, `${base}..HEAD`), []);
    const wrongPath = commit('fix(post): shader\n\nRegression: packages/post/tests/heat-haze.test.js', {
      'a.txt': '1',
    });
    const noTest = commit('fix: plain', { 'a.txt': '2' });
    const goodPath = commit('fix(post): ok\n\nRegression: packages/post/test/heat-haze.test.js', { 'a.txt': '3' });
    const notATest = commit('fix(x): not a test\n\nRegression: a.txt', { 'a.txt': '4' });
    const changesTest = commit('fix(core): ok', { 'packages/core/tests/a.test.js': 'y\n' });
    const changesTestDir = commit('fix(core)!: ok', { 'packages/core/test/b.js': 'y\n' });
    const notFix = commit('feat(x): fine', { 'a.txt': '5' });
    commit('fixture: not a fix', { 'a.txt': '6' });
    const problems = fixCommitsWithoutRegression(root, `${base}..HEAD`);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0], new RegExp(`${notATest}.*not a test file`));
    assert.match(problems[1], new RegExp(`${noTest}.*no "Regression:`));
    assert.match(problems[2], new RegExp(`${wrongPath}.*tests/heat-haze.test.js.*not a file`));
    for (const ok of [goodPath, changesTest, changesTestDir, notFix]) assert.ok(!problems.join('\n').includes(ok));
    assert.throws(
      () => assertFixCommitsHaveRegression(root, `${base}..HEAD`),
      /AGENTS\.md[\s\S]*packages\/post\/tests\/heat-haze/,
    );
    assert.doesNotThrow(() => assertFixCommitsHaveRegression(root, `${changesTestDir}..HEAD`));
    assert.deepEqual(fixCommitsWithoutRegression(root, 'nonexistent..HEAD'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
