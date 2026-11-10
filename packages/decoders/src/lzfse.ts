// Clean-room LZFSE block framing (Keramics), LZVN packets and table ANS (Duda 2013).
// No implementation source consulted. See docs/clean-room.md, batch 241.
import { decodeFailed } from './errors.js';

/** Limits for {@link decodeLZFSE}. */
export interface LZFSEOptions {
  /** Maximum decoded bytes across every block. Default 256 MiB. */
  maxBytes?: number;
  /** Cancellation reason is thrown before decoding and between blocks. */
  signal?: AbortSignal;
}

const corrupt = (why: string): never => {
  throw decodeFailed(`LZFSE: ${why}; export the file again (https://margoengine.com/docs/errors#failed)`);
};

// Reads little-endian bit fields in either direction. Reverse streams consume the
// high end of each field first, but the field's numerical representation is LE.
class Bits {
  at: number;
  constructor(
    private readonly data: Uint8Array,
    private readonly reverse = false,
    padding = 0,
  ) {
    this.at = reverse ? data.length * 8 + padding : 0;
  }
  read(n: number): number {
    const start = this.reverse ? this.at - n : this.at;
    if (start < 0 || start + n > this.data.length * 8) corrupt('bit stream ends early');
    let value = 0;
    for (let i = 0; i < n; i++) value += ((this.data[(start + i) >>> 3] >>> ((start + i) & 7)) & 1) * 2 ** i;
    this.at += this.reverse ? -n : n;
    return value;
  }
}

interface State {
  symbol: number;
  bits: number;
  base: number;
}

// A contiguous symbol spread: each frequency f partitions the next-state interval
// into f dyadic ranges. These ranges cover [0, states) exactly.
function table(frequencies: number[], states: number): State[] {
  if (frequencies.reduce((a, b) => a + b, 0) !== states) corrupt('invalid frequency sum');
  const out: State[] = [];
  frequencies.forEach((f, symbol) => {
    if (!f) return;
    const bits = Math.ceil(Math.log2(states / f)),
      split = (2 * states) / 2 ** bits - f;
    for (let j = 0; j < f; j++)
      out.push(
        j < split
          ? { symbol, bits, base: (f + j) * 2 ** bits - states }
          : { symbol, bits: bits - 1, base: (j - split) * 2 ** (bits - 1) },
      );
  });
  return out;
}

function frequencies(bytes: Uint8Array): number[] {
  const bits = new Bits(bytes),
    out: number[] = [];
  for (let i = 0; i < 360; i++) {
    // Prefix code, least-significant bit first: 00=0, 10=1, 001=2,
    // 101=3, 00011..11011=4..7, 00111=8-bit, 01111=14-bit.
    const pair = bits.read(2);
    if (!(pair & 1)) out.push(pair >>> 1);
    else if (pair === 1) out.push(2 + bits.read(1));
    else {
      const tail = bits.read(3);
      if (!(tail & 1)) out.push(4 + (tail >>> 1));
      else if (!(tail & 2)) out.push(8 + (tail >>> 2) + 2 * bits.read(3));
      else out.push(24 + (tail >>> 2) + 2 * bits.read(9));
    }
  }
  if (bytes.length * 8 - bits.at >= 8) corrupt('frequency table has trailing bytes');
  return out;
}

const L_EXTRA = [...Array<number>(16).fill(0), 2, 3, 5, 8],
  M_EXTRA = [...Array<number>(16).fill(0), 3, 5, 8, 11],
  D_EXTRA = Array.from({ length: 64 }, (_, i) => Math.max(0, (i >>> 2) - 0));
function bases(extra: number[]): number[] {
  let next = 0;
  return extra.map((n) => {
    const base = next;
    next += 2 ** n;
    return base;
  });
}
const L_BASE = bases(L_EXTRA),
  M_BASE = bases(M_EXTRA),
  D_BASE = bases(D_EXTRA);

