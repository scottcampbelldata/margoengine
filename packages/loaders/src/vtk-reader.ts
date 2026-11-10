import { LoaderError } from './types.js';
import { latin1, TextScanner } from './util.js';
const F = 'VTK';
const SIZES: Record<string, number> = {
  bit: 0,
  unsigned_char: 1,
  char: 1,
  unsigned_short: 2,
  short: 2,
  unsigned_int: 4,
  int: 4,
  unsigned_long: 8,
  long: 8,
  float: 4,
  double: 8,
  vtktypeint8: 1,
  vtktypeuint8: 1,
  vtktypeint16: 2,
  vtktypeuint16: 2,
  vtktypeint32: 4,
  vtktypeuint32: 4,
  vtktypeint64: 8,
  vtktypeuint64: 8,
  vtkidtype: 8,
};

/** Internal shared legacy numeric reader. */
export class Reader {
  pos = 0;
  private scanner?: TextScanner;
  constructor(
    readonly bytes: Uint8Array,
    binary: boolean,
    readonly maxValues: number,
  ) {
    if (!binary) this.scanner = new TextScanner(latin1(bytes), F);
  }
  get binary(): boolean {
    return !this.scanner;
  }
  mark(): number {
    return this.scanner ? this.scanner.pos : this.pos;
  }
  reset(mark: number): void {
    if (this.scanner) this.scanner.pos = mark;
    else this.pos = mark;
  }
  /** Reads one raw line; returns null at end of file. */
  line(): string | null {
    if (this.scanner) return this.scanner.line();
    const bytes = this.bytes;
    if (this.pos >= bytes.length) return null;
    let end = bytes.indexOf(10, this.pos);
    if (end < 0) end = bytes.length;
    const line = latin1(bytes, this.pos, Math.min(end, this.pos + 4096));
    this.pos = end + 1;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  /** Next non-blank line, split into tokens. */
  keyword(): string[] | null {
    for (;;) {
      const line = this.line();
      if (line === null) return null;
      const trimmed = line.trim();
      if (trimmed) return trimmed.split(/\s+/);
    }
  }
  /** Reads `count` values of `type` (`binary` big-endian, or whitespace separated text). */
  values(type: string, count: number, what: string, forceType?: string): Float64Array {
    const kind = (forceType ?? type).toLowerCase();
    const size = Object.hasOwn(SIZES, kind) ? SIZES[kind] : undefined;
    if (size === undefined)
      throw new LoaderError(F, 'unsupported', `unknown data type "${type.slice(0, 32)}" in ${what}`);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new LoaderError(F, 'header', `invalid value count ${count} in ${what}`);
    if (count > this.maxValues)
      throw new LoaderError(F, 'limit', `${what} has ${count} values, more than the limit of ${this.maxValues}`);
    if (this.scanner) {
      if (count * 2 > this.scanner.text.length - this.scanner.pos + 1)
        throw new LoaderError(F, 'truncated', `file ends inside ${what}`);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = this.scanner.number(what);
        if (kind !== 'float' && kind !== 'double' && !Number.isSafeInteger(out[i]))
          throw new LoaderError(F, 'range', `${what} integer is outside exact JavaScript precision`);
        if (kind === 'bit' && out[i] !== 0 && out[i] !== 1)
          throw new LoaderError(F, 'range', `${what} bit value must be zero or one`);
      }
      return out;
    }
    if (size === 0) {
      const packed = Math.ceil(count / 8);
      if (this.pos + packed > this.bytes.length)
        throw new LoaderError(F, 'truncated', `binary data ends inside ${what}`);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = (this.bytes[this.pos + (i >>> 3)] >>> (7 - (i & 7))) & 1;
      this.pos += packed;
      return out;
    }
    if (this.pos + count * size > this.bytes.length)
      throw new LoaderError(F, 'truncated', `binary data ends inside ${what}`);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, count * size),
      out = new Float64Array(count);
    const integer = kind !== 'float' && kind !== 'double',
      unsigned = kind.startsWith('unsigned') || kind.startsWith('vtktypeuint');
    for (let i = 0, o = 0; i < count; i++, o += size) {
      if (!integer) out[i] = size === 4 ? view.getFloat32(o) : view.getFloat64(o);
      else if (size === 1) out[i] = unsigned ? view.getUint8(o) : view.getInt8(o);
      else if (size === 2) out[i] = unsigned ? view.getUint16(o) : view.getInt16(o);
      else if (size === 4) out[i] = unsigned ? view.getUint32(o) : view.getInt32(o);
      else {
        out[i] = Number(unsigned ? view.getBigUint64(o) : view.getBigInt64(o));
        if (!Number.isSafeInteger(out[i]))
          throw new LoaderError(F, 'range', `${what} integer is outside exact JavaScript precision`);
      }
    }
    this.pos += count * size;
    return out;
  }
}

/** Internal nonnegative count reader. */
export const integerOf = (token: string | undefined, what: string): number => {
  const value = Number(token);
  if (token === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new LoaderError(F, 'header', `invalid ${what} "${String(token).slice(0, 32)}"`);
  return value;
};
