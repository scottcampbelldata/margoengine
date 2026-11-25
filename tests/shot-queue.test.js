// The shot queue (tools/shot/queue.mjs): job files checked, turned into shot tool arguments, and run one at a time with
// a stand-in shot tool in a scratch repository: a job that passes goes to done/, one that fails or is malformed to
// failed/, one past its hard limit is ended with its child processes, a
// second runner on a queue that has one exits at once, and a runner whose code changed under it (the checkout moved)
// claims no more jobs and exits for a runner on the new code. No browser and no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODE_CHANGED,
  PARENT_GONE,
  JOB_FORMAT,
  MAX_JOB_SECONDS,
  REMOTE_QUEUE_VARIABLE,
  jobArguments,
  HANG_MINUTES,
  jobLimitMs,
  parentRuns,
  parentWatch,
  queuedJobs,
  runJob,
  runQueue,
  runnerCodeStamp,
  submit,
  validateJob,
} from '../tools/shot/queue.mjs';

const job = (fields = {}) => ({
  format: JOB_FORMAT,
  version: 1,
  shot: 'tools/shot/shots/orrery-dolly.json',
  ...fields,
});

// The render machine's queue folder comes from the caller, never from a machine path written in the repository
// (check:banned-terms refused the dev PC's checkout path once written as the default).
test('submit takes the remote queue folder from --remote or MARGO_SHOT_REMOTE_QUEUE, and stops before copying without one', () => {
  assert.equal(REMOTE_QUEUE_VARIABLE, 'MARGO_SHOT_REMOTE_QUEUE');
  for (const remote of [undefined, ''])
    assert.throws(
      () => submit('tools/shot/shots/orrery-dolly.json', { host: 'no-such-host', remote, env: {} }),
      (error) => error instanceof TypeError && /--remote <dir> or set MARGO_SHOT_REMOTE_QUEUE/.test(error.message),
    );
});

test('job files: the shot in the repository, the options the shot tool takes, and no hold or pause', () => {
  assert.deepEqual(validateJob(job()), []);
  assert.deepEqual(validateJob(job({ seconds: 2, day: '2026-11-14', once: true, submitted: 'x' })), []);
  const bad = [
    [{ format: 'shot' }, /format/],
    [{ version: 2 }, /version/],
    [{ shot: '../outside.json' }, /shot must/],
    [{ shot: 'tools/shot/shots/a.txt' }, /shot must/],
    [{ seconds: 1200 }, /seconds must be above 0 and under 1200/],
    [{ production: 'yes' }, /production must be true or false/],
    [{ once: true, production: true }, /once and production: pick one/],
    [{ day: '14-11-2026' }, /day/],
    [{ once: 'yes' }, /once/],
    [{ maxMinutes: 5 }, /maxMinutes is not a job field/],
    [{ command: 'del' }, /command is not a job field/],
  ];
  for (const [fields, pattern] of bad)
    assert.match(validateJob(job(fields)).join('; '), pattern, JSON.stringify(fields));
  assert.deepEqual(validateJob(null), ['a job is {format, version, shot, ...}']);
  assert.deepEqual(jobArguments(job({ seconds: 2, day: '2026-11-14', once: true })), [
    'tools/shot/cli.mjs',
    'tools/shot/shots/orrery-dolly.json',
    '--seconds',
    '2',
    '--day',
    '2026-11-14',
    '--once',
  ]);
  assert.equal(jobLimitMs(job()), HANG_MINUTES * 60_000, 'one hang limit, no hold or lock wait');
});

test('a production job: a long shot of up to 20 minutes, rendered once with its probes checked', () => {
  assert.equal(MAX_JOB_SECONDS, 1200);
  assert.deepEqual(validateJob(job({ seconds: 600, production: true, encode: true })), []);
  assert.deepEqual(jobArguments(job({ seconds: 60, production: true, encode: true })), [
    'tools/shot/cli.mjs',
    'tools/shot/shots/orrery-dolly.json',
    '--seconds',
    '60',
    '--production',
    '--encode',
  ]);
});

