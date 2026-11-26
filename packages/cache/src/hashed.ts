import { fault, typeError } from '../../shared/errors.js';
import type { AssetCache } from './index.js';

const hex = (digest: Uint8Array) => Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The hash of a file's bytes, as lowercase SHA-256 hex; for building a manifest. */
export async function hashBytes(data: BufferSource): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

// SHA-256 (NIST FIPS 180-4, sections 4.1.2, 4.2.2, 5.1.1, 5.3.3 and 6.2). The constants are worked out as the standard
// defines them: the first 32 bits of the fractional parts of the cube roots of the first 64 primes (K) and of the square
// roots of the first 8 (the initial hash). Doubles carry those 32 bits exactly for primes this small.
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const fraction = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0,
  K = Uint32Array.from(PRIMES, (p) => fraction(Math.cbrt(p))),
  INITIAL = Uint32Array.from(PRIMES.slice(0, 8), (p) => fraction(Math.sqrt(p)));

/** Options of {@link SHA256} and {@link hashStream}. */
export interface SHA256Options {
  /**
   * Use the runtime's own incremental SHA-256 where it offers one through `process.getBuiltinModule('node:crypto')`
   * (Node 22.3 and later): the same hex, several times as fast as the JavaScript (measured in
   * docs/whitepaper/perf-history.md, KB-CACHE-HASHSTREAM-SPEED). Default true. False, or a runtime without it
   * (browsers, workers), runs the plain JavaScript.
   */
  native?: boolean;
}

/** The incremental hash a runtime offers, when it has one. */
interface RuntimeHash {
  update(bytes: Uint8Array): unknown;
  digest(encoding: 'hex'): string;
}

/*
 * Why the runtime digest and not a faster JavaScript or Wasm core: SHA-256 of one stream is serial, each 64-byte block
 * needing the state the one before left (NIST FIPS 180-4, 2015, doi:10.6028/NIST.FIPS.180-4, 6.2.2). SIMD speeds it
 * only across the message schedule or across several independent streams (Gueron and Krasnov, Parallelizing message
 * schedules to accelerate the computations of hash functions, J. Cryptographic Engineering 2(4), 2012,
 * doi:10.1007/s13389-012-0037-z), while the large gain for one stream comes from dedicated round instructions (Gulley,
 * Gopal, Yap, Feghali, Guilford and Wolrich, Intel SHA Extensions, Intel white paper, 2013), which the runtime's own
 * digest uses where the processor has them and Wasm cannot reach. The JavaScript stays for browsers and workers.
 */
function runtimeHash(): RuntimeHash | undefined {
  // getBuiltinModule loads a built-in without an import, so bundlers for the browser see nothing to resolve.
  const runtime = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process,
    crypto = runtime?.getBuiltinModule?.('node:crypto') as
      | { createHash?: (algorithm: string) => RuntimeHash }
      | undefined;
  return typeof crypto?.createHash === 'function' ? crypto.createHash('sha256') : undefined;
}

/**
 * SHA-256 over bytes given in any number of pieces, for a file too large to hold whole; `digest()` gives the same hex as
 * {@link hashBytes} of the joined bytes. It uses the runtime's own digest where there is one (see `native`), else plain
 * JavaScript, which runs where `crypto.subtle` has no incremental digest.
 */
export class SHA256 {
  /** `'native'` when the runtime's digest does the work, `'js'` for the plain JavaScript. */
  readonly engine: 'native' | 'js';
  private readonly runtime: RuntimeHash | undefined;
  private readonly state = INITIAL.slice();
  private readonly block = new Uint8Array(64);
  private readonly words = new Int32Array(64);
  private filled = 0;
  private length = 0;
  private done = false;

  constructor({ native = true }: SHA256Options = {}) {
    this.runtime = native ? runtimeHash() : undefined;
    this.engine = this.runtime ? 'native' : 'js';
  }

  /** Adds the next bytes. Returns this. */
  update(bytes: Uint8Array): this {
    if (this.done) throw fault('state', 'This SHA256 has given its digest; start a new one for more bytes', 'cache');
    if (!(bytes instanceof Uint8Array))
      throw typeError('SHA256.update takes a Uint8Array; wrap other views first', 'cache');
    this.length += bytes.length;
    if (this.runtime) {
      this.runtime.update(bytes);
      return this;
    }
    let at = 0;
    if (this.filled) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      at = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    // Whole blocks are read in place, with no copy and no view per block.
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.filled = bytes.length - at;
    }
    return this;
  }

  /** The hash of every byte added, as lowercase hex. The hash is then finished. */
  digest(): string {
    if (this.done) throw fault('state', 'This SHA256 has given its digest; start a new one for more bytes', 'cache');
    this.done = true;
    if (this.runtime) return this.runtime.digest('hex');
    // Padding (5.1.1): a 1 bit, zeros, then the length in bits as a 64-bit big-endian number.
    const bits = this.length * 8;
    this.block[this.filled++] = 0x80;
    if (this.filled > 56) {
      this.block.fill(0, this.filled);
      this.compress(this.block, 0);
      this.filled = 0;
    }
    this.block.fill(0, this.filled, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bits / 2 ** 32));
    view.setUint32(60, bits >>> 0);
    this.compress(this.block, 0);
    const out = new DataView(new ArrayBuffer(32));
    this.state.forEach((word, i) => out.setUint32(i * 4, word));
    return hex(new Uint8Array(out.buffer));
  }

  /**
   * One 64-byte block of `b` from `at` into the state (6.2.2). Words stay signed 32-bit integers (`| 0`) and the
   * working variables are locals, so the loop runs on small integers with no allocation.
   */
  private compress(b: Uint8Array, at: number): void {
    const w = this.words,
      h = this.state;
    for (let t = 0; t < 16; t++, at += 4) w[t] = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15],
        y = w[t - 2],
        s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3),
        s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0] | 0,
      bb = h[1] | 0,
      c = h[2] | 0,
      d = h[3] | 0,
      e = h[4] | 0,
      f = h[5] | 0,
      g = h[6] | 0,
      hh = h[7] | 0;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)),
        t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0,
        S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)),
        t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
}

