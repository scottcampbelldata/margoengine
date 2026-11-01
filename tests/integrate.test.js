// scripts/integrate.mjs, the only pusher to main. git and every command are injected: no repository, no build, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMAIL,
  demoPath,
  fixWithoutTest,
  integrate,
  missingFromLog,
  parsePlan,
  parseReady,
  queuePaths,
  readQueue,
  readStopped,
  stoppedHits,
  suspects,
  syncMainCheckout,
} from '../scripts/integrate.mjs';

const PLAN = `check:merge: AFFECTED GPU run
  run  npm run verify
  run  npm run check:examples-types -- --projects=examples
  skip (no affected package uses it)  npm run check:views
  run  npm run modern:test:packages -- --packages=sky
steps: one at a time`;

const WORKSPACES = [
  { name: '@margoengine/sky', dir: 'packages/sky', deps: [] },
  { name: '@margoengine/fog', dir: 'packages/fog', deps: [] },
  { name: '@margoengine/world', dir: 'packages/world', deps: ['@margoengine/sky'] },
];

/** A fake clone. `branches`: sha to its changed paths. `conflicts`: shas whose rebase fails. Records every call. */
function fakeGit({
  branches = {},
  conflicts = [],
  pushFails = false,
  author = EMAIL,
  stranger = false,
  commits = [],
  manifests = {},
} = {}) {
  const calls = [];
  let head = 'base';
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const git = (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'rev-parse' && args[1] === 'origin/main') return ok('base');
    if (verb === 'rev-parse' && args[1] === 'HEAD') return ok(head);
    if (verb === 'rev-parse') {
      const sha = args[3].replace('^{commit}', '');
      return sha in branches ? ok(sha) : { status: 1, stdout: '', stderr: '' };
    }
    if (verb === 'merge-base' && args[1] === '--is-ancestor') return { status: 1, stdout: '', stderr: '' };
    if (verb === 'merge-base') return ok('old');
    if (verb === 'show') {
      const rev = args[1].split(':')[0];
      if (!(rev in manifests)) return { status: 1, stdout: '', stderr: 'no package.json' };
      return ok(JSON.stringify({ dependencies: Object.fromEntries(manifests[rev].map((name) => [name, '1.0.0'])) }));
    }
    if (verb === 'log' && args[1] === '--format=%ae') return ok(author);
    if (verb === 'log' && args[1] === '--no-merges') return ok(commits.map((c) => c.sha).join('\n'));
    if (verb === 'log' && args[1] === '-1') return ok(commits.find((c) => c.sha === args[3])?.message ?? 'chore: x');
    if (verb === 'diff-tree') return ok((commits.find((c) => c.sha === args.at(-1))?.files ?? []).join('\n'));
    if (verb === 'cat-file')
      return { status: commits.some((c) => c.tests?.includes(args[2].split(':')[1])) ? 0 : 1, stdout: '', stderr: '' };
    if (verb === 'log' && args[1] === '--format=%ae %ce')
      return ok(stranger ? `${EMAIL} other@example.com` : `${EMAIL} ${EMAIL}`);
    if (verb === 'log') return ok(`${head} a commit`);
    if (verb === 'diff' && args.includes('--diff-filter=U')) return ok('src/x.ts');
    if (verb === 'diff') return ok(branches[args.at(-1)].join('\n'));
    if (verb === 'checkout' && args.includes('--detach')) head = args.at(-1);
    if (verb === 'rebase' && args[1] === '-q') {
      const sha = args.at(-1);
      if (conflicts.includes(sha)) return { status: 1, stdout: '', stderr: 'CONFLICT' };
      head = `${head}+${sha}`;
    }
    if (verb === 'push') {
      if (pushFails) return { status: 1, stdout: '', stderr: 'rejected, non-fast-forward' };
    }
    return ok();
  };
  git.calls = calls;
  git.pushes = () => calls.filter((a) => a[0] === 'push');
  git.head = () => head;
  return git;
}

