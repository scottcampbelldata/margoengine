// WOFF2's transformed 'glyf', 'loca' and 'hmtx' tables back to the OpenType ones, clean room from W3C "WOFF File
// Format 2.0" (V. Levantovsky, ed., Recommendation, 8 August 2024, https://www.w3.org/TR/WOFF2/), sections 5.1 to 5.4.
import { BinaryReader } from './sfnt-reader.js';
import { LoaderError, type LoaderErrorCode } from './types.js';

/** Throws the web font decoder's error. */
export function woffError(detail: string, code: LoaderErrorCode = 'header', cause?: unknown): never {
  throw new LoaderError(
    'WOFF',
    code,
    `${detail}; ${code === 'limit' ? 'raise maxBytes if you trust the file' : 'the web font is damaged or malformed, export it again'}`,
    { cause },
  );
}

/** The 255UInt16 variable-length integer. */
export function read255(r: BinaryReader): number {
  const code = r.u8();
  return code === 253 ? r.u16() : code === 255 ? r.u8() + 253 : code === 254 ? r.u8() + 506 : code;
}

const take = (r: BinaryReader, length: number): Uint8Array => {
  const bytes = r.slice(r.pos, length).bytes;
  r.pos += length;
  return bytes;
};

/** A growing big-endian buffer that refuses to pass `limit` bytes. */
class Output {
  private buffer = new Uint8Array(4096);
  length = 0;
  constructor(private readonly limit: number) {}
  private room(bytes: number): number {
    const at = this.length,
      end = at + bytes;
    if (end > this.limit) woffError(`the rebuilt 'glyf' table passes maxBytes (${this.limit})`, 'limit');
    if (end > this.buffer.length) {
      const grown = new Uint8Array(Math.max(end, this.buffer.length * 2));
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.length = end;
    return at;
  }
  u8(v: number): void {
    const at = this.room(1);
    this.buffer[at] = v;
  }
  u16(v: number): void {
    this.u8((v >> 8) & 255);
    this.u8(v & 255);
  }
  bytes(data: Uint8Array): void {
    const at = this.room(data.length);
    this.buffer.set(data, at);
  }
  result(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/** One point's coordinate deltas from its flag's low 7 bits and the glyph stream (section 5.2, "Triplet Encoding"). */
function triplet(code: number, r: BinaryReader): [number, number] {
  // The lowest bit is the sign of the first coordinate present, the next one of y: set means positive.
  const x = (v: number) => (code & 1 ? v : -v),
    y = (v: number) => (code & 2 ? v : -v);
  if (code < 10) return [0, x(((code & 14) << 7) + r.u8())];
  if (code < 20) return [x((((code - 10) & 14) << 7) + r.u8()), 0];
  if (code < 84) {
    const b = code - 20,
      byte = r.u8();
    return [x(1 + (b & 0x30) + (byte >> 4)), y(1 + ((b & 0x0c) << 2) + (byte & 15))];
  }
  if (code < 120) {
    const b = code - 84,
      high = 1 + (Math.floor(b / 12) << 8),
      dx = high + r.u8();
    return [x(dx), y(1 + (((b % 12) >> 2) << 8) + r.u8())];
  }
  if (code < 124) {
    const first = r.u8(),
      middle = r.u8();
    return [x((first << 4) + (middle >> 4)), y(((middle & 15) << 8) + r.u8())];
  }
  const dx = r.u16();
  return [x(dx), y(r.u16())];
}

/** The rebuilt `glyf` and `loca` tables of a transformed `glyf`, and the `loca` format they use (0 short, 1 long). */
export function rebuildGlyf(data: Uint8Array, limit: number): { glyf: Uint8Array; loca: Uint8Array; format: number } {
  const header = new BinaryReader(data);
  header.u16();
  const options = header.u16(),
    count = header.u16(),
    indexFormat = header.u16(),
    sizes = Array.from({ length: 7 }, () => header.u32());
  const [contourStream, pointStream, flagStream, glyphStream, compositeStream, boxStream, instructionStream] =
    sizes.map((size) => new BinaryReader(take(header, size)));
  const overlap = options & 1 ? take(header, (count + 7) >> 3) : undefined,
    boxed = take(boxStream, ((count + 31) >> 5) * 4),
    bit = (map: Uint8Array, i: number) => (map[i >> 3] & (0x80 >> (i & 7))) !== 0,
    out = new Output(limit),
    offsets = new Uint32Array(count + 1);
  const instructions = () => {
    const length = read255(glyphStream);
    out.u16(length);
    out.bytes(take(instructionStream, length));
  };
  for (let glyph = 0; glyph < count; glyph++) {
    offsets[glyph] = out.length;
    const contours = contourStream.i16(),
      box = bit(boxed, glyph) ? take(boxStream, 8) : undefined;
    if (contours === 0) {
      if (box) woffError(`empty glyph ${glyph} carries a bounding box`);
      continue;
    }
    if (contours < 0) {
      if (contours !== -1 || !box) woffError(`composite glyph ${glyph} has no bounding box or a bad contour count`);
      out.u16(0xffff);
      out.bytes(box);
      const start = compositeStream.pos;
      let flags: number,
        hinted = false;
      do {
        flags = compositeStream.u16();
        hinted ||= (flags & 0x100) !== 0;
        // Glyph index, two arguments (words or bytes) and the optional scale, x/y scale or 2x2 transform.
        compositeStream.skip(2 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0));
      } while (flags & 0x20);
      out.bytes(compositeStream.bytes.subarray(start, compositeStream.pos));
      if (hinted) instructions();
    } else {
      const ends: number[] = [];
      let points = 0;
      for (let c = 0; c < contours; c++) {
        points += read255(pointStream);
        if (points < 1 || points > 65536) woffError(`glyph ${glyph} has an impossible number of points`, 'range');
        ends.push(points - 1);
      }
      const flags = take(flagStream, points),
        xs: number[] = [],
        ys: number[] = [];
      let x = 0,
        y = 0,
        xMin = 32767,
        yMin = 32767,
        xMax = -32768,
        yMax = -32768;
      for (let i = 0; i < points; i++) {
        const [dx, dy] = triplet(flags[i] & 127, glyphStream);
        x += dx;
        y += dy;
        if (
          dx < -32768 ||
          dx > 32767 ||
          dy < -32768 ||
          dy > 32767 ||
          x < -32768 ||
          x > 32767 ||
          y < -32768 ||
          y > 32767
        )
          woffError(`glyph ${glyph} leaves the 16-bit coordinate range`, 'range');
        xs.push(dx);
        ys.push(dy);
        xMin = Math.min(xMin, x);
        yMin = Math.min(yMin, y);
        xMax = Math.max(xMax, x);
        yMax = Math.max(yMax, y);
      }
      out.u16(contours);
      if (box) out.bytes(box);
      else for (const v of [xMin, yMin, xMax, yMax]) out.u16(v);
      for (const end of ends) out.u16(end);
      instructions();
      // 'glyf' simple glyph: flags (on curve, short and same-or-sign bits), then all x deltas, then all y deltas.
      for (let i = 0; i < points; i++) {
        let flag = flags[i] & 128 ? 0 : 1;
        if (i === 0 && overlap && bit(overlap, glyph)) flag |= 0x40;
        for (const [delta, short, same] of [
          [xs[i], 2, 16],
          [ys[i], 4, 32],
        ])
          if (delta === 0) flag |= same;
          else if (delta >= -255 && delta <= 255) flag |= short | (delta > 0 ? same : 0);
        out.u8(flag);
      }
      for (const list of [xs, ys])
        for (const delta of list)
          if (delta >= -255 && delta <= 255) {
            if (delta) out.u8(Math.abs(delta));
          } else out.u16(delta);
    }
    // Short 'loca' offsets are halved, so every glyph ends on an even byte.
    if (out.length & 1) out.u8(0);
  }
  offsets[count] = out.length;
  // A short 'loca' reaches 131070 bytes; a font the rebuild grows past that gets the long one.
  const format = indexFormat === 0 && out.length <= 0x1fffe ? 0 : 1,
    loca = new Uint8Array((count + 1) * (format ? 4 : 2)),
    view = new DataView(loca.buffer);
  offsets.forEach((offset, i) => (format ? view.setUint32(i * 4, offset) : view.setUint16(i * 2, offset / 2)));
  return { glyf: out.result(), loca, format };
}

/**
 * The `hmtx` table of its WOFF2 transform (version 1): left side bearings the encoder left out are each glyph's xMin
 * in the font's `glyf` table.
 */
export function rebuildHmtx(
  data: Uint8Array,
  metrics: number,
  glyphCount: number,
  glyf: Uint8Array,
  loca: Uint8Array,
  format: number,
): Uint8Array {
  const r = new BinaryReader(data),
    flags = r.u8();
  if (!(flags & 3) || flags & 0xfc) woffError("the transformed 'hmtx' flags are invalid");
  if (metrics < 1 || metrics > glyphCount)
    woffError("'hhea' gives an impossible number of horizontal metrics", 'range');
  const advances = Array.from({ length: metrics }, () => r.u16()),
    bearings = flags & 1 ? undefined : Array.from({ length: metrics }, () => r.u16()),
    trailing = flags & 2 ? undefined : Array.from({ length: glyphCount - metrics }, () => r.u16()),
    offsets = new BinaryReader(loca),
    glyphs = new BinaryReader(glyf);
  const xMin = (glyph: number): number => {
    offsets.seek(glyph * (format ? 4 : 2));
    const start = format ? offsets.u32() : offsets.u16() * 2,
      end = format ? offsets.u32() : offsets.u16() * 2;
    if (end <= start) return 0;
    glyphs.seek(start + 2);
    return glyphs.u16();
  };
  const out = new Uint8Array(metrics * 4 + (glyphCount - metrics) * 2),
    view = new DataView(out.buffer);
  for (let i = 0; i < metrics; i++) {
    view.setUint16(i * 4, advances[i]);
    view.setUint16(i * 4 + 2, bearings ? bearings[i] : xMin(i));
  }
  for (let i = metrics; i < glyphCount; i++)
    view.setUint16(metrics * 4 + (i - metrics) * 2, trailing ? trailing[i - metrics] : xMin(i));
  return out;
}
