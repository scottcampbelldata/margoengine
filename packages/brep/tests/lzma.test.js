import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateLZMA, inflateXZ, isXZ } from '../src/jt/lzma.ts';

// Streams made by Python's lzma module (liblzma): .lzma, the bare 5-byte JT header, XZ with every check type, the lc /
// lp / pb range, stored LZMA2 chunks and a 2.6 MB multi-chunk payload, plus damaged inputs.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/lzma-vectors.json', import.meta.url), 'utf8'));
const bytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const decode = (input, limit) => (isXZ(input) ? inflateXZ(input, limit) : inflateLZMA(input, limit));
const corrupt = (what) => ({ name: 'TypeError', message: `Invalid JT file: corrupt LZMA data (${what})` });
const text = (data) => Buffer.from(data).toString('latin1');

test('LZMA vectors: every liblzma stream decodes byte for byte to its payload', () => {
  assert.equal(vectors.cases.length, 39);
  for (const c of vectors.cases) {
    const out = decode(bytes(c.input));
    assert.equal(out.length, c.length, c.name);
    assert.equal(sha256(out), c.sha256, c.name);
  }
});

test('LZMA vectors: damaged streams throw the TypeError that names the damage', () => {
  assert.equal(vectors.errors.length, 11);
  for (const e of vectors.errors) {
    const entry = e.entry === 'inflateXZ' ? inflateXZ : inflateLZMA;
    assert.throws(() => entry(bytes(e.input)), { name: 'TypeError', message: e.message }, e.name);
  }
});

test('LZMA limits: output up to the limit decodes, past it fails, and a known size is checked first', () => {
  const alone = bytes(vectors.cases.find((c) => c.name === 'alone/text-4k').input),
    xz = bytes(vectors.cases.find((c) => c.name === 'xz-crc64/text-4k').input),
    sized = bytes(vectors.cases.find((c) => c.name === 'alone-known-size/text-4k').input);
  assert.equal(inflateLZMA(alone, 4096).length, 4095);
  assert.equal(inflateLZMA(alone, 4095).length, 4095);
  assert.throws(() => inflateLZMA(alone, 4094), corrupt('output past 4094 bytes'));
  assert.equal(inflateXZ(xz, 4096).length, 4095);
  assert.throws(() => inflateXZ(xz, 4000), corrupt('output past 4000 bytes'));
  assert.equal(inflateLZMA(sized, 4095).length, 4095);
  assert.throws(() => inflateLZMA(sized, 4094), corrupt('unpacked size 4095 past 4094 bytes'));
  assert.equal(isXZ(xz), true);
  assert.equal(isXZ(alone), false);
  assert.equal(isXZ(xz.subarray(0, 3)), false);
  assert.throws(() => inflateXZ(alone), corrupt('no XZ stream header'));
  assert.throws(() => inflateXZ(xz.subarray(0, 23)), corrupt('no XZ stream header'));
});

// ---------------------------------------------------------------------------------------------------------------
// A small LZMA writer, for streams liblzma will not make. It is the encoding side of the LZMA specification: a carry
// propagating range encoder and the same contexts the decoder reads (named here, kept in a map), so whatever it writes
// a conforming decoder must read back. The round-trip tests below check it against the decoder on random programs.

class RangeEncoder {
  out = [];
  low = 0; // up to 33 bits, held exactly in a double
  range = 0xffffffff;
  cache = 0;
  pending = 1;
  shift() {
    if (this.low < 0xff000000 || this.low >= 2 ** 32) {
      const carry = this.low >= 2 ** 32 ? 1 : 0;
      let byte = this.cache;
      do {
        this.out.push((byte + carry) & 0xff);
        byte = 0xff;
      } while (--this.pending !== 0);
      this.cache = Math.floor(this.low / 2 ** 24) & 0xff;
    }
    this.pending++;
    this.low = (this.low % 2 ** 24) * 256;
  }
  normalize() {
    while (this.range < 2 ** 24) {
      this.range = (this.range * 256) >>> 0;
      this.shift();
    }
  }
  bit(probs, key, bit) {
    const p = probs.get(key) ?? 1024,
      bound = (this.range >>> 11) * p;
    if (bit === 0) {
      this.range = bound;
      probs.set(key, p + ((2048 - p) >> 5));
    } else {
      this.low += bound;
      this.range -= bound;
      probs.set(key, p - (p >> 5));
    }
    this.normalize();
  }
  direct(count, value) {
    for (let i = count - 1; i >= 0; i--) {
      this.range >>>= 1;
      if (Math.floor(value / 2 ** i) & 1) this.low += this.range;
      this.normalize();
    }
  }
  finish() {
    for (let i = 0; i < 5; i++) this.shift();
    return this.out;
  }
}

