// Counter-based random numbers for the physics world: Philox4x32-10 (Salmon, Moraes, Dror and Shaw, "Parallel random numbers:
// as easy as 1, 2, 3", SC 2011, section 4.3), the TypeScript twin of the kernels' Rust generator (kernel-common, K02), with
// the same key and counter layout, so a solver gets the same numbers in either language. A number is a pure function of its
// key and counter, never of a sequence drawn before it, so a solver gets the same numbers whatever order it visits its
// elements in, however many threads share the work, and after a seek or a restore. Exact in 32-bit integer arithmetic
// (Math.imul and a 16-bit split for the high word of a product).

/** Philox-4x32 multipliers (Salmon et al. 2011, section 4.3). */
const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
/** Weyl increments of the key (the upper 32 bits of the golden ratio and of sqrt(3) - 1, as the paper's section 4.2 gives). */
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;
/** Rounds: Philox4x32-10, three past the seven that pass BigCrush (the paper's choice for safety). */
const ROUNDS = 10;

/** The high 32 bits of the 64-bit product of two unsigned 32-bit words, exactly. */
function mulhi(a: number, b: number): number {
  const al = a & 0xffff,
    ah = a >>> 16,
    bl = b & 0xffff,
    bh = b >>> 16,
    low = al * bl,
    cross1 = ah * bl,
    cross2 = al * bh,
    middle = (low >>> 16) + (cross1 & 0xffff) + (cross2 & 0xffff);
  return (ah * bh + (cross1 >>> 16) + (cross2 >>> 16) + (middle >>> 16)) >>> 0;
}

/**
 * Philox4x32-10 of a counter (four words) under a key (two words), into `out` (four unsigned words). Each round splits the
 * counter into two pairs and runs the Philox S-box on each, L' = mullo(R, M), R' = mulhi(R, M) ^ k ^ L, with the words of the
 * pairs swapped between rounds; the key steps by the Weyl increments.
 */
export function philox(
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  k0: number,
  k1: number,
  out: Uint32Array = new Uint32Array(4),
): Uint32Array {
  let x0 = c0 >>> 0,
    x1 = c1 >>> 0,
    x2 = c2 >>> 0,
    x3 = c3 >>> 0,
    key0 = k0 >>> 0,
    key1 = k1 >>> 0;
  for (let round = 0; round < ROUNDS; round++) {
    const hi0 = mulhi(M0, x0),
      lo0 = Math.imul(M0, x0) >>> 0,
      hi1 = mulhi(M1, x2),
      lo1 = Math.imul(M1, x2) >>> 0;
    x0 = (hi1 ^ x1 ^ key0) >>> 0;
    x1 = lo1;
    x2 = (hi0 ^ x3 ^ key1) >>> 0;
    x3 = lo0;
    key0 = (key0 + W0) >>> 0;
    key1 = (key1 + W1) >>> 0;
  }
  out[0] = x0;
  out[1] = x1;
  out[2] = x2;
  out[3] = x3;
  return out;
}

const TWO_24 = 5.9604644775390625e-8; // 2^-24
const TWO_32 = 4294967296; // 2^32
const TWO_53 = 1.1102230246251565e-16; // 2^-53

/**
 * The random numbers of one (seed, solver, tick, element) and its streams, the same as the kernels' Rust `Random`
 * (`packages/physics/kernel-common/src/random.rs`) bit for bit: the key is the seed's two 32-bit words, the counter is
 * [element, solver << 16 | stream, tick low word, tick high word]. A draw is a pure function of those, never of what was
 * drawn before.
 */
export class RandomStream {
  private readonly words = new Uint32Array(4);
  /** The world's seed: a whole number from 0 to 2^53. */
  readonly seed: number;
  /** The solver's number, 16 bits ({@link solverNumber}). */
  readonly solver: number;
  private readonly k0: number;
  private readonly k1: number;

