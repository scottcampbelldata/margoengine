// Bug 70: `check:depth` and `check:no-webgpu` passed every assertion and then never exited; the audit had to kill them.
// Bug 30 had fixed the same hang for one suite (scripts/support/shutdown.mjs: browser first, then the servers'
// connections, one bounded budget). This applies it to every script that opens a browser, and fails the build for a
// script that does not: a script that starts a browser and a server of its own must tear both down with `closeAll`, and
// the shared launchers (`launchBrowser`, `openBrowser`, `startDevServer`) bound their own closes.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_KILL_MS,
  CLOSE_LIMIT_HELP,
  CLOSE_LIMIT_MS,
  launchBrowser,
  withBoundedClose,
} from '../scripts/lib/browser.mjs';
import {
  closeAll,
  endTree,
  runSuite,
  killOwnTree,
  SHUTDOWN_BUDGET_MS,
  waitSignaled,
} from '../scripts/support/shutdown.mjs';

const root = new URL('..', import.meta.url);

// A script that starts a browser itself.
const LAUNCH = /\blaunchBrowser\s*\(|\b(?:chromium|firefox|webkit)\.launch\(|launchPersistentContext\(/;
// A script that also starts an HTTP server of its own (openBrowser starts and closes its own, so it is not counted).
const OWN_SERVER = /\bcreateServer\s*\(|\bpreview\s*\(|\.listen\(/;

/** Scripts that start a browser and are not yet on the shared teardown, each with the reason. Only ever shrinks. */
const NOT_YET = new Map([
  [
    'packages/webgl2-compat/scripts/capabilities.mjs',
    'owned by the webgl2-compat work, which has not landed yet; it starts no server of its own',
  ],
]);

/** The tracked scripts, tests and tools that start a browser but do not use the shared bounded teardown. */
export function unboundedBrowserScripts(read = (file) => readFileSync(new URL(file, root), 'utf8')) {
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs', '*.ts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean);
  const offenders = [];
  for (const file of files) {
    if (/\.test\.js$|(^|\/)node_modules\/|(^|\/)dist\/|^scripts\/lib\/browser\.mjs$|^scripts\/browser\.js$/.test(file))
      continue;
    // Upstream defect repros go to other projects' trackers with no Margo code in them, so they cannot import
    // shutdown.mjs; they run by hand, never in a suite or gate (docs/upstream-reports/run-page.mjs).
    if (file.startsWith('docs/upstream-reports/')) continue;
    const source = read(file);
    if (!LAUNCH.test(source) || /shutdown\.mjs/.test(source)) continue;
    const direct = /\b(?:chromium|firefox|webkit)\.launch\(|launchPersistentContext\(/.test(source);
    if (direct || OWN_SERVER.test(source)) offenders.push(file);
  }
  return offenders;
}

test('every script that starts a browser and a server tears both down with closeAll', () => {
  const found = unboundedBrowserScripts().filter((file) => !NOT_YET.has(file));
  assert.deepEqual(
    found,
    [],
    `these scripts start a browser without the bounded teardown; end them with \`await closeAll({ browser, servers: [server] })\` from scripts/support/shutdown.mjs (bug 70):\n  ${found.join('\n  ')}`,
  );
});

test('a script moved onto closeAll leaves the not-yet list', () => {
  const still = new Set(unboundedBrowserScripts());
  const done = [...NOT_YET.keys()].filter((file) => !still.has(file));
  assert.deepEqual(done, [], `${done.join(', ')} now use closeAll: remove them from NOT_YET`);
});

test('the checker finds a script that closes its server while the browser is open', () => {
  const sources = {
    'a.mjs':
      'const browser = await launchBrowser({}); const server = await createServer({}); await browser.close(); await server.close();',
    'b.mjs':
      "import { closeAll } from './scripts/support/shutdown.mjs'; const browser = await launchBrowser({}); const server = createServer(); await closeAll({ browser, servers: [server] });",
    'c.mjs': 'const browser = await chromium.launch({});',
    'd.mjs': "const page = await openBrowser({ startPath: '/x.html' });",
  };
  const hit = Object.entries(sources)
    .filter(([, source]) => LAUNCH.test(source) && !/shutdown\.mjs/.test(source))
    .filter(([, source]) => /\b(?:chromium|firefox|webkit)\.launch\(/.test(source) || OWN_SERVER.test(source))
    .map(([file]) => file);
  assert.deepEqual(hit, ['a.mjs', 'c.mjs']);
});

test('launchBrowser and openBrowser close through the bounded teardown', () => {
  const launcher = readFileSync(new URL('scripts/lib/browser.mjs', root), 'utf8'),
    opener = readFileSync(new URL('scripts/browser.js', root), 'utf8');
  assert.match(launcher, /withBoundedClose\(await launch\(browser\.channel\)\)/);
  assert.match(launcher, /withBoundedClose\(await launchers\[browser\.engine\]\.launch/);
  assert.match(
    opener,
    /await closeAll\(\{ servers: \[server\] \}\)/,
    'startDevServer drops connections and is bounded',
  );
  assert.match(opener, /await closeAll\(\{ browser \}\)/, 'openBrowser closes the browser bounded');
  assert.doesNotMatch(opener, /^\s*await browser\??\.close\(\);/m, 'no bare browser.close() in openBrowser');
});

test('a browser whose close never finishes makes close() throw SHUTDOWN_TIMEOUT instead of hanging', async () => {
  const hung = withBoundedClose({ close: () => new Promise(() => {}) });
  // The shared budget is 30 s; shorten it for the test by closing through closeAll with the same wrapper.
  const outcome = await Promise.race([
    closeAll({ browser: hung, budgetMs: 200 }).then(
      () => 'finished',
      (error) => error.code,
    ),
    new Promise((resolve) => setTimeout(() => resolve('test timer'), 5000)),
  ]);
  assert.equal(outcome, 'SHUTDOWN_TIMEOUT');
});

test('a browser that closes normally still resolves, and arguments pass through', async () => {
  const calls = [];
  const browser = withBoundedClose({ close: async (...args) => calls.push(args) });
  await browser.close({ reason: 'done' });
  assert.deepEqual(calls, [[{ reason: 'done' }]]);
  assert.equal(withBoundedClose(undefined), undefined);
  assert.deepEqual(withBoundedClose({}), {});
});

test('a Chromium browser has its processes ended before the close, whose own shutdown a busy machine starves', async () => {
  // Headless Edge shuts down on low-priority threads: its graceful close took 68 to 146 s beside CPU hogs and failed the
  // 30 s budget. Here the close only finishes once the process tree has been ended, so a graceful wait cannot pass.
  const steps = [];
  let ended;
  const treeEnded = new Promise((resolve) => (ended = resolve));
  const fake = {
    browserType: () => ({ name: () => 'chromium' }),
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (method) => {
        steps.push(method);
        return {
          processInfo: [
            { type: 'renderer', id: 2 },
            { type: 'browser', id: 1 },
          ],
        };
      },
    }),
    close: async () => {
      await treeEnded;
      steps.push('close');
    },
  };
  await withBoundedClose(fake, {
    end: async (pid) => {
      steps.push(`end ${pid}`);
      ended();
      return [];
    },
  }).close();
  assert.deepEqual(steps, ['SystemInfo.getProcessInfo', 'end 1', 'close']);
});

/** A fake browser host (scripts/lib/browser.mjs `startHost`): records what the close asks of it. */
function fakeHost({
  pid = 10,
  result = { done: true, survivors: [], elapsedMs: 1 },
  ack = async () => ({}),
  finish = async () => result,
} = {}) {
  const calls = [];
  return {
    pid,
    process: { pid: 999 },
    calls,
    end: async (children) => {
      calls.push(['end', children]);
      await ack();
      return { browser: pid, children: children ?? [] };
    },
    finished: () => {
      calls.push(['finished']);
      return finish();
    },
    release: () => calls.push(['release']),
  };
}

/** A browser like one `launchBrowser` connected: it lists its processes over CDP while connected. */
function listingBrowser(
  calls,
  processInfo = [
    { id: 10, type: 'browser' },
    { id: 11, type: 'GPU' },
    { id: 12, type: 'renderer' },
  ],
) {
  let disconnected = false;
  return {
    newBrowserCDPSession: async () => ({
      send: async (method) => {
        assert.equal(method, 'SystemInfo.getProcessInfo');
        await new Promise((resolve) => setImmediate(resolve));
        if (disconnected) throw new Error('client disconnected the process-list session');
        calls.push(['listed']);
        return { processInfo };
      },
    }),
    close: async () => {
      disconnected = true;
      calls.push(['client']);
    },
  };
}

test('an owned browser is ended through its host: listed while connected, every listed child handed to the host, client closed, host released', async () => {
  const calls = [];
  const host = fakeHost();
  const browser = withBoundedClose(listingBrowser(calls), { host });
  await closeAll({ browser, budgetMs: 2000 });
  assert.deepEqual(host.calls, [['end', [11, 12]], ['finished'], ['release']]);
  assert.ok(
    calls.findIndex(([what]) => what === 'listed') < calls.findIndex(([what]) => what === 'client'),
    'listed before the client disconnects',
  );
});

// KB1898: check:readme-run closed a hung example's browser at its deadline and again at the end of the run. The second
// close asked the host the first had released to end again; a released host answers null, and the close threw
// "browser host <pid> did not acknowledge the end: null", hiding the example report.
test('closing a browser twice ends and releases its host once, and both calls share the outcome', async () => {
  const calls = [];
  const host = fakeHost();
  const browser = withBoundedClose(listingBrowser(calls), { host });
  const [first, second] = [browser.close(), browser.close()];
  await Promise.all([first, second]);
  await browser.close();
  assert.deepEqual(host.calls, [['end', [11, 12]], ['finished'], ['release']]);
  assert.equal(calls.filter(([what]) => what === 'client').length, 1, 'one client close');
});

// The SHUTDOWN_TIMEOUT "still open: Chromium process/stdio close (<pid>)" that blocked batches 160, 171 and 234 (2026-11-09):
// the close waited for Node's 'close' of the browser process, which Windows signals only once the kernel has torn the
// process down after TerminateProcess (its exit code is set within 60 ms; the signal took 65 ms to 1.2 s beside the
// batches, 8.7 s beside verify, over 30 s in the failure). Here the host never reports the teardown finished, as then;
// the in-process design this replaces asserted SHUTDOWN_TIMEOUT for exactly this (its test "a pending owned process
// termination keeps the shutdown timer runnable"). tests/browser-host.test.js runs the same case through launchBrowser.
test('a browser process the kernel has not finished tearing down cannot hold the close past the grace', {
  timeout: 5000,
}, async () => {
  const reported = [];
  const host = fakeHost({ finish: () => new Promise(() => {}) });
  const browser = withBoundedClose(listingBrowser([]), { host, graceMs: 100, report: (line) => reported.push(line) });
  // Moving on at the grace, not the budget, is read from the outcome, not a clock: closeAll rejects with
  // SHUTDOWN_TIMEOUT when its budget runs out, and the grace report below is written only when the grace timer won.
  await closeAll({ browser, budgetMs: 2000 });
  assert.deepEqual(host.calls.at(-1), ['release'], 'the host is released so the suite can end without it');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /Chromium 10 was ended but the kernel had not finished tearing it down 100 ms later/);
  assert.match(reported[0], /records a survivor in test-results\/browser-host-survivors\.log/);
});

test('a host that proves survivors within the grace fails the close naming them', async () => {
  const host = fakeHost({ result: { done: true, survivors: [11], elapsedMs: 5 } });
  await assert.rejects(
    closeAll({ browser: withBoundedClose(listingBrowser([]), { host }), budgetMs: 2000 }),
    (error) => {
      assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
      assert.deepEqual(error.open, ['Chromium process 11']);
      return true;
    },
  );
  assert.deepEqual(host.calls.at(-1), ['release']);
});

test('a host that dies before it acknowledges fails the close with HOST_GONE, and is still released', async () => {
  const host = fakeHost({
    ack: () => {
      throw Object.assign(new Error('browser host 999 ended (SIGKILL) before it answered'), { code: 'HOST_GONE' });
    },
  });
  const calls = [];
  await assert.rejects(closeAll({ browser: withBoundedClose(listingBrowser(calls), { host }), budgetMs: 2000 }), {
    code: 'HOST_GONE',
  });
  assert.deepEqual(host.calls.at(-1), ['release']);
  assert.ok(
    calls.some(([what]) => what === 'client'),
    'the client still disconnects',
  );
});

test('when Chromium does not list its processes in time, the host ends the whole tree', async () => {
  const host = fakeHost();
  const browser = withBoundedClose(
    { newBrowserCDPSession: () => new Promise(() => {}), close: async () => {} },
    { host, listMs: 20 },
  );
  await closeAll({ browser, budgetMs: 2000 });
  assert.deepEqual(host.calls[0], ['end', null]);
});

test('a client close that fails still ends the browser through the host, then throws', async () => {
  const host = fakeHost();
  const browser = withBoundedClose(
    {
      newBrowserCDPSession: () => new Promise(() => {}),
      close: async () => {
        throw new Error('client refused');
      },
    },
    { host, listMs: 20 },
  );
  await assert.rejects(closeAll({ browser, budgetMs: 2000 }), { message: 'client refused' });
  assert.deepEqual(
    host.calls.map(([what]) => what),
    ['end', 'release'],
  );
});

test('launchBrowser hands the launch settings to the host and connects to its endpoint; a failed connect ends the host', async () => {
  const hosted = [];
  const connects = [];
  const hosting = async (settings) => {
    hosted.push(settings);
    return fakeHost({ pid: 10 });
  };
  const launchers = {
    chromium: {
      launch: async () => assert.fail('an owned Chromium runs under its host'),
      connect: async (endpoint, options) => {
        connects.push([endpoint, options]);
        if (connects.length === 2) throw new Error('connect refused');
        return { close: async () => {} };
      },
    },
  };
  const browser = await launchBrowser({
    env: { MARGO_BROWSER: 'chromium' },
    platform: 'linux',
    argv: [],
    needs: 'none',
    headless: true,
    launchers,
    hosting,
  });
  assert.equal(hosted[0].host, '127.0.0.1');
  assert.equal(hosted[0].headless, true);
  assert.deepEqual(connects, [[undefined, { timeout: 30_000 }]]);
  await browser.close();
  const printed = [];
  let code;
  await launchBrowser({
    env: { MARGO_BROWSER: 'chromium' },
    platform: 'linux',
    argv: [],
    needs: 'none',
    launchers,
    hosting,
    report: (text) => printed.push(text),
    exit: (c) => (code = c),
  });
  assert.equal(code, 3);
  assert.match(printed[0], /cannot start chromium: connect refused/);
});

test('Firefox and a browser already gone close the ordinary way', async () => {
  for (const fake of [
    { browserType: () => ({ name: () => 'firefox' }), isConnected: () => true },
    { browserType: () => ({ name: () => 'chromium' }), isConnected: () => false },
  ]) {
    let closed = false;
    fake.close = async () => (closed = true);
    await withBoundedClose(fake, { end: () => assert.fail('nothing to end') }).close();
    assert.equal(closed, true);
  }
});

test('a Chromium browser whose processes cannot be ended still closes the ordinary way, then the close fails', async () => {
  let closed = false;
  const fake = {
    browserType: () => ({ name: () => 'chromium' }),
    isConnected: () => true,
    newBrowserCDPSession: async () => {
      throw new Error('CDP session refused');
    },
    close: async () => (closed = true),
  };
  await assert.rejects(withBoundedClose(fake, { end: () => assert.fail('no pid to end') }).close(), {
    message: 'CDP session refused',
  });
  assert.equal(closed, true, 'a browser left running holds the suite open after its last check');
});

/**
 * The processes of `browser` with a page open, so a renderer runs under the browser process (right after the launch a
 * busy machine often lists the browser process alone). Closes the browser on every path: a failed check that left it
 * running held this file's process open after its last test, and the root run waited on it with no limit (2026-11-08).
 * @returns {Promise<{ id: number, type: string }[] & { listedAt: number }>} `listedAt`: when the list was read (epoch ms)
 */
export async function processTree(browser) {
  let tree;
  await runSuite(
    async () => {
      await browser.newPage();
      const session = await browser.newBrowserCDPSession();
      tree = (await session.send('SystemInfo.getProcessInfo')).processInfo;
      tree.listedAt = Date.now();
      const types = tree.map((process) => process.type);
      assert.ok(types.includes('browser') && types.includes('renderer'), `a browser and a renderer: ${types}`);
    },
    () => browser.close(),
  );
  return tree;
}

test('a failed check on a real browser still closes it, so the file can exit', async () => {
  for (const fail of ['list', 'page']) {
    let closes = 0;
    const fake = {
      newPage: async () => {
        if (fail === 'page') throw new Error('no page');
      },
      newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ id: 1, type: 'browser' }] }) }),
      close: async () => closes++,
    };
    await assert.rejects(processTree(fake), fail === 'page' ? { message: 'no page' } : { code: 'ERR_ASSERTION' });
    assert.equal(closes, 1, `${fail}: the browser is closed once`);
  }
});

