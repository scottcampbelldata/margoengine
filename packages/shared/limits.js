// Per-file node and part caps (HANDOFF 5j, docs/limits.md): they bound memory for untrusted files at 100,000 by default,
// and an option raises them up to core's entity cap (2^23 slots).

/** Validates the count-cap option `name`: an integer from 1 to 8,388,608 (default 100,000). */
export function countLimit(name, value = 100_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8_388_608)
    throw new RangeError(`${name} must be an integer from 1 to 8388608`);
  return value;
}

/** Throws `RangeError: <message> (<count> > <limit>; raise the <name> option)` when `count` exceeds `limit`. */
export function checkCount(message, count, limit, name) {
  if (count > limit) throw new RangeError(`${message} (${count} > ${limit}; raise the ${name} option)`);
}
