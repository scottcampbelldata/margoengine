import type { VFXExtension } from './base.js';
/** Most expanded burst cycles in an effect; bounds authoring and replay work. */
export const MAX_BURST_EVENTS = 16384;
/** A repeated timed birth event. All settings are captured at attachment. */
export interface VFXScheduledBurst {
  /** Seconds from effect start, 0..1,000,000. */
  time: number;
  /** Birth count, whole 0..capacity; total frame births are capped by capacity/dead slots. */
  count: number;
  /** Whole repetitions, 1..16,384. Default 1. */
  cycles?: number;
  /** Seconds between repetitions, 0..1,000,000. Default 0. */
  interval?: number;
  /** Independent chance per repetition, 0..1. Default 1. */
  probability?: number;
}
/** Deterministic prewarm and burst scheduling, fixed at attachment. Reset repeats the same schedule. */
export interface VFXSchedule {
  /** Seconds to simulate before the first visible frame, 0..3600. Default 0. */
  prewarm?: number;
  /** Warmup step in seconds, 0.001..1, with at most 10,000 steps. Default 1/60. */
  step?: number;
  /** Up to 1024 burst definitions and 16,384 expanded cycles. Default empty. */
  bursts?: readonly VFXScheduledBurst[];
  /** Unsigned 32-bit seed for burst probabilities. Default 0. */
  seed?: number;
}
const number = (v: unknown, name: string, min: number, max: number, whole = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v)))
    throw new RangeError(
      `VFX schedule ${name} must be ${min}..${max}${whole ? ' whole' : ''}; pass a finite value in range`,
    );
};
const hash = (value: number) => {
  let n = value >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
};
/** Prewarm by ordinary submitted simulation steps, plus deterministic time/cycle/probability bursts. */
export const schedule: VFXExtension<VFXSchedule> = {
  validate(value, options) {
    if (!value || typeof value !== 'object') throw new TypeError('VFX schedule needs an object; pass {prewarm: 1}');
    number(value.prewarm ?? 0, 'prewarm', 0, 3600);
    number(value.step ?? 1 / 60, 'step', 0.001, 1);
    number(value.seed ?? 0, 'seed', 0, 0xffffffff, true);
    if (Math.ceil((value.prewarm ?? 0) / (value.step ?? 1 / 60)) > 10000)
      throw new RangeError('VFX prewarm exceeds 10000 steps; increase step or reduce duration');
    if (value.bursts !== undefined && (!Array.isArray(value.bursts) || value.bursts.length > 1024))
      throw new TypeError('VFX schedule bursts need at most 1024 definitions; pass an array');
    let cycles = 0;
    for (const burst of value.bursts ?? []) {
      if (!burst || typeof burst !== 'object')
        throw new TypeError('VFX schedule burst needs time and count; pass an object');
      number(burst.time, 'time', 0, 1e6);
      number(burst.count, 'count', 0, options.capacity ?? 1e6, true);
      number(burst.cycles ?? 1, 'cycles', 1, MAX_BURST_EVENTS, true);
      number(burst.interval ?? 0, 'interval', 0, 1e6);
      number(burst.probability ?? 1, 'probability', 0, 1);
      cycles += burst.cycles ?? 1;
    }
    if (cycles > MAX_BURST_EVENTS)
      throw new RangeError('VFX schedule exceeds 16384 burst cycles; reduce its repetitions');
  },
  create(_state, value) {
    const events: { time: number; count: number }[] = [];
    for (const [index, burst] of (value.bursts ?? []).entries())
      for (let cycle = 0; cycle < (burst.cycles ?? 1); cycle++) {
        const random = hash((value.seed ?? 0) ^ hash(index + 1) ^ Math.imul(cycle + 1, 0x9e3779b9)) / 4294967296;
        if (random < (burst.probability ?? 1))
          events.push({ time: burst.time + cycle * (burst.interval ?? 0), count: burst.count });
      }
    events.sort((a, b) => a.time - b.time);
    const duration = value.prewarm ?? 0,
      step = value.step ?? 1 / 60;
    let clock = 0,
      cursor = 0,
      pending = true;
    return {
      warmup(run) {
        if (!pending) return;
        pending = false;
        const full = Math.floor(duration / step);
        for (let i = 0; i < full; i++) run(step);
        const tail = duration - full * step;
        if (tail > 0) run(tail);
      },
      emission(delta) {
        clock += delta;
        let count = 0;
        while (cursor < events.length && events[cursor].time <= clock) count += events[cursor++].count;
        return count;
      },
      reset() {
        clock = 0;
        cursor = 0;
        pending = true;
      },
    };
  },
};
