import { existsSync, realpathSync, appendFileSync, readFileSync, truncateSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

export function worktreeIdentity(path) {
  let root = resolve(path);
  while (!existsSync(join(root, '.git')) && dirname(root) !== root) root = dirname(root);
  // Stand-in worktrees in CPU tests can be ordinary directories.
  if (!existsSync(join(root, '.git'))) root = resolve(path);
  root = existsSync(root) ? realpathSync(root) : root;
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

export function ownerLane(owner = '') {
  const lane = /(?:^|[^a-z0-9])lane[-_ ]?([a-z0-9]+)(?:$|[^a-z0-9])/i.exec(owner)?.[1];
  return lane ? `lane-${lane.toLowerCase()}` : owner.split(/[\s:/]/)[0].toLowerCase();
}

export function sameLane(a, b) {
  return Boolean(
    (a.worktree && b.worktree && worktreeIdentity(a.worktree) === worktreeIdentity(b.worktree)) ||
      (ownerLane(a.lane ?? a.owner) && ownerLane(a.lane ?? a.owner) === ownerLane(b.lane ?? b.owner)),
  );
}

/** FIFO among eligible lanes; a lane already holding a slot cannot block another lane. */
export function firstEligible(waiting, holders) {
  return waiting.find((request) => !holders.some((holder) => sameLane(request, holder)));
}

export function readUsage(file, now = Date.now()) {
  if (!existsSync(file)) return { freeSlotWaitMs: 0, freeSlotWaitSlotMs: 0, observedAt: now };
  const text = readFileSync(file, 'utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return { freeSlotWaitMs: 0, freeSlotWaitSlotMs: 0, observedAt: now };
  const complete = text.slice(0, end);
  if (!complete) return { freeSlotWaitMs: 0, freeSlotWaitSlotMs: 0, observedAt: now };
  const last = complete.split('\n').at(-1);
  const record = JSON.parse(last);
  const elapsed = Math.max(0, now - record.observedAt);
  return {
    ...record,
    freeSlotWaitMs: record.freeSlotWaitMs + (record.waiting && record.free ? elapsed : 0),
    freeSlotWaitSlotMs: record.freeSlotWaitSlotMs + (record.waiting ? elapsed * record.free : 0),
    observedAt: now,
  };
}

// Append-only records tolerate Windows status readers without replacing an open JSON file.
// Events are scheduler observations, not continuous GPU occupancy or legacy-client tracing.
export function observeUsage(file, state, capacity, now = Date.now()) {
  if (!state.waiting.length && !existsSync(file)) return;
  // All writers hold the scheduler mutex. A tail without a newline therefore
  // belongs to a crashed predecessor, not an active writer; it was never published.
  // Preserve every committed observation and discard only that incomplete tail.
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    const end = text.lastIndexOf('\n') + 1;
    if (end < text.length) truncateSync(file, Buffer.byteLength(text.slice(0, end)));
  }
  const previous = readUsage(file, now);
  const free = state.exclusive ? 0 : Math.max(0, capacity - state.shared.length);
  if (existsSync(file) && previous.free === free && previous.waiting === state.waiting.length) return;
  appendFileSync(file, JSON.stringify({ ...previous, free, waiting: state.waiting.length }) + '\n');
}