test('a real browser: close ends its main process and everything under it', { timeout: 5 * 60_000 }, async () => {
  const tree = await processTree(await launchBrowser({ headless: true, needs: 'none' }));
  let alive = tree
    .filter(({ id }) => {
      try {
        process.kill(id, 0);
        return true;
      } catch {
        return false;
      }
    })
    .map(({ id }) => id);
  // Windows hands a freed pid to the next new process at once, and suites side by side start many: a pid that answers
  // here counts only if its process started before the list was read (waitSignaled skips a newer one).
  if (alive.length && process.platform === 'win32') alive = await waitSignaled(alive, 10_000, tree.listedAt);
  assert.deepEqual(alive, [], `still running after the close, of ${tree.map(({ id, type }) => `${type} ${id}`)}`);
});

test('endTree polls every killed process without a native handle waiter, and returns the ones past the limit', async () => {
  let polls = 0;
  const gone = await endTree(1, {
    kill: async () => [11, 12],
    settle: null,
    alive: (pid) => pid === 12 && ++polls < 3,
  });
  assert.deepEqual(gone, []);
  assert.equal(polls, 3, 'it kept asking until the last process was gone');
  const left = await endTree(1, { kill: async () => [13], alive: () => true, settle: null, waitMs: 20 });
  assert.deepEqual(left, [13]);
});