// The shot tool the queue starts (tools/shot/cli.mjs), run on the repository's own shot file with --check or a bad --day,
// which both end before a browser opens.
function shotTool(...extra) {
  return spawnSync(process.execPath, ['tools/shot/cli.mjs', 'tools/shot/shots/orrery-dolly.json', ...extra], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
}

test('the shot tool takes no hold or owner option: --max-minutes and --owner are bad arguments (exit 2)', () => {
  assert.equal(shotTool('--check').status, 0, 'the shot file is valid');
  for (const extra of [
    ['--max-minutes', '5'],
    ['--owner', 'someone'],
  ]) {
    const run = shotTool('--check', ...extra);
    assert.equal(run.status, 2, extra[0]);
    assert.match(run.stderr, /Unknown option/, extra[0]);
  }
});

test('a render with no time option goes on to its output folder (it was refused as a bad --max-minutes)', () => {
  // A bad --day is refused where the output folder is chosen, the last step before the browser opens.
  const run = shotTool('--day', '14-11-2026');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /day must be YYYY-MM-DD/);
  assert.doesNotMatch(run.stderr, /max-minutes/);
});

// A scratch repository whose tools/shot/cli.mjs records its arguments, then exits with
// the code the shot file's name ends in (or hangs on "hang"; on "touch" it first edits the scratch tools/shot/queue.mjs, as a
// checkout that moves under the runner does).
function scratch() {
  const repo = mkdtempSync(join(tmpdir(), 'margo-queue-')),
    queue = join(repo, 'queue');
  mkdirSync(join(repo, 'tools', 'shot'), { recursive: true });
  mkdirSync(queue);
  writeFileSync(join(repo, 'tools', 'shot', 'queue.mjs'), '// the runner as loaded\n');
  writeFileSync(
    join(repo, 'tools', 'shot', 'cli.mjs'),
    `import { appendFileSync } from 'node:fs';
const shot = process.argv[2];
if (shot.includes('touch')) appendFileSync('tools/shot/queue.mjs', '// the next commit\\n');
console.log(JSON.stringify({ args: process.argv.slice(2) }));
if (shot.includes('hang')) { setInterval(() => {}, 1000); } else process.exitCode = Number(shot.match(/(\\d+)\\.json$/)[1]);
`,
  );
  const add = (name, body) => writeFileSync(join(queue, name), typeof body === 'string' ? body : JSON.stringify(body));
  return { repo, queue, add, done: () => rmSync(repo, { recursive: true, force: true }) };
}

test('runJob: a passing job goes to done/ with its log', async () => {
  const s = scratch();
  try {
    s.add('a.json', job({ shot: 'shots/pass-0.json', seconds: 1 }));
    const record = await runJob(s.queue, 'a.json', { repo: s.repo });
    assert.equal(record.code, 0);
    assert.ok(existsSync(join(s.queue, 'done', 'a.json')));
    assert.deepEqual(queuedJobs(s.queue), []);
    assert.deepEqual(readdirSync(join(s.queue, 'running')), [], 'the claim is released');
    const logged = JSON.parse(readFileSync(join(s.queue, 'logs', 'a.log'), 'utf8').trim());
    assert.deepEqual(logged.args, ['shots/pass-0.json', '--seconds', '1']);
  } finally {
    s.done();
  }
});

