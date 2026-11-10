// Argument and cancellation checks shared by every lightmap entry; no other imports, so each entry stays small.

/** Yields to the event loop, then throws if `signal` aborted. */
export async function checkpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

/** Throws a RangeError naming `name` unless `value` is a number (an integer by default) from `min` to `max`. */
export function inRange(value: number, min: number, max: number, name: string, integer = true): number {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  return value;
}