test('endTree uses the native identity-aware waiter before a killed PID can be mistaken for its replacement', async () => {
  const calls = [];
  const begun = Date.now();
  const gone = await endTree(11, {
    waitMs: 100,
    kill: async () => [11, 12],
    // PID 12 was immediately recycled by Windows. kill(pid, 0) cannot tell, so it remains alive.
    alive: () => true,
    settle: async (pids, left, since) => {
      calls.push(pids);
      assert.ok(left > 0 && left <= 100);
      assert.ok(since >= begun && since <= Date.now());
      return [];
    },
  });
  assert.deepEqual(gone, [], 'new processes with recycled PIDs must not consume the shutdown budget');
  assert.deepEqual(calls, [[11, 12]], 'the native waiter checks identity and process handles for every killed PID');
});

test('Windows endTree leaves a live replacement process alone after checking its creation time', {
  timeout: 15_000,
}, async () => {
  if (process.platform !== 'win32') return;
  let replacement;
  try {
    const gone = await endTree(1, {
      waitMs: 2000,
      kill: async () => {
        // The replacement is created after termination began, as happens when Windows reuses a killed PID.
        replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        await new Promise((resolve, reject) => replacement.once('spawn', resolve).once('error', reject));
        return [replacement.pid];
      },
    });
    assert.deepEqual(gone, []);
    assert.equal(replacement.exitCode, null, 'the unrelated replacement must still be running');
    process.kill(replacement.pid, 0);
  } finally {
    if (replacement?.pid) await endTree(replacement);
  }
});

