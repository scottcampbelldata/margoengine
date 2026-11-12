// One package build at a time in a checkout. build-modern removes a package's dist before it writes the new one, so two
// builds of the same packages at once delete each other's output (KB-RM4, 2026-11-11: in the 15:00 full CI run two root
// tests ran api:check side by side, both found the same six packages stale and rebuilt them together; one build died on
// ENOTEMPTY while removing game/dist, and packages/web/dist stayed missing for every later step).
//
// The lock is a folder (mkdir is atomic on every platform) holding owner.json with the holder's pid and start time. A
// holder whose process is gone, or that has held it past the hard limit, is reclaimed. A waiter gives up at its own
// time limit with a coded error that names the holder. A child build started by the holder (api-report's rebuild) gets
// MARGOENGINE_BUILD_LOCK in its environment and does not wait on its parent.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Lock folder, relative to the repository root (test-results/ is ignored by git). */
export const BUILD_LOCK_DIR = 'test-results/package-build.lock';
/** Environment variable a holder passes to the builds it starts itself. */
export const BUILD_LOCK_ENV = 'MARGOENGINE_BUILD_LOCK';
/** A full build:packages takes about 40 s on the dev PC and under 5 min on the slowest machine; past this it is hung. */
export const BUILD_LOCK_HARD_LIMIT_MS = 30 * 60_000;

const UNOWNED_LIMIT_MS = 10_000;

function folderTime(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Infinity;
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Takes the build lock of the checkout at `root` and returns a function that releases it. Returns a no-op when the
 * environment says a parent process already holds it. Waits while a live holder builds, up to `timeoutMs`.
 */
export function acquireBuildLock(
  root,
  { env = process.env, timeoutMs = BUILD_LOCK_HARD_LIMIT_MS, pollMs = 250, now = Date.now, log = console.error } = {},
) {
  const dir = join(root, BUILD_LOCK_DIR);
  const held = readOwner(dir);
  if (env[BUILD_LOCK_ENV] && held && String(held.pid) === env[BUILD_LOCK_ENV]) return () => {};
  const start = now();
  let told = false;
  for (;;) {
    mkdirSync(join(root, 'test-results'), { recursive: true });
    try {
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, started: new Date(now()).toISOString() })}\n`,
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readOwner(dir)?.pid === process.pid) rmSync(dir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(dir);
    if (owner && (!alive(owner.pid) || now() - Date.parse(owner.started) > BUILD_LOCK_HARD_LIMIT_MS)) {
      log(
        `build lock: reclaiming ${BUILD_LOCK_DIR} from pid ${owner.pid} (${alive(owner.pid) ? 'past its hard limit' : 'gone'})`,
      );
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    // A folder with no owner file is a holder between its mkdir and its write, or one that died there.
    if (!owner && now() - folderTime(dir) > UNOWNED_LIMIT_MS) {
      log(`build lock: reclaiming ${BUILD_LOCK_DIR}, which has had no owner for ${UNOWNED_LIMIT_MS / 1000} s`);
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (now() - start > timeoutMs) {
      const error = new Error(
        `build lock: ${BUILD_LOCK_DIR} still held by pid ${owner?.pid ?? 'unknown'} after ${Math.round(timeoutMs / 1000)} s; ` +
          'another package build is running in this checkout',
      );
      error.code = 'MARGO_BUILD_LOCK_TIMEOUT';
      throw error;
    }
    if (!told) {
      log(`build lock: waiting for the package build of pid ${owner?.pid ?? 'unknown'} to finish`);
      told = true;
    }
    sleep(pollMs);
  }
}
