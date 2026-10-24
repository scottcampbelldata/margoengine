/** Signed integer to an unsigned one, small magnitudes small. */
export function zigzag(n: number): number;
/** The inverse of {@link zigzag}. */
export function unzigzag(z: number): number;
/** A growing little-endian byte buffer. */
export class ByteWriter {
  bytes: Uint8Array;
  view: DataView;
  at: number;
  constructor(size?: number);
  room(n: number): void;
  u8(v: number): void;
  u16(v: number): void;
  u32(v: number): void;
  f32(v: number): void;
  f64(v: number): void;
  varint(v: number): void;
  raw(b: Uint8Array): void;
  done(): Uint8Array;
}
/** Checked little-endian reads; failures throw RangeError `"<what> <problem>; <fix>"`. */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly what: string;
  readonly fix: string;
  at: number;
  constructor(bytes: Uint8Array, what: string, fix: string, start?: number);
  fail(problem: string, fix?: string): RangeError;
  need(n: number): void;
  u8(): number;
  u16(): number;
  u32(): number;
  f32(): number;
  f64(): number;
  varint(): number;
  rest(): Uint8Array;
  end(): void;
}
