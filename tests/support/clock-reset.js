// GAP-FILM-RESET: a clock's `resetTime()` must leave it as a fresh one with the same options. Both are stepped the same
// after (a seek), and every field the next frame reads is compared: numbers, flags, counters, typed arrays and nested
// state, recursively. GPU objects, functions and the engine are left out; GPU history is compared through the flags
// (`valid`, `frameIndex`, ...) that make the next draw start it again.
import assert from 'node:assert/strict';

// A GPU object (buffer, texture, device): an engine part with a `destroy` of its own (a plugin, a view's state) is walked.
const gpuLike = (v) =>
  typeof v.setup !== 'function' &&
  typeof v.advanceTime !== 'function' &&
  (typeof v.destroy === 'function' ||
    typeof v.createView === 'function' ||
    typeof v.getMappedRange === 'function' ||
    typeof v.createBindGroup === 'function');
// An instance's own name (a serial) is identity, not time.
const skipped = new Set(['engine', 'device', 'gpu', 'options', 'name']);

/** A plain, comparable copy of `value`'s state. */
export function clockState(value, depth = 0, seen = new Set(), ignore = []) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (seen.has(value) || depth > 4 || gpuLike(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => clockState(v, depth + 1, seen));
    if (value instanceof Map)
      return [...value].map(([k, v]) => [clockState(k, depth + 1, seen), clockState(v, depth + 1, seen)]);
    if (value instanceof Set) return [...value].map((v) => clockState(v, depth + 1, seen));
    if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) return undefined;
    const out = {};
    for (const key of Object.keys(value).sort())
      if (!skipped.has(key) && !(depth === 0 && ignore.includes(key)))
        out[key] = clockState(value[key], depth + 1, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Frame deltas a run used before the reset: odd steps, a zero delta (a capture's redraw) and a long frame. */
export const usedDeltas = [1 / 60, 1 / 30, 0, 1 / 24, 0.25, 1 / 60, 0, 1 / 7];

/**
 * Asserts `make()`'s clock, run through `usedDeltas` (and `use`, standing in for the draws that leave history), then
 * reset, reads 0 and, seeked as far as a fresh one, holds the same state. `ignore` names top-level fields left out (a
 * flag that only re-uploads the same data).
 */
export function assertResetLikeFresh(make, { use, steps = 90, delta = 1 / 60, label = '', ignore = [] } = {}) {
  const state = (clock) => clockState(clock, 0, new Set(), ignore);
  const fresh = make(),
    used = make();
  for (let i = 0; i < 3; i++) for (const d of usedDeltas) used.advanceTime(d);
  use?.(used);
  assert.notDeepEqual(state(used), state(fresh), `${label}: the run changed nothing to reset`);
  used.resetTime();
  assert.equal(used.time ?? 0, 0, `${label}: time after resetTime`);
  assert.deepEqual(state(used), state(fresh), `${label}: reset state`);
  for (let i = 0; i < steps; i++) {
    fresh.advanceTime(delta);
    used.advanceTime(delta);
  }
  assert.deepEqual(state(used), state(fresh), `${label}: state after a seek of ${steps} steps`);
}
