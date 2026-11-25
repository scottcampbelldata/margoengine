// The film clock: time as a frame number over a rational frame rate, and the number of whole solver ticks it holds, in
// integer arithmetic (docs/physics-framework.md, section 2). A float sum of frame deltas drifts: 1/24 added 24 times is not
// 1, so two solvers, or one shot rendered at 24 and at 60 fps, disagree about how many ticks have run. Here the time is the
// exact fraction (frame + offset) * den / num seconds, and `ticks(rate)` is floor(time * rate) computed exactly, so a tick
// count is a pure function of the frame and the rate: a seek is an assignment, a resumed render lands on the ticks of the
// original, and no film length or frame rate loses time.
//
// Solver rates are fixed in seconds, not tied to the frame rate: the dyadic rates 60 * 2^k Hz (k from 0 to 7), so two coupled
// solvers always meet on a shared tick, the faster one subcycling a whole power of two of steps (the framework's multirate rule;
// its sources are in docs/physics-framework.md, section 2). A frame samples the solver between the
// two ticks around it, with `alpha(rate)` the exact fraction of the way.

/** A rate as a fraction: `num` frames every `den` seconds (24000 / 1001 for the 23.976 of NTSC film). */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** A fraction of a frame, `num / den` with 0 <= num < den: the time of a motion-blur sub-frame inside its frame. */
export interface FrameOffset {
  readonly num: number;
  readonly den: number;
}

/** Options of {@link FilmClock}. */
export interface FilmClockOptions {
  /** Frames a second, a whole number or a fraction (default 24). */
  fps?: number | FrameRate;
  /** The frame it starts at (default 0). */
  frame?: number;
}

/** The dyadic solver rates: level k is 60 * 2^k ticks a second, k from 0 to 7 (60 to 7,680 Hz). */
export const SOLVER_RATE_LEVELS = 8;

/**
 * The solver rate of a level: 60 * 2^level ticks a second.
 * @throws RangeError for a level that is not a whole number from 0 to 7.
 */
export function solverRate(level: number): number {
  if (!Number.isInteger(level) || level < 0 || level >= SOLVER_RATE_LEVELS)
    throw new RangeError(`A solver rate level is a whole number from 0 to 7; got ${level}.`);
  return 60 * 2 ** level;
}

const LIMIT = 2 ** 31;
const whole = (value: number, low: number, high: number, what: string): bigint => {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new RangeError(`${what} must be a whole number from ${low} to ${high}; got ${value}.`);
  return BigInt(value);
};
const rateOf = (fps: number | FrameRate): FrameRate => {
  const rate = typeof fps === 'number' ? { num: fps, den: 1 } : fps;
  whole(rate?.num, 1, LIMIT, 'A frame rate numerator');
  whole(rate?.den, 1, LIMIT, 'A frame rate denominator');
  return { num: rate.num, den: rate.den };
};

/**
 * Film time, exact. The time is the frame plus an offset inside it, over a rational frame rate; every tick count and
 * fraction it gives is computed in integers, so it is the same on every machine and for every way the frame was reached.
 *
 * ```ts
 * const clock = new FilmClock({ fps: { num: 24000, den: 1001 } });
 * clock.frame = 37;            // a seek is an assignment
 * clock.ticks(120);            // whole ticks of 1/120 s since time 0
 * clock.alpha(120);            // how far the frame is between its two ticks, 0 <= alpha < 1
 * ```
 */
export class FilmClock {
  /** Frames a second, as a fraction. */
  readonly fps: FrameRate;
  #frame: bigint;
  #num = 0n;
  #den = 1n;

  /** @throws RangeError for a frame rate that is not a positive whole number or fraction of whole numbers below 2^31, or a bad frame. */
  constructor(options: FilmClockOptions = {}) {
    this.fps = rateOf(options.fps ?? 24);
    this.#frame = whole(options.frame ?? 0, 0, Number.MAX_SAFE_INTEGER, 'A frame');
  }

  /** The whole frame. Setting it seeks there, with no offset. */
  get frame(): number {
    return Number(this.#frame);
  }
  set frame(value: number) {
    this.#frame = whole(value, 0, Number.MAX_SAFE_INTEGER, 'A frame');
    this.#num = 0n;
    this.#den = 1n;
  }

  /** The fraction of the frame past `frame`, in lowest terms (0 / 1 on a whole frame). */
  get offset(): FrameOffset {
    return { num: Number(this.#num), den: Number(this.#den) };
  }

  /**
   * Seeks to `frame` plus `offset` of the next frame (a motion-blur sub-frame), so a sub-frame has an exact time and lands on
   * the same ticks in every render that draws it.
   * @throws RangeError for a bad frame, or an offset that is not `num / den` with whole numbers 0 <= num < den < 2^31.
   */
  at(frame: number, offset: FrameOffset = { num: 0, den: 1 }): this {
    const f = whole(frame, 0, Number.MAX_SAFE_INTEGER, 'A frame'),
      d = whole(offset?.den, 1, LIMIT, 'A frame offset denominator'),
      n = whole(offset?.num, 0, LIMIT, 'A frame offset numerator');
    if (n >= d) throw new RangeError(`A frame offset is less than one frame; got ${offset.num} / ${offset.den}.`);
    const g = gcd(n, d);
    this.#frame = f;
    this.#num = n / g;
    this.#den = d / g;
    return this;
  }

  /**
   * Moves on by `frames` whole frames (default 1), dropping any offset.
   * @throws RangeError for a count that is not a whole number of 0 or more, or a frame past the safe integers.
   */
  advance(frames = 1): this {
    const step = whole(frames, 0, Number.MAX_SAFE_INTEGER, 'Frames to advance');
    this.frame = Number(this.#frame + step);
    return this;
  }

  /** Seconds since frame 0, as a double: for display and shader uniforms. Tick counts come from {@link FilmClock.ticks}, never from this. */
  get time(): number {
    const [n, d] = this.#seconds(1n);
    return Number(n) / Number(d);
  }

  /**
   * The whole ticks of `rate` ticks a second that lie at or before the clock's time: floor(time * rate), exactly.
   * @throws RangeError for a rate that is not a whole number from 1 to 2^31, or a count past the safe integers.
   */
  ticks(rate: number): number {
    const [n, d] = this.#seconds(whole(rate, 1, LIMIT, 'A tick rate')),
      count = n / d;
    if (count > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError(`${count} ticks of ${rate} a second is past the safe integers; seek to an earlier frame.`);
    return Number(count);
  }

  /**
   * How far the clock's time is past its last whole tick of `rate`, as a fraction of a tick: time * rate - ticks(rate), in
   * [0, 1). A frame between two ticks is drawn at this fraction of the way from the earlier to the later.
   * @throws RangeError for a rate that is not a whole number from 1 to 2^31.
   */
  alpha(rate: number): number {
    const [n, d] = this.#seconds(whole(rate, 1, LIMIT, 'A tick rate'));
    return Number(n % d) / Number(d);
  }

  /** The time times `scale`, as an exact fraction: ((frame * den_o + num_o) * fps.den * scale) / (fps.num * den_o). */
  #seconds(scale: bigint): [bigint, bigint] {
    const numerator = (this.#frame * this.#den + this.#num) * BigInt(this.fps.den) * scale;
    return [numerator, BigInt(this.fps.num) * this.#den];
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}
