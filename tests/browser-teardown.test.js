// Bug 70: `check:depth` and `check:no-webgpu` passed every assertion and then never exited; the audit had to kill them.
// Bug 30 had fixed the same hang for one suite (scripts/support/shutdown.mjs: browser first, then the servers'
// connections, one bounded budget). This applies it to every script that opens a browser, and fails the build for a
// script that does not: a script that starts a browser and a server of its own must tear both down with `closeAll`, and
// the shared launchers (`launchBrowser`, `openBrowser`, `startDevServer`) bound their own closes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { launchBrowser, stopOwned, withBoundedClose } from '../scripts/lib/browser.mjs';
import { closeAll, endTree, runSuite, taskkillPids, taskkillTree, waitSignaled } from '../scripts/support/shutdown.mjs';

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

test('owned Chromium cleanup releases a client waiting after native process termination', async () => {
  let release;
  const cleanup = new Promise((resolve) => (release = resolve));
  const calls = [];
  const browser = withBoundedClose({ close: async () => { calls.push('client'); await cleanup; } }, {
    server: { kill: async () => { calls.push('owner'); release(); } },
    end: () => assert.fail('external termination cannot settle the driver cleanup'),
  });
  try {
    await closeAll({ browser, budgetMs: 500 });
    assert.deepEqual(calls, ['owner', 'client']);
  } finally {
    // A regression must release its fake client too, so its own 30-second close does not hold the test open.
    release();
  }
});

test('owned Chromium terminates asynchronously before invoking the driver kill API', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const calls = [];
  const browser = withBoundedClose({ close: async () => calls.push('client') }, {
    platform: 'win32',
    server: {
      process: () => child,
      kill: async () => {
        assert.equal(child.exitCode, 1, 'driver kill would synchronously taskkill a running process');
        calls.push('owner');
      },
    },
    stop: (stopped) => {
      assert.equal(stopped, child);
      calls.push('terminate');
      setImmediate(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
    },
    end: () => assert.fail('an owned browser is ended through its own handle, never a helper program'),
  });
  await browser.close();
  assert.ok(calls.indexOf('terminate') < calls.indexOf('owner'));
  assert.equal(calls.filter((call) => call === 'client').length, 1);
});

test('a pending owned process termination keeps the shutdown timer runnable', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  let killed = false, disconnected = false;
  // The process is told to end but has not finished exiting (its handle is not signalled yet).
  const closing = withBoundedClose({ close: async () => { disconnected = true; } }, {
    platform: 'win32',
    server: { process: () => child, kill: async () => { killed = true; } },
    stop: () => {},
  }).close();
  try {
    await assert.rejects(closeAll({ browser: { close: () => closing }, budgetMs: 50 }), { code: 'SHUTDOWN_TIMEOUT' });
    assert.equal(disconnected, true);
    assert.equal(killed, false, 'the blocking driver kill must not run while the native process is alive');
  } finally {
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await closing;
  }
});

test('owned Chromium releases stdout, stderr and CDP pipes and observes close before driver kill', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  let processClosed = false;
  child.on('close', () => { processClosed = true; });
  const pipes = Array.from({ length: 4 }, () => ({
    closed: false,
    destroy() {
      this.closed = true;
      if (pipes.every((pipe) => pipe.closed) && !processClosed) child.emit('close', 1, null);
    },
  }));
  child.stdio = [null, ...pipes];
  let kills = 0;
  const browser = withBoundedClose({ close: async () => {} }, {
    platform: 'win32',
    server: {
      process: () => child,
      kill: async () => {
        assert.equal(processClosed, true, 'exit alone leaves the driver in its synchronous taskkill path');
        assert.ok(pipes.every((pipe) => pipe.closed), 'every owned pipe, including CDP, must be released');
        kills++;
      },
    },
    stop: () => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
    },
  });
  try {
    await browser.close();
    assert.equal(kills, 1);
  } finally {
    for (const pipe of pipes) pipe.destroy();
  }
});

