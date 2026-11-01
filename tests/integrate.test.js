// scripts/integrate.mjs, the only pusher to main. git and every command are injected: no repository, no build, no GPU,
// never the real queue. Every guarantee of the landing contract (AGENTS.md, "Before every push to main") has a test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMAIL,
  EXIT,
  MAX_QUEUE,
  contentProblem,
  demoPath,
  fixWithoutTest,
  integrate,
  lockWatch,
  messageProblem,
  missingFromLog,
  parsePlan,
  parseReady,
  queuePaths,
  readLanded,
  readQueue,
  readStopped,
  stepEnv,
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

const TIER1 = [
  'node scripts/worktree-node-modules.mjs',
  'node scripts/check-merge.mjs --plan --base=origin/main',
  'npm run build:packages',
  'npm run api:check',
  'node scripts/land-records.mjs --no-build',
  'npm run verify',
  'npm run check:examples-types -- --projects=examples',
  'npm run modern:test:packages -- --packages=sky',
];

/**
 * A fake clone. `branches`: sha to its changed paths. `conflicts`: shas whose rebase fails. `commits`: per-commit identity,
 * message and files (one noreply commit by default). `diffs`: sha to its added-lines diff. `onMain`: shas already on main.
 * origin/main starts at `base` and moves to what a push pushed. Records every call.
 */
function fakeGit({
  branches = {},
  conflicts = [],
  pushFails = false,
  author = EMAIL,
  committer = EMAIL,
  stranger = false,
  commits = [],
  manifests = {},
  diffs = {},
  onMain = [],
  refs = [],
  remoteMain = 'base',
} = {}) {
  const calls = [];
  let head = remoteMain,
    main = remoteMain;
  const ancestors = new Set(onMain);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const no = (stderr = '') => ({ status: 1, stdout: '', stderr });
  const git = (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'rev-parse' && args[1] === 'origin/main') return ok(main);
    if (verb === 'rev-parse' && args[1] === 'HEAD') return ok(head);
    if (verb === 'rev-parse') {
      const sha = args[3].replace('^{commit}', '');
      return sha in branches ? ok(sha) : no();
    }
    if (verb === 'merge-base' && args[1] === '--is-ancestor') return ancestors.has(args[2]) ? ok() : no();
    if (verb === 'merge-base') return ok('old');
    if (verb === 'for-each-ref') return ok(refs.join('\n'));
    if (verb === 'show') {
      const rev = args[1].split(':')[0];
      if (!(rev in manifests)) return no('no package.json');
      return ok(JSON.stringify({ dependencies: Object.fromEntries(manifests[rev].map((name) => [name, '1.0.0'])) }));
    }
    if (verb === 'log' && args[1] === '--no-merges') {
      const list = commits.length ? commits : [{ sha: 'c'.repeat(40) }];
      return ok(list.map((c) => `${c.sha} ${c.author ?? author} ${c.committer ?? committer}`).join('\n'));
    }
    if (verb === 'log' && args[1] === '-1') return ok(commits.find((c) => c.sha === args[3])?.message ?? 'chore: x');
    if (verb === 'diff-tree') return ok((commits.find((c) => c.sha === args.at(-1))?.files ?? []).join('\n'));
    if (verb === 'cat-file') return commits.some((c) => c.tests?.includes(args[2].split(':')[1])) ? ok() : no();
    if (verb === 'log' && args[1] === '--format=%ae %ce')
      return ok(stranger ? `${EMAIL} other@example.com` : `${EMAIL} ${EMAIL}`);
    if (verb === 'log') return ok(`${head} a commit`);
    if (verb === 'diff' && args.includes('--diff-filter=U')) return ok('src/x.ts');
    if (verb === 'diff' && args.includes('--unified=0')) return ok(diffs[args.at(-1)] ?? '');
    if (verb === 'diff') return ok(branches[args.at(-1)].join('\n'));
    if (verb === 'checkout' && args.includes('--detach')) head = args.at(-1);
    if (verb === 'rebase' && args[1] === '-q') {
      const sha = args.at(-1);
      if (conflicts.includes(sha)) return no('CONFLICT');
      head = `${head}+${sha}`;
    }
    if (verb === 'push') {
      if (pushFails) return no('rejected, non-fast-forward');
      main = head;
      ancestors.add(head);
    }
    return ok();
  };
  git.calls = calls;
  git.pushes = () => calls.filter((a) => a[0] === 'push');
  git.head = () => head;
  git.main = () => main;
  return git;
}

