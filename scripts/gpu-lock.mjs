// GPU access across agents and worktrees, as a reader/writer lock in test-results/gpu.lock of the MAIN checkout.
//   shared     correctness tests: up to MARGO_GPU_SLOTS (default 3) holders at once. The default for `gpu.lock`.
//   exclusive  only commands that measure speed: `--exclusive` / acquire({mode: 'exclusive'}), and automatically every
//              `bench*` npm script and every script under bench/, benchmarks/ or *-benchmarks/ (or named bench*.mjs).
//              It waits until no holder is left and, while it waits, new shared holders queue behind it, so it cannot
//              starve. Every explicitly selected non-GPU lock is exclusive.
// Nothing hangs while holding or waiting:
//   hold limit  every holder has a maximum hold time (default 20 min shared, at most 20 min exclusive, 30 min for any other
//               explicitly selected lock; `--max=<min>` / acquire({max})). `run` kills the command's whole process tree
//               (Windows: taskkill /T /F) when it is exceeded, frees the lock and exits 124 with
//               "TIMEOUT after N min: <command>". A holder that called acquire() itself is ended the same way by its
//               heartbeat process, a few seconds after the limit.
//   heartbeat   a heartbeat process refreshes each holder's entry every 15 s while the holder lives; a waiter reclaims an
//               entry whose process is dead, or that nobody has refreshed for 2 min (MARGO_GPU_LEASE_MIN), live or not.
//   wait limit  a request waits at most 60 min (`--wait-max=<min>` / acquire({waitMax})), then fails naming each holder,
//               its owner and the command it runs.
// Layout of the lock folder: shared/<token>.json per shared holder, exclusive.json for the exclusive holder and mutex/
// (an atomically published directory link, populated with owner.json before publication). Queued exclusive requests are <ts>-<token>.json in the
// folder beside it, gpu.lock-waiting/, which an old client's release (it removes the whole lock folder) leaves alone. Shared
// requests also retain FIFO tickets. Detached jobs have status records in gpu.lock-jobs/ and logs in the submitter's
// worktree. A holder, waiter or legacy owner.json whose process is gone is stale and removed. Release removes
// only our own entry: never delete an entry you don't own.
// Compatibility with the one-holder lock (before 2026-10-26, still run by agents in older worktrees): that version
// holds the GPU by creating the folder itself (atomic mkdir, then owner.json) and waits while the folder exists. Every
// holder here keeps its entry inside the folder and the folder is removed only when empty, so an old client waits
// while any new holder, shared or exclusive, is in. In the other direction an old owner.json counts as an exclusive
// holder, and a folder made in the last 5 s with nothing in it is an old client between its mkdir and its
// owner.json, so it is waited for too. Old clients therefore take turns with new ones as with each other.
// CLI: node scripts/gpu-lock.mjs run [--exclusive] [--max=<min>] [--wait-max=<min>] --owner=<agent id> -- <command...>
//      node scripts/gpu-lock.mjs status
// Env: MARGO_GPU_SLOTS=<n> shared slots (default 3); MARGO_GPU_EXCLUSIVE=1 requests exclusive but still needs speed
// classification or a timing reason. MARGO_GPU_LOCK=<folder> uses another lock. Refusals are logged beside the lock.
// Scripts that take the lock themselves use MARGO_GPU_LOCK_NESTED (a folder inside the held lock; it excuses only that
// lock, so a GPU test inside a different lock still takes the GPU lock) when run under `run`, so wrapping them can't
// deadlock; acquire() is a no-op there. MARGO_GPU_LOCK_NESTED_MODE names the outer holder's mode: an exclusive request
// inside a shared hold would wait on itself forever, so it throws and says to start the outer command with --exclusive.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { exitOnHelp } from './support/help.mjs';
import { speedEnabled } from './support/speed-phase.mjs';

/**
 * The main checkout of the clone that holds `root`, so every worktree shares one lock folder. A git worktree's `.git`
 * is a file naming `<main>/.git/worktrees/<name>` wherever the worktree folder is (a worktree outside
 * the main checkout once got a lock of its own and shared no GPU slots with anyone).
 * @param {string} root A checkout's top folder.
 */
export function mainCheckout(root) {
  const dotGit = join(root, '.git');
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
    const at = gitdir?.replace(/\\/g, '/').search(/\/\.git\/worktrees\/[^/]+$/) ?? -1;
    if (at > 0) return resolve(root, gitdir.slice(0, at));
  }
  return root.replace(/[\\/]\.[\w-]+[\\/]worktrees[\\/][^\\/]+$/, '');
}

