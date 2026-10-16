// Seeded, deterministic fuzzing primitives (launch gate 11a): PRNG, mutators, input derivation and the oracle.
// The runner is scripts/fuzz/run.js; targets live in scripts/fuzz/targets-*.js.

/** mulberry32: small, fast, deterministic. */
export function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
  };
  return r;
}

const encoder = new TextEncoder(),
  latin1 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'),
  fromLatin1 = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
export const bytesOf = (text) => encoder.encode(text);

// Values that break length, count and offset fields: 0, 1, sign bits, all ones, just past a power of two.
const INTERESTING = [0, 1, 2, 3, 7, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000];
INTERESTING.push(0xfffffffe, 0xffffffff, 0x40000000, 0x3fffffff, 0x01000000);
// Text numbers: huge counts, negative and out-of-range indices, NaN/Infinity spellings, float edge cases.
const NUMBERS = ['0', '-1', '1', '2', '-2147483649', '2147483647', '2147483648', '4294967295', '4294967296'];
NUMBERS.push('9007199254740993', '1e308', '-1e308', '1e999', '5e-324', 'NaN', 'nan', 'Infinity', '-inf', 'inf');
NUMBERS.push('1.5', '0x10', '-0', '99999999', '100000000000', '1e30', '3.4e38', '-3.5e38', '', '.', '-', '+');

/** One mutation class per entry; each takes (r, bytes, context) and returns new bytes. */
export const MUTATORS = {
  flip(r, b) {
    const out = b.slice();
    for (let n = 1 + r.int(4); n--; ) if (out.length) out[r.int(out.length)] ^= 1 << r.int(8);
    return out;
  },
  byte(r, b) {
    const out = b.slice();
    if (out.length) out[r.int(out.length)] = r.pick([0, 0xff, 0x7f, 0x80, r.int(256)]);
    return out;
  },
  /** Corrupted length, count or offset field: an interesting integer written at a (usually aligned) offset. */
  field(r, b) {
    if (b.length < 1) return b;
    const out = b.slice(),
      view = new DataView(out.buffer),
      width = r.pick([1, 2, 4, 4, 8]),
      at = Math.max(0, r.chance(0.6) ? r.int(Math.min(out.length, 256)) : r.int(out.length));
    const offset = r.chance(0.7) ? at - (at % width) : at,
      value = r.chance(0.8) ? r.pick(INTERESTING) : r.int(2 ** 32),
      little = r.chance(0.7);
    if (offset + width > out.length) return out;
    if (width === 1) view.setUint8(offset, value & 0xff);
    else if (width === 2) view.setUint16(offset, value & 0xffff, little);
    else if (width === 4) view.setUint32(offset, value >>> 0, little);
    else view.setBigUint64(offset, r.chance(0.5) ? BigInt(value) : 0xffffffffffffffffn - BigInt(r.int(3)), little);
    return out;
  },
  /** Truncated header or body: cut inside the first 128 bytes as often as anywhere else. */
  truncate(r, b) {
    return b.slice(0, r.chance(0.5) ? r.int(Math.min(b.length, 128) + 1) : r.int(b.length + 1));
  },
  remove(r, b) {
    if (b.length < 2) return b;
    const at = r.int(b.length),
      n = 1 + r.int(Math.min(64, b.length - at));
    return concat(b.subarray(0, at), b.subarray(at + n));
  },
  duplicate(r, b) {
    if (!b.length) return b;
    const at = r.int(b.length),
      n = 1 + r.int(Math.min(256, b.length - at)),
      to = r.int(b.length + 1),
      copies = r.chance(0.1) ? 1 + r.int(64) : 1,
      chunk = b.subarray(at, at + n);
    return concat(b.subarray(0, to), ...Array(copies).fill(chunk), b.subarray(to));
  },
  insert(r, b) {
    const at = r.int(b.length + 1),
      junk = Uint8Array.from({ length: 1 + r.int(16) }, () => r.int(256));
    return concat(b.subarray(0, at), junk, b.subarray(at));
  },
  splice(r, b, context) {
    const other = r.pick(context.seeds);
    if (!other?.length || !b.length) return b;
    const at = r.int(b.length),
      from = r.int(other.length);
    return concat(b.subarray(0, at), other.subarray(from, from + 1 + r.int(512)));
  },
  /** Text formats: a number token replaced by a huge count, a negative or out-of-range index, NaN or Infinity. */
  number(r, b, context) {
    if (!context.text) return MUTATORS.field(r, b);
    const text = latin1(b),
      matches = [...text.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].slice(0, 20_000);
    if (!matches.length) return b;
    const m = r.pick(matches);
    return fromLatin1(text.slice(0, m.index) + r.pick(NUMBERS) + text.slice(m.index + m[0].length));
  },
  line(r, b, context) {
    if (!context.text) return MUTATORS.duplicate(r, b);
    const lines = latin1(b).split('\n');
    if (lines.length < 2) return b;
    const i = r.int(lines.length),
      j = r.int(lines.length);
    const action = r.int(4);
    if (action === 0) lines.splice(i, 1);
    else if (action === 1) lines.splice(j, 0, ...Array(1 + (r.chance(0.1) ? r.int(1000) : 0)).fill(lines[i]));
    else if (action === 2) [lines[i], lines[j]] = [lines[j], lines[i]];
    else lines[i] = lines[i].split(/(\s+)/).reverse().join('');
    return fromLatin1(lines.join('\n'));
  },
  /** Text formats: deep nesting of the format's own brackets. */
  nest(r, b, context) {
    if (!context.text || !context.nest) return MUTATORS.insert(r, b);
    const [open, close] = r.pick(context.nest),
      depth = r.pick([40, 70, 300, 5000]),
      text = latin1(b),
      at = r.int(text.length + 1);
    return fromLatin1(
      text.slice(0, at) + open.repeat(depth) + (r.chance(0.5) ? close.repeat(depth) : '') + text.slice(at),
    );
  },
};
const MUTATOR_NAMES = Object.keys(MUTATORS);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Input `iteration` of `seed`: a target generator's hostile input, or one seed file with 1-4 stacked mutations. */
export async function input(target, context, seed, iteration) {
  const r = random(Math.imul(seed, 1_000_003) + iteration);
  if (target.generators?.length && r.chance(target.generatorRate ?? 0.15)) {
    const generator = r.pick(target.generators);
    return { bytes: await generator.call(target, r, context), how: `generator:${generator.name}` };
  }
  let bytes = r.pick(context.seeds);
  const how = [];
  for (let n = 1 + r.int(r.chance(0.2) ? 4 : 2); n--; ) {
    const name = r.pick(target.mutators ?? MUTATOR_NAMES);
    bytes = MUTATORS[name](r, bytes, context);
    how.push(name);
  }
  return { bytes, how: how.join('+') };
}