/** A fake command runner. `fail(command, head, { signal })` returns the failing output, `{ timedOut: true }`, or nothing for a pass. */
function fakeSteps(fail = () => undefined, git) {
  const ran = [];
  const run = async (command, { logFile, env, signal }) => {
    const call = { command, env, head: git?.head(), signal };
    ran.push(call);
    const output = await fail(command, git?.head(), call);
    const text = output?.timedOut ? 'killed\n' : output;
    writeFileSync(logFile, command.includes('--plan') ? PLAN : (text ?? 'fine\n'));
    if (output?.timedOut) return { ok: false, timedOut: true, seconds: 1800 };
    return { ok: output === undefined && !signal?.aborted, aborted: signal?.aborted, seconds: 1.5 };
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
const BY = { user: 'tester', host: 'box', pid: 1 };
let tick = 0;
const run = (paths, git, runStep, extra = {}) =>
  integrate({
    git,
    mainGit: null,
    runStep,
    paths,
    workspaces: WORKSPACES,
    log: () => {},
    now: () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++)),
    by: BY,
    lockPollMs: 5,
    ...extra,
  });
const ledger = (paths) => readFileSync(paths.ledger, 'utf8').trim().split('\n').map(JSON.parse);
const runs = (paths) => readdirSync(paths.runs).map((name) => JSON.parse(readFileSync(join(paths.runs, name), 'utf8')));

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

test('suspects: a named file or package first, then a dependent, then nobody', () => {
  const sky = { branch: 'sky', paths: ['packages/sky/src/a.ts'] },
    fog = { branch: 'fog', paths: ['packages/fog/src/a.ts'] };
  assert.deepEqual(suspects('FAIL packages\\sky\\test\\x.js', [sky, fog], WORKSPACES).branches, [sky]);
  assert.deepEqual(suspects('@margoengine/world: broke', [sky, fog], WORKSPACES).branches, [sky]);
  assert.deepEqual(suspects('something odd', [sky, fog], WORKSPACES), { branches: [], named: false });
});

test('a clean batch: rebased in order, tier 1 once in the fixed order, one unforced push, landed.log and the run record say everything', async () => {
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
    assert.deepEqual(steps.commands(), TIER1);
    assert.equal(steps.ran.find((r) => r.command === 'npm run verify').env.MARGOENGINE_PLANT_STALE, '1');
    assert.equal(steps.ran.find((r) => r.command.includes('modern:test')).env.MARGOENGINE_PACKAGE_TEST_PREBUILT, '1');
    assert.deepEqual(git.pushes(), [['push', 'origin', 'HEAD:refs/heads/main']]);
    assert.ok(
      !git
        .pushes()
        .flat()
        .some((word) => /^(--force|-f|--force-with-lease)$/.test(word)),
    );
    const [line] = readLanded(paths.landed);
    assert.deepEqual(
      line.branches.map((b) => [b.branch, b.sha, b.landedAs]),
      [
        ['one', SHA.a, `base+${SHA.a}`],
        ['two', SHA.b, `base+${SHA.a}+${SHA.b}`],
      ],
    );
    assert.equal(line.from, 'base');
    assert.equal(line.to, `base+${SHA.a}+${SHA.b}`);
    assert.equal(line.commits.length, 1);
    assert.equal(line.tier1.length, TIER1.length);
    assert.ok(line.tier1.every((s) => s.ok && typeof s.seconds === 'number' && existsSync(s.log)));
    assert.deepEqual(line.by, BY);
    assert.equal(line.run, out.record.id);
    assert.deepEqual(readQueue(paths.dir), []);
    // The permanent record of the run.
    const [record] = runs(paths);
    assert.equal(record.state, 'landed');
    assert.equal(record.result, 'landed');
    assert.equal(record.push.state, 'landed');
    assert.deepEqual(
      record.batch.map((b) => [b.branch, b.ready, b.rebased]),
      line.branches.map((b) => [b.branch, b.sha, b.landedAs]),
    );
    assert.equal(record.attempts.length, 1);
    assert.deepEqual(
      record.attempts[0].steps.map((s) => s.command),
      TIER1,
    );
    assert.deepEqual(
      ledger(paths).map((l) => [l.branch, l.action, l.removed]),
      [
        ['one', 'landed', true],
        ['two', 'landed', true],
      ],
    );
    assert.equal(JSON.parse(readFileSync(paths.latest, 'utf8')).to, line.to);
  } finally {
    done();
  }
});