const main = mainCheckout(resolve(import.meta.dirname, '..'));
export const lockDir = process.env.MARGO_GPU_LOCK ?? join(main, 'test-results', 'gpu.lock');
const sharedDir = join(lockDir, 'shared'),
  waitingDir = `${lockDir}-waiting`,
  mutexDir = join(lockDir, 'mutex'),
  exclusiveFile = join(lockDir, 'exclusive.json'),
  legacyFile = join(lockDir, 'owner.json');
const isGpuLock = basename(lockDir) === 'gpu.lock';
const MIN = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const files = (dir) => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
};
const number = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!(n > 0)) throw new RangeError(`${name} must be a positive number, got "${raw}"`);
  return n;
};
/** Milliseconds without a heartbeat after which a holder's entry may be reclaimed (MARGO_GPU_LEASE_MIN, default 2 min). */
const leaseMs = () =>
  process.env.MARGO_GPU_LEASE_MS ? Number(process.env.MARGO_GPU_LEASE_MS) : number('MARGO_GPU_LEASE_MIN', 2) * MIN;
const beatMs = () => Number(process.env.MARGO_GPU_BEAT_MS ?? 15_000);
// How long an empty folder with no owner.json counts as an old client that has just made it (see Compatibility).
const freshMs = () => Number(process.env.MARGO_GPU_FRESH_MS ?? 5_000);

// Publish a populated owner directory by atomically creating a junction (a directory symlink on Unix).
// Unlike renaming a directory, this cannot replace an empty mutex just made by an older client.
const mutexToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const mutexOwnerDir = `${lockDir}-mutex-${mutexToken}`;
let mutexHeartbeat;
function readyMutexHeartbeat() {
  mutexHeartbeat ??= new Promise((done, fail) => {
    const worker = new Worker(new URL('./support/gpu-mutex-beat.mjs', import.meta.url), {
      workerData: mutexOwnerDir,
      // This built-in-only worker needs no caller flags (eval-only and process-only flags are invalid here).
      execArgv: [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(
        Object.assign(new Error('gpu-lock: mutex heartbeat did not start within 30 seconds'), {
          code: 'ERR_GPU_MUTEX_HEARTBEAT_TIMEOUT',
        }),
      );
    }, 30_000);
    let ready = false;
    worker.on('error', (error) => {
      clearTimeout(timer);
      if (ready) throw error;
      fail(error);
    });
    worker.once('message', () => {
      clearTimeout(timer);
      ready = true;
      worker.unref();
      done();
    });
  });
  return mutexHeartbeat;
}

function tryMutex() {
  mkdirSync(mutexOwnerDir);
  writeFileSync(join(mutexOwnerDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: mutexToken }));
  try {
    symlinkSync(mutexOwnerDir, mutexDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    rmSync(mutexOwnerDir, { recursive: true });
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return null;
    throw error;
  }
  return () => {
    if (read(join(mutexDir, 'owner.json'))?.token !== mutexToken)
      throw Object.assign(new Error('gpu-lock: mutex ownership changed during its critical section'), {
        code: 'ERR_GPU_MUTEX_OWNER_LOST',
      });
    retireMutex(mutexDir);
    rmSync(mutexOwnerDir, { recursive: true });
  };
}

function reclaimDeadMutex() {
  // Pin the unique backing directory, not the reusable mutex name: another reclaimer can finish
  // while this process is descheduled. A later owner must never lose its metadata to that process.
  let target;
  try {
    if (!lstatSync(mutexDir).isSymbolicLink()) return;
    target = realpathSync(mutexDir);
  } catch (error) {
    if (error.code === 'ENOENT') return; // the owner released before we inspected the link
    throw error;
  }
  let ownerFile = join(target, 'owner.json');
  let owner = read(ownerFile);
  if (!owner) {
    // A reclaimer may itself have died after claiming the dead owner's metadata.
    // Its PID is atomically published in the claim name; live reclaimers alone may finish.
    const claim = files(target).find((name) => {
      const pid = /^reclaimed-(\d+)-[a-z0-9]+\.json$/.exec(name)?.[1];
      return pid && !alive(Number(pid));
    });
    if (claim) {
      ownerFile = join(target, claim);
      owner = read(ownerFile);
    }
  }
  // An old anonymous mutex has no evidence of a dead owner. Age alone is never such evidence.
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || alive(owner.pid)) return;
  if (
    typeof owner.token !== 'string' ||
    !/^\d+-[a-z0-9]+$/.test(owner.token) ||
    resolve(target) !== resolve(`${lockDir}-mutex-${owner.token}`)
  )
    return;
  // Claim this dead owner's metadata first. Only one reclaimer can rename it; all others see no owner.
  try {
    renameSync(ownerFile, join(target, `reclaimed-${mutexToken}.json`));
  } catch (error) {
    if (error.code === 'ENOENT') return; // another reclaimer won the claim
    throw error;
  }
  retireMutex(mutexDir);
  rmSync(target, { recursive: true });
}

