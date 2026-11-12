// A live mutex owner can be busy in synchronous code. Keep its directory fresh for older clients that only
// inspect mtime, independently of the main thread. Identity-aware clients never reclaim a live owner by age.
//
// The directory exists only during a critical section. The main thread tells this worker when it does through one shared
// Int32 (OWNER_*), and waits out a touch in progress before it removes the directory: on Windows a touch of a directory
// whose removal is pending fails with EPERM (measured: 59 of about 9,800 touches during 3,000 create and remove cycles),
// which used to end the worker and with it the whole gpu-lock process (KB-L6b-mb). With the handshake this worker never
// touches a directory that is being removed, so any failure it meets is a real one and still surfaces.
import { utimesSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** The owner directory is absent (between critical sections, or being removed): no touch. */
export const OWNER_ABSENT = 0;
/** The owner directory exists: the worker may touch it. */
export const OWNER_PRESENT = 1;
/** The worker is touching the owner directory right now: its removal waits. */
export const OWNER_TOUCHING = 2;

/** A new shared state for {@link touchOwner} and {@link quiesceOwner}. */
export const ownerState = () => new Int32Array(new SharedArrayBuffer(4));

/** Marks the owner directory present, once it and its owner.json exist. */
export function ownerPresent(state) {
  Atomics.store(state, 0, OWNER_PRESENT);
}

/** Touches `path` only while the main thread says it exists; returns whether it did. */
export function touchOwner(state, path, utimes = utimesSync) {
  if (Atomics.compareExchange(state, 0, OWNER_PRESENT, OWNER_TOUCHING) !== OWNER_PRESENT) return false;
  try {
    const now = new Date();
    utimes(path, now, now);
  } finally {
    Atomics.store(state, 0, OWNER_PRESENT);
    Atomics.notify(state, 0);
  }
  return true;
}

/**
 * Marks the owner directory absent, first waiting out a touch in progress (a single utimes call). After it returns no
 * touch is running or can start until {@link ownerPresent}.
 */
export function quiesceOwner(state, wait = (expected) => Atomics.wait(state, 0, expected, 50)) {
  for (;;) {
    const seen = Atomics.compareExchange(state, 0, OWNER_PRESENT, OWNER_ABSENT);
    if (seen !== OWNER_TOUCHING) return;
    wait(OWNER_TOUCHING);
  }
}

if (!isMainThread && workerData?.state) {
  const { path, state, intervalMs = 1_000 } = workerData;
  setInterval(() => touchOwner(state, path), intervalMs);
  parentPort.postMessage('ready');
}