test('an empty queue does nothing, not even a fetch, and still leaves a run record', async () => {
  const { paths, done } = setup();
  try {
    const git = fakeGit(),
      out = await run(paths, git, fakeSteps());
    assert.equal(out.result, 'idle');
    assert.deepEqual(git.calls, []);
    assert.equal(runs(paths)[0].result, 'idle');
  } finally {
    done();
  }
});

// Guarantee 1: never more than 6. The seventh READY and later are refused loudly, not queued quietly.
test(`a queue over ${MAX_QUEUE} lands the first ${MAX_QUEUE} and sends the rest back at once, with the banner, recorded`, async () => {
  const shas = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666', '7777777', '8888888'],
    { paths, done } = setup(Object.fromEntries(shas.map((sha, i) => [`b${i + 1}`, `READY ${sha}`])));
  try {
    const git = fakeGit({ branches: Object.fromEntries(shas.map((sha, i) => [sha, [`packages/p${i}/a.ts`]])) }),
      lines = [],
      out = await run(paths, git, fakeSteps(undefined, git), { log: (line) => lines.push(line) });
    assert.equal(out.result, 'landed');
    assert.equal(git.calls.filter((a) => a[0] === 'rebase' && a[1] === '-q').length, MAX_QUEUE);
    assert.deepEqual(readQueue(paths.dir), []);
    assert.deepEqual(
      out.sentBack.map((b) => b.branch),
      ['b7', 'b8'],
    );
    assert.match(out.sentBack[0].reason, /NEVER MORE THAN 6 IN THE QUEUE: this READY was number 7/);
    assert.ok(lines.some((line) => /NEVER MORE THAN 6 IN THE QUEUE: 8 unlanded/.test(line)));
    for (const name of ['b7', 'b8']) assert.ok(existsSync(join(paths.sentBack, `${name}.json`)), name);
    assert.deepEqual(out.record.overLimit, ['b7', 'b8']);
    assert.deepEqual(
      ledger(paths)
        .filter((l) => l.action === 'sent-back')
        .map((l) => l.branch),
      ['b7', 'b8'],
    );
  } finally {
    done();
  }
});

// Guarantee 2: every tier 1 step, in order, on the batch tip; nothing an environment variable can narrow or skip.
test('the plan and every step run on the batch tip, after every rebase', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}`, two: `READY ${SHA.b}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] } }),
      steps = fakeSteps(undefined, git);
    await run(paths, git, steps);
    assert.ok(
      steps.ran.every((r) => r.head === `base+${SHA.a}+${SHA.b}`),
      JSON.stringify(steps.ran.map((r) => r.head)),
    );
  } finally {
    done();
  }
});

test('stepEnv drops every MARGO* and MARGOENGINE* variable a caller exports except the lock code, and sets the identity', () => {
  const env = stepEnv(
    {
      PATH: 'p',
      MARGO_FULL: '1',
      MARGO_CHECK_KEEP_GOING: '1',
      MARGOENGINE_PACKAGE_TEST_REUSE_TARBALLS: '1',
      MARGOENGINE_PLANT_STALE: '0',
      MARGO_GPU_LOCK: 'lock',
      MARGO_GPU_LOCK_NESTED: 'nested',
      GIT_AUTHOR_EMAIL: 'someone@example.com',
    },
    { MARGOENGINE_PLANT_STALE: '1' },
  );
  assert.deepEqual(env, {
    PATH: 'p',
    MARGO_GPU_LOCK: 'lock',
    MARGO_GPU_LOCK_NESTED: 'nested',
    MARGOENGINE_PLANT_STALE: '1',
    GIT_AUTHOR_NAME: 'Scott Campbell',
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: 'Scott Campbell',
    GIT_COMMITTER_EMAIL: EMAIL,
  });
});