class Writer {
  probs = new Map();
  state = 0;
  reps = [0, 0, 0, 0]; // distances minus one
  data = []; // everything written, the expected output
  base = 0; // dictionary start
  rc = new RangeEncoder();
  constructor(lc = 3, lp = 0, pb = 2) {
    this.props(lc, lp, pb);
  }
  props(lc, lp, pb) {
    Object.assign(this, { lc, lp, pb });
    return lc + 9 * lp + 45 * pb;
  }
  resetState() {
    this.probs.clear();
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }
  get pos() {
    return this.data.length - this.base;
  }
  get posState() {
    return this.pos & ((1 << this.pb) - 1);
  }
  b(key, bit) {
    this.rc.bit(this.probs, key, bit);
  }
  tree(key, bits, value) {
    let node = 1;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.b(`${key}/${node}`, bit);
      node = (node << 1) | bit;
    }
  }
  reverse(key, bits, value) {
    let node = 1;
    for (let i = 0; i < bits; i++) {
      const bit = (value >> i) & 1;
      this.b(`${key}/${node}`, bit);
      node = (node << 1) | bit;
    }
  }
  length(coder, len) {
    const l = len - 2,
      ps = this.posState;
    if (l < 8) {
      this.b(`${coder}.choice`, 0);
      this.tree(`${coder}.low${ps}`, 3, l);
    } else if (l < 16) {
      this.b(`${coder}.choice`, 1);
      this.b(`${coder}.choice2`, 0);
      this.tree(`${coder}.mid${ps}`, 3, l - 8);
    } else {
      this.b(`${coder}.choice`, 1);
      this.b(`${coder}.choice2`, 1);
      this.tree(`${coder}.high`, 8, l - 16);
    }
  }
  copy(len) {
    for (let i = 0; i < len; i++) this.data.push(this.data[this.data.length - this.reps[0] - 1]);
  }
  literal(byte) {
    const pos = this.pos,
      prev = pos > 0 ? this.data[this.data.length - 1] : 0,
      ctx = `lit${((pos & ((1 << this.lp) - 1)) << this.lc) + (prev >> (8 - this.lc))}`;
    this.b(`isMatch${this.state}.${this.posState}`, 0);
    let symbol = 1,
      guide = this.state >= 7 ? this.data[this.data.length - this.reps[0] - 1] : -1;
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      if (guide >= 0) {
        const g = (guide >> i) & 1;
        this.b(`${ctx}.m${g}/${symbol}`, bit);
        if (g !== bit) guide = -1;
      } else this.b(`${ctx}/${symbol}`, bit);
      symbol = (symbol << 1) | bit;
    }
    this.data.push(byte);
    this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
  }
  /** A new match `dist` bytes back (0xffffffff + 1 for the end marker). */
  match(dist, len) {
    const posState = this.posState;
    this.b(`isMatch${this.state}.${posState}`, 1);
    this.b(`isRep${this.state}`, 0);
    this.length('len', len);
    const d = dist - 1,
      slot = d < 4 ? d : 2 * (31 - Math.clz32(d)) + (Math.floor(d / 2 ** (30 - Math.clz32(d))) & 1);
    this.tree(`slot${Math.min(len - 2, 3)}`, 6, slot);
    if (slot >= 4) {
      const bits = (slot >> 1) - 1,
        extra = d - (2 | (slot & 1)) * 2 ** bits;
      if (slot < 14) this.reverse(`extra${slot}`, bits, extra);
      else {
        this.rc.direct(bits - 4, Math.floor(extra / 16));
        this.reverse('align', 4, extra & 15);
      }
    }
    this.reps = [d, this.reps[0], this.reps[1], this.reps[2]];
    this.state = this.state < 7 ? 7 : 10;
    if (d !== 0xffffffff) this.copy(len);
  }
  end() {
    this.match(2 ** 32, 2);
  }
  /** A repeat of reps[k] for `len` bytes. */
  rep(k, len) {
    this.b(`isMatch${this.state}.${this.posState}`, 1);
    this.b(`isRep${this.state}`, 1);
    if (k === 0) {
      this.b(`repG0${this.state}`, 0);
      this.b(`rep0Long${this.state}.${this.posState}`, 1);
    } else {
      this.b(`repG0${this.state}`, 1);
      this.b(`repG1${this.state}`, k === 1 ? 0 : 1);
      if (k > 1) this.b(`repG2${this.state}`, k === 2 ? 0 : 1);
      const d = this.reps[k];
      this.reps.splice(k, 1);
      this.reps.unshift(d);
    }
    this.length('repLen', len);
    this.state = this.state < 7 ? 8 : 11;
    this.copy(len);
  }
  shortRep() {
    this.b(`isMatch${this.state}.${this.posState}`, 1);
    this.b(`isRep${this.state}`, 1);
    this.b(`repG0${this.state}`, 0);
    this.b(`rep0Long${this.state}.${this.posState}`, 0);
    this.state = this.state < 7 ? 9 : 11;
    this.copy(1);
  }
  /** The range-coded bytes so far; the next symbols go to a fresh range coder (an LZMA2 chunk boundary). */
  flush() {
    const out = this.rc.finish();
    this.rc = new RangeEncoder();
    return out;
  }
  /** As JT 10 writes it without a size: properties, dictionary size, then data ending in the end marker. */
  bare() {
    this.end();
    return Uint8Array.from([this.lc + 9 * this.lp + 45 * this.pb, 0, 0, 1, 0, ...this.flush()]);
  }
}