// Lane P's cutscene GPU suite passed every check, then its close failed with SHUTDOWN_TIMEOUT: the host's waiter had
// reported an ended Chromium child as a survivor 677 ms after the end. The waiter took a start time it could not read
// for a process still running; the pid named no process of ours by then.
test('Windows waiter: an ended process gone before its start time was read is not a survivor', {
  timeout: 15_000,
}, async () => {
  if (process.platform !== 'win32') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const lookup = '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch [ArgumentException] { continue }';
  try {
    // The race made certain: the process is found, then ended, and its start time is read only once it is gone.
    const survivors = await waitSignaled([child.pid], 5000, Date.now() - 60_000, (file, args, options, callback) => {
      assert.ok(args[3].includes(lookup), 'the waiter still looks the process up first');
      const widened = args[3].replace(
        lookup,
        `${lookup}\n  Stop-Process -Id $id -Force; Start-Sleep -Milliseconds 1500`,
      );
      return execFile(file, [...args.slice(0, 3), widened], options, callback);
    });
    await exited;
    assert.deepEqual(survivors, [], 'a process the kernel has finished with is not still present');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('Windows waiter with kill: a child already terminating (Kill throws access denied) is not a survivor', {
  timeout: 15_000,
}, async () => {
  if (process.platform !== 'win32') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    // The 1-in-5 case made certain: Chromium has begun ending the child, so Kill fails as .NET's Process.Kill does
    // for a process that is terminating (Win32Exception, access denied).
    const survivors = await waitSignaled(
      [child.pid],
      5000,
      Date.now() + 60_000,
      (file, args, options, callback) => {
        assert.ok(args[3].includes('$p.Kill()'), 'kill ends the process through its handle');
        const terminating = args[3].replace(
          '$p.Kill()',
          'Stop-Process -Id $id -Force; throw (New-Object ComponentModel.Win32Exception 5)',
        );
        return execFile(file, [...args.slice(0, 3), terminating], options, callback);
      },
      { kill: true },
    );
    await exited;
    assert.deepEqual(survivors, [], 'an ending child is waited for, not reported because Kill could not end it again');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('Windows waiter with kill: every child is ended before the first wait', { timeout: 30_000 }, async () => {
  if (process.platform !== 'win32') return;
  // A killed Edge child's process object can stay unsignalled for the whole bound: a kill-then-wait loop left every
  // later child running that long. Each wait is held 1.5 s here; the children must still end together.
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }),
  );
  try {
    await Promise.all(
      children.map((c) => new Promise((resolve, reject) => c.once('spawn', resolve).once('error', reject))),
    );
    const ended = children.map((c) => new Promise((resolve) => c.once('exit', () => resolve(performance.now()))));
    const survivors = await waitSignaled(
      children.map((c) => c.pid),
      10_000,
      Date.now() + 60_000,
      (file, args, options, callback) => {
        const slow = args[3].replace(/^(\s*)\$left = /m, '$1Start-Sleep -Milliseconds 1500; $left = ');
        assert.notEqual(slow, args[3], 'the wait line is where the test expects it');
        return execFile(file, [...args.slice(0, 3), slow], options, callback);
      },
      { kill: true },
    );
    const [first, second] = await Promise.all(ended);
    assert.deepEqual(survivors, []);
    assert.ok(
      Math.abs(second - first) < 1000,
      `the second child ended ${Math.round(second - first)} ms after the first`,
    );
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill();
  }
});

test('Windows waiter with kill: a child Kill could not end that stays running is still a survivor', {
  timeout: 15_000,
}, async () => {
  if (process.platform !== 'win32') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  try {
    // Kill fails (access denied) and nothing else ends the child: the caught exception must not hide it.
    const survivors = await waitSignaled(
      [child.pid],
      800,
      Date.now() + 60_000,
      (file, args, options, callback) =>
        execFile(
          file,
          [...args.slice(0, 3), args[3].replace('$p.Kill()', 'throw (New-Object ComponentModel.Win32Exception 5)')],
          options,
          callback,
        ),
      { kill: true },
    );
    assert.deepEqual(survivors, [child.pid], 'WaitForExit still reports a child that did not end');
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
  }
});

test('Windows waiter: a pid held by a process this user cannot query is not reported as ours', {
  timeout: 15_000,
}, async () => {
  if (process.platform !== 'win32') return;
  // The System process (pid 4) stands in for a service that took an ended Chromium child's pid.
  const readable = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$null -ne [Diagnostics.Process]::GetProcessById(4).StartTime'],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();
  assert.equal(readable, 'False', 'the stand-in must be a process whose start time this user cannot read');
  assert.deepEqual(await waitSignaled([4], 2000, 0), []);
});

test('an own-tree kill that could not run has ended nothing known, so its root pid is still waited for', async () => {
  const run = (outcome) => (file, args, options, callback) => {
    assert.equal(file, 'powershell.exe');
    assert.ok(args[3].includes(`$owner = ${process.pid}; $root = 77`), 'the tree is walked from this process');
    callback(outcome.error ?? null, outcome.stdout ?? '');
  };
  assert.deepEqual(await killOwnTree(77, 1000, run({ stdout: '77\r\n78\r\n' })), [77, 78]);
  // Not below this process (it exited, or its pid is another process's now): nothing ended, nothing to wait for.
  assert.deepEqual(await killOwnTree(77, 1000, run({ stdout: '' })), []);
  // Did not start (a console that could not be created), ran out of time, or a WMI failure.
  for (const error of [
    { code: 3221225794 },
    { code: null, killed: true, signal: 'SIGTERM' },
    { code: 1 },
    { code: 'ENOENT' },
  ])
    assert.deepEqual(await killOwnTree(77, 1000, run({ error })), [77], JSON.stringify(error));
});

test('a server with a connected client is dropped and closed (the case that hung check:depth and check:no-webgpu)', async () => {
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).write(':\n\n'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: server.address().port }, (res) => {
      res.on('data', () => {});
      resolve(req);
    });
    req.on('error', () => {});
    req.end();
  });
  await closeAll({ browser: { close: async () => {} }, servers: [server], budgetMs: 5000 });
  assert.equal(server.listening, false);
  client.destroy();
});

