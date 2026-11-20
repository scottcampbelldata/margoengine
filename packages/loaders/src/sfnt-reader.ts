import { LoaderError, type LoaderErrorCode } from './types.js';

/** Format name of every font error. */
export const FONT = 'TTF';

/** Throws the font loader's error: `detail` names what is wrong, the tail what to do. */
export function fontError(detail: string, code: LoaderErrorCode = 'header'): never {
  throw new LoaderError(
    FONT,
    code,
    code === 'unsupported'
      ? `${detail}; convert the font to TrueType or plain CFF outlines`
      : code === 'limit'
        ? `${detail}; the glyph is too complex to read, simplify it in a font editor`
        : code === 'range'
          ? `${detail}; pick axes and values from the font's variationAxes`
          : `${detail}; the font is malformed, re-export it from a font editor`,
  );
}

/** Bounds-checked big-endian cursor over one table, glyph or program (OpenType data types). */
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  check(pos: number, length: number): void {
    if (
      !Number.isSafeInteger(pos) ||
      !Number.isSafeInteger(length) ||
      pos < 0 ||
      length < 0 ||
      pos > this.length - length
    )
      fontError('an offset or length runs past its table, glyph or program', 'truncated');
  }
  slice(pos: number, length: number): BinaryReader {
    this.check(pos, length);
    return new BinaryReader(this.bytes.subarray(pos, pos + length));
  }
  /** The bytes from `offset` to the end. */
  tail(offset: number): BinaryReader {
    return this.slice(offset, this.length - offset);
  }
  seek(pos: number): void {
    this.check(pos, 0);
    this.pos = pos;
  }
  skip(bytes: number): void {
    this.check(this.pos, bytes);
    this.pos += bytes;
  }
  u8(): number {
    this.check(this.pos, 1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.check(this.pos, 1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.check(this.pos, 2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.check(this.pos, 2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.check(this.pos, 4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.check(this.pos, 4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  /** F2DOT14: signed 2.14 fixed point. */
  f2(): number {
    return this.i16() / 16384;
  }
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
}