/** A fake command runner. `fail(command, attempt)` returns the failing output, or nothing for a pass. */
function fakeSteps(fail = () => undefined, git) {
  const ran = [];
  const run = async (command, { logFile, env }) => {
    ran.push({ command, env, head: git?.head() });
    const output = fail(command, git?.head());
    writeFileSync(logFile, command.includes('--plan') ? PLAN : (output ?? 'fine\n'));
    return { ok: output === undefined };
  };
  run.ran = ran;
  run.commands = () => ran.map((r) => r.command);
  return run;
}

function setup(entries = {}) {
  const home = mkdtempSync(join(tmpdir(), 'margo-integrate-')),
    paths = queuePaths(home);
  mkdirSync(paths.dir, { recursive: true });
  let age = 1_000_000;
  for (const [branch, line] of Object.entries(entries)) {
    const file = join(paths.dir, `${branch}.ready`);
    writeFileSync(file, `${line}\n`);
    age += 100;
    utimesSync(file, age, age);
  }
  return { home, paths, done: () => rmSync(home, { recursive: true, force: true }) };
}

const SHA = { a: 'aaaaaaa', b: 'bbbbbbb', c: 'ccccccc' };
const run = (paths, git, runStep, mainGit = null) =>
  integrate({
    git,
    mainGit,
    runStep,
    paths,
    workspaces: WORKSPACES,
    log: () => {},
    now: () => new Date('2026-11-01T00:00:00Z'),
  });

test('parseReady takes READY <sha> and READY <sha> fix, nothing else', () => {
  assert.deepEqual(parseReady('READY abc1234\n'), { sha: 'abc1234', fix: false });
  assert.deepEqual(parseReady('READY abc1234 fix'), { sha: 'abc1234', fix: true });
  for (const bad of ['', 'READY', 'READY main', 'ready abc1234', 'READY abc1234 now'])
    assert.equal(parseReady(bad), null);
});

test('readQueue: fix entries first, then oldest first; a bad file is marked', () => {
  const { paths, done } = setup({ first: `READY ${SHA.a}`, second: `READY ${SHA.b} fix`, third: 'nonsense' });
  try {
    assert.deepEqual(
      readQueue(paths.dir).map((e) => [e.branch, Boolean(e.invalid)]),
      [
        ['second', false],
        ['first', false],
        ['third', true],
      ],
    );
  } finally {
    done();
  }
});

test('parsePlan reads run and skip lines of check:merge --plan', () => {
  assert.deepEqual(parsePlan(PLAN), {
    verify: 'npm run verify',
    'check:examples-types': 'npm run check:examples-types -- --projects=examples',
    'check:views': null,
    'modern:test:packages': 'npm run modern:test:packages -- --packages=sky',
  });
});

test('demoPath: demo sources, apps and Plaza are demos; engine packages and scripts are not', () => {
  for (const file of [
    'apps/showcase-night-citadel/src/a.ts',
    'examples/voxel-sandbox/main.js',
    'examples/gallery/x.html',
    'docs/plaza-notes.md',
  ])
    assert.equal(demoPath(file), true, file);
  for (const file of ['packages/sky/src/index.ts', 'scripts/integrate.mjs', 'examples/vite/src/main.ts'])
    assert.equal(demoPath(file), false, file);
});

test('stoppedHits: "demos" and a file class each catch their paths', () => {
  assert.deepEqual(stoppedHits(['apps/x/a.ts', 'scripts/y.mjs'], ['demos']), [{ file: 'apps/x/a.ts', tag: 'demos' }]);
  assert.deepEqual(stoppedHits(['packages/core/a.ts'], ['floor']), [{ file: 'packages/core/a.ts', tag: 'floor' }]);
  assert.deepEqual(stoppedHits(['scripts/y.mjs'], []), []);
});

test('readStopped: no file stops nothing; broken JSON and unknown tags throw, so a typo never lets a batch through', () => {
  const { home, paths, done } = setup();
  try {
    assert.deepEqual(readStopped(paths.control), []);
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(paths.control, '{ "stopped": ["demos"], "words": "stop" }');
    assert.deepEqual(readStopped(paths.control), ['demos']);
    writeFileSync(paths.control, '{ "stopped": ["demo"] }');
    assert.throws(() => readStopped(paths.control), { code: 'INTEGRATE_CONTROL_INVALID' });
    writeFileSync(paths.control, '{ broken');
    assert.throws(() => readStopped(paths.control), { code: 'INTEGRATE_CONTROL_INVALID' });
  } finally {
    done();
  }
});