test('owned close timeout names its stalled listing, termination or client step', { timeout: 3000 }, async () => {
  for (const hung of ['listing', 'termination', 'client']) {
    const release = Promise.withResolvers();
    const host = fakeHost({ ack: () => (hung === 'termination' ? release.promise : Promise.resolve()) });
    const browser = withBoundedClose(
      {
        newBrowserCDPSession: async () => ({
          send: () => (hung === 'listing' ? release.promise : Promise.resolve({ processInfo: [] })),
        }),
        close: () => (hung === 'client' ? release.promise : Promise.resolve()),
      },
      // A fake host's pids are not processes of this test: the kill at the limit is recorded, not run.
      { host, budgetMs: 50, kill: async () => [] },
    );
    const expected = {
      listing: /Chromium process listing/,
      termination: /Chromium process termination/,
      client: /Playwright client close/,
    };
    try {
      await assert.rejects(closeAll({ browser, budgetMs: 60 }), (error) => {
        assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
        assert.match(error.message, expected[hung]);
        assert.ok(error.open.some((name) => expected[hung].test(name)));
        return true;
      });
    } finally {
      release.resolve({ processInfo: [] });
    }
  }
});

// KB-P3h: nodes-browser (compat) printed its passing result beside two busy GPU suites and then did not exit for over
// 20 minutes. A hosted close past its budget threw SHUTDOWN_TIMEOUT but left the host and its browser running and the
// host's pipes referenced: a suite that went on after the error (scripts/visual-regression.js does) could never end, the
// host waiting for an end request and the suite for the host. Past the limit the close now kills both trees.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

