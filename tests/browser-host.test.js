// The browser host (scripts/support/browser-host.mjs): the process that owns Playwright's browser server, so a suite
// never waits on the kernel's teardown of a browser it has ended (the SHUTDOWN_TIMEOUT "Chromium process/stdio close"
// that blocked batches 160, 171 and 234: the browser's exit code was set within 60 ms of TerminateProcess, but Windows
// signalled its process object only once the kernel had torn it down, over 30 s under GPU load; see the host's header).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { endOwned, hostBrowser } from '../scripts/support/browser-host.mjs';
import { launchBrowser, startHost } from '../scripts/lib/browser.mjs';

const fixture = fileURLToPath(new URL('fixtures/fake-browser-host.mjs', import.meta.url));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** A child like Chromium under Playwright: five pipes, runs until ended. */
async function fakeBrowser() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  return child;
}

/** A child whose exit never arrives: a process the kernel is still tearing down. */
function stuckBrowser(pid = 4_000_000) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdio: [],
    kill(signal) {
      this.signalCode = signal;
      return true;
    },
  });
}

test('endOwned ends the browser through its handle and acknowledges before the exit, then settles and kills the server', async () => {
  const child = await fakeBrowser();
  let exited = false,
    kills = 0;
  child.once('exit', () => (exited = true));
  const server = {
    process: () => child,
    kill: async () => {
      assert.equal(exited, true, 'the server cleanup is only asked for once the browser has exited');
      kills++;
    },
  };
  const { pid, listed, settled } = endOwned(server, [], { reapMs: 10_000, settle: null });
  assert.equal(pid, child.pid);
  assert.deepEqual(listed, []);
  assert.equal(child.killed, true, 'told to end before endOwned returned');
  assert.ok(
    child.stdio.every((pipe) => pipe.destroyed),
    'every owned pipe is released at once',
  );
  assert.deepEqual(await settled, []);
  assert.equal(kills, 1);
  assert.equal(alive(child.pid), false);
});

test('endOwned without endListed (POSIX) signals each listed child by pid and waits for them through settle', async () => {
  const child = await fakeBrowser();
  const other = await fakeBrowser();
  const waited = [];
  const settle = async (pids, waitMs, since) => {
    waited.push(pids);
    assert.ok(waitMs > 0 && waitMs <= 5000);
    assert.ok(since <= Date.now());
    return [];
  };
  const { listed, settled } = endOwned({ process: () => child, kill: async () => {} }, [other.pid, child.pid, 0], {
    reapMs: 5000,
    settle,
    endListed: null,
  });
  assert.deepEqual(listed, [other.pid], 'the browser itself and invalid pids are left out of the list');
  assert.deepEqual(await settled, []);
  assert.deepEqual(waited, [[other.pid]]);
  await new Promise((resolve) =>
    other.exitCode === null && other.signalCode === null ? other.once('exit', resolve) : resolve(),
  );
  assert.equal(alive(other.pid), false);
});

test('endOwned hands the listed children to endListed with the listing time, and signals none of them itself', async () => {
  const child = await fakeBrowser();
  const other = await fakeBrowser();
  const calls = [];
  const listedAt = Date.now() - 50;
  const { listed, settled } = endOwned({ process: () => child, kill: async () => {} }, [other.pid], {
    reapMs: 5000,
    settle: null,
    listedAt,
    endListed: async (pids, waitMs, since) => {
      calls.push({ pids, waitMs, since });
      return [];
    },
  });
  assert.deepEqual(listed, [other.pid]);
  assert.deepEqual(await settled, []);
  assert.deepEqual(calls, [{ pids: [other.pid], waitMs: 5000, since: listedAt }]);
  assert.equal(alive(other.pid), true, 'the bare pid was not signalled');
  other.kill('SIGKILL');
});

