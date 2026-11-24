// The clock the kernel reads at the phase boundaries of a step, to fill `KernelWorld.timing`. It is its own file because
// the files of a step may not name a clock (tests/step-path.test.js): this reading goes into a field the kernel keeps
// outside the world's block and never reads back, so it cannot change a step, a snapshot or the hash.

/** Milliseconds on a clock that only goes forward. */
export const clock = (): number => performance.now();