test('the close limit and its kill fit inside the shared shutdown budget, so the coded error arrives first', () => {
  assert.ok(CLOSE_LIMIT_MS + CLOSE_KILL_MS < SHUTDOWN_BUDGET_MS);
  assert.equal(CLOSE_LIMIT_HELP, 'docs/limits.md#browser-close-limit');
  assert.match(
    readFileSync(new URL('docs/limits.md', root), 'utf8'),
    /^#+ Browser close limit\r?$/m,
    'the help link names a heading',
  );
});

test('a hosted close past its limit kills the host and the browser, releases the host, and fails with the coded error', {
  timeout: 5000,
}, async () => {
  const host = fakeHost({ ack: () => new Promise(() => {}) });
  const killed = [];
  const browser = withBoundedClose(
    {
      newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }) }),
      close: () => new Promise(() => {}),
    },
    { host, budgetMs: 100, killMs: 1234, kill: async (pids, waitMs) => (killed.push([pids, waitMs]), []) },
  );
  await assert.rejects(browser.close(), (error) => {
    assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
    assert.deepEqual(error.killed, [999, 10]);
    assert.deepEqual(error.survivors, []);
    assert.ok(
      error.open.some((name) => /Chromium process termination/.test(name)),
      error.open.join(', '),
    );
    assert.match(error.message, /passed its 100 ms limit/);
    assert.match(
      error.message,
      /killed browser host 999 and browser 10 with their process trees; see docs\/limits\.md#browser-close-limit$/,
    );
    return true;
  });
  assert.deepEqual(killed, [[[999, 10], 1234]]);
  assert.deepEqual(host.calls.at(-1), ['release']);
});