test('a banned term (tests/banned-terms.test.js, run by verify) is a gate failure that names the branch', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/README.md'] } }),
      steps = fakeSteps(
        (command) => (command === 'npm run verify' ? 'packages/sky/README.md:3: banned term\n' : undefined),
        git,
      ),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'nothing');
    assert.equal(out.sentBack[0].step, 'verify');
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

// Guarantee 3: intake.
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
    assert.equal(out.record.stopped.length, 1);
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

test('identity: a wrong author or a wrong committer goes back at intake, before anything is built', async () => {
  for (const identity of [{ author: 'someone@example.com' }, { committer: 'someone@example.com' }]) {
    const { paths, done } = setup({ one: `READY ${SHA.a}` });
    try {
      const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, ...identity }),
        steps = fakeSteps(undefined, git),
        out = await run(paths, git, steps);
      assert.equal(out.result, 'nothing', JSON.stringify(identity));
      assert.match(
        out.sentBack[0].reason,
        identity.author ? /author is not the noreply/ : /committer is not the noreply/,
      );
      assert.deepEqual(steps.ran, []);
    } finally {
      done();
    }
  }
  // The last guard before the push, for anything intake could not see (a records commit made with the wrong identity).
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, stranger: true }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'refused');
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('messageProblem: em and en dashes, home folders, secrets and foreign addresses are refused; the allowed ones pass', () => {
  assert.equal(messageProblem('fix(sky): x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), null);
  assert.equal(messageProblem(`feat: y\n\nSigned-off-by: Scott <${EMAIL}>`), null);
  assert.match(messageProblem('feat: a \u2014 b'), /em or en dash/);
  assert.match(messageProblem('feat: a \u2013 b'), /em or en dash/);
  assert.match(messageProblem('feat: see C:\\Users\\someone\\x'), /home folder/);
  assert.match(messageProblem('feat: see /home/someone/x'), /home folder/);
  assert.match(messageProblem('feat: see ~/.claude/x'), /home folder/);
  assert.match(messageProblem('feat: token ghp_abcdefghijklmnopqrstuvwxyz0123'), /secret/);
  assert.match(messageProblem('feat: mail scott@scottsbusiness.example.org'), /carries the address/);
});

test('contentProblem: an added line with a home folder, a secret or an address at a domain of his own is refused; context lines are not', () => {
  assert.equal(contentProblem(`+++ b/a.ts\n+const email = '${EMAIL}';\n-C:\\Users\\old\\x\n context`), null);
  assert.match(contentProblem('+const p = "C:\\\\Users\\\\someone\\\\x";').problem, /home-folder/);
  assert.match(contentProblem('+AKIAABCDEFGHIJKLMNOP').problem, /secret/);
  assert.match(contentProblem('+-----BEGIN RSA PRIVATE KEY-----').problem, /secret/);
  assert.match(contentProblem('+contact: me@scottcampbell.example').problem, /the address/);
  assert.equal(contentProblem('+author: someone@example.com'), null);
});

test('a commit message with an em dash, or an added line with a secret, sends the branch back at intake', async () => {
  for (const [options, reason] of [
    [{ commits: [{ sha: SHA.a, message: 'feat(sky): a \u2014 b', files: ['packages/sky/a.ts'] }] }, /em or en dash/],
    [{ diffs: { [SHA.a]: '+const key = "ghp_abcdefghijklmnopqrstuvwxyz0123";\n' } }, /looks like a secret/],
    [{ diffs: { [SHA.a]: '+// see C:\\Users\\someone\\notes.md\n' } }, /home-folder path/],
  ]) {
    const { paths, done } = setup({ one: `READY ${SHA.a}` });
    try {
      const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, ...options }),
        steps = fakeSteps(undefined, git),
        out = await run(paths, git, steps);
      assert.equal(out.result, 'nothing');
      assert.match(out.sentBack[0].reason, reason);
      assert.deepEqual(steps.ran, []);
      assert.deepEqual(git.pushes(), []);
    } finally {
      done();
    }
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

test('an entry already on main is retired with a ledger line, not silently', async () => {
  const { paths, done } = setup({ old: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, onMain: [SHA.a] }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'idle');
    assert.deepEqual(readQueue(paths.dir), []);
    assert.deepEqual(
      ledger(paths).map((l) => [l.branch, l.action]),
      [['old', 'already-on-main']],
    );
  } finally {
    done();
  }
});

// Guarantee 4: RED.
test('while RED.json exists only the fix lands, ahead of the queue; without a fix nothing happens', async () => {
  const { paths, done } = setup({ work: `READY ${SHA.a}` });
  try {
    writeFileSync(paths.red, '{}');
    const idle = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } });
    const held = await run(paths, idle, fakeSteps(undefined, idle));
    assert.equal(held.result, 'held');
    assert.equal(held.exit, 0);
    assert.deepEqual(idle.pushes(), []);

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

test('RED.held.json, a RED set aside on order, holds nothing: the batch lands and the record says the held RED was seen', async () => {
  const { paths, done } = setup({ work: `READY ${SHA.a}` });
  try {
    writeFileSync(paths.redHeld, '{ "sha": "62a54b15" }');
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      lines = [],
      out = await run(paths, git, fakeSteps(undefined, git), { log: (line) => lines.push(line) });
    assert.equal(out.result, 'landed');
    assert.equal(out.record.redHeld, true);
    assert.equal(out.record.red, false);
    assert.ok(lines.some((line) => /RED\.held\.json exists: a RED set aside/.test(line)));
    assert.ok(existsSync(paths.redHeld), 'left as it is');
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

// Guarantee 5: accountability.
test('a run record that cannot be written stops the run before anything happens: exit 8, nothing pushed', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    writeFileSync(paths.runs, 'a file where the runs folder should be');
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'record');
    assert.equal(out.exit, EXIT.record);
    assert.deepEqual(git.calls, []);
    assert.equal(readQueue(paths.dir).length, 1);
  } finally {
    done();
  }
});

test('the record says "pushing" before the push; landed.log that cannot be appended after it is a failed landing (exit 8), and the next run finishes the record', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    mkdirSync(paths.landed); // a folder in the way of landed.log
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'record');
    assert.equal(out.exit, EXIT.record);
    assert.equal(git.pushes().length, 1);
    const [pending] = runs(paths);
    assert.equal(pending.state, 'pushing');
    assert.equal(pending.push.tip, `base+${SHA.a}`);
    assert.equal(readQueue(paths.dir).length, 1, 'the READY entry stays until the landing is recorded');
    rmSync(paths.landed, { recursive: true });
    // The next run, with nothing new READY, sees the pushed tip on origin/main and finishes the record.
    const next = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, onMain: [`base+${SHA.a}`, SHA.a] }),
      again = await run(paths, next, fakeSteps(undefined, next));
    assert.equal(again.result, 'idle');
    assert.deepEqual(next.pushes(), []);
    const [line] = readLanded(paths.landed);
    assert.equal(line.run, pending.id);
    assert.equal(line.to, `base+${SHA.a}`);
    assert.equal(line.recoveredBy, again.record.id);
    assert.deepEqual(readQueue(paths.dir), []);
    const [first, second] = runs(paths);
    assert.equal(first.state, 'landed');
    assert.equal(first.recoveredBy, second.id);
    assert.deepEqual(second.recovered, [{ run: first.id, tip: `base+${SHA.a}`, onMain: true }]);
    assert.deepEqual(
      ledger(paths).map((l) => [l.branch, l.action]),
      [['one', 'landed']],
    );
  } finally {
    done();
  }
});

