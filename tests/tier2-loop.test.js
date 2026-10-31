// scripts/tier2-loop.mjs, the full check after the push. git and every command are injected: no repository, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cycle,
  failureFrom,
  failureIds,
  lastGreen,
  rerunCommands,
  rerunSuite,
  suspectCommits,
} from '../scripts/tier2-loop.mjs';

const TIP = 'c'.repeat(40);

function fakeGit({ tip = TIP, green = 'g'.repeat(40), pushFails = false, tagExists = false, files = {} } = {}) {
  const calls = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const git = (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'rev-parse' && args[1] === 'origin/main') return ok(tip);
    if (verb === 'rev-parse' && args[1] === '-q') return tagExists ? ok(tip) : { status: 1, stdout: '', stderr: '' };
    if (verb === 'rev-parse') return ok(`parent-of-${args[1].replace('^', '')}`);
    if (verb === 'tag' && args[1] === '--list') return ok(green ? `green/${green}\n` : '');
    if (verb === 'rev-list') return ok(green);
    if (verb === 'log') return ok('aaa first commit\nbbb second commit');
    if (verb === 'diff-tree') return ok((files[args.at(-1)] ?? []).join('\n'));
    if (verb === 'push' && pushFails) return { status: 1, stdout: '', stderr: 'no network' };
    return ok();
  };
  git.calls = calls;
  git.pushes = () => calls.filter((a) => a[0] === 'push');
  return git;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'margo-tier2-')),
    paths = { dir, red: join(dir, 'RED.json'), state: join(dir, 'tier2-state.json') };
  return { paths, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const pass = () => ({ ok: true });
const steps = (full) => {
  const ran = [];
  const run = async (command, options) => {
    ran.push({ command, ...options });
    return command.includes('check:merge') ? full() : { ok: true };
  };
  run.ran = ran;
  run.full = () => ran.filter((r) => r.command.includes('check:merge'));
  return run;
};
const go = (paths, git, run, results = () => null, extra = {}) =>
  cycle({
    git,
    run,
    paths,
    results,
    limitMs: 1000,
    log: () => {},
    now: () => new Date('2026-11-01T00:00:00Z'),
    ...extra,
  });

test('a pass runs the full check side by side and keeping going, tags green/<sha>, pushes only that tag, clears RED', async () => {
  const { paths, done } = setup();
  try {
    writeFileSync(paths.red, '{}');
    const git = fakeGit(),
      run = steps(pass),
      out = await go(paths, git, run);
    assert.equal(out.result, 'pass');
    assert.equal(out.tagPushed, true);
    assert.equal(run.full().length, 1);
    assert.equal(run.full()[0].command, 'npm run check:merge:full');
    assert.equal(run.full()[0].env.MARGO_CHECK_PARALLEL, '1');
    assert.equal(run.full()[0].env.MARGO_CHECK_KEEP_GOING, '1');
    assert.equal(run.full()[0].limitMs, 1000);
    assert.ok(git.calls.some((a) => a.join(' ') === `checkout -q -f --detach ${TIP}`));
    assert.ok(git.calls.some((a) => a.join(' ') === `tag green/${TIP} ${TIP}`));
    assert.deepEqual(git.pushes(), [['push', 'origin', `refs/tags/green/${TIP}`]]);
    assert.equal(existsSync(paths.red), false);
  } finally {
    done();
  }
});

test('main has not moved: idle, nothing runs; main moved: the newest tip runs', async () => {
  const { paths, done } = setup();
  try {
    await go(paths, fakeGit(), steps(pass));
    const again = steps(pass),
      git = fakeGit();
    assert.equal((await go(paths, git, again)).result, 'idle');
    assert.deepEqual(again.ran, []);
    assert.deepEqual(git.pushes(), []);
    const moved = steps(pass),
      next = 'd'.repeat(40);
    assert.deepEqual(await go(paths, fakeGit({ tip: next }), moved), { result: 'pass', sha: next, tagPushed: true });
    assert.equal(moved.full().length, 1);
  } finally {
    done();
  }
});

test('a failure writes RED.json with every failure and the range since green, pushes nothing, and is not rerun', async () => {
  const { paths, done } = setup();
  try {
    const merge = {
        results: [
          { command: 'npm run verify', ok: true },
          { command: 'npm run check:gpu-packages -- --no-build', ok: false, log: 'gpu.log' },
          { command: 'npm run check:depth', ok: false, log: 'depth.log' },
          { command: 'npm run check:views', ok: false, notRun: 'it needs build:site' },
        ],
      },
      gpu = { results: [{ label: 'sky test:gpu', outcome: 'fail' }] },
      git = fakeGit(),
      out = await go(
        paths,
        git,
        steps(() => ({ ok: false })),
        (file) => (file.includes('check-merge') ? merge : gpu),
      );
    assert.equal(out.result, 'fail');
    const red = JSON.parse(readFileSync(paths.red, 'utf8'));
    assert.equal(red.step, 'check:gpu-packages');
    assert.equal(red.suite, 'sky/test:gpu');
    assert.deepEqual(
      red.failures.map((f) => f.suite ?? f.step),
      ['sky/test:gpu', 'check:depth'],
    );
    assert.deepEqual(red.range, { from: 'g'.repeat(40), to: TIP });
    assert.deepEqual(
      red.commits.map((c) => c.sha),
      ['aaa', 'bbb'],
    );
    assert.equal(red.commits[1].subject, 'second commit');
    assert.deepEqual(git.pushes(), []);
    assert.ok(!git.calls.some((a) => a[0] === 'tag' && a[1] !== '--list'));
    const again = steps(pass);
    assert.equal((await go(paths, fakeGit(), again)).result, 'idle');
  } finally {
    done();
  }
});

test('a second failure keeps the time RED began, for the 2 hour box', async () => {
  const { paths, done } = setup();
  try {
    writeFileSync(paths.red, JSON.stringify({ since: '2026-10-31T20:00:00Z' }));
    await go(
      paths,
      fakeGit(),
      steps(() => ({ ok: false })),
    );
    assert.equal(JSON.parse(readFileSync(paths.red, 'utf8')).since, '2026-10-31T20:00:00Z');
  } finally {
    done();
  }
});

test('past the time limit counts as a failure, named as such', async () => {
  const { paths, done } = setup();
  try {
    const out = await go(
      paths,
      fakeGit(),
      steps(() => ({ ok: false, timedOut: true })),
    );
    assert.equal(out.result, 'timeout');
    assert.equal(JSON.parse(readFileSync(paths.red, 'utf8')).step, 'time limit');
  } finally {
    done();
  }
});

test('a heat stop is no failure: no RED, no tag, and the same commit runs again', async () => {
  const { paths, done } = setup();
  try {
    const results = () => ({ heatStopped: 'npm run check:views', results: [] }),
      out = await go(
        paths,
        fakeGit(),
        steps(() => ({ ok: false })),
        results,
      );
    assert.equal(out.result, 'heat');
    assert.equal(existsSync(paths.red), false);
    const again = steps(pass);
    assert.equal((await go(paths, fakeGit(), again)).result, 'pass');
  } finally {
    done();
  }
});

test('the old result files are cleared first, so a run that dies early cannot read the last run', async () => {
  const { paths, done } = setup();
  try {
    let cleared = 0;
    const run = steps(() => (assert.equal(cleared, 1), { ok: true }));
    await go(paths, fakeGit(), run, () => null, { clearResults: () => cleared++ });
    assert.equal(cleared, 1);
  } finally {
    done();
  }
});

test('a tag push that fails still counts as a pass and says what to run; an existing tag is not made twice', async () => {
  const { paths, done } = setup();
  try {
    const lines = [],
      git = fakeGit({ pushFails: true, tagExists: true }),
      out = await go(paths, git, steps(pass), () => null, { log: (line) => lines.push(line) });
    assert.equal(out.result, 'pass');
    assert.equal(out.tagPushed, false);
    assert.ok(!git.calls.some((a) => a[0] === 'tag'));
    assert.ok(lines.some((line) => line.includes(`git push origin refs/tags/green/${TIP}`)));
  } finally {
    done();
  }
});

test('failureFrom: not-run steps are no failures; a split suite label becomes its id, once', () => {
  const merge = { results: [{ command: 'npm run check:gpu-packages -- --no-build', ok: false }] },
    gpu = {
      results: [
        { label: 'voxel test:gpu [1/2] a', outcome: 'fail' },
        { label: 'voxel test:gpu [2/2] b', outcome: 'fail' },
        { label: 'root test:x', outcome: 'fail' },
        { label: 'sky test:gpu', outcome: 'not-run' },
      ],
    };
  assert.deepEqual(
    failureFrom(merge, gpu).failures.map((f) => f.suite),
    ['voxel/test:gpu', 'root/test:x'],
  );
  assert.equal(failureFrom({ results: [{ command: 'npm run a', ok: false, notRun: 'x' }] }, null).step, 'unknown');
  assert.equal(failureFrom(null, null).step, 'unknown');
});

test('lastGreen: the newest green tag, or null', () => {
  assert.equal(lastGreen(fakeGit(), TIP), 'g'.repeat(40));
  assert.equal(lastGreen(fakeGit({ green: null }), TIP), null);
});

const CTX = {
  workspaces: [
    { name: '@margoengine/sky', dir: 'packages/sky', deps: [] },
    { name: '@margoengine/fog', dir: 'packages/fog', deps: [] },
  ],
  footprints: {
    'gpu/sky/test:gpu': { packages: new Set(['@margoengine/sky']), files: new Set(), patterns: [], all: false },
    'gpu/fog/test:gpu': { packages: new Set(['@margoengine/fog']), files: new Set(), patterns: [], all: false },
    'visual/a': { packages: new Set(['@margoengine/fog']), files: new Set(), patterns: [], all: false },
    views: { packages: new Set(), files: new Set(['scripts/views.mjs']), patterns: [], all: false },
  },
  checkCode: new Set(['scripts/check-merge.mjs']),
  smoke: [],
  steps: ['npm run verify', 'npm run check:views', 'npm run check:gpu-packages -- --no-build'],
  tests: [{ label: 'sky test:gpu' }],
  testId: (t) => t.label.replace(' ', '/'),
};
const COMMITS = [
  { sha: 'one', subject: 'sky' },
  { sha: 'two', subject: 'fog' },
  { sha: 'three', subject: 'views' },
  { sha: 'four', subject: 'check code' },
];
const FILES = {
  one: ['packages/sky/src/a.ts'],
  two: ['packages/fog/src/a.ts'],
  three: ['scripts/views.mjs'],
  four: ['scripts/check-merge.mjs'],
};

test('suspectCommits: the footprint picks the commits that reach the suite; a run-everything commit stays in', () => {
  const git = fakeGit({ files: FILES }),
    pick = (failure) => suspectCommits({ git, ctx: CTX, red: { ...failure, commits: COMMITS } }).map((c) => c.sha);
  assert.deepEqual(pick({ step: 'check:gpu-packages', suite: 'sky/test:gpu' }), ['one', 'four']);
  assert.deepEqual(pick({ step: 'check:views', suite: null }), ['three', 'four']);
  assert.deepEqual(pick({ step: 'visual:check', suite: null }), ['two', 'four']);
  // A step with no footprint of its own cannot rule any commit out.
  assert.deepEqual(pick({ step: 'check:quickstart', suite: null }), ['one', 'two', 'three', 'four']);
});

test('failureIds: a suite is itself, a step its footprints, and an unmapped step null', () => {
  assert.deepEqual(failureIds({ suite: 'sky/test:gpu' }, CTX.footprints), ['gpu/sky/test:gpu']);
  assert.deepEqual(failureIds({ step: 'check:gpu-packages' }, CTX.footprints), [
    'gpu/sky/test:gpu',
    'gpu/fog/test:gpu',
  ]);
  assert.equal(failureIds({ step: 'verify' }, CTX.footprints), null);
});

test('rerunCommands: one suite through check:merge own narrowing; a visual step builds the site first', () => {
  const suite = rerunCommands(CTX, { step: 'check:gpu-packages', suite: 'sky/test:gpu' });
  assert.equal(suite.command, 'npm run check:gpu-packages -- --no-build --select=sky/test:gpu');
  assert.deepEqual(suite.prepare, ['node scripts/worktree-node-modules.mjs', 'npm run build:packages']);
  const views = rerunCommands(CTX, { step: 'check:views', suite: null });
  assert.equal(views.command, 'npm run check:views');
  assert.ok(views.prepare.includes('npm run build:site'));
  assert.throws(() => rerunCommands(CTX, { step: 'check:gpu-packages', suite: 'no/such' }), {
    code: 'TIER2_SUITE_UNKNOWN',
  });
  assert.throws(() => rerunCommands(CTX, { step: 'time limit', suite: null }), { code: 'TIER2_SUITE_UNKNOWN' });
});

test('rerunSuite: the candidate then its parent, and the verdict from the two', async () => {
  const { paths, done } = setup();
  try {
    for (const [candidateOk, parentOk, verdict] of [
      [false, true, 'culprit'],
      [true, true, 'not-reproduced'],
      [false, false, 'older'],
    ]) {
      const git = fakeGit(),
        order = [];
      const run = async (command) => {
        const at = git.calls
          .filter((a) => a[0] === 'checkout')
          .at(-1)
          .at(-1);
        if (command !== 'SUITE') return { ok: true };
        order.push(at);
        return { ok: at === 'cand' ? candidateOk : parentOk };
      };
      const out = await rerunSuite({
        git,
        run,
        candidate: 'cand',
        logDir: paths.dir,
        limitMs: 1000,
        log: () => {},
        commands: { prepare: ['BUILD'], command: 'SUITE' },
      });
      assert.deepEqual(order, ['cand', 'parent-of-cand']);
      assert.equal(out.verdict, verdict);
      assert.deepEqual(git.pushes(), []);
    }
  } finally {
    done();
  }
});

test('rerunSuite: a build that fails is no verdict', async () => {
  const { paths, done } = setup();
  try {
    await assert.rejects(
      rerunSuite({
        git: fakeGit(),
        run: async () => ({ ok: false }),
        candidate: 'cand',
        logDir: paths.dir,
        limitMs: 1000,
        log: () => {},
        commands: { prepare: ['BUILD'], command: 'SUITE' },
      }),
      { code: 'TIER2_SETUP_FAILED' },
    );
  } finally {
    done();
  }
});