  /** @throws RangeError for a seed outside 0..2^53 or a solver number outside 0..65535. */
  constructor(seed: number, solver: number) {
    if (!(Number.isSafeInteger(seed) && seed >= 0) || !isShort(solver))
      throw new RangeError(
        `A random stream takes a seed from 0 to 2^53 and a solver number from 0 to 65535 (got ${seed} and ${solver}); use solverNumber(id).`,
      );
    this.seed = seed;
    this.solver = solver;
    this.k0 = seed % TWO_32;
    this.k1 = Math.floor(seed / TWO_32);
  }

  /**
   * The four random words of (tick, element, stream), into `out`. The tick is a whole number up to 2^53, the element a
   * 32-bit word, the stream 16 bits.
   * @throws RangeError for any of them out of range.
   */
  block(tick: number, element: number, stream = 0, out: Uint32Array = new Uint32Array(4)): Uint32Array {
    if (!(Number.isSafeInteger(tick) && tick >= 0) || !isWord(element) || !isShort(stream))
      throw new RangeError(
        `A random draw takes a tick from 0 to 2^53, an element from 0 to 4294967295 and a stream from 0 to 65535 (got ${tick}, ${element}, ${stream}).`,
      );
    return philox(
      element,
      ((this.solver << 16) | stream) >>> 0,
      tick % TWO_32,
      Math.floor(tick / TWO_32),
      this.k0,
      this.k1,
      out,
    );
  }

  /** Two numbers of [0, 1) of (tick, element, stream), 53 random bits each, into `out`: Rust's `unit_f64`. */
  unitF64(tick: number, element: number, stream = 0, out: [number, number] = [0, 0]): [number, number] {
    const b = this.block(tick, element, stream, this.words);
    out[0] = (b[0]! * 2097152 + (b[1]! >>> 11)) * TWO_53;
    out[1] = (b[2]! * 2097152 + (b[3]! >>> 11)) * TWO_53;
    return out;
  }

  /** Four numbers of [0, 1) of (tick, element, stream), 24 random bits each (exact in f32), into `out`: Rust's `unit_f32`. */
  unitF32(tick: number, element: number, stream = 0, out: Float32Array | number[] = new Float32Array(4)) {
    const b = this.block(tick, element, stream, this.words);
    for (let i = 0; i < 4; i++) out[i] = (b[i]! >>> 8) * TWO_24;
    return out;
  }

  /**
   * Four whole numbers of [0, n) of (tick, element, stream), by Lemire's multiply-shift without rejection, into `out`:
   * Rust's `below`.
   * @throws RangeError for an n outside 1..2^32 - 1.
   */
  below(tick: number, element: number, stream: number, n: number, out: Uint32Array = new Uint32Array(4)): Uint32Array {
    if (!isWord(n) || n === 0) throw new RangeError(`below(n) takes n from 1 to 4294967295 (got ${n}).`);
    const b = this.block(tick, element, stream, this.words);
    for (let i = 0; i < 4; i++) out[i] = mulhi(b[i]!, n);
    return out;
  }

  /** One number of [0, 1) with 53 random bits: the first of {@link RandomStream.unitF64}. */
  uniform(tick: number, element: number, stream = 0): number {
    const b = this.block(tick, element, stream, this.words);
    return (b[0]! * 2097152 + (b[1]! >>> 11)) * TWO_53;
  }
}

function isWord(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 4294967295;
}

function isShort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

const encoder = new TextEncoder();

/**
 * A solver's number for keying its random numbers: the 32-bit FNV-1a hash of its id's UTF-8 bytes (G. Fowler, L. C. Noll and
 * K.-P. Vo; D. Eastlake et al., "The FNV Non-Cryptographic Hash Algorithm", IETF draft) xor-folded to 16 bits as that draft
 * gives for shorter hashes, so it is the same in every world, whatever order solvers were added in. A world refuses two
 * solvers with one number.
 */
export function solverNumber(id: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(id)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return ((h >>> 16) ^ (h & 0xffff)) >>> 0;
}