test('a "pushing" record whose push never reached origin/main is closed as moved and its entries stay READY', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    mkdirSync(paths.runs, { recursive: true });
    writeFileSync(
      join(paths.runs, '2026-11-01T00-00-00-000Z.json'),
      JSON.stringify({
        id: '2026-11-01T00-00-00-000Z',
        state: 'pushing',
        push: { tip: 'never-arrived', state: 'pushing' },
        landing: { run: '2026-11-01T00-00-00-000Z', to: 'never-arrived', branches: [{ branch: 'one', sha: SHA.a }] },
        entries: [{ branch: 'one', file: join(paths.dir, 'one.ready'), taken: SHA.a, sha: SHA.a }],
      }),
    );
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'landed', 'the entry was still READY and lands now');
    const earlier = runs(paths).find((r) => r.id === '2026-11-01T00-00-00-000Z');
    assert.equal(earlier.result, 'moved');
    assert.equal(earlier.push.state, 'not on main');
    assert.equal(readLanded(paths.landed).filter((l) => l.to === 'never-arrived').length, 0);
  } finally {
    done();
  }
});

test('commits on origin/main that no landing recorded are written to landed.log as a hand push', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    writeFileSync(
      paths.landed,
      `${JSON.stringify({ at: 'earlier', from: 'older', to: 'recorded-tip', branches: [] })}\n`,
    );
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, onMain: ['recorded-tip'] }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'landed');
    const [, hand, landing] = readLanded(paths.landed);
    assert.equal(hand.kind, 'hand-push');
    assert.equal(hand.from, 'recorded-tip');
    assert.equal(hand.to, 'base');
    assert.equal(hand.commits.length, 1);
    assert.equal(landing.from, 'base');
    assert.equal(out.record.handPush.to, 'base');
  } finally {
    done();
  }
});

