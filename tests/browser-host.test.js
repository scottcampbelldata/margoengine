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
  assert.ok(child.stdio.every((pipe) => pipe.destroyed), 'every owned pipe is released at once');
  assert.deepEqual(await settled, []);
  assert.equal(kills, 1);
  assert.equal(alive(child.pid), false);
});

test('endOwned ends each listed child by pid and waits for them through the native waiter', async () => {
  const child = await fakeBrowser();
  const other = await fakeBrowser();
  const waited = [];
  const settle = async (pids, waitMs, since) => {
    waited.push(pids);
    assert.ok(waitMs > 0 && waitMs <= 5000);
    assert.ok(since <= Date.now());
    return [];
  };
  const { listed, settled } = endOwned({ process: () => child, kill: async () => {} }, [other.pid, child.pid, 0], { reapMs: 5000, settle });
  assert.deepEqual(listed, [other.pid], 'the browser itself and invalid pids are left out of the list');
  assert.deepEqual(await settled, []);
  assert.deepEqual(waited, [[other.pid]]);
  await new Promise((resolve) => (other.exitCode === null && other.signalCode === null ? other.once('exit', resolve) : resolve()));
  assert.equal(alive(other.pid), false);
});

test('endOwned reports a browser the kernel has not finished with at the bound, and never asks the server to wait on it', async () => {
  const child = stuckBrowser();
  let kills = 0;
  const begun = Date.now();
  const { settled } = endOwned({ process: () => child, kill: async () => kills++ }, [], { reapMs: 100, settle: null });
  assert.deepEqual(await settled, [child.pid]);
  assert.ok(Date.now() - begun >= 100);
  assert.equal(kills, 0, 'the server cleanup would wait on the exit itself');
});

test('endOwned ends the whole tree by helper program when Chromium listed nothing', async () => {
  const child = stuckBrowser(77);
  const ended = [];
  const { settled } = endOwned({ process: () => child, kill: async () => {} }, null, {
    reapMs: 50,
    settle: null,
    end: async (pid, { waitMs }) => (ended.push([pid, waitMs]), [77]),
  });
  assert.deepEqual(await settled, [77, 77]);
  assert.deepEqual(ended, [[77, 50]]);
});

test('hostBrowser speaks the protocol: ready, then the acknowledgement at once, then the result; a closed input ends too', async () => {
  for (const how of ['request', 'input end']) {
    const child = await fakeBrowser();
    const input = new PassThrough(),
      output = new PassThrough();
    const lines = [];
    output.on('data', (chunk) => lines.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line))));
    const server = { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:1/x', kill: async () => {} };
    const run = hostBrowser({ settings: {}, launchServer: async () => server, input, output, reapMs: 10_000, settle: null, log: () => {} });
    await new Promise((resolve) => output.once('data', resolve));
    assert.deepEqual(lines, [{ ready: true, wsEndpoint: 'ws://127.0.0.1:1/x', pid: child.pid }]);
    if (how === 'request') input.write(`not json\n${JSON.stringify({ end: true, children: [] })}\n`);
    else input.end();
    assert.equal(await run, 0);
    assert.deepEqual(lines.slice(1), [{ terminated: { browser: child.pid, children: [] } }, { done: true, survivors: [], elapsedMs: lines[2].elapsedMs }]);
    assert.equal(alive(child.pid), false);
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

test('startHost runs a real host: end is acknowledged at once and the host proves everything gone, then ends', { timeout: 30_000 }, async () => {
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

test('startHost: a browser the kernel never finishes with is logged as a survivor at the bound, in the host, not the suite', { timeout: 30_000 }, async () => {
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
    assert.match(await readFile(logFile, 'utf8'), /still present \d+ ms after they were ended: 4000000 \(browser 4000000; listed 4000001\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The hang itself, end to end: a launched browser whose exit never arrives (the kernel still tearing it down after
// TerminateProcess) is handed off at the grace, the close resolves, and the host alone records the survivor.
test('launchBrowser: a browser the kernel never finishes with is handed off at the grace, logged by the host, and the suite moves on', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-host-'));
  try {
    const logFile = join(dir, 'survivors.log');
    let host;
    const hosting = async (settings) => (host = await startHost({ ...settings, stuck: true, reapMs: 2500, logFile }, { hostPath: fixture }));
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
      graceLines.filter((line) => /was ended but the kernel had not finished tearing it down 2000 ms later/.test(line)).length,
      1,
      `the close moved on at the grace: ${graceLines.join(' | ')}`,
    );
    assert.equal(await exit, 3, 'the host ended by itself with the survivor code');
    assert.match(await readFile(logFile, 'utf8'), /still present \d+ ms after they were ended: 4000000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startHost: a launch that fails in the host rejects with its message, and a host that dies is HOST_GONE', { timeout: 30_000 }, async () => {
  await assert.rejects(startHost({ fail: true }, { hostPath: fixture }), { message: 'browserType.launchServer: no such browser' });
  const host = await startHost({}, { hostPath: fixture });
  host.process.kill('SIGKILL');
  await assert.rejects(host.end([]), { code: 'HOST_GONE' });
  host.release();
});
