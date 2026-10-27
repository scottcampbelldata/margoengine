// A wind field: a mean wind that gusts and shifts over time, plus turbulence that differs from place to place. Pure and
// deterministic: the same options and the same (position, time) give the same vector, so replays and tests agree.

/** Settings of a {@link WindField}. */
export interface WindOptions {
  /** Mean speed in metres per second, 0 to 60. Default 5. */
  speed?: number;
  /** Direction the wind blows toward in radians; 0 is +Z, pi/2 is +X. Default 0. */
  direction?: number;
  /** Gustiness 0..1: how far the speed swings above and below the mean (up to +-gust of it) and how far the direction wobbles (up to 0.5 gust radians). Default 0.3. */
  gust?: number;
  /** Local turbulence 0..1 as a share of the speed that varies from place to place. Default 0.2. */
  turbulence?: number;
  /** Seconds between gusts (the period of the slowest swing), 0.5 to 600. Default 8. */
  gustPeriod?: number;
  /** Metres over which turbulence changes, 1 to 10,000. Default 30. */
  scale?: number;
  /** Seed of the noise: a different seed gives a different but equally plausible wind. Default 1. */
  seed?: number;
}

const check = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Wind ${name} must be a finite number from ${min} to ${max}; got ${String(value)}`);
  return value;
};

// Integer hash (the PCG output function) to a value in [-1, 1]. Exact in 32-bit integer maths, so equal everywhere.
function hash(x: number, y: number, z: number, w: number, seed: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^
      Math.imul(y | 0, 0x165667b1) ^
      Math.imul(z | 0, 0x9e3779b1) ^
      Math.imul(w | 0, 0x85ebca6b) ^
      seed) >>>
    0;
  h = (Math.imul(h, 747796405) + 2891336453) >>> 0;
  h = Math.imul((h >>> ((h >>> 28) + 4)) ^ h, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return (h / 4294967295) * 2 - 1;
}
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth value noise in [-1, 1] over four dimensions (three of space, one of time), continuous everywhere. */
export function valueNoise(x: number, y: number, z: number, w: number, seed = 0): number {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    z0 = Math.floor(z),
    w0 = Math.floor(w);
  const fx = fade(x - x0),
    fy = fade(y - y0),
    fz = fade(z - z0),
    fw = fade(w - w0);
  const at = (i: number, j: number, k: number, l: number) => hash(x0 + i, y0 + j, z0 + k, w0 + l, seed);
  const row = (j: number, k: number, l: number) => lerp(at(0, j, k, l), at(1, j, k, l), fx);
  const plane = (k: number, l: number) => lerp(row(0, k, l), row(1, k, l), fy);
  const volume = (l: number) => lerp(plane(0, l), plane(1, l), fz);
  return lerp(volume(0), volume(1), fw);
}

/** Wind as a function of place and time. */
export class WindField {
  private o: Required<WindOptions>;

  constructor(options: WindOptions = {}) {
    this.o = {
      speed: 5,
      direction: 0,
      gust: 0.3,
      turbulence: 0.2,
      gustPeriod: 8,
      scale: 30,
      seed: 1,
      ...options,
    };
    this.validate();
  }

  private validate(): void {
    const o = this.o;
    check(o.speed, 'speed', 0, 60);
    check(o.direction, 'direction', -1000, 1000);
    check(o.gust, 'gust', 0, 1);
    check(o.turbulence, 'turbulence', 0, 1);
    check(o.gustPeriod, 'gustPeriod', 0.5, 600);
    check(o.scale, 'scale', 1, 10000);
    check(o.seed, 'seed', -2147483648, 4294967295);
  }

  /** The current settings (a copy). */
  get options(): Readonly<Required<WindOptions>> {
    return { ...this.o };
  }

  /** Changes settings. Throws RangeError for a bad value and keeps the old settings. */
  set(options: WindOptions): this {
    const before = this.o;
    this.o = { ...before, ...options };
    try {
      this.validate();
    } catch (error) {
      this.o = before;
      throw error;
    }
    return this;
  }

  /** Speed multiplier from gusts at time `t` seconds, between `1 - gust` and `1 + gust` (it is the same everywhere). */
  gustFactor(t: number): number {
    const o = this.o,
      u = t / o.gustPeriod,
      s = o.seed | 0;
    // Two swings, one slow and one at about a third of the period, so gusts are not a single sine wave.
    return 1 + o.gust * (0.7 * valueNoise(u, 0, 0, 0, s) + 0.3 * valueNoise(u * 3.1, 7, 0, 0, s ^ 0x5bd1e995));
  }

  /** Direction (radians) at time `t`: the mean direction plus a wobble of up to `0.5 * gust` radians. */
  directionAt(t: number): number {
    const o = this.o;
    return o.direction + 0.5 * o.gust * valueNoise(t / (o.gustPeriod * 1.7), 3, 0, 0, (o.seed | 0) ^ 0x1b873593);
  }

  /**
   * Wind velocity `[x, y, z]` in metres per second at a world position and time. Horizontal wind is the gusting mean
   * plus turbulence that drifts downwind; vertical wind is a small share of the speed. Never longer than
   * `speed * (1 + gust + turbulence)`.
   */
  sample(
    x: number,
    y: number,
    z: number,
    t: number,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    const o = this.o,
      s = o.seed | 0;
    const speed = o.speed * this.gustFactor(t),
      direction = this.directionAt(t),
      dx = Math.sin(direction),
      dz = Math.cos(direction);
    // The noise pattern travels with the mean wind (at its mean speed), so turbulence blows past like real air.
    const px = (x - dx * o.speed * t) / o.scale,
      pz = (z - dz * o.speed * t) / o.scale,
      py = y / o.scale,
      pt = t / (o.gustPeriod * 2);
    const along = valueNoise(px, py, pz, pt, s ^ 0x68e31da4),
      across = valueNoise(px + 31.7, py, pz - 17.3, pt, s ^ 0xb5297a4d),
      lift = valueNoise(px - 9.1, py + 5.2, pz + 3.3, pt, s ^ 0x1b56c4e9);
    const turb = o.turbulence * o.speed;
    const forward = speed + turb * along * 0.5,
      sideways = turb * across * 0.5;
    out[0] = dx * forward + dz * sideways;
    out[1] = turb * lift * 0.25;
    out[2] = dz * forward - dx * sideways;
    return out;
  }
}