test('every READY file the run removes is one ledger line, with its reason', async () => {
  const { paths, done } = setup({ bad: 'READY', conflict: `READY ${SHA.a}`, good: `READY ${SHA.b}` });
  try {
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'] },
        conflicts: [SHA.a],
      }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'landed');
    assert.deepEqual(readQueue(paths.dir), []);
    const lines = ledger(paths);
    assert.deepEqual(
      lines.map((l) => [l.branch, l.action, l.removed]),
      [
        ['bad', 'sent-back', true],
        ['conflict', 'sent-back', true],
        ['good', 'landed', true],
      ],
    );
    assert.ok(lines.every((l) => l.reason && l.run === out.record.id));
    assert.deepEqual(out.record.ledger, lines);
  } finally {
    done();
  }
});

// Guarantee 6: failure handling.
test('a run that no longer holds the landing lock stops before its first step, pushes nothing and says so: exit 7', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps(undefined, git),
      out = await run(paths, git, steps, { holding: () => 'another integrator holds the landing lock now' });
    assert.equal(out.result, 'lost');
    assert.equal(out.exit, EXIT.lost);
    assert.match(out.line, /another integrator/);
    assert.deepEqual(steps.ran, []);
    assert.deepEqual(git.pushes(), []);
    assert.equal(readQueue(paths.dir).length, 1);
  } finally {
    done();
  }
});

test('a lock lost while a step runs aborts that step through its signal, and nothing is pushed', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    let lost = null;
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps(async (command, _head, { signal }) => {
        if (command !== 'npm run verify') return undefined;
        lost = 'the landing lock entry is gone';
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return 'killed\n';
      }, git),
      out = await run(paths, git, steps, { holding: () => lost });
    assert.equal(out.result, 'lost');
    assert.ok(steps.ran.find((r) => r.command === 'npm run verify').signal.aborted);
    assert.deepEqual(git.pushes(), []);
    assert.equal(readQueue(paths.dir).length, 1);
    const [record] = runs(paths);
    assert.equal(record.attempts[0].steps.at(-1).aborted, 'the landing lock entry is gone');
  } finally {
    done();
  }
});

test('a lock lost after the gate and before the push stops the push', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    let lost = null;
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps((command) => {
        if (command.includes('modern:test:packages')) lost = 'the lock wrapper died';
      }, git),
      out = await run(paths, git, steps, { holding: () => lost });
    assert.equal(out.result, 'lost');
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('lockWatch: null while the entry keeps the token it started with; a reason when it is gone or another holder wrote it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-lock-'));
  try {
    const file = join(dir, 'exclusive.json');
    assert.match(lockWatch(dir)(), /no landing lock entry/);
    writeFileSync(file, JSON.stringify({ owner: 'integrator', pid: 1, token: 'one' }));
    const holding = lockWatch(dir);
    assert.equal(holding(), null);
    writeFileSync(file, JSON.stringify({ owner: 'integrator', pid: 2, token: 'two', takenAt: 'later' }));
    assert.match(holding(), /another integrator holds the landing lock now \(integrator, pid 2/);
    rmSync(file);
    assert.match(holding(), /entry .* is gone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    assert.equal(back.run, out.record.id);
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
    assert.equal(out.record.attempts.length, 2);
    assert.deepEqual(readLanded(paths.landed)[0].sentBack, [
      { branch: 'sky', step: 'verify', reason: back.reason, log: back.log },
    ]);
  } finally {
    done();
  }
});