test('suspects: a named file or package first, then a dependent, then the whole batch', () => {
  const sky = { branch: 'sky', paths: ['packages/sky/src/a.ts'] },
    fog = { branch: 'fog', paths: ['packages/fog/src/a.ts'] };
  assert.deepEqual(suspects('FAIL packages\\sky\\test\\x.js', [sky, fog], WORKSPACES).branches, [sky]);
  assert.deepEqual(suspects('@margoengine/world: broke', [sky, fog], WORKSPACES).branches, [sky]);
  assert.deepEqual(suspects('something odd', [sky, fog], WORKSPACES), { branches: [sky, fog], named: false });
});

test('a clean batch: rebased in order, tier 1 once, records, one unforced push, landed.log written', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}`, two: `READY ${SHA.b}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] } }),
      steps = fakeSteps(undefined, git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'landed');
    assert.equal(out.exit, 0);
    assert.deepEqual(
      git.calls.filter((a) => a[0] === 'rebase' && a[1] === '-q').map((a) => [a[3], a[5]]),
      [
        ['base', SHA.a],
        [`base+${SHA.a}`, SHA.b],
      ],
    );
    assert.deepEqual(steps.commands(), [
      'node scripts/worktree-node-modules.mjs',
      'node scripts/check-merge.mjs --plan --base=origin/main',
      'npm run build:packages',
      'npm run api:check',
      'node scripts/land-records.mjs --no-build',
      'npm run verify',
      'npm run check:examples-types -- --projects=examples',
      'npm run modern:test:packages -- --packages=sky',
    ]);
    assert.equal(steps.ran.find((r) => r.command === 'npm run verify').env.MARGOENGINE_PLANT_STALE, '1');
    assert.equal(steps.ran.find((r) => r.command.includes('modern:test')).env.MARGOENGINE_PACKAGE_TEST_PREBUILT, '1');
    assert.deepEqual(git.pushes(), [['push', 'origin', 'HEAD:refs/heads/main']]);
    assert.ok(!git.calls.flat().some((word) => /^(--force|-f|--force-with-lease)$/.test(word) && word !== '-f'));
    assert.ok(!git.pushes().flat().includes('-f'));
    const line = JSON.parse(readFileSync(paths.landed, 'utf8'));
    assert.deepEqual(
      line.branches.map((b) => b.branch),
      ['one', 'two'],
    );
    assert.equal(line.commits.length, 1);
    assert.equal(line.tier1.length, 8);
    assert.deepEqual(readQueue(paths.dir), []);
  } finally {
    done();
  }
});

test('an empty queue does nothing, not even a fetch', async () => {
  const { paths, done } = setup();
  try {
    const git = fakeGit(),
      out = await run(paths, git, fakeSteps());
    assert.equal(out.result, 'idle');
    assert.deepEqual(git.calls, []);
  } finally {
    done();
  }
});

test('a batch touching a stopped class is refused whole: nothing rebased, built or pushed, entries stay', async () => {
  const { home, paths, done } = setup({ engine: `READY ${SHA.a}`, demo: `READY ${SHA.b}` });
  try {
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(paths.control, '{ "stopped": ["demos"] }');
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['apps/showcase-night-citadel/a.ts'] },
      }),
      steps = fakeSteps(undefined, git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'refused');
    assert.equal(out.exit, 4);
    assert.match(out.line, /demo touch apps\/showcase-night-citadel\/a\.ts/);
    assert.deepEqual(steps.ran, []);
    assert.deepEqual(git.pushes(), []);
    assert.ok(!git.calls.some((a) => a[0] === 'rebase'));
    assert.equal(readQueue(paths.dir).length, 2);
  } finally {
    done();
  }
});

