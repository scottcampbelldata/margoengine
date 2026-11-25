// The arithmetic of `Physics.advance`: how many fixed steps a frame of a shot is, in whole numbers. Kept out of `physics.ts` so that
// file stays free of `Math` (tests/step-path.test.js); nothing here uses `Math` either, and the counting is BigInt, so it is the same
// number in every engine.

/** A frame rate as whole numbers of frames in a whole number of seconds: `24`, or `{num: 24000, den: 1001}`. */
export type FrameRate = number | { num: number; den: number };

const whole = (x: unknown, what: string): bigint => {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0)
    throw new RangeError(`${what} must be a non-negative whole number; got ${String(x)}.`);
  return BigInt(x);
};

/**
 * The steps taken when frame `frame` of a shot at `rate` is on screen, and the fraction of the next step that has begun
 * (0 to below 1), for a world that steps `fixedTimestep` seconds at a time. `frame * den * stepsPerSecond / num`, floored, in integers.
 * @throws RangeError for a frame or a rate that is not whole numbers above what it needs to be, and for a `fixedTimestep` that is
 * not one over a whole number of steps a second (a frame must be able to land on a step).
 */
export function filmSteps(frame: number, rate: FrameRate, fixedTimestep: number): { steps: number; left: number } {
  const num = whole(typeof rate === 'number' ? rate : rate?.num, 'The rate'),
    den = whole(typeof rate === 'number' ? 1 : rate?.den, 'The rate');
  if (num === 0n || den === 0n)
    throw new RangeError('The rate must be above 0 frames a second. Pass 24, or {num: 24000, den: 1001}.');
  const perSecond = 1 / fixedTimestep,
    nearest = perSecond + 0.5 - ((perSecond + 0.5) % 1),
    off = perSecond - nearest;
  if (off > 1e-9 * perSecond || -off > 1e-9 * perSecond)
    throw new RangeError(
      `fixedTimestep ${fixedTimestep} s is not one over a whole number of steps a second, so frames do not land on steps. Use 1/60, 1/120 or the like.`,
    );
  const owed = whole(frame, 'The frame') * den * BigInt(nearest);
  return { steps: Number(owed / num), left: Number(owed % num) / Number(num) };
}