test('runJob: a failing job and a malformed one go to failed/; an exit 75 is a failure like any other', async () => {
  const s = scratch();
  try {
    s.add('b.json', job({ shot: 'shots/fail-1.json' }));
    s.add('c.json', '{ not json');
    s.add('d.json', job({ shot: 'shots/x.json', command: 'rm' }));
    s.add('e.json', job({ shot: 'shots/exit-75.json' }));
    assert.equal((await runJob(s.queue, 'b.json', { repo: s.repo })).code, 1);
    assert.match((await runJob(s.queue, 'c.json', { repo: s.repo })).error, /not JSON/);
    assert.match((await runJob(s.queue, 'd.json', { repo: s.repo })).error, /command is not a job field/);
    assert.deepEqual(readdirSync(join(s.queue, 'failed')).sort(), ['b.json', 'c.json', 'd.json']);
    assert.equal((await runJob(s.queue, 'e.json', { repo: s.repo })).code, 75);
    assert.deepEqual(queuedJobs(s.queue), [], 'nothing is requeued');
    assert.ok(existsSync(join(s.queue, 'failed', 'e.json')));
    assert.equal(await runJob(s.queue, 'gone.json', { repo: s.repo }), null, 'a job someone else claimed');
  } finally {
    s.done();
  }
});

test('runJob: a job past its hard limit is ended and fails as timed out', async () => {
  const s = scratch();
  try {
    s.add('f.json', job({ shot: 'shots/hang.json' }));
    const record = await runJob(s.queue, 'f.json', { repo: s.repo, limitMs: () => 1500 });
    assert.equal(record.timedOut, true);
    assert.ok(existsSync(join(s.queue, 'failed', 'f.json')));
  } finally {
    s.done();
  }
});

test('runQueue runs the queue in name order, one job at a time, and a second runner exits at once', async () => {
  const s = scratch();
  try {
    s.add('2-second.json', job({ shot: 'shots/b-0.json' }));
    s.add('1-first.json', job({ shot: 'shots/a-0.json' }));
    const lines = [];
    await runQueue({ queue: s.queue, repo: s.repo, log: (line) => lines.push(line) });
    assert.match(lines[0], /start 1-first\.json/);
    assert.match(lines[2], /start 2-second\.json/);
    assert.deepEqual(readdirSync(join(s.queue, 'done')).sort(), ['1-first.json', '2-second.json']);
    assert.ok(!existsSync(join(s.queue, 'runner.pid')), 'the runner leaves no pid file');
    // A live runner's pid file: this test process stands in for it, from a parent's pid.
    writeFileSync(join(s.queue, 'runner.pid'), String(process.ppid));
    s.add('3-third.json', job({ shot: 'shots/c-0.json' }));
    const second = [];
    await runQueue({ queue: s.queue, repo: s.repo, log: (line) => second.push(line) });
    assert.match(second[0], /already serves/);
    assert.deepEqual(queuedJobs(s.queue), ['3-third.json'], 'the second runner ran nothing');
  } finally {
    s.done();
  }
});