/** mulberry32 (Tommy Ettinger's public-domain 32-bit generator), seeded, for repeatable random programs. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Writes a random mix of every symbol kind (lengths 2-273, distances up to the whole output). */
function program(w, rand, symbols) {
  const int = (n) => Math.floor(rand() * n);
  for (let i = 0; i < symbols; i++) {
    const pos = w.pos,
      len = rand() < 0.8 ? 2 + int(14) : 2 + int(272),
      kind = pos === 0 ? 0 : int(5);
    if (kind === 0) w.literal(rand() < 0.5 ? 97 + int(4) : int(256));
    else if (kind === 1) w.match(rand() < 0.5 ? 1 + int(Math.min(pos, 16)) : 1 + int(pos), len);
    else if (kind === 2) w.rep(int(4), len);
    else if (kind === 3) w.shortRep();
    else w.literal(int(256)); // after a match, the matched-literal form
  }
}

test('LZMA writer round trips: random programs over all lc / lp / pb (lc 5-8 included), both header forms', () => {
  const rand = random(20261024);
  for (let trial = 0; trial < 40; trial++) {
    const lc = trial % 9,
      lp = Math.floor(trial / 9) % 5,
      pb = trial % 5,
      w = new Writer(lc, lp, pb);
    program(w, rand, 300 + Math.floor(rand() * 900));
    const expected = Uint8Array.from(w.data),
      bare = w.bare();
    assert.deepEqual(inflateLZMA(bare), expected, `lc ${lc} lp ${lp} pb ${pb}, 5-byte header`);
    // The 13-byte header with the size known: decoding stops at the size, before the end marker.
    const sized = new Uint8Array(bare.length + 8);
    sized.set(bare.subarray(0, 5));
    new DataView(sized.buffer).setUint32(5, expected.length, true);
    sized.set(bare.subarray(5), 13);
    assert.deepEqual(inflateLZMA(sized), expected, `lc ${lc} lp ${lp} pb ${pb}, known size`);
  }
});