/**
 * Ends a process and everything it started. On Windows `taskkill /T /F` (a plain kill stops only the shell or launcher
 * and leaves browsers, servers and kernels running); elsewhere the process group, which `spawnLimited` makes.
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
}

// Starts `command` (a shell string, or [program, ...args]) and ends its whole process tree past `timeoutMs`. Resolves
// to {code, timedOut} (code 124 on a timeout), with the child as `.child`.
function spawnLimited(command, { timeoutMs, env }) {
  const windows = process.platform === 'win32',
    child = Array.isArray(command)
      ? spawn(command[0], command.slice(1), { env, stdio: 'inherit', detached: !windows })
      : spawn(command, { env, stdio: 'inherit', shell: true, detached: !windows });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMs);
  const result = new Promise((done) => {
    const finish = (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? 124 : (code ?? 1), timedOut });
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
  result.child = child;
  return result;
}

const BENCH_SCRIPT = /(^|[\\/])(bench|[\w-]*benchmarks)[\\/].*\.[cm]?[jt]s$|(^|[\\/])bench[\w.-]*\.[cm]?[jt]s$/i;
/**
 * Whether a command measures speed and so needs the GPU to itself: an npm script named bench*, or a script under
 * bench/, benchmarks/ or *-benchmarks/, or named bench*.mjs. `words` is the command (program and arguments).
 */
export function measuresSpeed(words, lifecycle = process.env.npm_lifecycle_event) {
  if (/^bench/.test(lifecycle ?? '')) return true;
  return words.some(
    (word, i) => BENCH_SCRIPT.test(word) || (/^bench/.test(word) && /^(run|run-script)$/.test(words[i - 1] ?? '')),
  );
}

/** The number of shared slots: MARGO_GPU_SLOTS, default 3. */
export function slots() {
  const raw = process.env.MARGO_GPU_SLOTS;
  if (raw === undefined || raw === '') return 3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`MARGO_GPU_SLOTS must be a whole number of 1 or more, got "${raw}"`);
  return n;
}

/**
 * The mode an acquire really uses. `requested` is 'shared' or 'exclusive' (default: shared on gpu.lock, exclusive on
 * any other lock). MARGO_GPU_EXCLUSIVE=1 raises a shared request to exclusive; nothing lowers one.
 */
export function resolveMode(requested) {
  if (requested !== undefined && requested !== 'shared' && requested !== 'exclusive')
    throw new TypeError(`gpu-lock: mode must be "shared" or "exclusive", got "${requested}"`);
  if (requested === 'exclusive' || /^(1|true|yes)$/i.test(process.env.MARGO_GPU_EXCLUSIVE ?? '')) return 'exclusive';
  if (requested === undefined && measuresSpeed(process.argv.slice(1, 2))) return 'exclusive';
  return isGpuLock ? (requested ?? 'shared') : 'exclusive';
}

/** GPU holds default to 20 minutes; other named locks default to 30 minutes. */
export const defaultMaxMinutes = () => (isGpuLock ? 20 : 30);
export const EXCLUSIVE_MAX_MINUTES = 20;

// Only the coordinator may add an entry, with Scott's OK. No wildcards or immortal approvals.
export function exclusiveApproval(
  command,
  entries = read(new URL('./gpu-exclusive-allow.json', import.meta.url)),
  now = Date.now(),
) {
  if (!Array.isArray(entries))
    throw new TypeError('gpu-exclusive-allow.json must be an array of coordinator approvals');
  return entries.find(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      entry.command === command &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() &&
      typeof entry.approvedBy === 'string' &&
      entry.approvedBy.trim() &&
      typeof entry.expiry === 'string' &&
      Number.isFinite(Date.parse(entry.expiry)) &&
      Date.parse(entry.expiry) > now,
  );
}

