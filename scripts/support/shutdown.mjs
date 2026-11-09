// Tears down a browser suite in the one order that cannot hang (bug 30). `httpServer.close(callback)` calls back only
// once every connection is gone, and a browser keeps keep-alive and half-closed connections to the servers it loaded
// from; closing the server first, with the browser still open, never called back and the suite (every assertion
// passed) was killed after 600 s. So: browser context, then browser, then the servers' connections, then the servers,
// then the child processes' whole trees, all inside one budget that names what was still open when it ran out.
import { execFile, spawnSync } from 'node:child_process';

/** How long `closeAll` may take in all before it throws. */
export const SHUTDOWN_BUDGET_MS = 30_000;

/** An `http.Server`, a Vite dev or preview server (its `httpServer`), or anything with `close()`. */
function httpServerOf(server) {
  return typeof server?.closeAllConnections === 'function' ? server : server?.httpServer;
}

/** Kills `child` and everything it started (`taskkill /T /F` on Windows, where `kill()` leaves the tree), then releases its pipes. */
export async function killTree(child) {
  if (!child) return;
  const running = child.exitCode === null && child.signalCode === null;
  if (running && child.pid) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  if (running && child.exitCode === null && child.signalCode === null)
    await new Promise((resolve) => child.once('exit', resolve));
}

/**
 * Whether `pid` is still running. On Windows this reads the exit code (libuv's `kill(pid, 0)` answers "gone" once the
 * exit code is set), and the exit code is set before the process has closed its handles: a folder it sat in or a file
 * it wrote can still be held then. `waitSignaled` waits for the handles.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The processes `taskkill /T` says it ended, from its lines `SUCCESS: The process with PID 12 (child process of PID 3) ...`. */
export function taskkillPids(output) {
  return [...output.matchAll(/^\S.*?PID (\d+)/gm)].map((match) => Number(match[1]));
}

/**
 * Windows: waits until each of `pids` has finished exiting, its handles closed (its process object signalled), and
 * resolves to the ones still running when `waitMs` ran out. A pid that is gone, or that a newer process took after
 * `sinceMs` (epoch ms), is not waited for. Node has no call that waits on a process it did not start, so .NET's
 * `Process.WaitForExit` does, from one Windows PowerShell for all the pids.
 * @param {number[]} pids
 * @param {number} waitMs
 * @param {number} sinceMs
 * @returns {Promise<number[]>}
 */