test('a queue over 6 lands the first 6, says so loudly and leaves the rest READY', async () => {
  const shas = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666', '7777777', '8888888'],
    { paths, done } = setup(Object.fromEntries(shas.map((sha, i) => [`b${i + 1}`, `READY ${sha}`])));
  try {
    const git = fakeGit({ branches: Object.fromEntries(shas.map((sha, i) => [sha, [`packages/p${i}/a.ts`]])) }),
      lines = [],
      out = await integrate({
        git,
        runStep: fakeSteps(undefined, git),
        paths,
        workspaces: WORKSPACES,
        log: (line) => lines.push(line),
        now: () => new Date('2026-11-01T00:00:00Z'),
      });
    assert.equal(out.result, 'landed');
    assert.equal(git.calls.filter((a) => a[0] === 'rebase' && a[1] === '-q').length, 6);
    assert.deepEqual(
      readQueue(paths.dir).map((e) => e.branch),
      ['b7', 'b8'],
    );
    assert.ok(lines.some((line) => /NEVER MORE THAN 6 IN THE QUEUE: 8 unlanded/.test(line)));
  } finally {
    done();
  }
});

test('a stop order written while the gate runs still stops the push', async () => {
  const { home, paths, done } = setup({ demo: `READY ${SHA.a}` });
  try {
    mkdirSync(join(home, 'private'), { recursive: true });
    const git = fakeGit({ branches: { [SHA.a]: ['apps/x/a.ts'] } }),
      steps = fakeSteps((command) => {
        if (command === 'npm run verify') writeFileSync(paths.control, '{ "stopped": ["demos"] }');
      }, git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'refused');
    assert.deepEqual(git.pushes(), []);
    assert.equal(readQueue(paths.dir).length, 1);
  } finally {
    done();
  }
});

test('a conflict sends that branch back and the rest land', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}`, two: `READY ${SHA.b}` });
  try {
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] },
        conflicts: [SHA.a],
      }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['two'],
    );
    assert.ok(git.calls.some((a) => a[0] === 'rebase' && a[1] === '--abort'));
    const back = JSON.parse(readFileSync(join(paths.sentBack, 'one.json'), 'utf8'));
    assert.equal(back.step, 'rebase');
    assert.match(back.reason, /src\/x\.ts/);
    assert.deepEqual(readQueue(paths.dir), []);
  } finally {
    done();
  }
});

test('a failure naming one package sends that branch back with its log; the gate runs again on the rest, then pushes', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}`, fog: `READY ${SHA.b}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] } }),
      steps = fakeSteps(
        (command, head) =>
          command === 'npm run verify' && head.includes(SHA.a) ? 'FAILED packages/sky/tests/a.test.js\n' : undefined,
        git,
      ),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['fog'],
    );
    assert.equal(steps.commands().filter((c) => c === 'npm run verify').length, 2);
    const back = JSON.parse(readFileSync(join(paths.sentBack, 'sky.json'), 'utf8'));
    assert.equal(back.step, 'verify');
    assert.ok(existsSync(back.log));
    assert.equal(git.pushes().length, 1);
  } finally {
    done();
  }
});

test('a failure naming nobody: the one whose leaving cures it goes back, an innocent one stays READY', async () => {
  const { paths, done } = setup({ guilty: `READY ${SHA.a}`, innocent: `READY ${SHA.b}`, other: `READY ${SHA.c}` });
  try {
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'], [SHA.c]: ['packages/world/a.ts'] },
      }),
      steps = fakeSteps(
        (command, head) => (command === 'npm run verify' && head.includes(SHA.a) ? 'no names here\n' : undefined),
        git,
      ),
      out = await run(paths, git, steps);
    // other steps out (no cure), innocent steps out (no cure), then guilty fails alone and goes back; nothing lands.
    assert.equal(out.result, 'nothing');
    assert.equal(out.exit, 6);
    assert.deepEqual(
      out.sentBack.map((b) => b.branch),
      ['guilty'],
    );
    assert.deepEqual(
      readQueue(paths.dir)
        .map((e) => e.branch)
        .sort(),
      ['innocent', 'other'],
    );
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('a failure naming nobody, cured when the last one steps out: only that one goes back', async () => {
  const { paths, done } = setup({ good: `READY ${SHA.a}`, guilty: `READY ${SHA.b}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] } }),
      steps = fakeSteps(
        (command, head) => (command === 'npm run verify' && head.includes(SHA.b) ? 'no names here\n' : undefined),
        git,
      ),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['good'],
    );
    assert.deepEqual(
      out.sentBack.map((b) => b.branch),
      ['guilty'],
    );
    assert.match(out.sentBack[0].reason, /passed once it left/);
  } finally {
    done();
  }
});