function refusal(code, message, request) {
  mkdirSync(dirname(lockDir), { recursive: true });
  appendFileSync(
    join(dirname(lockDir), 'gpu-lock-refusals.log'),
    JSON.stringify({ at: new Date().toISOString(), code, ...request, message }) + '\n',
  );
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Validate exclusive GPU use before waiting or entering an outer holder. Other locks are unaffected. */
export function validateRequest({ owner, mode, maxMinutes, command, timing }) {
  if (!owner) throw new Error('gpu-lock: pass an owner (agent id)');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0)
    throw new RangeError('gpu-lock: max must be a finite positive number of minutes');
  if (!isGpuLock || mode !== 'exclusive') return;
  const request = { owner, mode, maxMinutes, command, timing };
  const approval = !speedEnabled() ? exclusiveApproval(command) : undefined;
  if (
    !measuresSpeed(command.split(/\s+/)) &&
    !measuresSpeed(process.argv.slice(1, 2)) &&
    !(typeof timing === 'string' && timing.trim()) &&
    !approval
  )
    refusal(
      'ERR_GPU_EXCLUSIVE_NOT_TIMING',
      'exclusive GPU access is only for speed measurement; correctness gates use shared slots. For an unclassified timing command pass --timing=<reason>.',
      request,
    );
  if (!speedEnabled() && !approval)
    refusal(
      'ERR_SPEED_PHASE_DEFERRED',
      'all exclusive GPU requests are refused during the build phase; only an exact, unexpired coordinator allowlist entry approved by Scott may proceed.',
      request,
    );
  if (approval) {
    mkdirSync(dirname(lockDir), { recursive: true });
    appendFileSync(
      join(dirname(lockDir), 'gpu-lock-timing.log'),
      JSON.stringify({ at: new Date().toISOString(), ...request, approval }) + '\n',
    );
  }
  if (maxMinutes > EXCLUSIVE_MAX_MINUTES)
    refusal(
      'ERR_GPU_EXCLUSIVE_LIMIT',
      `exclusive GPU holds cannot exceed ${EXCLUSIVE_MAX_MINUTES} minutes; split the speed suite into bounded measurements.`,
      request,
    );
  if (timing) {
    mkdirSync(dirname(lockDir), { recursive: true });
    appendFileSync(
      join(dirname(lockDir), 'gpu-lock-timing.log'),
      JSON.stringify({ at: new Date().toISOString(), ...request }) + '\n',
    );
  }
}

