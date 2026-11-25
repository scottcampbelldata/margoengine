// The browser host: a process of its own that owns Playwright's browser server, so a suite never waits on the kernel's
// teardown of a browser process it has ended.
//
// Why. After `TerminateProcess` the browser's exit code is set within about 60 ms, but Windows signals its process
// object only once the kernel has torn the process down (handle table, address space, the GPU driver's share of both).
// Measured on the workstation (RTX A6000, Windows 11, Edge): 65 ms to 1.2 s beside the batches, 8.7 s beside `verify`, over
// 30 s in the failure that blocked batches 160, 171 and 234. Nothing in Margo runs during that time, and nothing can
// shorten it. Everything of Playwright's that waits on that signal (the process handle, the stdio and CDP pipes, the
// WebSocket server and the temporary profile removal) lives here, in this process. The suite ends the browser through
// this host, gets an acknowledgement as soon as every process has been told to end (milliseconds), disconnects, and
// moves on; this host then waits for the kernel with time of its own, finishes Playwright's cleanup and ends. A
// process still present after `REAP_MS` is logged as a survivor (`HOST_LOG`, in the suite's working directory).
//
// Protocol (one JSON object per line). Host to suite: `{"ready":true,"wsEndpoint":...,"pid":<browser pid>}` or
// `{"error":<message>}` once; `{"terminated":{"browser":pid,"children":[...]}}` after an end request; then
// `{"done":true,"survivors":[...],"elapsedMs":n}`. Suite to host: `{"end":true,"children":[pids]|null,"listedAt":ms}` (`listedAt`: the wall clock
// when the children were listed); the end of
// the host's stdin (the suite is gone) counts as an end request with no listed children.
//
// CLI: node scripts/support/browser-host.mjs <launch settings as JSON>
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endTree, waitSignaled } from './shutdown.mjs';

/** How long the host waits for the kernel to finish with an ended browser before it logs it as a survivor and ends. */
export const REAP_MS = 120_000;

/** Where the host records a process that was still present after `REAP_MS`, relative to the suite's working directory. */
export const HOST_LOG = 'test-results/browser-host-survivors.log';

/** Whether `pid` still answers (Windows: its exit code is not set yet). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Resolves to the pids of `pids` still running after `waitMs` (poll; the platforms without a native waiter). */
async function pollGone(pids, waitMs) {
  const begun = Date.now();
  let left = pids;
  while ((left = left.filter(alive)).length && Date.now() - begun < waitMs)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return left;
}

/**
 * Ends the browser `server` owns: the browser process through the handle this process holds, each of `children` by pid
 * (Chromium's own list, read by the suite over CDP before it disconnected; `null` when it could not be read, which
 * falls back to `end`, the whole tree by helper program), then its pipes. Resolves once every process has been told
 * to end, with the waits as `settled`: the native wait for the browser's exit and the children's handles, bounded by
 * `reapMs`, then the server's own cleanup (its WebSocket server and temporary profile). `settled` resolves to the pids
 * still present at the bound.
 */
export function endOwned(
  server,
  children,
  {
    reapMs = REAP_MS,
    end = endTree,
    settle = process.platform === 'win32' ? waitSignaled : pollGone,
    endListed = process.platform === 'win32'
      ? (pids, waitMs, sinceMs) => waitSignaled(pids, waitMs, sinceMs, undefined, { kill: true })
      : null,
    listedAt,
    log = console.error,
  } = {},
) {
  // The wall clock start goes to `settle`, which compares it with process start times; the bound itself is measured on
  // the monotonic clock (KB-BH-REAP1).
  const begun = Date.now();
  // A listed child is ours only if it started no later than the listing (the suite's `listedAt`, else this request).
  const since = Number.isFinite(listedAt) && listedAt <= begun ? listedAt : begun;
  const started = performance.now();
  const child = server.process?.();
  const pid = child?.pid;
  const running = child && child.exitCode === null && child.signalCode === null;
  const exited = running ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
  let fallback = null;
  const killHandle = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let refused;
    const onError = (error) => (refused = error);
    child.once('error', onError);
    try {
      child.kill('SIGKILL');
    } finally {
      child.removeListener('error', onError);
    }
    if (refused) log(`browser host: the browser process ${pid} refused to end: ${refused.message}`);
  };
  // With no list from Chromium the tree is ended by pid (`end`, taskkill /T through killChildTreeSync on Windows), so the browser must still run
  // while that runs: Windows reuses a pid once no handle to its process is left, and Node closes the handle it holds
  // once the exit is seen. Killed first, the browser's pid was free while taskkill (which reads the process table
  // through WMI, seconds on a loaded PC) still ran, and the next suite's browser host, or any process that took the pid
  // or had it as parent, was ended with it (KB-HOST-COMPATEXIT1). The handle kill follows the tree's end.
  const byTree = children === null && pid && running;
  if (running && !byTree) killHandle();
  const listed = (children ?? []).filter((other) => Number.isInteger(other) && other > 0 && other !== pid);
  // Windows reuses a pid once its process is gone: a child that exited after Chromium listed it may have left its pid
  // to an unrelated process. `endListed` ends each listed pid only through a handle to a process that started no later
  // than the listing, and waits for it. Without it (POSIX, where pids are not reused that soon) they are signalled here.
  for (const other of endListed ? [] : listed) {
    try {
      process.kill(other, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') log(`browser host: process ${other} refused to end: ${error.message}`);
    }
  }
  // Playwright's own transport sees its pipes close at once; the kernel cancels the reads either way. Chromium ends
  // itself when its pipe closes, so with a tree to end by pid the pipes close only after that, like the handle kill.
  const closePipes = () => {
    for (const pipe of child?.stdio ?? []) pipe?.destroy();
  };
  if (byTree)
    fallback = Promise.resolve(end(child, { waitMs: reapMs })).finally(() => {
      killHandle();
      closePipes();
    });
  else {
    // The tree of a browser that had already exited is not ended by pid: that pid may be another process by now.
    if (children === null && pid)
      log(`browser host: the browser process ${pid} had exited; its tree is not ended by pid`);
    closePipes();
  }
  const settled = (async () => {
    let timer;
    // A timer is whole milliseconds and may fire before `reapMs` has passed on the monotonic clock: it is re-armed for
    // the time still left, so the bound never resolves early (KB-BH-REAP1).
    const late = new Promise((resolve) => {
      const arm = (waitMs) =>
        (timer = setTimeout(() => {
          const left = reapMs - (performance.now() - started);
          if (left > 0) arm(Math.ceil(left));
          else resolve('late');
        }, waitMs));
      arm(reapMs);
    });
    // One bound for all of them, waited for side by side: the browser's exit, the listed children's handles, the tree.
    const [browserGone, children, tree] = await Promise.all([
      Promise.race([exited.then(() => 'gone'), late]),
      listed.length ? (endListed ?? settle)(listed, reapMs, since) : [],
      fallback ?? [],
    ]);
    const survivors = [...(browserGone === 'late' ? [pid] : []), ...children, ...tree];
    // The server's cleanup waits for the browser's exit itself; it is only asked for once that exit has arrived.
    if (browserGone === 'gone') await Promise.race([server.kill(), late]);
    clearTimeout(timer);
    return survivors;
  })();
  return { pid, listed, settled };
}

