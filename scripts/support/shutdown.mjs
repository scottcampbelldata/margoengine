// Tears down a browser suite in the one order that cannot hang (bug 30). `httpServer.close(callback)` calls back only
// once every connection is gone, and a browser keeps keep-alive and half-closed connections to the servers it loaded
// from; closing the server first, with the browser still open, never called back and the suite (every assertion
// passed) was killed after 600 s. So: browser context, then browser, then the servers' connections, then the servers,
// then the child processes' whole trees, all inside one budget that names what was still open when it ran out.
import { execFile, spawnSync } from 'node:child_process';

/** How long `closeAll` may take in all before it throws. */
export const SHUTDOWN_BUDGET_MS = 30_000;

/** Pending nested teardown steps, shared by a resource and wrappers that own its shutdown. */
export const SHUTDOWN_STEPS = Symbol('shutdown steps');

/** Opt-in phase timestamps for teardown diagnosis; errors still propagate to the owning close. */
export function traceShutdown(name, run, report = process.env.MARGO_TRACE_SHUTDOWN === '1' ? console.error : null) {
  if (!report) return run();
  const begun = Date.now();
  const emit = (outcome) =>
    report?.(
      `[shutdown] ${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, name, outcome, elapsedMs: Date.now() - begun })}`,
    );
  emit('start');
  return (async () => {
    try {
      const result = await run();
      emit('done');
      return result;
    } catch (error) {
      emit(`error: ${String(error?.message ?? error)}`);
      throw error;
    }
  })();
}

/** An `http.Server`, a Vite dev or preview server (its `httpServer`), or anything with `close()`. */
function httpServerOf(server) {
  return typeof server?.closeAllConnections === 'function' ? server : server?.httpServer;
}

/**
 * How Margo's scripts end a process tree by a bare pid on Windows (KB-TEST-FILEEXIT1); a child process whose handle this
 * process holds goes the fast way, {@link killChildTreeSync}. A pid names a process only while
 * it runs: once it has exited and the last handle to it is closed, Windows gives the number to a new process (about a
 * minute later on the workstation, beside the lanes' test runs), and `ParentProcessId` keeps naming a parent that has
 * exited, or the newer process that took its pid. `taskkill /T /F <pid>` trusts both, so a kill sent after the exit, or
 * a tree walked through a reused parent, ended whatever held the number then: a `node --test` file of another run, which
 * its runner reports as 'test failed' with nothing on stderr.
 *
 * This script ends `root` and its tree only if `root` is in the tree of `owner` (this process, which runs while the
 * script runs), walked from the process table with each child created no earlier than its parent (Microsoft's rule for
 * a reused `ParentProcessId`), and each process is ended through a handle opened by pid and checked against the creation
 * time the table gave, so a pid reused between the listing and the kill is left alone. `root` equal to `owner` ends
 * everything below this process but not this process. It prints the pids it ended, parents first. A root that is not
 * ours (it exited, or its pid is another process's now) ends nothing. With `waitMs` it then waits on each handle for up
 * to that long, so the folders and files they held are free, and exits 3 if one still runs.
 */