test('a failure naming two branches sends both back at once: one more gate run, no one stepped out one at a time', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}`, fog: `READY ${SHA.b}`, world: `READY ${SHA.c}` });
  try {
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'], [SHA.c]: ['packages/world/a.ts'] },
      }),
      steps = fakeSteps(
        (command, head) =>
          command === 'npm run verify' && head.includes(SHA.a)
            ? 'FAIL packages/sky/tests/a.test.js\nFAIL @margoengine/fog\n'
            : undefined,
        git,
      ),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      out.landed.map((b) => b.branch),
      ['world'],
    );
    assert.deepEqual(out.sentBack.map((b) => b.branch).sort(), ['fog', 'sky']);
    assert.equal(steps.commands().filter((c) => c === 'npm run verify').length, 2);
  } finally {
    done();
  }
});

test('a failure naming nobody, with more than one branch, stops the run at once: every entry stays READY, no step-out', async () => {
  const { paths, done } = setup({ guilty: `READY ${SHA.a}`, innocent: `READY ${SHA.b}`, other: `READY ${SHA.c}` });
  try {
    const git = fakeGit({
        branches: { [SHA.a]: ['packages/sky/a.ts'], [SHA.b]: ['packages/fog/a.ts'], [SHA.c]: ['packages/world/a.ts'] },
      }),
      steps = fakeSteps((command) => (command === 'npm run verify' ? 'no names here\n' : undefined), git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'nothing');
    assert.equal(out.exit, 6);
    assert.match(out.line, /names no branch of guilty, innocent, other/);
    assert.equal(steps.commands().filter((c) => c === 'npm run verify').length, 1);
    assert.deepEqual(out.sentBack, []);
    assert.deepEqual(
      readQueue(paths.dir)
        .map((e) => e.branch)
        .sort(),
      ['guilty', 'innocent', 'other'],
    );
    assert.deepEqual(git.pushes(), []);
    assert.equal(out.record.unblamed.step, 'verify');
    assert.deepEqual(out.record.stillReady, ['guilty', 'innocent', 'other']);
  } finally {
    done();
  }
});

test('a failure naming nobody with one branch in the batch names that branch', async () => {
  const { paths, done } = setup({ only: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps((command) => (command === 'npm run verify' ? 'no names here\n' : undefined), git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'nothing');
    assert.match(out.sentBack[0].reason, /this branch alone/);
    assert.deepEqual(readQueue(paths.dir), []);
  } finally {
    done();
  }
});

test('a step that hangs past its limit is killed, named as hung in the record and the reason, and nothing is pushed', async () => {
  const { paths, done } = setup({ only: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps((command) => (command === 'npm run verify' ? { timedOut: true } : undefined), git),
      out = await run(paths, git, steps);
    assert.equal(out.result, 'nothing');
    assert.match(out.sentBack[0].reason, /hung past 30 min and its process tree was killed/);
    const [record] = runs(paths);
    const verify = record.attempts[0].steps.find((s) => s.step === 'verify');
    assert.equal(verify.timedOut, true);
    assert.equal(verify.ok, false);
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('a sent-back notice is removed when that branch lands later', async () => {
  const { paths, done } = setup({ sky: `READY ${SHA.a}` });
  try {
    mkdirSync(paths.sentBack, { recursive: true });
    writeFileSync(join(paths.sentBack, 'sky.json'), '{ "reason": "stale" }');
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'landed');
    assert.equal(existsSync(join(paths.sentBack, 'sky.json')), false);
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

test('a refused push leaves every entry READY, writes no landing and closes the record as moved', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] }, pushFails: true }),
      out = await run(paths, git, fakeSteps(undefined, git));
    assert.equal(out.result, 'moved');
    assert.equal(out.exit, 5);
    assert.equal(git.pushes().length, 1);
    assert.equal(readQueue(paths.dir).length, 1);
    assert.equal(existsSync(paths.landed), false);
    const [record] = runs(paths);
    assert.equal(record.push.state, 'rejected');
    assert.equal(record.state, 'done');
    assert.match(record.push.stderr[0], /non-fast-forward/);
  } finally {
    done();
  }
});

test('a crash in the middle of a run leaves a record that says so, and the error is not swallowed', async () => {
  const { paths, done } = setup({ one: `READY ${SHA.a}` });
  try {
    const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
      steps = fakeSteps((command) => {
        if (command === 'npm run verify') throw new Error('the disk went away');
      }, git);
    await assert.rejects(run(paths, git, steps), /the disk went away/);
    const [record] = runs(paths);
    assert.equal(record.state, 'crashed');
    assert.equal(record.error, 'the disk went away');
    assert.equal(record.attempts[0].steps.at(-1).step, 'verify');
    assert.equal(readQueue(paths.dir).length, 1);
    assert.deepEqual(git.pushes(), []);
  } finally {
    done();
  }
});

test('a send-back or landing removes a READY file only while it still holds the sha the run took, and the ledger says a newer one stays', async () => {
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
      const [line] = ledger(paths);
      assert.equal(line.removed, false);
      assert.match(line.kept, /newer READY bbbbbbb stays/);
    } finally {
      done();
    }
  }
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

test('missingFromLog reads the names worktree-node-modules.mjs lists', () => {
  assert.deepEqual(
    missingFromLog('Error: older than this worktree: run npm install there. Missing: ws, left-pad\n    at x'),
    ['ws', 'left-pad'],
  );
  assert.deepEqual(missingFromLog('fine'), []);
});

// Guarantee 7: a landing notice a watcher can see.
test('a landing writes latest-landing.json and calls notify with the landing; a notice that fails does not undo the landing', async () => {
  for (const notifyFails of [false, true]) {
    const { paths, done } = setup({ one: `READY ${SHA.a}` });
    try {
      const seen = [];
      const git = fakeGit({ branches: { [SHA.a]: ['packages/sky/a.ts'] } }),
        out = await run(paths, git, fakeSteps(undefined, git), {
          notify: async (landing) => {
            seen.push(landing);
            if (notifyFails) throw new Error('no watcher');
          },
        });
      assert.equal(out.result, 'landed');
      assert.equal(out.exit, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].to, `base+${SHA.a}`);
      assert.deepEqual(JSON.parse(readFileSync(paths.latest, 'utf8')).branches, seen[0].branches);
      assert.equal(runs(paths)[0].notified, notifyFails ? 'failed: no watcher' : true);
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
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: `${branch}\n`, stderr: '' };
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
      out = await run(paths, git, fakeSteps(undefined, git), { mainGit: main });
    assert.equal(out.result, 'landed');
    assert.deepEqual(
      main.calls.filter((a) => a[0] === 'merge'),
      [['merge', '--ff-only', 'origin/main']],
    );
    assert.match(out.mainCheckout, /fast-forwarded/);
    assert.equal(readLanded(paths.landed)[0].mainCheckout, out.mainCheckout);
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
      out = await run(paths, git, fakeSteps(undefined, git), { mainGit: main, log: (line) => lines.push(line) });
    assert.equal(out.result, 'landed');
    assert.equal(out.exit, 0);
    assert.equal(git.pushes().length, 1);
    assert.equal(main.calls.filter((a) => a[0] === 'merge').length, 1);
    assert.ok(!main.calls.some((a) => ['reset', 'stash', 'checkout', 'clean'].includes(a[0])));
    assert.equal(lines.filter((line) => /main checkout is behind/.test(line)).length, 1);
    assert.match(out.mainCheckout, /behind origin[/]main.*could not fast-forward.*not touched/);
    assert.equal(readLanded(paths.landed)[0].mainCheckout, out.mainCheckout);
  } finally {
    done();
  }
});

test('a main checkout that is on another branch is left alone', () => {
  const main = fakeMain({ branch: 'some-work' });
  assert.match(syncMainCheckout(main), /not on main/);
  assert.ok(!main.calls.some((a) => a[0] === 'merge'));
});