test('LZMA: long distances use the direct and aligned bits; overlapping matches repeat their own output', () => {
  const w = new Writer();
  for (let i = 0; i < 5000; i++) w.literal((i * 7919) & 0xff);
  w.match(4999, 273); // slot 24: 7 direct bits and 4 aligned bits
  w.match(1, 200); // a run from one byte
  w.literal(1);
  w.match(3, 9); // overlapping: copies bytes it has just written
  assert.deepEqual(inflateLZMA(w.bare()), Uint8Array.from(w.data));
});

test('LZMA: repeats before any data, distances before the start and the end marker in a sized stream are corrupt', () => {
  let w = new Writer();
  w.shortRep();
  assert.throws(() => inflateLZMA(w.bare()), corrupt('repeat before any data'));
  w = new Writer();
  w.data.push(0); // the writer needs a byte to copy; the decoder has none
  w.base = 1;
  w.rep(0, 2);
  assert.throws(() => inflateLZMA(w.bare()), corrupt('repeat before any data'));
  w = new Writer();
  w.literal(1);
  w.literal(2);
  w.data.unshift(0); // write a distance of 3 over 2 bytes of output
  w.base = 1;
  w.match(3, 2);
  assert.throws(() => inflateLZMA(w.bare()), corrupt('match distance before start'));
  // A known size longer than the data reaches the end marker first.
  w = new Writer();
  w.literal(1);
  const bare = w.bare(),
    sized = Uint8Array.from([...bare.subarray(0, 5), 2, 0, 0, 0, 0, 0, 0, 0, ...bare.subarray(5)]);
  assert.throws(() => inflateLZMA(sized), corrupt('end marker before the unpacked size'));
  // Properties at the top of the range: lc 8, lp 4, pb 4 (224) is accepted; 225 is not.
  w = new Writer(8, 4, 4);
  program(w, random(7), 200);
  const expected = Uint8Array.from(w.data),
    top = w.bare();
  assert.equal(top[0], 224);
  assert.deepEqual(inflateLZMA(top), expected);
  top[0] = 225;
  assert.throws(() => inflateLZMA(top), corrupt('bad properties'));
});

// ---------------------------------------------------------------------------------------------------------------
// XZ streams built by hand around hand-built LZMA2 chunks.

/** A stored LZMA2 chunk: control 1 (dictionary reset) or 2 (no reset). */
const stored = (control, data) => [control, (data.length - 1) >> 8, (data.length - 1) & 0xff, ...data];

/** An LZMA chunk from the writer's symbols since its last flush; `reset` 0-3, `props` for reset 2 and 3. */
function chunk(w, reset, unpacked, props) {
  const packed = w.flush(),
    u = unpacked - 1,
    p = packed.length - 1;
  return [
    0x80 | (reset << 5) | (u >> 16),
    (u >> 8) & 0xff,
    u & 0xff,
    p >> 8,
    p & 0xff,
    ...(reset >= 2 ? [props] : []),
    ...packed,
  ];
}

/** An .xz multibyte integer. */
function varint(n) {
  const out = [];
  for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push(0x80 | (n % 0x80));
  return [...out, n];
}

/** Block header for `filters` (each [id, ...properties]), padded to its size, with a dummy CRC32. */
function blockHeader(filters = [[0x21, 0x10]], flags = filters.length - 1, sizes = []) {
  const body = [flags, ...sizes];
  for (const [id, ...props] of filters) body.push(...varint(id), ...varint(props.length), ...props);
  const size = Math.ceil((body.length + 1 + 4) / 4) * 4;
  return [size / 4 - 1, ...body, ...new Array(size - body.length - 5).fill(0), 0xde, 0xad, 0xbe, 0xef];
}