/** Remove a mutex from its reusable name before deleting it (Windows may keep a deleted name pending). */
export function retireMutex(path, { rename = renameSync, remove = rmSync } = {}) {
  const retired = join(dirname(path), `mutex-released-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rename(path, retired);
  remove(retired, { recursive: true, force: true });
}

// Runs `fn` (synchronous, short) while holding a mutex with atomically published owner identity.
// `fn` gets {fresh}: true when the folder was made by someone else less than freshMs() ago (an old client mid-acquire
// when nothing is in it; see Compatibility). A folder `fn` leaves empty is removed again unless it is fresh: an empty
// folder would make old clients wait forever.
async function locked(fn, deadline) {
  mkdirSync(dirname(lockDir), { recursive: true });
  await readyMutexHeartbeat();
  let fresh = false;
  let release;
  for (;;) {
    try {
      mkdirSync(lockDir);
      fresh = false;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const made = statSync(lockDir);
        fresh = Date.now() - (made.birthtimeMs || made.mtimeMs) < freshMs();
      } catch {}
    }
    release = tryMutex();
    if (release) break;
    reclaimDeadMutex();
    if (Date.now() > deadline)
      throw Object.assign(
        new Error(
          `gpu-lock: timed out waiting for mutex owner ${JSON.stringify(read(join(mutexDir, 'owner.json')))}; anonymous legacy mutexes require their owner to release them`,
        ),
        {
          code: 'ERR_GPU_MUTEX_WAIT_TIMEOUT',
        },
      );
    await sleep(10);
  }
  try {
    return fn({ fresh });
  } finally {
    release();
    if (!fresh)
      try {
        rmdirSync(lockDir);
      } catch {}
  }
}

/** Why a holder's entry is dead, or null when it is alive: its process is gone, its heartbeat stopped, or it overran. */
function deadReason(entry, file) {
  if (entry.pid && !alive(entry.pid)) return `pid ${entry.pid} gone`;
  if (entry.beats) {
    let beat = 0;
    try {
      beat = statSync(file).mtimeMs;
    } catch {}
    if (Date.now() - beat > leaseMs()) return `no heartbeat for ${Math.round((Date.now() - beat) / 1000)} s`;
    // The limit is enforced by the holder's wrapper and heartbeat process; this covers both having died.
    if (entry.deadline && Date.now() > entry.deadline + 2 * MIN) return 'past its hold limit';
  }
  return null;
}

// The live entries of each kind; dead ones are removed (and logged). Call inside `locked`.
function snapshot(log, fresh = false) {
  const live = (dir) =>
    files(dir).flatMap((name) => {
      const file = join(dir, name),
        entry = read(file);
      const reason = entry && deadReason(entry, file);
      if (entry && !reason) return [{ ...entry, file }];
      if (entry) log?.(`gpu-lock: removing stale ${basename(dir)} entry of ${entry.owner} (${reason})`);
      try {
        unlinkSync(file);
      } catch {}
      return [];
    });
  let exclusive = read(exclusiveFile);
  const legacy = read(legacyFile); // a holder from before shared slots existed
  for (const [file, entry] of [
    [exclusiveFile, exclusive],
    [legacyFile, legacy],
  ]) {
    const reason = entry && deadReason(entry, file);
    if (reason) {
      log?.(`gpu-lock: taking over stale lock from ${entry.owner} (${reason})`);
      rmSync(file, { force: true });
      if (entry === exclusive) exclusive = null;
    }
  }
  let held = exclusive ?? (legacy && !deadReason(legacy, legacyFile) ? legacy : null);
  const shared = live(sharedDir),
    waiting = live(waitingDir).sort((a, b) => a.file.localeCompare(b.file));
  // An old client makes the folder, then writes owner.json: a just-made folder with nothing in it is one in between,
  // and so is an owner.json being written (unreadable for a moment). Past freshMs() an unreadable one is stale.
  if (!held && legacy === null && existsSync(legacyFile)) {
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(legacyFile).mtimeMs;
    } catch {}
    if (age < freshMs()) held = { owner: 'an older gpu-lock client (writing owner.json)', mode: 'exclusive' };
    else {
      log?.('gpu-lock: removing an unreadable owner.json');
      rmSync(legacyFile, { force: true });
    }
  }
  if (!held && fresh && !shared.length && !existsSync(legacyFile))
    held = { owner: 'an older gpu-lock client (it has just made the lock folder)', mode: 'exclusive' };
  return { exclusive: held, shared, waiting };
}

// Removes the lock folder when nothing is in it, so a script that still makes the folder by hand (older checkouts) is
// not blocked by an empty one. Skipped when another process is changing the lock right now.
function tidy() {
  const release = tryMutex();
  if (!release) return;
  for (const dir of [sharedDir, waitingDir])
    try {
      rmdirSync(dir);
    } catch {}
  release();
  try {
    rmdirSync(lockDir);
  } catch {}
}

/**
 * Who holds the GPU now: null when nobody; the exclusive holder's entry (plus `mode: 'exclusive'`); or, when shared
 * holders exist, `{mode: 'shared', holders, slots}`. `waiting` lists queued exclusive requests when there are any.
 */
export function status() {
  const liveEntry = (file) => {
    const entry = read(file);
    return entry && !deadReason(entry, file) ? entry : null;
  };
  const waiting = files(waitingDir)
    .map((name) => read(join(waitingDir, name)))
    .filter((entry) => entry && (!entry.pid || alive(entry.pid)));
  const exclusive = liveEntry(exclusiveFile) ?? liveEntry(legacyFile);
  const holders = files(sharedDir)
    .map((name) => liveEntry(join(sharedDir, name)))
    .filter(Boolean);
  const extra = waiting.length ? { waiting } : {};
  if (exclusive) return { ...exclusive, mode: 'exclusive', ...extra };
  if (holders.length) return { mode: 'shared', holders, slots: slots(), ...extra };
  return waiting.length ? { mode: 'idle', ...extra } : null;
}

const describe = (entry) =>
  entry
    ? `${entry.owner} (${entry.mode ?? 'exclusive'}${entry.takenAt ? `, since ${entry.takenAt}` : ''}${entry.command ? `, running: ${entry.command}` : ''})`
    : 'an unlabelled holder';

const spawnBeat = (verb, args) =>
  spawn(process.execPath, [import.meta.filename, verb, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MARGO_GPU_LOCK: lockDir },
  }).unref();

// Starts the process that keeps a holder's entry fresh and ends the holder if it overruns. It is separate from the holder
// because a holder busy in a long synchronous call (spawnSync) cannot refresh anything itself.
// On Windows it must not be the holder's child: `taskkill /T` follows parent ids, so ending the holder ended the heartbeat
// too, and that closed the job object Node keeps its children in, which ended the taskkill. Whether taskkill reached the
// holder first was a race (about 2 runs in 100 on a busy machine: the holder ran on past its limit, and on all runs the
// heartbeat died before it could write gpu-lock-timeouts.log). So a starter that exits at once stands between them.
function startHeartbeat(file, token, deadline) {
  spawnBeat(process.platform === 'win32' ? 'beat-start' : 'beat', [file, token, String(process.pid), String(deadline)]);
}

/**
 * Waits until the lock is ours and returns a release function (with the mode used as `.mode`) that removes only our own
 * entry. `mode` is 'shared' or 'exclusive' (see resolveMode). `max` is the longest hold in minutes (default by mode, see
 * defaultMaxMinutes) and `waitMax` the longest wait in minutes (default 60, MARGO_GPU_WAIT_MAX_MIN): past it this throws,
 * naming the holder and its command. `command` says what the holder runs (shown to those who wait).
 */
export async function acquire({
  owner,
  mode: requested,
  max,
  waitMax = number('MARGO_GPU_WAIT_MAX_MIN', 60),
  command = process.argv.slice(1).join(' ').slice(0, 300),
  timing,
  queuedAt = Date.now(),
  onQueued,
  poll = 1_000,
  log = console.error,
} = {}) {
  if (!owner) throw new Error('gpu-lock: pass an owner (agent id)');
  const mode = resolveMode(timing === undefined ? requested : 'exclusive');
  const maxMinutes = max ?? defaultMaxMinutes(mode);
  validateRequest({ owner, mode, maxMinutes, command, timing });
  // Inside `run` of this same lock the command already holds it; a different lock is still taken.
  if (process.env.MARGO_GPU_LOCK_NESTED === join(lockDir, 'nested')) {
    if (mode === 'exclusive' && process.env.MARGO_GPU_LOCK_NESTED_MODE === 'shared')
      throw new Error(
        `gpu-lock: ${owner} needs the GPU exclusively (it measures speed) but the wrapping gpu-lock run holds only a shared slot; start the outer command with "node scripts/gpu-lock.mjs run --exclusive ..."`,
      );
    const noop = () => {};
    noop.mode = mode;
    return noop;
  }
  const token = `${owner.replace(/[^\w.-]/g, '_')}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    entry = (beats = true) => {
      const now = Date.now();
      return JSON.stringify({
        owner,
        pid: process.pid,
        token,
        mode,
        command,
        ...(timing ? { timing } : {}),
        takenAt: new Date(now).toISOString(),
        maxMinutes,
        deadline: now + maxMinutes * MIN,
        beats,
      });
    };
  let ticket;
  let queued = false;
  const waitStart = Date.now();
  const take = (file) => {
    startHeartbeat(file, token, Date.now() + maxMinutes * MIN);
    const release = () => {
      if (read(file)?.token === token) rmSync(file, { force: true });
      tidy();
    };
    release.mode = mode;
    return release;
  };
  const giveUp = (held) => {
    if (queued) rmSync(join(waitingDir, ticket), { force: true });
    tidy();
    return new Error(
      `gpu-lock: gave up after ${Math.round((Date.now() - waitStart) / MIN)} min waiting for the GPU (${mode} request by ${owner}); it is held by ${held.map(describe).join('; ')}. Wait longer with --wait-max=<min>, or look at the holder: node scripts/gpu-lock.mjs status`,
    );
  };
  for (let announced = 0; ; ) {
    const result = await locked(
      ({ fresh }) => {
        const state = snapshot(log, fresh),
          others = state.waiting.filter((w) => w.token !== token);
        // An old client's release removes the whole folder, our ticket with it: queue again, in the same place.
        if (queued && others.length === state.waiting.length) queued = false;
        const first = state.waiting[0]?.token === token || (!queued && others.length === 0);
        if (mode === 'shared') {
          if (!state.exclusive && first && state.shared.length < slots()) {
            if (queued) rmSync(join(waitingDir, ticket), { force: true });
            mkdirSync(sharedDir, { recursive: true });
            const file = join(sharedDir, `${token}.json`);
            writeFileSync(file, entry());
            return { file };
          }
        }
        if (mode === 'exclusive' && !state.exclusive && !state.shared.length && first) {
          if (queued) rmSync(join(waitingDir, ticket), { force: true });
          writeFileSync(exclusiveFile, entry());
          return { file: exclusiveFile };
        }
        if (!queued) {
          // Allocate order while holding the mutex. Timestamp ties must not reorder owners alphabetically.
          const last = Math.max(0, ...state.waiting.map((w) => Number(/^(\d+)-/.exec(basename(w.file))?.[1]) || 0));
          ticket ??= `${String(Math.max(queuedAt, last + 1)).padStart(15, '0')}-${token}.json`;
          mkdirSync(waitingDir, { recursive: true });
          writeFileSync(join(waitingDir, ticket), entry(false));
          queued = true;
          onQueued?.();
        }
        return { held: [state.exclusive, ...state.shared, ...others].filter(Boolean) };
      },
      waitStart + waitMax * MIN,
    );
    if (result.file) return take(result.file);
    if (Date.now() - waitStart > waitMax * MIN) throw giveUp(result.held);
    if (Date.now() - announced >= 10 * MIN || announced === 0) {
      announced = Date.now();
      log(`gpu-lock: ${mode} request waiting for ${result.held.map(describe).join('; ')}`);
    }
    await sleep(poll);
  }
}

/**
 * `arg` quoted for a cmd.exe command line read back by the C runtime's argument parser: plain words stay as they are,
 * anything else is wrapped in double quotes with embedded quotes (and the backslashes before them) escaped.
 */
export function quoteWindows(arg) {
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * A command line for cmd.exe (`shell: true` on Windows) that hands the program `args` exactly: each quoted for the
 * program ({@link quoteWindows}), then made literal to cmd. cmd reads the line first and toggles its own quoting at
 * every ", the escaped \" included, so a | & < > ( ) ^ after an escaped quote stood outside cmd's quotes and ran as its
 * operator ('a"|b' piped into a command named b). A caret before each such character, with cmd's quote state followed
 * across the whole line, makes it literal; cmd removes the caret again.
 */
export function windowsCommandLine(args) {
  let out = '',
    open = false;
  for (const char of args.map(quoteWindows).join(' ')) {
    if (char === '"') open = !open;
    else if (!open && '()^<>&|'.includes(char)) out += '^';
    out += char;
  }
  return out;
}

export const USAGE = `usage: node scripts/gpu-lock.mjs run [--exclusive] [--max=<min>] [--wait-max=<min>] --owner=<id> -- <command...>
       node scripts/gpu-lock.mjs enqueue --owner=<id> [--max=<min>] [--wait-max=<min>] -- <command...>
       node scripts/gpu-lock.mjs wait <ticket> [--wait-max=<min>]
       node scripts/gpu-lock.mjs status

Runs a command while holding the GPU lock (test-results/gpu.lock of the main checkout), or prints the holders.
enqueue returns a ticket after queueing a detached command. Do CPU work, then wait for its result without losing its place.
Shared and exclusive requests retain FIFO order. wait timing out does not cancel the queued command.

Options:
  --exclusive                hold the whole GPU for speed measurement only
  --timing=<reason>          classify an otherwise unrecognized timing command (logged)
  --max=<min>                hold limit in minutes (default 20; exclusive GPU maximum 20)
  --wait-max=<min>           give up waiting after this many minutes (default 60)
  --owner=<id>              name shown to other waiters
  -h, --help                 print this help and exit

Example:
  node scripts/gpu-lock.mjs run --owner=me --max=15 -- node packages/sky/test/browser-check.mjs`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, ...rest] = process.argv.slice(2);
  // Help counts only before the `--` that starts the wrapped command, which may take its own --help.
  const own = process.argv.slice(2, process.argv.indexOf('--') < 0 ? undefined : process.argv.indexOf('--'));
  exitOnHelp(USAGE, own);
  if (verb === 'status') console.log(JSON.stringify(status()));
  else if (verb === 'beat-start') spawnBeat('beat', [...rest, String(process.pid)]);
  else if (verb === 'beat') {
    // The heartbeat process: node gpu-lock.mjs beat <entry file> <token> <holder pid> <deadline ms> [<starter pid>]
    const [file, token, parent, deadline, starter] = rest;
    const grace = Number(process.env.MARGO_GPU_GRACE_MS ?? 15_000);
    setInterval(() => {
      const entry = read(file);
      if (!entry || entry.token !== token) process.exit(0); // released
      if (!alive(Number(parent))) {
        rmSync(file, { force: true });
        process.exit(0);
      }
      if (Date.now() > Number(deadline) + grace) {
        // While the starter lives this process is still in the holder's tree. It exits as soon as it has started this
        // one; the bound is for its pid having gone to another process.
        if (starter && alive(Number(starter)) && Date.now() < Number(deadline) + grace + MIN) return;
        killTree(Number(parent));
        rmSync(file, { force: true });
        try {
          appendFileSync(
            join(dirname(lockDir), 'gpu-lock-timeouts.log'),
            `${new Date().toISOString()} TIMEOUT after ${entry.maxMinutes} min: ${entry.owner}: ${entry.command}\n`,
          );
        } catch {}
        process.exit(0);
      }
      try {
        const now = new Date();
        utimesSync(file, now, now);
      } catch {}
    }, beatMs());
  } else if (['enqueue', 'wait', 'queue-run'].includes(verb)) {
    const { createGpuQueue } = await import('./gpu-queue.mjs');
    await createGpuQueue({
      acquire,
      defaultMaxMinutes,
      lockDir,
      measuresSpeed,
      resolveMode,
      validateRequest,
      windowsCommandLine,
    }).queueCli(verb, rest);
  } else if (verb === 'run') {
    const split = rest.indexOf('--'),
      flags = rest.slice(0, split < 0 ? rest.length : split),
      flag = (name) => flags.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
      owner = flag('owner'),
      mode =
        flags.includes('--exclusive') || flag('timing') !== undefined || measuresSpeed(rest.slice(split + 1))
          ? 'exclusive'
          : undefined,
      command = rest.slice(split + 1);
    if (split < 0 || !command.length)
      throw new Error(
        'usage: gpu-lock.mjs run [--exclusive] [--max=<min>] [--wait-max=<min>] --owner=<id> -- <command...>',
      );
    const given = (name) => (flag(name) === undefined ? undefined : Number(flag(name)));
    for (const name of ['max', 'wait-max'])
      if (given(name) !== undefined && !(given(name) > 0))
        throw new RangeError(`--${name} must be a positive number of minutes`);
    // Each argument reaches the command as given, spaces and quotes included. Windows starts npm and other .cmd
    // tools only through cmd.exe, so there the command line is built with every argument quoted for it; elsewhere the
    // arguments go straight to the program.
    const windows = process.platform === 'win32',
      text = command.join(' ');
    let release;
    try {
      release = await acquire({
        owner,
        mode,
        timing: flag('timing'),
        max: given('max'),
        waitMax: given('wait-max'),
        command: text,
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    const maxMinutes = given('max') ?? defaultMaxMinutes(release.mode),
      env = {
        ...process.env,
        // MARGO_GPU_LOCK chose the lock this run holds. Under another lock the command's own GPU work must take the GPU
        // lock beside it, not this one again.
        ...(isGpuLock ? {} : { MARGO_GPU_LOCK: join(dirname(lockDir), 'gpu.lock') }),
        MARGO_GPU_LOCK_NESTED: join(lockDir, 'nested'),
        MARGO_GPU_LOCK_NESTED_MODE: release.mode,
      };
    const running = spawnLimited(windows ? windowsCommandLine(command) : command, {
      timeoutMs: maxMinutes * MIN,
      env,
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.on(signal, () => {
        killTree(running.child.pid);
        release();
        process.exit(130);
      });
    const { code, timedOut } = await running;
    release();
    if (timedOut) console.error(`TIMEOUT after ${+maxMinutes.toFixed(2)} min: ${text}`);
    process.exit(code);
  } else
    throw new Error(
      'usage: gpu-lock.mjs run [--exclusive] [--max=<min>] [--wait-max=<min>] --owner=<id> -- <command...> | status',
    );
}
