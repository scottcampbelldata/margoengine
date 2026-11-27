// Deterministic 32-bit seeded pseudo-random generator (SplitMix32 + Mulberry32) for repeatable Voronoi fracture.

/** Deterministic pseudo-random generator for seeded fracture site placement. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Mix seed with SplitMix32 finalizer so small consecutive integers (0, 1, 2) start well-separated.
    let s = (seed | 0) + 0x9e3779b9;
    s = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
    s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
    this.state = (s ^ (s >>> 16)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Approximate standard normal sample (mean 0, stddev 1) via Box-Muller transform. */
  gaussian(): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