// Bug (2026-11-01): verify ran before land-records, so a new package could never land: tests/sizes-page.test.js needs
// its entry-sizes row and tests/public-truth.test.js the package count in docs/api-surface.md, and only records write them.
test('a new package lands: verify reads the records, and api:check runs before they are rewritten', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } });
    let recorded = false,
      checkedBefore = false;
    const steps = fakeSteps((command) => {
        if (command === 'npm run api:check') checkedBefore = !recorded;
        if (command.includes('land-records')) recorded = true;
        return command === 'npm run verify' && !recorded ? 'entry-sizes.json has no sizes' : undefined;
      }, git),
      out = await run(paths, git, steps);
    assert.deepEqual(out.sentBack, []);
    assert.equal(checkedBefore, true, 'api:check sees what the branch committed');
    assert.equal(git.pushes().length, 1);
  } finally {
    done();
  }
});

test('a failed land-records counts as a gate failure: nothing is pushed', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps((command) => (command.includes('land-records') ? 'a baseline would grow\n' : undefined), git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'nothing');
    assert.equal(out.sentBack[0].step, 'land-records');
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('while RED.json exists only the fix lands, ahead of the queue; without a fix nothing happens', async () => {
  const { paths, done } = setup({ work: `READY ${SHA.a}` });
  try {
    writeFileSync(paths.red, '{}');
    const idle = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } });
    const held = await run(paths, idle, fakeSteps(undefined, idle));
    assert.equal(held.result, 'held');
    assert.equal(held.exit, 0);
    assert.deepEqual(idle.calls, []);

    writeFileSync(join(paths.dir, 'thefix.ready'), `READY ${SHA.b} fix\n`);
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['thefix'],
    );
    assert.deepEqual(
      readQueue(paths.dir).map((e) => e.branch),
      ['work'],
    );
  } finally {
    done();
  }
});

test('main going RED during the gate holds the batch; a fix still goes', async () => {
  for (const [line, result] of [
    [`READY ${SHA.a}`, 'held'],
    [`READY ${SHA.a} fix`, 'landed'],
  ]) {
    const { paths, done } = setup({ one: line });
    try {
      const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
        steps = fakeSteps((command) => {
          if (command === 'npm run verify') writeFileSync(paths.red, '{}');
        }, git),
        out = await run(paths, git, steps);
      assert.equal(out.result, result);
      assert.equal(git.pushes().length, result === 'landed' ? 1 : 0);
    } finally {
      done();
    }
  }
});

test('a refused push leaves every entry READY and writes no landed.log', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, pushFails: true }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'moved');
    assert.equal(out.exit, 5);
    assert.equal(git.pushes().length, 1);
    assert.equal(readQueue(paths.dir).length, 1);
    assert.equal(existsSync(paths.landed), false);
  } finally {
    done();
  }
});

test('identity: a wrong author goes back at intake, a wrong committer stops the push', async () => {
  const first = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, author: 'someone@example.com' }),
      out = await run(first.paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'nothing');
    assert.match(out.sentBack[0].reason, /noreply/);
  } finally {
    first.done();
  }
  const second = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, stranger: true }),
      out = await run(second.paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'refused');
    assert.deepEqual(git.pushes(), []);
  } finally {
    second.done();
  }
});

test('a READY file that does not parse or names no commit goes back; the rest go on', async () => {
  const { paths, done } = setup({ bad: 'READY', gone: 'READY fffffff', good: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['good'],
    );
    assert.deepEqual(out.sentBack.map((b) => b.branch).sort(), ['bad', 'gone']);
  } finally {
    done();
  }
});