/** An XZ stream (check type `check`) with the given blocks, each [header bytes, chunk bytes]. */
function xz(blocks, check = 0) {
  const checkSize = check === 0 ? 0 : 4 << Math.floor((check - 1) / 3),
    out = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, check, 1, 2, 3, 4];
  for (const [header, chunks] of blocks) {
    const start = out.length;
    out.push(...header, ...chunks);
    while ((out.length - start) % 4) out.push(0);
    out.push(...new Array(checkSize).fill(0x55));
  }
  // Index indicator, then filler standing in for the index and footer (neither is read).
  out.push(0, ...new Array(15).fill(0));
  return Uint8Array.from(out);
}

const ascii = (s) => [...Buffer.from(s, 'latin1')];

test('LZMA2: control 2 stores bytes without a dictionary reset, so later matches reach back past it', () => {
  const w = new Writer();
  w.data.push(...ascii('abcdef'));
  const props = w.props(3, 0, 2);
  w.match(6, 3); // "abc" from the first stored chunk
  w.match(9, 4); // across both stored chunks
  const chunks = [...stored(1, ascii('abc')), ...stored(2, ascii('def')), ...chunk(w, 2, 7, props), 0];
  assert.equal(text(inflateXZ(xz([[blockHeader(), chunks]]))), 'abcdefabcabcd');
  // Two stored chunks alone.
  assert.equal(text(inflateXZ(xz([[blockHeader(), [...stored(1, ascii('xy')), ...stored(2, ascii('z')), 0]]]))), 'xyz');
  // Control 1 does reset the dictionary: the same match now reaches before its start.
  const v = new Writer();
  v.data.push(...ascii('abcdef'));
  v.base = 3; // where the decoder's dictionary now starts
  v.match(6, 3);
  const reset = [...stored(1, ascii('abc')), ...stored(1, ascii('def')), ...chunk(v, 2, 3, props), 0];
  assert.throws(() => inflateXZ(xz([[blockHeader(), reset]])), corrupt('match distance before start'));
});

test('LZMA2: a reset-1 chunk restarts probabilities, state and repeats; a reset-2 chunk brings new properties', () => {
  // Chunk 1 (reset 3): "hello world " as literals and a match, leaving state, reps and probabilities behind.
  const w = new Writer(3, 0, 2),
    first = w.props(3, 0, 2);
  for (const c of ascii('hello world ')) w.literal(c);
  w.match(6, 5);
  const c1 = chunk(w, 3, w.data.length, first);
  // Chunk 2 (reset 1): the encoder starts over too, so only a decoder that resets reads this back.
  w.resetState();
  let mark = w.data.length;
  w.literal(ascii('!')[0]);
  w.match(18, 11);
  w.rep(0, 3);
  const c2 = chunk(w, 1, w.data.length - mark);
  // Chunk 3 (reset 2): new lc / lp / pb, state reset, dictionary kept.
  w.resetState();
  const second = w.props(0, 2, 1);
  mark = w.data.length;
  w.literal(ascii('?')[0]);
  w.match(30, 6);
  w.shortRep();
  const c3 = chunk(w, 2, w.data.length - mark, second);
  // Chunk 4 (reset 0): state and probabilities continue from chunk 3.
  mark = w.data.length;
  w.rep(0, 4);
  w.literal(ascii('.')[0]);
  const c4 = chunk(w, 0, w.data.length - mark);
  const out = inflateXZ(xz([[blockHeader(), [...c1, ...c2, ...c3, ...c4, 0]]], 4));
  assert.equal(text(out), text(w.data));
  assert.equal(text(out).slice(0, 17), 'hello world world');
});

