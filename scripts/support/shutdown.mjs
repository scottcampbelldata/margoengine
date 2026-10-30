// Tears down a browser suite in the one order that cannot hang (bug 30). `httpServer.close(callback)` calls back only
// once every connection is gone, and a browser keeps keep-alive and half-closed connections to the servers it loaded
// from; closing the server first, with the browser still open, never called back and the suite (every assertion
// passed) was killed after 600 s. So: browser context, then browser, then the servers' connections, then the servers,
// then the child processes' whole trees, all inside one budget that names what was still open when it ran out.
import { spawnSync } from 'node:child_process';

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