test('fixWithoutTest: a fix needs a changed test file or a Regression line naming an existing file', () => {
  const exists = (path) => path === 'tests/real.test.js';
  const commit = (message, files = ['src/a.ts']) => ({ sha: 'a'.repeat(40), message, files, exists });
  for (const subject of ['fix: x', 'fix(bench): x', 'Fix(core)!: x', 'fix(a/b): x'])
    assert.match(fixWithoutTest([commit(subject)]).reason, /Regression: <repo path>/, subject);
  assert.equal(fixWithoutTest([commit('fix(a): x', ['src/a.ts', 'tests/a.test.js'])]), null);
  assert.equal(fixWithoutTest([commit('fix(a): x', ['packages/a/test/b.js'])]), null);
  assert.equal(fixWithoutTest([commit('fix(a): x', ['scripts/x.test.mjs'])]), null);
  assert.equal(fixWithoutTest([commit(['fix(a): x', '', 'body', 'Regression: tests/real.test.js'].join('\n'))]), null);
  assert.match(
    fixWithoutTest([commit(['fix(a): x', '', 'Regression: tests/gone.test.js'].join('\n'))]).reason,
    /no such file/,
  );
  for (const subject of ['feat: x', 'fixture: x', 'docs: fix x', 'chore(fix): x'])
    assert.equal(fixWithoutTest([commit(subject)]), null, subject);
});

test('a branch with a fix commit and no test goes back at intake; with a test or a Regression line it lands', async () => {
  const fix = (extra) => ({
    sha: SHA.a,
    message: 'fix(sky): stop the flicker',
    files: ['packages/sky/a.ts'],
    ...extra,
  });
  const regression = (path) => `fix(sky): x\n\nRegression: ${path}`;
  for (const [commits, result] of [
    [[fix()], 'nothing'],
    [[fix({ files: ['packages/sky/a.ts', 'packages/sky/tests/a.test.js'] })], 'landed'],
    [[fix({ message: regression('tests/sky.test.js'), tests: ['tests/sky.test.js'] })], 'landed'],
    [[fix({ message: regression('tests/missing.test.js') })], 'nothing'],
  ]) {
    const { paths, done } = setup({ one: `READY ${SHA.a}` });
    try {
      const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, commits }),
        out = await run(paths, git, fakeSteps(undefined, git));
      assert.equal(out.result, result);
      if (result === 'nothing') assert.match(out.sentBack[0].reason, /fix commit/);
    } finally {
      done();
    }
  }
});

test('a send-back or landing removes a READY file only while it still holds the sha the run took', async () => {
  // The helper writes a newer READY for the same branch while the run is going; the old sha's outcome must not delete it.
  for (const conflicts of [[SHA.a], []]) {
    const { paths, done } = setup({ one: `READY ${SHA.a}` });
    try {
      const inner = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, conflicts }),
        git = (args) => {
          if (args[0] === 'rebase' && args[1] === '-q') writeFileSync(join(paths.dir, 'one.ready'), `READY ${SHA.b}\n`);
          return inner(args);
        };
      git.calls = inner.calls;
      git.pushes = inner.pushes;
      git.head = inner.head;
      await run(paths, git, fakeSteps(undefined, git));
      assert.equal(
        readFileSync(join(paths.dir, 'one.ready'), 'utf8').trim(),
        `READY ${SHA.b}`,
        `conflict=${conflicts.length}`,
      );
    } finally {
      done();
    }
  }
});