// The dev PC's runner, a long-lived process, kept the queue code it loaded before the shot production mode landed:
// after its checkout moved it failed every --production job with "production is not a job field" (2026-11-14). A
// runner whose code changed under it claims no more jobs and exits; the scheduled task starts one on the new code.
test('runnerCodeStamp follows the bytes of the runner folder and the checkout commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-stamp-'));
  try {
    writeFileSync(join(dir, 'queue.mjs'), '// a\n');
    writeFileSync(join(dir, 'notes.txt'), 'not code');
    const first = runnerCodeStamp({ dir, repo: dir });
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(runnerCodeStamp({ dir, repo: dir }), first, 'the same code, the same stamp');
    writeFileSync(join(dir, 'notes.txt'), 'still not code');
    assert.equal(runnerCodeStamp({ dir, repo: dir }), first, 'only .mjs and .js files count');
    appendFileSync(join(dir, 'queue.mjs'), '// b\n');
    const edited = runnerCodeStamp({ dir, repo: dir });
    assert.notEqual(edited, first, 'an edited module');
    writeFileSync(join(dir, 'shot-file.mjs'), '// new\n');
    assert.notEqual(runnerCodeStamp({ dir, repo: dir }), edited, 'a new module');
    assert.notEqual(runnerCodeStamp({ dir: join(dir, 'gone'), repo: dir }), first, 'an unreadable folder');
    // The commit: a scratch git repository moved on by one commit, with no file of the folder changed.
    const git = (...args) => {
      const run = spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Stamp Test',
          GIT_AUTHOR_EMAIL: 'stamp@example.invalid',
          GIT_COMMITTER_NAME: 'Stamp Test',
          GIT_COMMITTER_EMAIL: 'stamp@example.invalid',
        },
      });
      assert.equal(run.status, 0, run.stderr);
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const one = runnerCodeStamp({ dir, repo: dir });
    git('commit', '-q', '--allow-empty', '-m', 'two');
    assert.notEqual(runnerCodeStamp({ dir, repo: dir }), one, 'a moved checkout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runQueue: a checkout that moves while a job runs leaves the next job for a runner on the new code', async () => {
  const s = scratch();
  try {
    s.add('1-first.json', job({ shot: 'shots/touch-0.json' }));
    s.add('2-second.json', job({ shot: 'shots/b-0.json', production: true }));
    const lines = [];
    const codeStamp = () => runnerCodeStamp({ dir: join(s.repo, 'tools', 'shot'), repo: s.repo });
    const outcome = await runQueue({ queue: s.queue, repo: s.repo, log: (line) => lines.push(line), codeStamp });
    assert.equal(outcome, CODE_CHANGED);
    assert.deepEqual(readdirSync(join(s.queue, 'done')), ['1-first.json'], 'the job that was running finishes');
    assert.deepEqual(queuedJobs(s.queue), ['2-second.json'], 'the stale runner claims nothing more');
    assert.ok(
      !existsSync(join(s.queue, 'failed')) || readdirSync(join(s.queue, 'failed')).length === 0,
      'and fails nothing',
    );
    assert.match(lines.at(-1), /code changed \(the checkout moved\): exiting/);
    assert.ok(!existsSync(join(s.queue, 'runner.pid')), 'the next runner is not turned away');
    // The runner the scheduled task starts next, on the new code, takes the job.
    assert.equal(await runQueue({ queue: s.queue, repo: s.repo, log: () => {}, codeStamp }), undefined);
    assert.deepEqual(readdirSync(join(s.queue, 'done')).sort(), ['1-first.json', '2-second.json']);
  } finally {
    s.done();
  }
});

test('runQueue --watch: an idle runner exits at its next poll once its code changes', { timeout: 20_000 }, async () => {
  const s = scratch();
  try {
    // The runner stamps its code at its start and at each poll: wait for two polls that saw it unchanged.
    let calls = 0,
      polledTwice;
    const twoPolls = new Promise((r) => (polledTwice = r));
    const codeStamp = () => {
      if (++calls === 3) polledTwice();
      return runnerCodeStamp({ dir: join(s.repo, 'tools', 'shot'), repo: s.repo });
    };
    const lines = [];
    const watching = runQueue({
      queue: s.queue,
      repo: s.repo,
      watch: true,
      pollMs: 20,
      log: (line) => lines.push(line),
      codeStamp,
    });
    await twoPolls;
    assert.ok(existsSync(join(s.queue, 'runner.pid')), 'still watching while the code stays');
    appendFileSync(join(s.repo, 'tools', 'shot', 'queue.mjs'), '// the next commit\n');
    assert.equal(await watching, CODE_CHANGED);
    assert.ok(!existsSync(join(s.queue, 'runner.pid')));
  } finally {
    s.done();
  }
});