export const OWN_TREE_SCRIPT = (owner, root, waitMs = 0) =>
  [
    "$ErrorActionPreference = 'Stop'",
    '$made = @{}; $below = @{}',
    'foreach ($r in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)) {',
    '  if ($null -eq $r.CreationDate) { continue }',
    '  $made[[int]$r.ProcessId] = $r.CreationDate',
    '  $below[[int]$r.ParentProcessId] += @([int]$r.ProcessId)',
    '}',
    'function Get-Below([int]$top) {',
    '  $found = New-Object System.Collections.ArrayList; $next = New-Object System.Collections.Queue',
    '  if (-not $made.ContainsKey($top)) { return ,$found }',
    '  $next.Enqueue($top)',
    '  while ($next.Count) {',
    '    $parent = [int]$next.Dequeue()',
    '    foreach ($id in $below[$parent]) {',
    '      if ($id -eq $PID -or $id -eq $parent -or $found.Contains($id) -or $made[$id] -lt $made[$parent]) { continue }',
    '      [void]$found.Add($id); $next.Enqueue($id)',
    '    }',
    '  }',
    '  return ,$found',
    '}',
    `$owner = ${owner}; $root = ${root}`,
    'if ($root -ne $owner -and -not (Get-Below $owner).Contains($root)) { exit 0 }',
    '$ids = New-Object System.Collections.ArrayList; if ($root -ne $owner) { [void]$ids.Add($root) }',
    '[void]$ids.AddRange((Get-Below $root))',
    '$ended = New-Object System.Collections.ArrayList',
    'foreach ($id in $ids) {',
    // Gone since the listing: it ended with its parent (a node child's children are in a job that ends with it).
    '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch [ArgumentException] { $id; continue }',
    '  try { $start = $p.StartTime } catch [ComponentModel.Win32Exception] { continue } catch [InvalidOperationException] { continue }',
    '  if ([Math]::Abs(($start - $made[$id]).TotalMilliseconds) -ge 1) { continue }',
    // Kill throws only for a process that is already ending (access denied while it exits) or has exited: ended either way.
    '  try { $p.Kill() } catch [ComponentModel.Win32Exception] {} catch [InvalidOperationException] {}',
    '  [void]$ended.Add($p); $id',
    '}',
    `if (${Math.round(waitMs)} -gt 0) {`,
    `  foreach ($p in $ended) { [void]$p.WaitForExit(${Math.round(waitMs)}) }`,
    '  if (@($ended | Where-Object { -not $_.HasExited }).Count) { exit 3 }',
    '}',
    'exit 0',
  ].join('\n');

/** Where the script runs: never a folder of the caller's, which the caller may remove once the tree has ended. */
export const OWN_TREE_CWD = process.env.SystemRoot;
const ownTreeArgs = (pid) => ['-NoProfile', '-NonInteractive', '-Command', OWN_TREE_SCRIPT(process.pid, pid)];
const endedPids = (stdout) => [...String(stdout ?? '').matchAll(/\d+/g)].map((match) => Number(match[0]));

/**
 * Pid `pid` may be a bare number from anywhere: it is ended, with its tree, only when it is this process or one of its
 * descendants ({@link OWN_TREE_SCRIPT}). Returns the pids ended. A script that could not run (it did not start, ran out
 * of time, or failed to read the process table, which a loaded PC can) has ended nothing known, so it answers `[pid]`:
 * the caller then waits for that process and reports it if it still runs.
 * @param {number} pid
 * @returns {number[]}
 */