// The SHUTDOWN_TIMEOUT that blocked five lanes on 2026-11-09 ("still open: browser" after every check passed): the owned
// browser was ended by helper programs started at close time (taskkill.exe, which reads the process table through WMI,
// then a PowerShell handle wait). On this PC those failed or stalled under load and around GPU driver resets; a helper
// that could not run reported no process ended, which read as "all gone", so nothing ended the browser and the close
// waited out the 30,000 ms budget on its exit. Here the helpers report nothing, as they did then.
const helpersCannotRun = async () => [];

test('owned Chromium on Windows is ended through its own process handle, so a helper that cannot run cannot leave it running', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  const browser = withBoundedClose({ close: async () => {} }, {
    platform: 'win32',
    server: { process: () => child, kill: async () => assert.equal(child.signalCode, 'SIGKILL') },
    end: helpersCannotRun,
  });
  await closeAll({ browser, budgetMs: 2000 });
  assert.deepEqual(signals, ['SIGKILL']);
});

test('a real owned process is ended and closed within the budget while the helper programs cannot run', { timeout: 30_000 }, async () => {
  // Like Chromium under Playwright: piped stdio plus two extra pipes (the CDP pair), and a process that would run forever.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  let driverKills = 0;
  const browser = withBoundedClose({ close: async () => {} }, {
    platform: 'win32',
    server: {
      process: () => child,
      kill: async () => {
        assert.equal(child.signalCode, 'SIGKILL', 'the driver kill runs only once the process has closed');
        driverKills++;
      },
    },
    end: helpersCannotRun,
  });
  try {
    await closeAll({ browser, budgetMs: 10_000 });
    assert.equal(driverKills, 1);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('stopOwned ends the browser through its handle and every process Chromium lists, with no helper program', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null });
  child.kill = (signal) => (child.signalCode = signal);
  const browser = {
    newBrowserCDPSession: async () => ({
      send: async (method) => {
        assert.equal(method, 'SystemInfo.getProcessInfo');
        return { processInfo: [{ id: 10, type: 'browser' }, { id: 11, type: 'GPU' }, { id: 12, type: 'utility' }] };
      },
    }),
  };
  const live = new Set([11, 12]);
  let polls = 0;
  await stopOwned(child, browser, {
    end: () => assert.fail('a browser that lists its processes needs no helper program'),
    kill: (pid) => setTimeout(() => live.delete(pid), 20),
    alive: (pid) => (polls++, live.has(pid)),
  });
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(live.size, 0, 'it returns only once the listed children have exited');
  assert.ok(polls > 2);
});

test('owned Chromium lists its processes before client close can disconnect the listing', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null });
  let disconnected = false, lists = 0;
  const calls = [];
  child.kill = (signal) => {
    calls.push('native');
    child.signalCode = signal;
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  const browser = withBoundedClose({
    newBrowserCDPSession: async () => ({
      send: async () => {
        lists++;
        await new Promise((resolve) => setImmediate(resolve));
        if (disconnected) throw new Error('client disconnected the process-list session');
        calls.push('listed');
        return { processInfo: [{ id: 10, type: 'browser' }] };
      },
    }),
    close: async () => { disconnected = true; calls.push('client'); },
  }, {
    platform: 'win32',
    server: { process: () => child, kill: async () => calls.push('driver') },
    end: () => assert.fail('a healthy process-list session must not race into helper fallback'),
  });
  try {
    await closeAll({ browser, budgetMs: 500 });
    assert.equal(lists, 1);
    assert.ok(calls.indexOf('listed') < calls.indexOf('client'));
    assert.ok(calls.indexOf('native') < calls.indexOf('driver'));
    assert.equal(disconnected, true);
  } finally {
    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');
  }
});

