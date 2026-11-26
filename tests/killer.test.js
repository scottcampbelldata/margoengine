// startKiller (scripts/support/shutdown.mjs): the Windows PowerShell the browser host starts at launch and keeps
// waiting, so the listed Chromium children are ended at the end request without waiting for PowerShell to start. Before
// it, that start ran past waitSignaled's 10 s bound in 4 closes of 18 beside four CPU hogs, and the kill was never made
// (KB-HOST-KILLLATE1).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startKiller } from '../scripts/support/shutdown.mjs';

const windows = process.platform === 'win32';
const sleeper = async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  return child;
};
const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
const until = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, 'the condition held in time');
    await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-wait: poll the killer's ready flag
  }
};

/** A stand-in PowerShell: `ready` says whether it announces itself, `answer` whether it answers a request. */
function fakeShell({ ready, answer }) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new PassThrough(), { unref() {} }),
    stdin: Object.assign(new EventEmitter(), {
      lines: [],
      write(line) {
        this.lines.push(line);
        if (answer) child.stdout.write('done\n');
        return true;
      },
      end() {},
      unref() {},
    }),
    unref() {},
  });
  if (ready) queueMicrotask(() => child.stdout.write('ready\n'));
  return child;
}

test('the warm killer ends the listed pids itself, with no second PowerShell and no fallback', {
  skip: !windows && 'Windows PowerShell',
  timeout: 60_000,
}, async () => {
  let spawns = 0,
    fallbacks = 0;
  const killer = startKiller({
    spawnProcess: (...args) => (spawns++, spawn(...args)),
    fallback: async () => fallbacks++,
  });
  const [a, b] = [await sleeper(), await sleeper()];
  try {
    await until(() => killer.ready, 45_000);
    await killer.kill([a.pid, b.pid], Date.now());
    await Promise.all([exited(a), exited(b)]);
    assert.equal(spawns, 1, 'the PowerShell started with the killer did the kill');
    assert.equal(fallbacks, 0);
  } finally {
    killer.close();
    for (const c of [a, b]) if (c.exitCode === null) c.kill();
  }
});

test('the warm killer spares a pid whose process started after the listing', {
  skip: !windows && 'Windows PowerShell',
  timeout: 60_000,
}, async () => {
  const killer = startKiller({ fallback: async () => assert.fail('no fallback') });
  const listedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 50)); // fixed-wait: the process must start strictly after
  const newer = await sleeper();
  try {
    await until(() => killer.ready, 45_000);
    await killer.kill([newer.pid], listedAt);
    assert.equal(newer.exitCode, null, 'a newer process that took a listed pid is not ended');
  } finally {
    killer.close();
    newer.kill();
  }
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The warm PowerShell must never outlive the browser host that started it, whether the host closes it or just ends.
test('the warm PowerShell ends with its owner, closed or not', {
  skip: !windows && 'Windows PowerShell',
  timeout: 90_000,
}, async () => {
  const shutdown = new URL('../scripts/support/shutdown.mjs', import.meta.url).href;
  for (const how of ['close', 'exit']) {
    const owner = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { startKiller } from ${JSON.stringify(shutdown)};
         const killer = startKiller();
         console.log(killer.pid);
         const wait = () => (killer.ready ? ${how === 'close' ? 'killer.close()' : 'process.exit(0)'} : setTimeout(wait, 20));
         wait();`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    let text = '';
    owner.stdout.on('data', (chunk) => (text += chunk));
    await exited(owner);
    const pid = Number(text.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `${how}: the owner reported its killer's pid`);
    await until(() => !alive(pid), 15_000);
  }
});

test('a killer not ready yet hands the pids to the fallback', async () => {
  const shell = fakeShell({ ready: false, answer: false });
  const calls = [];
  const killer = startKiller({
    spawnProcess: () => shell,
    fallback: async (pids, since) => calls.push({ pids, since }),
  });
  await killer.kill([11, 0, 12], 1234);
  assert.deepEqual(calls, [{ pids: [11, 12], since: 1234 }]);
  assert.deepEqual(shell.stdin.lines, [], 'nothing was sent to a process that is not ready');
});

test('a killer that does not answer in time falls back and is not used again', async () => {
  const shell = fakeShell({ ready: true, answer: false });
  const calls = [];
  const killer = startKiller({ spawnProcess: () => shell, fallback: async (pids) => calls.push(pids), timeoutMs: 30 });
  await until(() => killer.ready, 5_000);
  await killer.kill([21], 1);
  await killer.kill([22], 1);
  assert.deepEqual(calls, [[21], [22]]);
  assert.deepEqual(shell.stdin.lines, ['1 21\n'], 'a late answer cannot be taken for the next request');
});

test('an answering killer sends one line per request and needs no fallback', async () => {
  const shell = fakeShell({ ready: true, answer: true });
  const killer = startKiller({ spawnProcess: () => shell, fallback: async () => assert.fail('no fallback') });
  await until(() => killer.ready, 5_000);
  await killer.kill([31, 32], 5000.4);
  assert.deepEqual(shell.stdin.lines, ['5000 31,32\n']);
});