/** A fake main checkout: `branch` it is on, `ffFails` the stderr of a merge that cannot fast-forward. Records every call. */
function fakeMain({ branch = 'main', ffFails = null } = {}) {
  const calls = [];
  const main = (args) => {
    calls.push(args);
    if (args[0] === 'symbolic-ref')
      return {
        status: 0,
        stdout: `${branch}
`,
        stderr: '',
      };
    if (args[0] === 'merge')
      return ffFails ? { status: 128, stdout: '', stderr: ffFails } : { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  main.calls = calls;
  return main;
}

test('after the push the main checkout is fast-forwarded to origin/main, and the landing line says so', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      main = fakeMain(),
      out = await run(paths, git, fakeSteps(undefined, git), main);
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      main.calls.filter((a) => a[0] === 'merge'),
      [['merge', '--ff-only', 'origin/main']],
    );
    assert.match(out.mainCheckout, /fast-forwarded/);
    assert.equal(JSON.parse(readFileSync(paths.landed, 'utf8')).mainCheckout, out.mainCheckout);
  } finally {
    done();
  }
});

test('a main checkout that cannot fast-forward does not undo the landing: one line, recorded, tried once, nothing reset or stashed', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      main = fakeMain({ ffFails: 'error: Your local changes would be overwritten by merge.' }),
      lines = [],
      out = await integrate({
        git,
        mainGit: main,
        runStep: fakeSteps(undefined, git),
        paths,
        workspaces: WORKSPACES,
        log: (line) => lines.push(line),
        now: () => new Date('2026-11-01T00:00:00Z'),
      });
    assert.equal(out.result, 'landed');
    assert.equal(out.exit, 0);
    assert.equal(git.pushes().length, 1);
    assert.equal(main.calls.filter((a) => a[0] === 'merge').length, 1);
    assert.ok(!main.calls.some((a) => ['reset', 'stash', 'checkout', 'clean'].includes(a[0])));
    assert.equal(lines.filter((line) => /main checkout is behind/.test(line)).length, 1);
    assert.match(out.mainCheckout, /behind origin[/]main.*could not fast-forward.*not touched/);
    assert.equal(JSON.parse(readFileSync(paths.landed, 'utf8')).mainCheckout, out.mainCheckout);
  } finally {
    done();
  }
});

test('a main checkout that is on another branch is left alone', () => {
  const main = fakeMain({ branch: 'some-work' });
  assert.match(syncMainCheckout(main), /not on main/);
  assert.ok(!main.calls.some((a) => a[0] === 'merge'));
});

test('missingFromLog reads the names worktree-node-modules.mjs lists', () => {
  assert.deepEqual(
    missingFromLog('Error: older than this worktree: run npm install there. Missing: ws, left-pad\n    at x'),
    ['ws', 'left-pad'],
  );
  assert.deepEqual(missingFromLog('fine'), []);
});

test('a stale install: only the branch whose package.json adds the missing dependency goes back, at once, and the rest land', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}`, fog: `READY ${SHA.b}`, mid: `READY ${SHA.c}` });
  try {
    const git = fakeGit({
        branches: {
          [SHA.a]: ['packages/sky/a.ts'],
          [SHA.b]: ['packages/fog/a.ts', 'package.json'],
          [SHA.c]: ['packages/world/a.ts'],
        },
        manifests: { old: ['biome'], [SHA.a]: ['biome'], [SHA.b]: ['biome', 'ws'], [SHA.c]: ['biome'] },
      }),
      steps = fakeSteps(
        (command, head) =>
          command === 'node scripts/worktree-node-modules.mjs' && head.includes(SHA.b)
            ? 'Error: older than this worktree: run npm install there. Missing: ws\n'
            : undefined,
        git,
      ),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'landed');
    assert.deepEqual(out.landed.map((b) => b.branch).sort(), ['mid', 'sky']);
    assert.deepEqual(
      out.sentBack.map((b) => b.branch),
      ['fog'],
    );
    const back = JSON.parse(readFileSync(join(paths.sentBack, 'fog.json'), 'utf8'));
    assert.equal(back.step, 'relink');
    assert.match(back.reason, /adds ws.*run npm install in the main checkout/);
    // One failed relink, then one clean run of the gate: no branch was tried alone to find the cause.
    assert.equal(steps.commands().filter((c) => c === 'node scripts/worktree-node-modules.mjs').length, 2);
    assert.equal(existsSync(join(paths.sentBack, 'sky.json')), false);
    assert.equal(existsSync(join(paths.sentBack, 'mid.json')), false);
  } finally {
    done();
  }
});