/**
 * Runs the host: launches the server, reports its endpoint on `output`, ends the browser on the first end request from
 * `input` (or when `input` ends), reports the acknowledgement and the result, and resolves to the exit code (0, or 3
 * when a process survived the bound, which `logFile` records).
 */
export async function hostBrowser({
  settings,
  launchServer,
  input = process.stdin,
  output = process.stdout,
  log = console.error,
  reapMs = REAP_MS,
  logFile = HOST_LOG,
  end,
  settle,
  endListed,
} = {}) {
  // The suite may be gone by the time the result is ready: a closed pipe is not an error here.
  output.on?.('error', () => {});
  const say = (message) => new Promise((resolve) => output.write(`${JSON.stringify(message)}\n`, () => resolve()));
  let server;
  try {
    server = await launchServer(settings);
  } catch (error) {
    await say({ error: String(error?.message ?? error) });
    return 1;
  }
  const pid = server.process?.()?.pid ?? null;
  await say({ ready: true, wsEndpoint: server.wsEndpoint(), pid });
  const lines = createInterface({ input });
  const request = await new Promise((resolve) => {
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.end) resolve({ children: Array.isArray(message.children) ? message.children : null });
    });
    lines.once('close', () => resolve({ children: null }));
    input.once?.('error', () => resolve({ children: null }));
  });
  // Nothing more is read: the input is let go, so it does not hold this process open (KB-OWN-EXIT2).
  lines.close();
  const begun = Date.now();
  const { listed, settled } = endOwned(server, request.children, {
    reapMs,
    end,
    settle,
    log,
    listedAt: request.listedAt,
    ...(endListed === undefined ? {} : { endListed }),
  });
  await say({ terminated: { browser: pid, children: listed } });
  const survivors = await settled;
  const elapsedMs = Date.now() - begun;
  if (survivors.length) {
    const line = `${new Date().toISOString()} host ${process.pid}: still present ${elapsedMs} ms after they were ended: ${survivors.join(', ')} (browser ${pid}; listed ${listed.join(', ') || 'none'})\n`;
    try {
      await mkdir(dirname(logFile), { recursive: true });
      await appendFile(logFile, line);
    } catch (error) {
      log(`browser host: cannot write ${logFile}: ${error.message}`);
    }
    log(`browser host: ${line.trim()}`);
  }
  await say({ done: true, survivors, elapsedMs });
  return survivors.length ? 3 : 0;
}

/** The host's own path, for the suite's spawn. */
export const HOST_PATH = fileURLToPath(import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('@playwright/test');
  const settings = JSON.parse(process.argv[2] ?? '{}');
  const child = { current: null };
  const launchServer = async (options) => {
    const server = await chromium.launchServer(options);
    child.current = server.process?.();
    if (child.current && process.env.MARGO_TRACE_SHUTDOWN === '1') {
      const record = (event) =>
        console.error(
          `[chromium] ${JSON.stringify({
            at: new Date().toISOString(),
            pid: child.current.pid,
            event,
            exitCode: child.current.exitCode,
            signalCode: child.current.signalCode,
            pipes: child.current.stdio?.map(
              (pipe) =>
                pipe && {
                  destroyed: pipe.destroyed,
                  closed: pipe.closed,
                  readable: pipe.readable,
                  writable: pipe.writable,
                },
            ),
          })}`,
        );
      child.current.once('exit', () => record('exit'));
      child.current.once('close', () => record('close'));
      child.current.stdio?.forEach((pipe, i) => pipe?.once('close', () => record(`pipe ${i} close`)));
      record('launch');
    }
    return server;
  };
  process.exitCode = await hostBrowser({ settings, launchServer });
  // Nothing of the browser's is waited for past the result: the process handle is unreferenced, so a browser the
  // kernel is still tearing down cannot hold this host open either.
  child.current?.unref();
  // With a survivor, Playwright's server (its WebSocket listener) was never asked to clean up, because that waits on
  // the browser's exit; otherwise everything is closed and the host ends by its event loop.
  if (process.exitCode === 3) process.exit(3); // process.exit: a survivor's Playwright server cannot be closed
}