export function killOwnTreeSync(pid, timeout = SHUTDOWN_BUDGET_MS, report = console.error) {
  if (!(Number.isInteger(pid) && pid > 0)) return [];
  const { status, signal, stdout, stderr, error } = spawnSync('powershell.exe', ownTreeArgs(pid), {
    cwd: OWN_TREE_CWD,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  if (status === 0) return endedPids(stdout);
  report(ownTreeFailure(pid, error?.message ?? signal ?? `exit ${status}`, stderr));
  return [pid];
}

const ownTreeFailure = (pid, why, stderr) =>
  `the tree of ${pid} could not be ended (${why}): ${
    String(stderr ?? '')
      .trim()
      .slice(-600) || 'no output'
  }`;

/** The processes `taskkill /T` says it ended, from its lines `SUCCESS: The process with PID 12 (child process of PID 3) ...`. */
export function taskkillPids(output) {
  return [...output.matchAll(/^\S.*?PID (\d+)/gm)].map((match) => Number(match[1]));
}

/**
 * Ends `child`, a process this one started, and its tree, the fast way (`taskkill /T /F`, about 1 s where
 * {@link killOwnTreeSync} reads the whole process table): only while its exit has not been seen, and synchronously,
 * so Node cannot see the exit and close its handle while taskkill runs. Windows keeps a pid from any new process while
 * a handle to its process is open, so the pid is the child's for the whole kill. A child whose exit was seen is not
 * ended by pid: the number may be another run's process by now (KB-TEST-FILEEXIT1). Resolves to the pids ended, or
 * `[child.pid]` when taskkill could not say (the caller then waits for it). Windows only; callers keep their own kill
 * elsewhere (a process group, or the handle). taskkill finds the tree by `ParentProcessId`; Microsoft does not say
 * whether it checks creation times, so a process orphaned by an earlier holder of the child's pid could still be taken
 * in (docs/limits.md, "Process tree kills"). {@link killOwnTreeSync} checks them, at the cost of reading the table.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {number[]}
 */
export function killChildTreeSync(child, timeout = SHUTDOWN_BUDGET_MS) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return [];
  return taskkillHeld(child.pid, timeout);
}

/** `taskkill /T /F` on a pid this process holds a handle to (its child, or itself), run synchronously. */
function taskkillHeld(pid, timeout) {
  const { stdout, status } = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    cwd: OWN_TREE_CWD,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  const ended = taskkillPids(String(stdout ?? ''));
  // Exit code 128 only says the process had already ended; no lines and any other code: nothing ended is known.
  return ended.length || status === 128 ? ended : [pid];
}

/** {@link killOwnTreeSync} without blocking this process. */
export function killOwnTree(pid, timeout = SHUTDOWN_BUDGET_MS, run = execFile, report = console.error) {
  if (!(Number.isInteger(pid) && pid > 0)) return Promise.resolve([]);
  return new Promise((resolve) => {
    run(
      'powershell.exe',
      ownTreeArgs(pid),
      { cwd: OWN_TREE_CWD, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(endedPids(stdout));
        report(ownTreeFailure(pid, error.message ?? error.code, stderr));
        resolve([pid]);
      },
    );
  });
}

/** Kills `child` and everything it started (on Windows through {@link killChildTreeSync}, where `kill()` leaves the tree), then releases its pipes. */
export async function killTree(child) {
  if (!child) return;
  const running = child.exitCode === null && child.signalCode === null;
  if (running && child.pid) {
    if (process.platform === 'win32') killChildTreeSync(child);
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

/**
 * Windows: waits until each of `pids` has finished exiting, its handles closed (its process object signalled), and
 * resolves to the ones still running when `waitMs` ran out. A pid that is gone, that a newer process took after
 * `sinceMs` (epoch ms), or whose start time cannot be read is not waited for. Node has no call that waits on a process
 * it did not start, so .NET's `Process.WaitForExit` does, from one Windows PowerShell for all the pids. With `kill`,
 * each pid that passed the start-time check is ended first, through that same process handle, all of them before
 * the first wait.
 * @param {number[]} pids
 * @param {number} waitMs
 * @param {number} sinceMs
 * @param {typeof execFile} [run]
 * @param {{ kill?: boolean }} [options]
 * @returns {Promise<number[]>}
 */
export function waitSignaled(pids, waitMs, sinceMs, run = execFile, { kill = false } = {}) {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!ids.length) return Promise.resolve([]);
  if (!(waitMs > 0)) return Promise.resolve(ids);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$end = [DateTime]::UtcNow.AddMilliseconds(${Math.round(waitMs)})`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(sinceMs)}).UtcDateTime`,
    '$kept = @()',
    `foreach ($id in @(${ids.join(',')})) {`,
    '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch [ArgumentException] { continue }',
    // A start time that cannot be read means the pid names no process of ours any more, so it is not waited for or
    // reported: either the kernel finished with ours between the lookup and the read (PowerShell's getter then gives
    // $null, and the process object is already signalled), or a newer process this user cannot query (a service:
    // 135 of 958 processes on the workstation) took the pid. Every process Chromium starts as this user is readable, during
    // its teardown too. Reporting it failed a close with SHUTDOWN_TIMEOUT 677 ms after the end.
    '  $start = $p.StartTime',
    '  if ($null -eq $start -or $start.ToUniversalTime() -gt $since) { continue }',
    // With `kill` the process is ended here, through the handle whose start time was just read, so a pid Windows has
    // given to a newer process since the listing is never ended (the bare-pid window of KB-HOST-COMPATEXIT1). Kill
    // throws InvalidOperationException when the process has already exited, and Win32Exception when it is still
    // terminating (TerminateProcess answers access denied; the .NET Process.Kill reference lists "The process is
    // terminating"): both are what was asked for. Uncaught, the second stopped the script, and the error path
    // reported every listed child as a survivor (1 close in 5). WaitForExit below still reports one that stays.
    ...(kill
      ? ['  try { $p.Kill() } catch [InvalidOperationException] { } catch [ComponentModel.Win32Exception] { }']
      : []),
    '  $kept += ,@($id, $p)',
    '}',
    // Every pid is ended before the first wait: a killed Edge child's process object can stay unsignalled for the
    // whole bound after its exit code is set, and a kill-then-wait loop left every later child running that long
    // (browser-teardown, "close ends its main process": GPU, network and storage alive 6 s after the close).
    'foreach ($k in $kept) {',
    '  $left = [int][Math]::Max(0, ($end - [DateTime]::UtcNow).TotalMilliseconds)',
    '  if (-not $k[1].WaitForExit($left)) { $k[0] }',
    '}',
    // A caught missing-process exception leaves PowerShell's last status false.
    // The complete handled loop is a successful query, including an empty result.
    'exit 0',
  ].join('\n');
  return new Promise((resolve) => {
    // A failed native query proves no process has exited; retain every unresolved PID.
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: waitMs + 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? ids : [...String(stdout).matchAll(/\d+/g)].map((match) => Number(match[0]))),
    );
  });
}