test('LZMA2: the short repeat checks its distance against the last dictionary reset', () => {
  // rep0 is 5 (6 bytes back) after the match; a stored chunk with a dictionary reset leaves 2 bytes, and a continuing
  // chunk then asks for the byte 6 back.
  const build = (symbol) => {
    const w = new Writer(),
      props = w.props(3, 0, 2);
    for (const c of ascii('abcdef')) w.literal(c);
    w.match(6, 2);
    const c1 = chunk(w, 3, 8, props);
    w.data.push(...ascii('xy'));
    w.base = 8;
    symbol(w);
    return xz([[blockHeader(), [...c1, ...stored(1, ascii('xy')), ...chunk(w, 0, 1), 0]]]);
  };
  assert.throws(() => inflateXZ(build((w) => w.shortRep())), corrupt('match distance before start'));
  assert.throws(() => inflateXZ(build((w) => w.literal(0x41))), corrupt('match distance before start'));
  // The same short repeat with the dictionary kept (control 2) reads 'b'.
  const w = new Writer(),
    props = w.props(3, 0, 2);
  for (const c of ascii('abcdef')) w.literal(c);
  w.match(6, 2);
  const c1 = chunk(w, 3, 8, props);
  w.data.push(...ascii('xy'));
  w.shortRep();
  const kept = xz([[blockHeader(), [...c1, ...stored(2, ascii('xy')), ...chunk(w, 0, 1), 0]]]);
  assert.equal(text(inflateXZ(kept)), 'abcdefabxye');
});

test('LZMA2 / XZ framing: control bytes, missing properties, literal settings, filters, integers and blocks', () => {
  const lit = (s, reset, props = 3 + 45 * 2) => {
    const w = new Writer(props % 9, Math.floor(props / 9) % 5, Math.floor(props / 45));
    for (const c of ascii(s)) w.literal(c);
    return chunk(w, reset, s.length, props);
  };
  const one = (chunks, header = blockHeader()) => xz([[header, [...chunks, 0]]]);
  assert.throws(() => inflateXZ(one([3, 0, 0])), corrupt('LZMA2 control byte 3'));
  assert.throws(() => inflateXZ(one([0x7f, 0, 0])), corrupt('LZMA2 control byte 127'));
  assert.throws(() => inflateXZ(one(lit('abc', 0))), corrupt('LZMA2 chunk before its properties'));
  assert.throws(() => inflateXZ(one(lit('abc', 1))), corrupt('LZMA2 chunk before its properties'));
  assert.throws(() => inflateXZ(one(lit('abc', 3, 3 + 9 * 2))), corrupt('LZMA2 literal settings over 4 bits'));
  assert.throws(() => inflateXZ(one(lit('abc', 3, 225))), corrupt('bad properties'));
  assert.equal(text(inflateXZ(one(lit('abc', 3, 4)))), 'abc'); // lc 4, lp 0: the most LZMA2 allows
  // Filters: a chain names its first filter; LZMA2 in a chain of two is refused too.
  assert.throws(
    () =>
      inflateXZ(
        one(
          lit('abc', 3),
          blockHeader([
            [0x21, 0x10],
            [0x21, 0x10],
          ]),
        ),
      ),
    corrupt('XZ filter 21 (only LZMA2 alone is read)'),
  );
  assert.throws(
    () => inflateXZ(one(lit('abc', 3), blockHeader([[0x4000000000000]]))),
    corrupt('XZ filter 4000000000000 (only LZMA2 alone is read)'),
  );
  // Optional sizes in the block header are read past; an over-long multibyte integer is corrupt.
  assert.equal(text(inflateXZ(one(lit('abc', 3), blockHeader(undefined, 0xc0, [0x81, 0x01, 3])))), 'abc');
  assert.throws(
    () => inflateXZ(one(lit('abc', 3), blockHeader(undefined, 0x40, new Array(9).fill(0x80)))),
    corrupt('integer too long'),
  );
  // Several blocks, each bringing its own properties, concatenate; check fields of every size are skipped.
  for (const check of [0, 1, 4, 10]) {
    const blocks = [
      [blockHeader(), [...lit('one ', 3), 0]],
      [blockHeader(), [...stored(1, ascii('two ')), 0]],
      [blockHeader(), [...lit('six', 3), 0]],
    ];
    assert.equal(text(inflateXZ(xz(blocks, check))), 'one two six');
  }
  // A packed size past the input.
  const cut = one(lit('abcdefgh', 3));
  assert.throws(() => inflateXZ(cut.subarray(0, 30)), corrupt('chunk past the end'));
});