// Regression (KB-HOST-COMPATEXIT1 follow-up, 2026-11-25): endOwned ended the listed children with process.kill(pid)
// moments after Chromium listed them, so a child that had exited meanwhile could leave its pid to an unrelated process,
// which was then killed. On Windows the default endListed ends a pid only through a handle to a process that started no
// later than the listing.
test('endOwned on Windows ends a listed child that started before the listing and spares a pid whose process started after it', {
  skip: process.platform !== 'win32' && 'Windows pid reuse; POSIX signals listed pids directly',
}, async () => {
  const child = await fakeBrowser();
  const before = await fakeBrowser();
  await new Promise((resolve) => setTimeout(resolve, 50)); // fixed-wait: the listing must fall strictly between the starts
  const listedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 50)); // fixed-wait: the same, after the listing
  const after = await fakeBrowser(); // stands in for an unrelated process that took a listed pid after the listing
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, [before.pid, after.pid], {
    reapMs: 10_000,
    listedAt,
  });
  assert.deepEqual(await settled, []);
  await new Promise((resolve) =>
    before.exitCode === null && before.signalCode === null ? before.once('exit', resolve) : resolve(),
  );
  assert.equal(alive(before.pid), false, 'the listed child is ended');
  assert.equal(alive(after.pid), true, 'a process that started after the listing is never ended');
  after.kill('SIGKILL');
});

test('endOwned reports a browser the kernel has not finished with at the bound, and never asks the server to wait on it', async () => {
  const child = stuckBrowser();
  let kills = 0;
  const begun = performance.now();
  const { settled } = endOwned({ process: () => child, kill: async () => kills++ }, [], { reapMs: 100, settle: null });
  assert.deepEqual(await settled, [child.pid]);
  // The bound is measured on the monotonic clock; the wall clock may be corrected under a run (KB-BH-REAP1).
  assert.ok(performance.now() - begun >= 100);
  assert.equal(kills, 0, 'the server cleanup would wait on the exit itself');
});

test('endOwned: a timer that fires before the bound by the monotonic clock is re-armed, whatever the wall clock reads (KB-BH-REAP1)', async (t) => {
  // Local CI 2026-11-15: the runner timed a run at 104 ms on the monotonic clock while Date.now read under 100. Here
  // the wall clock and the timers agree that 100 ms have passed, but the monotonic clock has seen only 98.6.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let mono = 5_000;
  t.mock.method(performance, 'now', () => mono);
  const child = stuckBrowser();
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, [], { reapMs: 100, settle: null });
  let result = null;
  settled.then((value) => (result = value));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  mono += 98.6;
  t.mock.timers.tick(100);
  await flush();
  assert.equal(Date.now() - 1_000_000, 100, 'the wall clock reads the bound');
  assert.equal(result, null, 'not late: only 98.6 ms have passed on the monotonic clock');
  mono += 1.2;
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result, null, 'not late at 99.8 ms: re-armed for the 1.4 ms left, rounded up to 2');
  mono += 1;
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(result, [child.pid], 'late once the monotonic clock has passed the bound');
});

test('endOwned ends the whole tree by helper program when Chromium listed nothing', async () => {
  const child = stuckBrowser(77);
  const ended = [];
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, null, {
    reapMs: 50,
    settle: null,
    end: async (browser, { waitMs }) => (ended.push([browser.pid, waitMs]), [77]),
  });
  assert.deepEqual(await settled, [77, 77]);
  assert.deepEqual(ended, [[77, 50]]);
});

test('endOwned ends an unlisted tree by pid while the browser still runs, and through its handle only after (KB-HOST-COMPATEXIT1)', async () => {
  // Windows reuses a pid once no handle to its process is left. Killed through its handle first, the browser's pid was
  // free while taskkill /T still ran, and the next suite's browser host, which had taken it, was ended with no word.
  const child = stuckBrowser(78);
  const pipe = new PassThrough();
  child.stdio = [pipe];
  const seen = [];
  let finish;
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, null, {
    reapMs: 50,
    settle: null,
    end: (browser) => {
      seen.push(['end', browser.pid, child.signalCode]);
      return new Promise((resolve) => (finish = resolve));
    },
    log: () => {},
  });
  assert.deepEqual(seen, [['end', 78, null]], 'the tree end starts while the browser has not been killed');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(child.signalCode, null, 'the browser keeps its pid while the tree end runs');
  assert.equal(pipe.destroyed, false, 'its pipes stay open too: Chromium ends itself when its pipe closes');
  finish([]);
  await settled;
  assert.equal(child.signalCode, 'SIGKILL', 'killed through its handle once the tree end has finished');
  assert.equal(pipe.destroyed, true, 'and its pipes closed then');
});