test('a kill that leaves a process running says which, and the close still fails coded', {
  timeout: 5000,
}, async () => {
  const host = fakeHost({ ack: () => new Promise(() => {}) });
  const browser = withBoundedClose(
    { close: () => new Promise(() => {}) },
    { host, budgetMs: 50, listMs: 10, killMs: 77, kill: async () => [10] },
  );
  await assert.rejects(browser.close(), (error) => {
    assert.equal(error.code, 'SHUTDOWN_TIMEOUT');
    assert.deepEqual(error.survivors, [10]);
    assert.match(error.message, /but 10 still ran 77 ms later/);
    return true;
  });
});

test('a normal hosted close and a hosted close that fails on its own never take the kill path', async () => {
  for (const [ack, expected] of [
    [async () => ({}), 'closed'],
    [() => Promise.reject(Object.assign(new Error('gone'), { code: 'HOST_GONE' })), 'HOST_GONE'],
  ]) {
    const host = fakeHost({ ack });
    let kills = 0;
    const browser = withBoundedClose(listingBrowser([]), { host, budgetMs: 2000, kill: async () => (kills++, []) });
    const outcome = await browser.close().then(
      () => 'closed',
      (error) => error.code,
    );
    assert.equal(outcome, expected);
    assert.equal(kills, 0);
    assert.deepEqual(host.calls.at(-1), ['release']);
  }
});