// "schtasks /End" on the dev PC ended the task's PowerShell wrapper and left its node runner running on its own (pid
// 47156, 2026-11-14): Windows ends only the process a task started, not the processes under it. The runner watches
// the process that started it and exits once that is gone, ending a running job's shot first.
test('runQueue: once the process that started it is gone, the running job is stopped and nothing more is claimed', {
  timeout: 20_000,
}, async () => {
  const s = scratch();
  try {
    s.add('1-first.json', job({ shot: 'shots/hang.json' }));
    s.add('2-second.json', job({ shot: 'shots/b-0.json' }));
    // The parent is gone once the hung shot has started: its stand-in writes its arguments to the job's log first.
    const log = join(s.queue, 'logs', '1-first.log');
    const alive = () => !(existsSync(log) && readFileSync(log, 'utf8').length > 0);
    const lines = [];
    const outcome = await runQueue({
      queue: s.queue,
      repo: s.repo,
      log: (line) => lines.push(line),
      parentAlive: alive,
      parentMs: 20,
    });
    assert.equal(outcome, PARENT_GONE);
    const record = JSON.parse(readFileSync(join(s.queue, 'failed', '1-first.json'), 'utf8'));
    assert.equal(record.stopped, true);
    assert.match(record.error, /the runner was ended/);
    assert.deepEqual(queuedJobs(s.queue), ['2-second.json'], 'the next job waits for the next runner');
    assert.deepEqual(readdirSync(join(s.queue, 'running')), []);
    assert.ok(!existsSync(join(s.queue, 'runner.pid')));
    assert.match(lines.at(-1), /the process that started the runner is gone/);
    assert.equal(parentRuns(process.pid), true);
    assert.equal(parentRuns(process.ppid), true);
  } finally {
    s.done();
  }
});

// On macOS and Linux an orphaned runner is re-parented to launchd or init, which always runs: probing the parent id read
// at each check found it alive forever, so the runner outlived its ended wrapper (the test below failed off Windows).
test('a re-parented runner sees its parent gone, though its new parent runs', () => {
  let ppid = 4242;
  const alive = parentWatch(4242, () => ppid);
  // The new parent runs on every platform: this test process stands in for it (Windows has no process 1 and does not
  // re-parent, so the init case below is checked only where it exists).
  ppid = process.pid;
  assert.equal(parentRuns(ppid), true, 'the new parent answers the probe');
  assert.equal(alive(), false);
  if (process.platform !== 'win32') {
    ppid = 1;
    assert.equal(parentRuns(1), true, 'init or launchd answers the probe');
    assert.equal(alive(), false);
  }
  assert.equal(parentWatch()(), true, "this process is still its parent's child");
});

test('queue.mjs run --watch exits once the wrapper that started it is ended on its own, as schtasks /End does', {
  timeout: 60_000,
}, async () => {
  const queue = mkdtempSync(join(tmpdir(), 'margo-orphan-'));
  const cli = fileURLToPath(new URL('../tools/shot/queue.mjs', import.meta.url));
  // The wrapper pipes the runner's output, as PowerShell's *>> does, and is then ended alone, not its process tree. Its
  // child is detached: node would otherwise put it in a job object that ends it with the wrapper, which PowerShell does not.
  const wrapper = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, [process.argv[1], 'run', '--watch', '--queue', process.argv[2]], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
c.stdout.resume(); c.stderr.resume(); setInterval(() => {}, 1000);`,
      cli,
      queue,
    ],
    { stdio: 'ignore' },
  );
  const pidFile = join(queue, 'runner.pid');
  let runner;
  try {
    for (let i = 0; i < 3000 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 10));
    runner = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(runner > 0 && runner !== wrapper.pid);
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(wrapper.pid)], { stdio: 'ignore' });
    else wrapper.kill('SIGKILL');
    let gone = false;
    for (let i = 0; i < 2000 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 10));
      gone = !parentRuns(runner);
    }
    assert.ok(gone, `the runner ${runner} still runs after its wrapper ended`);
    assert.ok(!existsSync(pidFile), 'and it removed its pid file');
  } finally {
    if (runner && parentRuns(runner))
      spawnSync(
        process.platform === 'win32' ? 'taskkill' : 'kill',
        process.platform === 'win32' ? ['/F', '/PID', String(runner)] : ['-9', String(runner)],
        { stdio: 'ignore' },
      );
    wrapper.kill();
    rmSync(queue, { recursive: true, force: true });
  }
});