/** Chunks of a file: an async or plain iterable of byte arrays (a Node read stream is one) or a web ReadableStream. */
export type ByteChunks = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | ReadableStream<Uint8Array>;

/**
 * The SHA-256 of a file read in chunks, as lowercase hex: the same as {@link hashBytes} of the whole file, holding one
 * chunk at a time. `signal` stops it between chunks; the promise rejects with its reason.
 */
export async function hashStream(
  chunks: ByteChunks,
  { signal, native }: { signal?: AbortSignal } & SHA256Options = {},
): Promise<string> {
  signal?.throwIfAborted();
  if (chunks === null || typeof chunks !== 'object')
    throw typeError(
      'hashStream takes an iterable of Uint8Array chunks or a ReadableStream; pass a file stream',
      'cache',
    );
  const hash = new SHA256({ native }),
    source =
      typeof (chunks as { getReader?: unknown }).getReader === 'function' && !(Symbol.asyncIterator in chunks)
        ? readerChunks(chunks as unknown as ReadableStream<Uint8Array>)
        : (chunks as AsyncIterable<Uint8Array> | Iterable<Uint8Array>);
  if (!(Symbol.asyncIterator in source || Symbol.iterator in source))
    throw typeError(
      'hashStream takes an iterable of Uint8Array chunks or a ReadableStream; pass a file stream',
      'cache',
    );
  for await (const chunk of source) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  return hash.digest();
}

/** A ReadableStream's chunks, for runtimes whose streams are not async iterable. */
async function* readerChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
const versioned = (url: string, hash: string) => {
  const at = url.indexOf('#'),
    plain = at < 0 ? url : url.slice(0, at);
  return `${plain}${plain.includes('?') ? '&' : '?'}v=${hash}`;
};

/**
 * Per-file versioning for an {@link AssetCache}. A manifest maps each URL to the SHA-256 of its bytes, so a release drops
 * only the files that changed, where the cache's own `version` drops all of them. A listed file is requested as
 * `url?v=<hash>`, kept under that name, and its bytes are checked once per session. A stored copy is read without asking
 * the server (`cache: 'force-cache'`, unless the request names another mode), as the bytes of a hash cannot change.
 * Files not listed pass straight through. Pass `assets.fetch` as a loader's `fetch` option.
 */
export class HashedAssets {
  private manifest: Readonly<Record<string, string>>;
  private readonly checked = new Set<string>();
  /** Names whose bytes were wrong: the next request goes past every HTTP cache. */
  private readonly rejected = new Set<string>();

  constructor(
    private readonly cache: Pick<AssetCache, 'fetch' | 'delete'>,
    manifest: Readonly<Record<string, string>>,
  ) {
    this.manifest = manifest;
  }
  /**
   * Fetch-compatible, by a listed file's URL as the manifest spells it.
   * @throws MargoError `'failed'` when the bytes do not match the manifest; the stored copy is dropped first.
   */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input),
      hash = this.manifest[url];
    if (!hash) return this.cache.fetch(input, init);
    const name = versioned(url, hash),
      given = init?.cache ?? (input instanceof Request ? input.cache : 'default'),
      cache = given !== 'default' ? given : this.rejected.has(name) ? 'reload' : 'force-cache',
      // A Request keeps its signal, headers and credentials on the versioned URL.
      response = await this.cache.fetch(input instanceof Request ? new Request(name, input) : name, { ...init, cache });
    if (!response.ok || this.checked.has(name)) return response;
    const actual = await hashBytes(await response.clone().arrayBuffer());
    if (actual !== hash) {
      this.rejected.add(name);
      await this.cache.delete(name);
      throw fault(
        'failed',
        `${url} has hash ${actual}, not the manifest's ${hash}; publish the file and manifest together`,
        'cache',
      );
    }
    this.rejected.delete(name);
    this.checked.add(name);
    return response;
  };
  /** Moves to a new manifest and drops the stored copies it no longer names. Returns how many were dropped. */
  async update(manifest: Readonly<Record<string, string>>): Promise<number> {
    const old = this.manifest;
    this.manifest = manifest;
    let dropped = 0;
    for (const url of Object.keys(old))
      if (manifest[url] !== old[url]) {
        const name = versioned(url, old[url]);
        await this.cache.delete(name);
        this.checked.delete(name);
        dropped++;
      }
    return dropped;
  }
}