test('a real stuck close is killed at its limit: host and browser gone, and the suite exits on its own', {
  timeout: 90_000,
}, async () => {
  const suite = spawn(
    process.execPath,
    [fileURLToPath(new URL('fixtures/stuck-close-suite.mjs', import.meta.url)), '1000'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  let out = '';
  suite.stdout.on('data', (chunk) => (out += chunk));
  // The hang bound: a suite still running 45 s after its 1,000 ms limit is the bug; it is ended so the test reports it.
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => suite.once('exit', resolve)),
    new Promise((resolve) => (timer = setTimeout(resolve, 45_000, 'still running'))),
  ]);
  clearTimeout(timer);
  const [pids, outcome] = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (code === 'still running') await endTree(suite.pid, { waitMs: 10_000 });
  for (const pid of [pids?.host, pids?.browser]) if (pid && alive(pid)) await endTree(pid, { waitMs: 10_000 });
  assert.equal(code, 0, `the suite did not end after its close: ${out}`);
  assert.equal(outcome.code, 'SHUTDOWN_TIMEOUT');
  assert.deepEqual(outcome.killed, [pids.host, pids.browser]);
  assert.deepEqual(outcome.survivors, []);
  assert.match(outcome.message, /passed its 1000 ms limit/);
  assert.equal(alive(pids.host), false, 'the host is gone');
  assert.equal(alive(pids.browser), false, 'the browser under it is gone');
});
