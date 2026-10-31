// scripts/integrate.mjs, the only pusher to main. git and every command are injected: no repository, no build, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMAIL,
  demoPath,
  integrate,
  parsePlan,
  parseReady,
  queuePaths,
  readQueue,
  readStopped,
  stoppedHits,
  suspects,
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
function fakeGit({ branches = {}, conflicts = [], pushFails = false, author = EMAIL, stranger = false } = {}) {
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
    if (verb === 'log' && args[1] === '--format=%ae') return ok(author);
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
const run = (paths, git, runStep) =>
  integrate({
    git,
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
      'npm run verify',
      'npm run check:examples-types -- --projects=examples',
      'npm run modern:test:packages -- --packages=sky',
      'node scripts/land-records.mjs --no-build',
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
    assert.equal(line.tier1.length, 6);
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
