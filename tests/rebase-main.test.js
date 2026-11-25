// scripts/rebase-main.mjs on a scripted conflict in a temporary repository: generated files are regenerated or merged
// and the rebase finishes; a conflict in a source file stops it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { endRecorder } from './support/end-recorder.js';

const script = resolve(import.meta.dirname, '..', 'scripts', 'rebase-main.mjs');
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const SIZES = 'scripts/quality/baselines/sizes.json';
const sizes = (items, history = []) =>
  JSON.stringify({ gate: 'sizes', total: Object.values(items).reduce((a, b) => a + b, 0), history, items }, null, 2) +
  '\n';

/** A clone with a `work` branch and an origin/main that moved on; `files` maps path to [base, upstream, work]. */
function repository(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-rebase-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const origin = join(dir, 'origin.git'),
    clone = join(dir, 'clone');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, clone);
  const all = {
    ...files,
    'scripts/build-llms.mjs': Array(3).fill(
      "import { readFileSync, writeFileSync } from 'node:fs';\n" +
        "writeFileSync('site/llms.txt', readFileSync('docs/a.md', 'utf8') + readFileSync('docs/b.md', 'utf8'));\n",
    ),
  };
  const commit = (index, message) => {
    for (const [path, versions] of Object.entries(all)) {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), versions[index]);
    }
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', message);
  };
  git(clone, 'checkout', '-q', '-b', 'main');
  commit(0, 'base');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', 'work');
  commit(2, 'work');
  git(clone, 'checkout', '-q', 'main');
  commit(1, 'upstream');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', 'work');
  const read = (path) => readFileSync(join(clone, path), 'utf8').replace(/\r\n/g, '\n');
  const rebase = (runEnv = env) =>
    spawnSync(process.execPath, [script], { cwd: clone, env: runEnv, encoding: 'utf8', timeout: 120_000 });
  return { clone, git: (...args) => git(clone, ...args), read, rebase };
}

test('generated files are regenerated or merged by key and the rebase finishes', (t) => {
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'docs/b.md': ['b\n', 'b\n', 'b work\n'],
    'site/llms.txt': ['a\nb\n', 'a upstream\nb\n', 'a\nb work\n'],
    [SIZES]: [
      sizes({ 'a/.': 10, 'b/.': 20, 'c/.': 5 }),
      sizes({ 'a/.': 12, 'b/.': 20, 'c/.': 5, 'u/.': 1 }, [{ reason: 'upstream' }]),
      sizes({ 'a/.': 10, 'b/.': 25, 'w/.': 7 }, [{ reason: 'work' }]),
    ],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.read('site/llms.txt'), 'a upstream\nb work\n');
  const merged = JSON.parse(repo.read(SIZES));
  assert.deepEqual(merged.items, { 'a/.': 12, 'b/.': 25, 'u/.': 1, 'w/.': 7 });
  assert.equal(merged.total, 45);
  assert.deepEqual(merged.history, [{ reason: 'upstream' }, { reason: 'work' }]);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('log', '--format=%s').trim(), 'chore: generated files after the rebase\nwork\nupstream\nbase');
});

test('a conflict in a source file stops the rebase, names it, and a second run finishes it', (t) => {
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a upstream\n', 'a work\n'],
    'docs/b.md': ['b\n', 'b\n', 'b\n'],
    'site/llms.txt': ['a\nb\n', 'a upstream\nb\n', 'a work\nb\n'],
  });
  // The stop ends by the event loop with code 1, never through process.exit (KB-OWN-EXIT2).
  const recorder = endRecorder(mkdtempSync(join(repo.clone, '..', 'ends-')), env);
  const result = repo.rebase(recorder.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the generated files:\n {2}docs\/a\.md/);
  assert.deepEqual(recorder.lines(), ['undefined loop 1']);
  writeFileSync(join(repo.clone, 'docs/a.md'), 'a both\n');
  repo.git('add', 'docs/a.md');
  const resumed = repo.rebase();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(repo.read('site/llms.txt'), 'a both\nb\n');
});

test('a clean rebase runs no generator and adds no commit', (t) => {
  const stub = (body) => Array(3).fill(`import { appendFileSync } from 'node:fs';\n${body}\n`);
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'docs/b.md': ['b\n', 'b\n', 'b work\n'],
    'docs/api-surface.md': ['base\n', 'base\n', 'base\n'],
    'scripts/api-report.js': stub("appendFileSync('docs/api-surface.md', 'ran\\n');"),
    'scripts/generate-all-entries.mjs': stub("appendFileSync('docs/api-surface.md', 'ran\\n');"),
    'site/llms.txt': ['x\n', 'x\n', 'x\n'],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /done, no conflict markers/);
  assert.equal(repo.read('docs/api-surface.md'), 'base\n', 'no generator ran');
  assert.equal(repo.read('docs/a.md'), 'a upstream\n');
  assert.equal(repo.read('docs/b.md'), 'b work\n');
  assert.equal(repo.git('log', '--format=%s').trim(), 'work\nupstream\nbase');
});

test('a conflict in a later generated-only commit regenerates only the package the branch changed', (t) => {
  const stub = (body) =>
    Array(3).fill(`import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\n${body}\n`);
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a\n', 'a\n'],
    'docs/b.md': ['b\n', 'b\n', 'b\n'],
    'docs/api-surface.md': ['base\n', 'upstream\n', 'base\n'],
    'packages/scene/package.json': ['{}\n', '{}\n', '{ }\n'],
    'scripts/api-report.js': stub("appendFileSync('docs/api-surface.md', `${process.argv.slice(2).join(' ')}\\n`);"),
    'scripts/generate-all-entries.mjs': stub(''),
    'site/llms.txt': ['a\nb\n', 'a\nb\n', 'a\nb\n'],
  });
  writeFileSync(join(repo.clone, 'docs/api-surface.md'), 'work\n');
  repo.git('commit', '-qam', 'generated');
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.read('docs/api-surface.md'), 'upstream\n--update --package=scene\n');
  assert.equal(repo.git('status', '--porcelain'), '');
});
