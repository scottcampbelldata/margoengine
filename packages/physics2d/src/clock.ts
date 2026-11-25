// The clock the kernel reads at the phase boundaries of a step, to fill `Physics2D.timing`. It is its own file because a
// reading goes into a field the kernel keeps outside the world's state and never reads back, so it cannot change a step,
// a snapshot or the hash.

/** Milliseconds on a clock that only goes forward. */
export const clock = (): number => performance.now();