/** Decodes raw, LZVN, LZFSE v1 and v2 blocks, including reused v2 tables. No imports or network work at runtime. */
export function decodeLZFSE(input: Uint8Array | ArrayBuffer, options: LZFSEOptions = {}): Uint8Array {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeLZFSE needs byte data');
  const max = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 0 || max > 0x7fffffff) throw new RangeError('maxBytes must be 0..2147483647');
  options.signal?.throwIfAborted();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0,
    length = 0,
    output = new Uint8Array(0),
    saved: number[] | undefined;
  const need = (n: number) => {
    if (at + n > bytes.length) corrupt('block ends early');
  };
  const u32 = (offset: number) => dv.getUint32(at + offset, true);
  const reserve = (n: number) => {
    if (length + n > max) corrupt(`output exceeds maxBytes ${max}`);
    if (length + n > output.length) {
      const grown = new Uint8Array(Math.min(max, Math.max(length + n, output.length * 2, 1024)));
      grown.set(output);
      output = grown;
    }
  };
  const match = (distance: number, count: number, end: number) => {
    if (distance < 1 || distance > length || length + count > end) corrupt('match is outside output');
    for (let i = 0; i < count; i++) {
      output[length] = output[length - distance];
      length++;
    }
  };
  for (;;) {
    options.signal?.throwIfAborted();
    need(4);
    const magic = u32(0);
    if (magic === 0x24787662) {
      if (at + 4 !== bytes.length) corrupt('data after end marker');
      return output.slice(0, length);
    }
    need(8);
    const raw = u32(4),
      end = length + raw;
    reserve(raw);
    if (magic === 0x2d787662) {
      need(8 + raw);
      output.set(bytes.subarray(at + 8, at + 8 + raw), length);
      length = end;
      at += 8 + raw;
    } else if (magic === 0x6e787662) {
      need(12);
      const packed = u32(8);
      need(12 + packed);
      let p = at + 12,
        distance = 0,
        ended = false;
      const stop = p + packed;
      const byte = () => {
        if (p >= stop) corrupt('LZVN packet ends early');
        return bytes[p++];
      };
      while (p < stop) {
        const op = byte();
        if (op === 6) {
          if (p + 7 !== stop) corrupt('invalid LZVN end marker');
          p += 7;
          ended = true;
          break;
        }
        if (op === 14 || op === 22) continue;
        let literal = 0,
          count = 0;
        if (op >= 0xe0 && op <= 0xef) literal = op === 0xe0 ? byte() + 16 : op & 15;
        else if (op >= 0xf0) count = op === 0xf0 ? byte() + 16 : op & 15;
        else if (op >= 0xa0 && op <= 0xbf) {
          const b = byte(),
            c = byte();
          literal = (op >>> 3) & 3;
          count = (((op & 7) << 2) | (b & 3)) + 3;
          distance = (b >>> 2) | (c << 6);
        } else {
          if (
            (op >= 0x70 && op < 0x80) ||
            (op >= 0xd0 && op < 0xe0) ||
            op === 0x1e ||
            op === 0x26 ||
            op === 0x2e ||
            op === 0x36 ||
            op === 0x3e
          )
            corrupt('invalid LZVN opcode');
          literal = op >>> 6;
          count = ((op >>> 3) & 7) + 3;
          if ((op & 7) === 7) distance = byte() | (byte() << 8);
          else if ((op & 7) !== 6) distance = ((op & 7) << 8) | byte();
        }
        if (p + literal > stop || length + literal + count > end) corrupt('LZVN literal exceeds block');
        output.set(bytes.subarray(p, p + literal), length);
        p += literal;
        length += literal;
        if (count) match(distance, count, end);
      }
      if (!ended || length !== end) corrupt('LZVN output size mismatch');
      at = stop;
    } else if (magic === 0x31787662 || magic === 0x32787662) {
      let header: number,
        literals: number,
        matches: number,
        literalBytes: number,
        matchBytes: number,
        literalPadding: number,
        matchPadding: number,
        literalStates: number[],
        states: number[],
        freq: number[];
      if (magic === 0x31787662) {
        header = 772;
        need(header);
        literals = u32(12);
        matches = u32(16);
        literalBytes = u32(20);
        matchBytes = u32(24);
        literalPadding = dv.getInt32(at + 28, true);
        matchPadding = dv.getInt32(at + 40, true);
        literalStates = [32, 34, 36, 38].map((i) => dv.getUint16(at + i, true));
        states = [44, 46, 48].map((i) => dv.getUint16(at + i, true));
        freq = Array.from({ length: 360 }, (_, i) => dv.getUint16(at + 50 + i * 2, true));
        if (u32(8) !== literalBytes + matchBytes) corrupt('v1 payload size mismatch');
      } else {
        need(32);
        const fields = new Bits(bytes.subarray(at + 8, at + 32));
        literals = fields.read(20);
        literalBytes = fields.read(20);
        matches = fields.read(20);
        literalPadding = fields.read(3) - 7;
        fields.read(1);
        literalStates = [fields.read(10), fields.read(10), fields.read(10), fields.read(10)];
        matchBytes = fields.read(20);
        matchPadding = fields.read(3) - 7;
        fields.read(1);
        header = fields.read(32);
        states = [fields.read(10), fields.read(10), fields.read(10)];
        if (header < 32) corrupt('v2 header size is invalid');
        need(header);
        if (header === 32) {
          if (!saved) corrupt('v2 tables have no predecessor');
          freq = saved!;
        } else freq = frequencies(bytes.subarray(at + 32, at + header));
      }
      saved = freq;
      if (
        literalPadding < -7 ||
        literalPadding > 0 ||
        matchPadding < -7 ||
        matchPadding > 0 ||
        literals > 40000 ||
        matches > 10000
      )
        corrupt('invalid compressed block counts');
      need(header + literalBytes + matchBytes);
      const lt = table(freq.slice(104), 1024),
        tables = [table(freq.slice(0, 20), 64), table(freq.slice(20, 40), 64), table(freq.slice(40, 104), 256)],
        lb = new Bits(bytes.subarray(at + header, at + header + literalBytes), true, literalPadding),
        mb = new Bits(
          bytes.subarray(at + header + literalBytes, at + header + literalBytes + matchBytes),
          true,
          matchPadding,
        ),
        decoded = new Uint8Array(literals);
      const symbol = (t: State[], state: number, bits: Bits): [number, number] => {
        const s = t[state];
        if (!s) corrupt('state outside frequency table');
        return [s.symbol, s.base + bits.read(s.bits)];
      };
      for (let i = 0; i < literals; i++) {
        const slot = i & 3,
          [s, next] = symbol(lt, literalStates[slot], lb);
        decoded[i] = s;
        literalStates[slot] = next;
      }
      let used = 0,
        distance = 0;
      for (let i = 0; i < matches; i++) {
        const values: number[] = [];
        for (let k = 0; k < 3; k++) {
          const t = tables[k],
            s = t[states[k]];
          if (!s) corrupt('LMD state outside table');
          const extra = [L_EXTRA, M_EXTRA, D_EXTRA][k][s.symbol],
            base = [L_BASE, M_BASE, D_BASE][k][s.symbol];
          states[k] = s.base + mb.read(s.bits);
          values.push(base + mb.read(extra));
        }
        const [l, m, d] = values;
        if (used + l > literals || length + l + m > end) corrupt('LMD lengths exceed block');
        output.set(decoded.subarray(used, used + l), length);
        used += l;
        length += l;
        if (d) distance = d;
        if (m) match(distance, m, end);
      }
      if (length !== end) corrupt('compressed output size mismatch');
      at += header + literalBytes + matchBytes;
    } else corrupt('unknown block signature');
  }
}