/**
 * Ends `target` and everything it started, and resolves when none of them runs any more and, on Windows, each has
 * closed its handles (`settle`, default `waitSignaled`), so the folders and files they held can be removed. `target` is
 * a child process (on Windows ended with {@link killChildTreeSync}: fast, and not at all once its exit has been seen) or
 * a pid (on Windows this process's own, ended the same way, or any other, ended only while it is below this process:
 * {@link killOwnTree}, which reads the whole process table, 4 to 20 s on the loaded workstation). The kill may take up
 * to the larger of `waitMs` and `SHUTDOWN_BUDGET_MS`; after it this never waits past `waitMs` (plus PowerShell's start
 * on Windows) and resolves to the pids still running then, normally none.
 * @param {number | import('node:child_process').ChildProcess} target
 * @param {{ waitMs?: number, kill?: (target: number | import('node:child_process').ChildProcess, timeout: number) => Promise<number[]>, alive?: (pid: number) => boolean, settle?: (pids: number[], waitMs: number, sinceMs: number) => Promise<number[]> }} [options]
 * @returns {Promise<number[]>}
 */
export async function endTree(
  target,
  {
    waitMs = SHUTDOWN_BUDGET_MS,
    kill,
    alive = isAlive,
    settle = process.platform === 'win32' ? waitSignaled : null,
  } = {},
) {
  const child = typeof target === 'object' && target !== null ? target : null,
    pid = child ? child.pid : target;
  if (!pid) return [];
  const begun = Date.now(),
    killMs = Math.max(waitMs, SHUTDOWN_BUDGET_MS);
  let pids;
  if (kill) pids = await kill(target, killMs);
  else if (process.platform === 'win32')
    pids = child
      ? killChildTreeSync(child, killMs)
      : pid === process.pid
        ? taskkillHeld(pid, killMs)
        : await killOwnTree(pid, killMs);
  else if (child && (child.exitCode !== null || child.signalCode !== null)) pids = [];
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
  const killed = pids,
    killedAt = Date.now();
  // Windows PIDs can be reused before the kill returns. kill(pid, 0) then sees the replacement,
  // so polling it before the identity-aware handle wait can spend the whole budget on an unrelated
  // process. The native waiter already waits for exit and checks StartTime: let it own that wait.
  if (settle) return settle(killed, waitMs, begun);
  for (;;) {
    pids = pids.filter(alive);
    // wall-clock: a bound on the wait for processes already killed, far from normal.
    if (pids.length && Date.now() - killedAt > waitMs) return pids;
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
      await traceShutdown(name, run);
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
    if (open.has('browser') && browser?.[SHUTDOWN_STEPS]?.size) {
      open.delete('browser');
      for (const name of browser[SHUTDOWN_STEPS]) open.add(name);
    }
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
