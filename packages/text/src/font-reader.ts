import { MargoError } from '@margoengine/math/errors';
export const FONT_HELP = 'https://margoengine.com/docs/text';
export function fontError(detail: string): never {
  throw new MargoError('failed', `OpenType font ${detail}; provide valid supported font bytes. Help: ${FONT_HELP}`);
}
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;
  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    this.bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
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
    ) {
      fontError('offset or length exceeds its containing table, glyph or program');
    }
  }
  slice(pos: number, length: number): BinaryReader {
    this.check(pos, length);
    return new BinaryReader(this.bytes.subarray(pos, pos + length));
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
  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }
}
