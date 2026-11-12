// Imported first by every root test that names scripts/gpu-lock.mjs or a MARGO_GPU_ variable (tests/gpu-lock-env.test.js
// checks it). The lane that runs the tests sets lock settings of its own: MARGO_GPU_SLOTS=4 while the queue drains,
// MARGO_GPU_LOCK_NESTED inside `gpu-lock run`. A fixture that read them tested the lane, not the lock: "shared holders
// share ... (3 by default)" failed on every root run made with MARGO_GPU_SLOTS=4 (found in the KB-FL1 hunt,
// 2026-11-11). So every MARGO_GPU_ variable is removed, and MARGO_GPU_LOCK names a lock of this test process's own:
// a fixture that forgets to pass its own lock then takes, waits on and logs beside that one, never the machine's real
// GPU lock in the main checkout. Nothing is created here; gpu-lock makes the folder only if something takes the lock.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const key of Object.keys(process.env)) if (/^MARGO_GPU_/i.test(key)) delete process.env[key];

/** The lock this test process uses when a fixture names none. */
export const ownLock = join(tmpdir(), `gpu-lock-own-${process.pid}-${randomUUID()}`, 'gpu.lock');
process.env.MARGO_GPU_LOCK = ownLock;