test('stopOwned falls back to the helper route only when Chromium does not list its processes, and still ends the browser', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null });
  child.kill = (signal) => (child.signalCode = signal);
  const ended = [];
  await stopOwned(child, { newBrowserCDPSession: () => new Promise(() => {}) }, {
    listMs: 20,
    end: async (pid) => (ended.push(pid), []),
  });
  assert.deepEqual(ended, [10]);
  assert.equal(child.signalCode, 'SIGKILL', 'a helper that ended nothing still leaves no browser running');
  child.signalCode = null;
  await assert.rejects(stopOwned(child, {}, { end: async () => [10, 11] }), { code: 'SHUTDOWN_TIMEOUT' });
});

test('an owned process that refuses to be ended fails the close with that error', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  child.kill = () => {
    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    return false;
  };
  let driverKills = 0;
  const browser = withBoundedClose({ close: async () => {} }, {
    platform: 'win32',
    server: { process: () => child, kill: async () => driverKills++ },
    end: helpersCannotRun,
  });
  await assert.rejects(closeAll({ browser, budgetMs: 2000 }), { code: 'EPERM' });
  assert.equal(driverKills, 0, 'the synchronous driver kill must not run on a process still alive');
  assert.equal(child.listenerCount('error'), 0, 'no listener is left behind');
});

test('owned Chromium outside Windows retains native driver termination', async () => {
  let killed = false;
  await withBoundedClose({ close: async () => {} }, {
    platform: 'linux',
    server: {
      process: () => ({ pid: 123, exitCode: null, signalCode: null }),
      kill: async () => { killed = true; },
    },
    end: () => assert.fail('the Windows workaround must not change POSIX process groups'),
  }).close();
  assert.equal(killed, true);
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

test('Windows endTree leaves a live replacement process alone after checking its creation time', { timeout: 15_000 }, async () => {
  if (process.platform !== 'win32') return;
  let replacement;
  try {
    const gone = await endTree(1, {
      waitMs: 2000,
      kill: async () => {
        // The replacement is created after termination began, as happens when Windows reuses a killed PID.
        replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore', windowsHide: true,
        });
        await new Promise((resolve, reject) => replacement.once('spawn', resolve).once('error', reject));
        return [replacement.pid];
      },
    });
    assert.deepEqual(gone, []);
    assert.equal(replacement.exitCode, null, 'the unrelated replacement must still be running');
    process.kill(replacement.pid, 0);
  } finally {
    if (replacement?.pid) await endTree(replacement.pid);
  }
});

test('the pids come from taskkill lines, never the parent it names', () => {
  assert.deepEqual(
    taskkillPids(
      'SUCCESS: The process with PID 95380 (child process of PID 55468) has been terminated.\r\nSUCCESS: The process with PID 55468 (child process of PID 102216) has been terminated.\r\n',
    ),
    [95380, 55468],
  );
  assert.deepEqual(taskkillPids(''), []);
});

test('a taskkill that could not run has ended nothing known, so its root pid is still waited for', async () => {
  const run = (outcome) => (file, args, options, callback) => {
    assert.equal(file, 'taskkill');
    assert.deepEqual(args, ['/PID', '77', '/T', '/F']);
    callback(outcome.error ?? null, outcome.stdout ?? '');
  };
  const success = 'SUCCESS: The process with PID 78 (child process of PID 77) has been terminated.\r\nSUCCESS: The process with PID 77 (child process of PID 5) has been terminated.\r\n';
  assert.deepEqual(await taskkillTree(77, 1000, run({ stdout: success })), [78, 77]);
  // Exit code 128: the process had already ended. Nothing to wait for.
  assert.deepEqual(await taskkillTree(77, 1000, run({ error: { code: 128 } })), []);
  // Did not start (a console that could not be created), ran out of time, or a WMI failure with no process ended.
  for (const error of [{ code: 3221225794 }, { code: null, killed: true, signal: 'SIGTERM' }, { code: 1 }, { code: 'ENOENT' }])
    assert.deepEqual(await taskkillTree(77, 1000, run({ error })), [77], JSON.stringify(error));
  // Partly done: the lines still say what was ended.
  assert.deepEqual(await taskkillTree(77, 1000, run({ error: { code: 1 }, stdout: success })), [78, 77]);
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
