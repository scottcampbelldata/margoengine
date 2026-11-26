// scripts/rebase-main.mjs on a scripted conflict in a temporary repository: generated files are regenerated or merged
// and the rebase finishes; a conflict in a source file stops it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  JSON.stringify(
    {
      gate: 'sizes',
      total: Object.values(items).reduce((a, b) => a + b, 0),
      history,
      items,
    },
    null,
    2,
  ) + '\n';

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
    spawnSync(process.execPath, [script], {
      cwd: clone,
      env: runEnv,
      encoding: 'utf8',
      timeout: 120_000,
    });
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

const surface = (total, rows) =>
  [
    '# Public API surface',
    '',
    total,
    '',
    '| Package | Exports per entry | Unexported | `any` | Gzip |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
const row = (name, entries, unexported = '') => `| ${name} | ${entries} | ${unexported} |  | 1,000 |`;
// Each run of the stubbed API report leaves its arguments in the git directory: the work count.
const generators = {
  'docs/a.md': ['a\n', 'a\n', 'a\n'],
  'docs/b.md': ['b\n', 'b\n', 'b\n'],
  'site/llms.txt': ['a\nb\n', 'a\nb\n', 'a\nb\n'],
  'scripts/api-report.js': Array(3).fill(
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync('.git/reports.log', process.argv.slice(2).join(' ') + '\\n');\n",
  ),
  'scripts/generate-all-entries.mjs': Array(3).fill('\n'),
};
const reports = (repo) => (existsSync(join(repo.clone, '.git/reports.log')) ? repo.read('.git/reports.log') : '');

test('a branch that adds entries merges the api-surface rows and builds no report, re-export packages included', (t) => {
  const post = row('@margoengine/post', '`.` 3, `./settings` 1', 2),
    scene = row('@margoengine/scene', '`.` 5'),
    sceneUpstream = row('@margoengine/scene', '`.` 6, `./up` 2'),
    postBranch = row('@margoengine/post', '`.` 3, `./lut` 4, `./settings` 1', 5);
  const repo = repository(t, {
    ...generators,
    'docs/api-surface.md': [
      surface('2 packages, 3 entries, 9 exported names.', [post, scene]),
      surface('2 packages, 4 entries, 12 exported names.', [post, sceneUpstream]),
      surface('2 packages, 4 entries, 13 exported names.', [postBranch, scene]),
    ],
    'api/post.lut.api.md': ['', '', 'lut\n'],
    'api/scene.api.md': ['s\n', 's upstream\n', 's\n'],
    'api/margoengine.api.md': ['m\n', 'm upstream\n', 'm\n'],
    'packages/post/package.json': ['{}\n', '{}\n', '{ }\n'],
    'packages/margoengine/package.json': ['{}\n', '{}\n', '{ }\n'],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reports(repo), '', 'no API report runs');
  assert.equal(
    repo.read('docs/api-surface.md'),
    surface('2 packages, 5 entries, 16 exported names.', [postBranch, sceneUpstream]),
  );
  assert.equal(repo.read('api/margoengine.api.md'), 'm upstream\n');
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('both sides changing one api-surface row keep the entries of both', (t) => {
  const post = (entries, unexported) => row('@margoengine/post', entries, unexported);
  const repo = repository(t, {
    ...generators,
    'docs/api-surface.md': [
      surface('1 packages, 2 entries, 4 exported names.', [post('`.` 3, `./settings` 1', 2)]),
      surface('1 packages, 3 entries, 9 exported names.', [post('`.` 3, `./ssr` 5, `./settings` 1', 3)]),
      surface('1 packages, 3 entries, 11 exported names.', [post('`.` 4, `./lut` 6, `./settings` 1', 6)]),
    ],
    'api/post.ssr.api.md': ['', 'ssr\n', ''],
    'api/post.lut.api.md': ['', '', 'lut\n'],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reports(repo), '');
  assert.equal(
    repo.read('docs/api-surface.md'),
    surface('1 packages, 4 entries, 16 exported names.', [post('`.` 4, `./ssr` 5, `./lut` 6, `./settings` 1', 7)]),
  );
});

const HOOKS = [
  'pre-rebase',
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'post-merge',
  'post-rewrite',
];
/** Every hook a rebase or a commit can run, each leaving its name in the git directory. */
function hooks(repo) {
  for (const name of HOOKS)
    writeFileSync(join(repo.clone, '.git/hooks', name), `#!/bin/sh\necho ${name} >> .git/hooks.log\n`, { mode: 0o755 });
  return () => (existsSync(join(repo.clone, '.git/hooks.log')) ? repo.read('.git/hooks.log') : '');
}

test('a two-commit branch replays without running any git hook, generated conflicts settled', (t) => {
  const repo = repository(t, {
    ...generators,
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'docs/b.md': ['b\n', 'b\n', 'b work\n'],
    'site/llms.txt': ['a\nb\n', 'a upstream\nb\n', 'a\nb work\n'],
  });
  writeFileSync(join(repo.clone, 'docs/second.md'), 'second\n');
  repo.git('add', 'docs/second.md');
  repo.git('commit', '-q', '--author=Someone <someone@example.invalid>', '-m', 'second\n\nIts body.');
  const authored = repo.git('log', '-2', '--format=%an|%ae|%ad|%B');
  const ran = hooks(repo);
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ran(), '', 'no hook ran');
  assert.match(result.stdout, /replayed 2 commit\(s\) without a checkout/);
  assert.equal(
    repo.git('log', '--format=%s').trim(),
    'chore: generated files after the rebase\nsecond\nwork\nupstream\nbase',
  );
  assert.equal(repo.git('log', '-2', '--skip=1', '--format=%an|%ae|%ad|%B'), authored);
  assert.equal(repo.git('log', '-3', '--format=%ce'), 'test@example.invalid\n'.repeat(3), 'the committer is yours');
  assert.equal(repo.read('docs/a.md'), 'a upstream\n');
  assert.equal(repo.read('docs/second.md'), 'second\n');
  assert.equal(repo.read('site/llms.txt'), 'a upstream\nb work\n');
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('branch', '--show-current'), 'work\n');
});

test('a replay never overwrites an untracked file that main adds', (t) => {
  const repo = repository(t, {
    ...generators,
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'docs/b.md': ['b\n', 'b\n', 'b work\n'],
  });
  // main gains a file this checkout already holds untracked.
  repo.git('checkout', '-q', 'main');
  writeFileSync(join(repo.clone, 'docs/new.md'), 'upstream\n');
  repo.git('add', 'docs/new.md');
  repo.git('commit', '-qm', 'adds new');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'work');
  writeFileSync(join(repo.clone, 'docs/new.md'), 'mine\n');
  const before = repo.git('rev-parse', 'HEAD');
  const result = repo.rebase();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new\.md/);
  assert.equal(repo.read('docs/new.md'), 'mine\n');
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
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

test('a report both sides changed, in a later generated-only commit, is built for its package alone', (t) => {
  const repo = repository(t, {
    ...generators,
    'api/scene.api.md': ['base\n', 'upstream\n', 'base\n'],
    'api/post.api.md': ['p\n', 'p\n', 'p work\n'],
    'packages/scene/package.json': ['{}\n', '{}\n', '{}\n'],
    'packages/post/package.json': ['{}\n', '{}\n', '{ }\n'],
  });
  writeFileSync(join(repo.clone, 'api/scene.api.md'), 'work\n');
  repo.git('commit', '-qam', 'generated');
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reports(repo), '--update --package=scene\n');
  assert.equal(repo.read('api/scene.api.md'), 'upstream\n');
  assert.equal(repo.git('status', '--porcelain'), '');
});

// e6b371f6f listed two messages in scripts/errors/entries.js and left site/errors.html as it was; hygiene failed on main.
test('a branch that changed the errors entries without building the page gets the page built, in its own commit', (t) => {
  const page = Array(3).fill(
    "import { readFileSync, writeFileSync } from 'node:fs';\n" +
      "const want = readFileSync('scripts/errors/entries.js', 'utf8').toUpperCase();\n" +
      "if (process.argv.includes('--check')) process.exit(readFileSync('site/errors.html', 'utf8') === want ? 0 : 1);\n" +
      "writeFileSync('site/errors.html', want);\n",
  );
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'scripts/errors/entries.js': ['one\n', 'one\n', 'one\ntwo\n'],
    'scripts/errors/page.mjs': page,
    'site/errors.html': ['ONE\n', 'ONE\n', 'ONE\n'],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /errors\.html was stale/);
  assert.equal(repo.read('site/errors.html'), 'ONE\nTWO\n');
  assert.equal(
    repo.git('log', '-1', '--format=%s').trim(),
    'chore: site/errors.html matches scripts/errors/entries.js',
  );
});

test('a branch whose errors page already matches its entries gets no extra commit', (t) => {
  const page = Array(3).fill(
    "import { readFileSync } from 'node:fs';\n" +
      "process.exit(readFileSync('site/errors.html', 'utf8') === readFileSync('scripts/errors/entries.js', 'utf8').toUpperCase() ? 0 : 1);\n",
  );
  const repo = repository(t, {
    'docs/a.md': ['a\n', 'a upstream\n', 'a\n'],
    'scripts/errors/entries.js': ['one\n', 'one\n', 'one\ntwo\n'],
    'scripts/errors/page.mjs': page,
    'site/errors.html': ['ONE\n', 'ONE\n', 'ONE\nTWO\n'],
  });
  const result = repo.rebase();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repo.git('log', '--format=%s').trim(), 'work\nupstream\nbase');
});