// Messages V8 and Wasm produce on their own: if one escapes a parser, the parser did not validate first.
const ENGINE =
  /Cannot read propert|Cannot set propert|is not a function|is not iterable|is not defined|is not a constructor|Invalid array length|Invalid typed array length|Array buffer allocation failed|Maximum call stack|out of memory|Offset is outside the bounds|outside the bounds of the DataView|Start offset .* is outside|should be a multiple of|Invalid DataView length|Unexpected (token|end of JSON|non-whitespace)|in JSON at position|Cannot convert|Cannot mix BigInt|unreachable|memory access out of bounds|Aborted\(|RangeError: Invalid string length|Invalid string length|Reduce of empty array|undefined is not|null is not|Converting circular|The encoded data was not valid|incorrect header check|invalid (stored|distance|code|block)|unexpected end of file|Decompression failed|The compressed data/i;

/** Default oracle: native errors are named only when their message is the package's own, not the engine's. */
export function isNamed(error, target) {
  if (!(error instanceof Error)) return false;
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return false;
  // A package error class (LoaderError, ...) is named even when it quotes the engine message it wraps.
  if (!['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error.name))
    return target.named ? target.named(error) : true;
  if (error.name === 'SyntaxError' && !target.namedSyntax) return false;
  if (ENGINE.test(error.message)) return false;
  return target.named ? target.named(error) : true;
}

const signature = (kind, error) =>
  `${kind}:${error?.name ?? ''}:${String(error?.message ?? error)
    .replace(/\d+/g, 'N')
    .replace(/"[^"]*"/g, '"S"')
    .slice(0, 120)}`;

/** Runs one input; returns null (pass) or a finding. */
export async function check(target, bytes) {
  globalThis.gc?.();
  const before = process.memoryUsage(),
    start = performance.now();
  let error = null,
    threw = false;
  try {
    await target.run(bytes);
  } catch (e) {
    error = e;
    threw = true;
  }
  const elapsed = performance.now() - start,
    after = process.memoryUsage(),
    grown = after.arrayBuffers - before.arrayBuffers + Math.max(0, after.heapUsed - before.heapUsed),
    budget = target.memory ?? 64 * 1024 * 1024 + 64 * bytes.length;
  if (threw && !isNamed(error, target))
    return {
      kind: 'unnamed',
      signature: signature('unnamed', error),
      message: `${error?.name}: ${String(error?.message ?? error).slice(0, 300)}`,
      stack: String(error?.stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map((l) => l.trim()),
    };
  if (elapsed > (target.timeMs ?? 2000))
    return { kind: 'slow', signature: `slow:${threw ? signature('', error) : 'ok'}`, message: `${elapsed | 0} ms` };
  if (grown > budget)
    return {
      kind: 'memory',
      signature: `memory:${threw ? signature('', error) : 'ok'}`,
      message: `${(grown / 2 ** 20).toFixed(0)} MiB for a ${bytes.length} B input`,
    };
  return null;
}
