// Per-Canvas `maxDpr`, built on the one pixel-ratio control core has: `globalThis.margoLow` (the light tier's cap, which
// also drops MSAA). Core takes no per-canvas option and is frozen, so the cap is page-wide while a Canvas holds it.
declare global {
  var margoLow: number | undefined;
}
const holds = new Set<{ value: number }>();
let saved: number | undefined;

function apply(): void {
  let cap = saved || Number.POSITIVE_INFINITY;
  for (const hold of holds) cap = Math.min(cap, hold.value);
  globalThis.margoLow = cap === Number.POSITIVE_INFINITY ? saved : cap;
}

/**
 * Lowers the engine's pixel-ratio cap to `value` until the returned function is called. Values of 2 or more change
 * nothing (the engine never exceeds 2); several holds use the lowest; the previous `margoLow` returns after the last.
 */
export function capPixelRatio(value: number): () => void {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value))
    throw new RangeError(`Canvas maxDpr must be a number above 0 (got ${String(value)}); try maxDpr={1}`);
  if (value >= 2) return () => {};
  const hold = { value };
  if (!holds.size) saved = globalThis.margoLow;
  holds.add(hold);
  apply();
  return () => {
    if (!holds.delete(hold)) return;
    if (holds.size) apply();
    else globalThis.margoLow = saved;
  };
}