test('endOwned never ends a tree by the pid of a browser that has already exited (KB-HOST-COMPATEXIT1)', async () => {
  const child = Object.assign(stuckBrowser(79), { exitCode: 1 });
  const ended = [],
    logs = [];
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, null, {
    reapMs: 50,
    settle: null,
    end: async (browser) => (ended.push(browser.pid), []),
    log: (line) => logs.push(line),
  });
  await settled;
  assert.deepEqual(ended, [], 'the pid may belong to another process by now');
  assert.match(logs.join(' '), /79 had exited/);
});

test('hostBrowser speaks the protocol: ready, then the acknowledgement at once, then the result; a closed input ends too', async () => {
  for (const how of ['request', 'input end']) {
    const child = await fakeBrowser();
    const input = new PassThrough(),
      output = new PassThrough();
    const lines = [];
    output.on('data', (chunk) =>
      lines.push(
        ...String(chunk)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ),
    );
    const server = { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:1/x', kill: async () => {} };
    const run = hostBrowser({
      settings: {},
      launchServer: async () => server,
      input,
      output,
      reapMs: 10_000,
      settle: null,
      log: () => {},
    });
    await new Promise((resolve) => output.once('data', resolve));
    assert.deepEqual(lines, [{ ready: true, wsEndpoint: 'ws://127.0.0.1:1/x', pid: child.pid }]);
    if (how === 'request') input.write(`not json\n${JSON.stringify({ end: true, children: [] })}\n`);
    else input.end();
    assert.equal(await run, 0);
    assert.deepEqual(lines.slice(1), [
      { terminated: { browser: child.pid, children: [] } },
      { done: true, survivors: [], elapsedMs: lines[2].elapsedMs },
    ]);
    assert.equal(alive(child.pid), false);
    // Regression (2026-11-19, KB-OWN-EXIT2): the host kept reading its input after the end request, so a host process
    // could not end by its event loop and needed process.exit.
    assert.equal(input.listenerCount('data'), 0, `the input is let go after ${how}`);
  }
});

test('hostBrowser reports a failed launch and ends', async () => {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => (text += chunk));
  const code = await hostBrowser({
    settings: {},
    launchServer: async () => {
      throw new Error('browserType.launchServer: no such browser');
    },
    input: new PassThrough(),
    output,
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(text), { error: 'browserType.launchServer: no such browser' });
});

test('startHost runs a real host: end is acknowledged at once and the host proves everything gone, then ends', {
  timeout: 30_000,
}, async () => {
  const host = await startHost({ name: 'round trip' }, { hostPath: fixture });
  assert.equal(host.wsEndpoint, 'ws://127.0.0.1:1/fake');
  assert.ok(alive(host.pid), 'the fake browser runs under the host');
  const exit = new Promise((resolve) => host.process.once('exit', resolve));
  assert.deepEqual(await host.end([]), { browser: host.pid, children: [] });
  const result = await host.finished();
  assert.deepEqual(result, { done: true, survivors: [], elapsedMs: result.elapsedMs });
  host.release();
  assert.equal(await exit, 0);
  assert.equal(alive(host.pid), false);
  assert.equal(alive(host.process.pid), false);
});

test('startHost keeps a result that arrives before finished() is called: a host that answers and ends early is not HOST_GONE', {
  timeout: 30_000,
}, async () => {
  // launchBrowser's close awaits Playwright's own close beside end(); a host that ends the browser first sends its
  // result and exits while nobody waits on it yet. That result used to be dropped, and the later finished() failed with
  // HOST_GONE although the host had answered (shadows test:gpu, a closed browser on a loaded Mac).
  const host = await startHost({ name: 'early result' }, { hostPath: fixture });
  const exit = new Promise((resolve) => host.process.once('exit', resolve));
  assert.deepEqual(await host.end([]), { browser: host.pid, children: [] });
  assert.equal(await exit, 0);
  await new Promise((resolve) => setImmediate(resolve)); // the host's stdout has closed too
  const result = await host.finished();
  assert.deepEqual(result, { done: true, survivors: [], elapsedMs: result.elapsedMs });
  host.release();
});

test('startHost: a browser the kernel never finishes with is logged as a survivor at the bound, in the host, not the suite', {
  timeout: 30_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-host-'));
  try {
    const logFile = join(dir, 'survivors.log');
    const host = await startHost({ stuck: true, reapMs: 200, logFile }, { hostPath: fixture });
    const exit = new Promise((resolve) => host.process.once('exit', resolve));
    // A listed child that is already gone (no such pid) is not a survivor; the stuck browser is.
    assert.deepEqual(await host.end([4_000_001]), { browser: 4_000_000, children: [4_000_001] });
    const result = await host.finished();
    assert.deepEqual(result.survivors, [4_000_000]);
    assert.ok(result.elapsedMs >= 200);
    host.release();
    assert.equal(await exit, 3);
    assert.match(
      await readFile(logFile, 'utf8'),
      /still present \d+ ms after they were ended: 4000000 \(browser 4000000; listed 4000001\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The hang itself, end to end: a launched browser whose exit never arrives (the kernel still tearing it down after
// TerminateProcess) is handed off at the grace, the close resolves, and the host alone records the survivor.
test('launchBrowser: a browser the kernel never finishes with is handed off at the grace, logged by the host, and the suite moves on', {
  timeout: 30_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-host-'));
  try {
    const logFile = join(dir, 'survivors.log');
    let host;
    const hosting = async (settings) =>
      (host = await startHost({ ...settings, stuck: true, reapMs: 2500, logFile }, { hostPath: fixture }));
    const reported = [];
    // The bounded close reports to console.error, bound when the browser is launched: watch it from before the launch.
    const graceLines = [];
    t.mock.method(console, 'error', (line) => graceLines.push(String(line)));
    const browser = await launchBrowser({
      env: { MARGO_BROWSER: 'chromium' },
      platform: 'linux',
      argv: [],
      needs: 'none',
      headless: true,
      launchers: { chromium: { connect: async () => ({ close: async () => {} }) } },
      hosting,
      report: (text) => reported.push(text),
      exit: (code) => assert.fail(`launch failed ${code}`),
    });
    const exit = new Promise((resolve) => host.process.once('exit', resolve));
    // Not through closeAll's 30 s budget: the close itself moves on at the 2,000 ms grace. Which wait ended it is read
    // from the outcome, not a clock: the grace line (written to console.error by the bounded close) appears only when
    // the grace timer wins the race, and a close that waited for the host instead would throw SHUTDOWN_TIMEOUT.
    await browser.close();
    t.mock.restoreAll();
    assert.equal(
      graceLines.filter((line) => /was ended but the kernel had not finished tearing it down 2000 ms later/.test(line))
        .length,
      1,
      `the close moved on at the grace: ${graceLines.join(' | ')}`,
    );
    assert.equal(await exit, 3, 'the host ended by itself with the survivor code');
    assert.match(await readFile(logFile, 'utf8'), /still present \d+ ms after they were ended: 4000000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startHost: a launch that fails in the host rejects with its message, and a host that dies is HOST_GONE', {
  timeout: 30_000,
}, async () => {
  await assert.rejects(startHost({ fail: true }, { hostPath: fixture }), {
    message: 'browserType.launchServer: no such browser',
  });
  const host = await startHost({}, { hostPath: fixture });
  host.process.kill('SIGKILL');
  await assert.rejects(host.end([]), { code: 'HOST_GONE' });
  host.release();
});

test('startHost: end() on a host that already exited fails with a coded HOST_GONE, not a bare write EPIPE (KB-NA1b)', {
  timeout: 30_000,
}, async () => {
  const host = await startHost({ name: 'gone before end' }, { hostPath: fixture });
  const exit = new Promise((resolve) => host.process.once('exit', resolve));
  host.process.kill('SIGKILL');
  await exit;
  await assert.rejects(host.end([]), (error) => {
    assert.equal(error.code, 'HOST_GONE');
    assert.match(error.message, new RegExp(`browser host ${host.process.pid} .*exited before the end request`));
    return true;
  });
  host.release();
});

test('startHost: end() on a host whose stdin is closed fails with HOST_GONE (KB-NA1b)', {
  timeout: 30_000,
}, async () => {
  const host = await startHost({ name: 'stdin closed' }, { hostPath: fixture });
  host.process.stdin.destroy();
  await assert.rejects(host.end([]), { code: 'HOST_GONE' });
  host.process.kill('SIGKILL');
  host.release();
});