export function waitSignaled(pids, waitMs, sinceMs) {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!ids.length) return Promise.resolve([]);
  if (!(waitMs > 0)) return Promise.resolve(ids);
  const script = [
    `$end = [DateTime]::UtcNow.AddMilliseconds(${Math.round(waitMs)})`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(sinceMs)}).UtcDateTime`,
    `foreach ($id in @(${ids.join(',')})) {`,
    '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch { continue }',
    '  try { if ($p.StartTime.ToUniversalTime() -gt $since) { continue } } catch {}',
    '  $left = [int][Math]::Max(0, ($end - [DateTime]::UtcNow).TotalMilliseconds)',
    '  if (-not $p.WaitForExit($left)) { $id }',
    '}',
  ].join('\n');
  return new Promise((resolve) => {
    // A PowerShell that did not answer in time says nothing about the pids, so all of them count as still running.
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: waitMs + 10_000, windowsHide: true },
      (error, stdout) =>
        resolve(error?.killed ? ids : [...String(stdout).matchAll(/\d+/g)].map((match) => Number(match[0]))),
    );
  });
}

/**
 * Ends `pid` and its tree with `taskkill /T /F` and resolves to the pids it ended. Exit code 128 only says a process had
 * already ended, so the lines say what happened, not the code. A taskkill that could not run (it did not start, ran out
 * of time, or failed with no process ended: it reads the process table through WMI, which a loaded PC can fail) has
 * ended nothing known, so it resolves to `[pid]`: the caller then waits for that process and reports it if it still
 * runs, instead of taking "no lines" for "nothing left".
 * @param {number} pid
 * @param {number} timeout
 * @param {typeof execFile} [run]
 * @returns {Promise<number[]>}
 */
export function taskkillTree(pid, timeout, run = execFile) {
  return new Promise((resolve) => {
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout, windowsHide: true }, (error, stdout) => {
      const ended = taskkillPids(String(stdout ?? ''));
      resolve(error && error.code !== 128 && !ended.length ? [pid] : ended);
    });
  });
}

/**
 * Ends `pid` and everything it started, and resolves when none of them runs any more and, on Windows, each has closed
 * its handles (`settle`, default `waitSignaled`), so the folders and files they held can be removed. Never waits past
 * `waitMs` (plus PowerShell's start on Windows): it resolves to the pids still running then, normally none.
 * @param {number} pid
 * @param {{ waitMs?: number, kill?: (pid: number, timeout: number) => Promise<number[]>, alive?: (pid: number) => boolean, settle?: (pids: number[], waitMs: number, sinceMs: number) => Promise<number[]> }} [options]
 * @returns {Promise<number[]>}
 */
export async function endTree(
  pid,
  {
    waitMs = SHUTDOWN_BUDGET_MS,
    kill,
    alive = isAlive,
    settle = process.platform === 'win32' ? waitSignaled : null,
  } = {},
) {
  if (!pid) return [];
  const begun = Date.now();
  let pids;
  if (kill) pids = await kill(pid, waitMs);
  else if (process.platform === 'win32') pids = await taskkillTree(pid, waitMs);
  else {
    pids = [pid];
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  const killed = pids;
  // Windows PIDs can be reused before taskkill returns. kill(pid, 0) then sees the replacement,
  // so polling it before the identity-aware handle wait can spend the whole budget on an unrelated
  // process. The native waiter already waits for exit and checks StartTime: let it own that wait.
  if (settle) return settle(killed, begun + waitMs - Date.now(), begun);
  for (;;) {
    pids = pids.filter(alive);
    // wall-clock: a bound on the wait for processes already killed, far from normal.
    if (pids.length && Date.now() - begun > waitMs) return pids;
    if (!pids.length) return [];
    // fixed-wait: polling the process table, which has no event to wait on.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Call after a suite's last step: a process still alive `ms` later holds something it never closed, and would sit
 * silent until the runner kills it ("no result after 600 s"). It then prints the kinds of resource still open
 * (`process.getActiveResourcesInfo()`: TCPServerWrap a server, ProcessWrap a child process, PipeWrap a pipe, Timeout a
 * timer) and exits 1. The timer does not hold the process itself, so a suite that ends cleanly never waits for it.
 */
export function watchExit(ms = SHUTDOWN_BUDGET_MS, { exit = process.exit, report = console.error } = {}) {
  setTimeout(() => {
    const open = process.getActiveResourcesInfo();
    report(
      `the suite finished but did not exit within ${ms} ms; still open: ${open.join(', ') || 'nothing Node can name (a native handle)'}. Close it before the suite ends`,
    );
    exit(1);
  }, ms).unref();
}

/**
 * Runs a suite's checks, then its teardown, on every path. A failed check stays the error the suite exits with: a
 * teardown that fails after it (a bounded close that ran out, say) is printed beside it, never in its place, so an
 * assertion is not reported as a shutdown error. With every check passed, a failed teardown is the error. Node exits
 * at once (code 1) on the throw, whatever is still open, so a failed suite never sits until the runner kills it.
 * @template T
 * @param {() => Promise<T>} checks
 * @param {() => Promise<unknown>} teardown
 * @returns {Promise<T>}
 */
export async function runSuite(checks, teardown, { report = console.error } = {}) {
  let result;
  try {
    result = await checks();
  } catch (error) {
    try {
      await teardown();
    } catch (closeError) {
      report(`the suite failed (its error follows), and its teardown failed too: ${closeError.message}`);
    }
    throw error;
  }
  await teardown();
  return result;
}

/** Drops every connection of an http server and waits for it to stop listening. */
async function closeServer(server) {
  const http = httpServerOf(server);
  if (!http) {
    await server?.close?.();
    return;
  }
  // A Vite server closes its http server itself (and removes its cache folder and watchers); closing the http server
  // here as well made the second close throw ERR_SERVER_NOT_RUNNING. So a wrapper is told to close once, after its
  // connections are dropped, and a bare http server is closed here.
  const stopped = new Promise((resolve, reject) => {
    if (server !== http) Promise.resolve(server.close()).then(resolve, reject);
    else if (http.listening) http.close(() => resolve());
    else resolve();
  });
  http.closeIdleConnections?.();
  http.closeAllConnections?.();
  await stopped;
}

/**
 * Shuts a suite down. Every step runs even when an earlier one fails; the first failure is thrown at the end.
 * Throws an error with `code: 'SHUTDOWN_TIMEOUT'` naming each resource still open when `budgetMs` ran out.
 * @param {{ context?: { close(): Promise<unknown> }, browser?: { close(): Promise<unknown> }, servers?: unknown[], children?: import('node:child_process').ChildProcess[], budgetMs?: number }} resources
 */
export async function closeAll({ context, browser, servers = [], children = [], budgetMs = SHUTDOWN_BUDGET_MS } = {}) {
  const open = new Set();
  const failures = [];
  const step = async (name, run) => {
    open.add(name);
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
    open.delete(name);
  };
  const work = (async () => {
    if (context) await step('browser context', () => context.close());
    if (browser) await step('browser', () => browser.close());
    await Promise.all([
      ...children.map((child, i) => step(`child process ${child?.pid ?? i}`, () => killTree(child))),
      ...servers.map((server, i) => {
        const port = httpServerOf(server)?.address?.()?.port;
        return step(`server ${port ?? i}`, () => closeServer(server));
      }),
    ]);
  })();
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve('late'), budgetMs)));
  const outcome = await Promise.race([work.then(() => 'done'), late]);
  clearTimeout(timer);
  if (outcome === 'late') {
    const error = new Error(
      `shutdown did not finish within ${budgetMs} ms; still open: ${[...open].join(', ')}. Find what holds it (netstat -ano, tasklist) and close it before the suite ends`,
      { cause: failures[0] },
    );
    error.code = 'SHUTDOWN_TIMEOUT';
    error.open = [...open];
    throw error;
  }
  if (failures.length) throw failures[0];
}
