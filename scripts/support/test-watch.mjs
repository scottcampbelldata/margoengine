// A `node --test` reporter that names a hung test. `--test-timeout` ends a test whose promise never settles, but it runs
// inside the test's own process: a blocked event loop, or a process that stays alive after its tests, runs on until the
// whole step is killed, and a step prints nothing until it ends. This reporter sits in the runner's process, so it still
// runs. When a test file gives no event for SILENCE_SECONDS (MARGO_TEST_SILENCE_SECONDS overrides it), it prints the file
// and the test and ends the run, children included. Every event resets the count, so a long file of short tests never
// trips it.
import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';

/** Above verify's TEST_TIMEOUT_MS, so a test whose promise never settles gets `--test-timeout`'s error and its stack first. */
export const SILENCE_SECONDS = 360;

/** Tracks what each running test file last said; pure, so its rules test without a real hang. */
export class HangWatch {
  files = new Map();
  constructor(limitSeconds) {
    this.limit = limitSeconds * 1000;
  }
  /** Takes one reporter event. `now` is in milliseconds. */
  see({ type, data }, now) {
    if (type !== 'test:enqueue' && type !== 'test:dequeue' && type !== 'test:complete') return;
    if (!data?.file) return;
    const isFile = resolve(data.name) === resolve(data.file),
      { files } = this;
    if (isFile) {
      if (type === 'test:dequeue') files.set(data.file, { name: data.name, heard: now, queue: [], running: [], done: undefined });
      else if (type === 'test:complete') files.delete(data.file);
      return;
    }
    const file = files.get(data.file);
    if (!file) return;
    file.heard = now;
    if (type === 'test:enqueue') file.queue.push(data.name);
    else if (type === 'test:dequeue') {
      const at = file.queue.indexOf(data.name);
      if (at >= 0) file.queue.splice(at, 1);
      file.running.push(data.name);
    } else {
      const at = file.running.lastIndexOf(data.name);
      if (at >= 0) file.running.splice(at, 1);
      file.done = data.name;
    }
  }
  /** One line for each file silent past the limit. */
  hung(now) {
    const lines = [];
    for (const { name, heard, queue, running, done } of this.files.values()) {
      if (now - heard < this.limit) continue;
      const seconds = Math.round((now - heard) / 1000),
        where = running.length
          ? `in test "${running.join(' > ')}"`
          : queue.length
            ? `in or before test "${queue[0]}"`
            : done !== undefined
              ? `after its last test "${done}" (something keeps the process alive)`
              : 'with no test reported yet (a blocked process reports nothing)';
      lines.push(`HUNG TEST: ${name} ${where}: no event for ${seconds} s`);
    }
    return lines;
  }
}

/**
 * Stops every process below `root` and waits on each one's handle, so its files and working folder are free on return.
 * Prints how many it stopped; exits 3 if one outlives the wait. Skips its own process, which is below `root` too.
 */
const stopScript = (root) => `
$below = @{}
foreach ($p in Get-CimInstance Win32_Process) { $below[[int]$p.ParentProcessId] += @([int]$p.ProcessId) }
$ids = New-Object System.Collections.ArrayList
$next = New-Object System.Collections.Queue
$next.Enqueue(${root})
while ($next.Count) {
  foreach ($id in $below[[int]$next.Dequeue()]) {
    if ($id -ne $PID -and -not $ids.Contains($id)) { [void]$ids.Add($id); $next.Enqueue($id) }
  }
}
$found = @(foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue })
foreach ($p in $found) { try { $p.Kill() } catch {} }
foreach ($p in $found) { [void]$p.WaitForExit(20000) }
$found.Count
if (@($found | Where-Object { -not $_.HasExited }).Count) { exit 3 }
`;

/** Every process on the machine, pid to parent and whether it is a zombie, from one `ps` listing; skips `ps` itself. */
function processTable() {
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' }),
    { status, stdout, stderr, error } = listing;
  if (status !== 0) throw new Error(`ps failed (status ${status}): ${error?.message ?? stderr}`);
  const table = new Map();
  for (const line of stdout.split('\n')) {
    const [pid, parent, state] = line.trim().split(/\s+/);
    if (pid && Number(pid) !== listing.pid)
      table.set(Number(pid), { parent: Number(parent), zombie: state.startsWith('Z') });
  }
  return table;
}

/** Every process below `root` in `table`, children before their children. */
function below(table, root) {
  const children = new Map();
  for (const [pid, { parent }] of table) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const found = [];
  for (let at = 0, next = [root]; at < next.length; at++)
    for (const pid of children.get(next[at]) ?? []) if (!found.includes(pid)) found.push(pid), next.push(pid);
  return found;
}

/** Sends a signal; a process that already ended is what was wanted. */
function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Stops every process below `root` on macOS and Linux, grandchildren included, and waits until each is gone (a zombie
 * holds no files or folder, so it counts as gone). A grandchild is not in the runner's reach otherwise: the runner's own
 * SIGTERM ends its test processes only, and a process group would take in whoever started the run. Each listing freezes
 * what it finds before the next one, so nothing starts a child between the last listing and the kill.
 */
function stopTree(root) {
  const stopped = new Set();
  for (let fresh = below(processTable(), root); fresh.length; ) {
    for (const pid of fresh) signal(pid, 'SIGSTOP'), stopped.add(pid);
    fresh = below(processTable(), root).filter((pid) => !stopped.has(pid));
  }
  for (const pid of stopped) signal(pid, 'SIGKILL');
  const deadline = Date.now() + 20000,
    pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const table = processTable(),
      left = [...stopped].filter((pid) => table.has(pid) && !table.get(pid).zombie);
    if (!left.length || Date.now() > deadline) return { count: stopped.size, left };
    Atomics.wait(pause, 0, 0, 50);
  }
}

/**
 * Ends this runner and the test processes it started, the runner last: whoever waits on the run may remove the run's
 * folder the moment it ends. `taskkill /T` on this process could not promise that: the runner died while taskkill was
 * still running in the run's folder, and Windows refuses to remove a process's working folder. So the runner stops its
 * children, waits, then exits, and the killer works from another folder so it never holds that one.
 */
function endRun() {
  if (process.platform !== 'win32') {
    const { count, left } = stopTree(process.pid);
    writeSync(
      2,
      left.length
        ? `HUNG RUN: child processes may still be alive: ${left.join(', ')}\n`
        : `HUNG RUN ENDED: ${count} child processes stopped and gone\n`,
    );
    process.exit(1);
  }
  const { status, stdout, stderr, error } = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', stopScript(process.pid)],
    { cwd: process.env.SystemRoot, encoding: 'utf8', timeout: 60000, windowsHide: true },
  );
  writeSync(
    2,
    status === 0
      ? `HUNG RUN ENDED: ${stdout.trim()} child processes stopped and gone\n`
      : `HUNG RUN: child processes may still be alive (status ${status}): ${error?.message ?? stderr}\n`,
  );
  process.exit(1);
}

export default async function* watch(source) {
  const limit = Number(process.env.MARGO_TEST_SILENCE_SECONDS ?? SILENCE_SECONDS);
  if (!(limit > 0)) throw new RangeError('MARGO_TEST_SILENCE_SECONDS must be a number of seconds');
  const hangs = new HangWatch(limit),
    timer = setInterval(() => {
      const lines = hangs.hung(Date.now());
      if (!lines.length) return;
      clearInterval(timer);
      writeSync(2, `\n${lines.join('\n')}\n`);
      endRun();
    }, 1000);
  timer.unref();
  for await (const event of source) hangs.see(event, Date.now());
  clearInterval(timer);
}
