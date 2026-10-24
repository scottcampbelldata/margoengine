// Encoders for the TGA, DDS, KTX 1 and TIFF reader tests and the demo fixtures (scripts/texture-fixtures.mjs), written
// from the same four specifications the readers follow. Test-only: never shipped.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

/** Messages name the fix after the problem (docs/conventions.md): a '; ' clause or a fix verb. */
export const namesFix = (message) => /; \w|\b(must|needs?|pass|use|raise|request|resize|convert|save)\b/.test(message);

/** Asserts `fn` throws MargoError `code` (default 'failed') whose message matches `pattern` and names a fix. */
export const failed = (fn, pattern, code = 'failed') =>
  assert.throws(
    fn,
    (error) =>
      error.name === 'MargoError' && error.code === code && pattern.test(error.message) && namesFix(error.message),
  );

/** Asserts `fn` throws a `Type` (TypeError, RangeError) whose message matches `pattern` and names a fix. */
export const rejects = (fn, Type, pattern = /./) =>
  assert.throws(fn, (error) => error instanceof Type && pattern.test(error.message) && namesFix(error.message));

/** One BC1 block of a single colour: both endpoints the RGB565 colour, every index 0. */
export function bc1Solid(r, g, b) {
  const c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  return [c & 255, c >> 8, c & 255, c >> 8, 0, 0, 0, 0];
}

// A small deterministic RGBA image, top row first.
export function image(width, height, seed = 1, alpha = true) {
  const data = new Uint8Array(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = i % 4 === 3 && !alpha ? 255 : (s >>> 16) & 255;
  }
  return data;
}
/** Pixels in file order for a TGA origin: bottom-up unless `top`, right-to-left when `right`. */
export function fileOrder(rgba, width, height, top, right) {
  const order = [];
  for (let fy = 0; fy < height; fy++)
    for (let fx = 0; fx < width; fx++) {
      const y = top ? fy : height - 1 - fy,
        x = right ? width - 1 - fx : fx;
      order.push(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    }
  return order;
}

export function tgaRLE(pixels, size) {
  const out = [];
  for (let i = 0; i < pixels.length; ) {
    let run = 1;
    const same = (a, b) => pixels[a].every((v, k) => v === pixels[b][k]);
    while (i + run < pixels.length && run < 128 && same(i, i + run)) run++;
    if (run > 1) {
      out.push(128 | (run - 1), ...pixels[i].subarray(0, size));
      i += run;
    } else {
      let n = 1;
      while (i + n < pixels.length && n < 128 && !(i + n + 1 < pixels.length && same(i + n, i + n + 1))) n++;
      out.push(n - 1);
      for (let k = 0; k < n; k++) out.push(...pixels[i + k].subarray(0, size));
      i += n;
    }
  }
  return out;
}

export function tga({
  type,
  width,
  height,
  bits,
  descriptor = 0,
  pixels,
  map,
  mapBits = 24,
  mapFirst = 0,
  id = [],
  footer,
}) {
  const header = [
    id.length,
    map ? 1 : 0,
    type,
    mapFirst & 255,
    mapFirst >> 8,
    map ? map.length & 255 : 0,
    map ? map.length >> 8 : 0,
    map ? mapBits : 0,
    0,
    0,
    0,
    0,
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
    bits,
    descriptor,
  ];
  const size = (bits + 7) >> 3,
    body = type > 8 ? tgaRLE(pixels, size) : pixels.flatMap((p) => [...p.subarray(0, size)]);
  const bytes = [...header, ...id, ...(map ? map.flat() : []), ...body];
  if (footer !== undefined) {
    const extension = bytes.length,
      area = new Array(495).fill(0);
    area[0] = 495 & 255;
    area[1] = 495 >> 8;
    area[494] = footer;
    bytes.push(...area, extension & 255, (extension >> 8) & 255, extension >> 16, 0, 0, 0, 0, 0);
    bytes.push(...Buffer.from('TRUEVISION-XFILE.\0', 'latin1'));
  }
  return new Uint8Array(bytes);
}
export const bgra = (p) => new Uint8Array([p[2], p[1], p[0], p[3]]);
export function dds({
  width,
  height,
  mips = 1,
  fourCC,
  bits = 0,
  masks = [0, 0, 0, 0],
  pfFlags,
  caps2 = 0,
  dx10,
  data,
}) {
  const header = new DataView(new ArrayBuffer(dx10 ? 148 : 128));
  header.setUint32(0, 0x20534444, true);
  header.setUint32(4, 124, true);
  header.setUint32(8, 0x1007 | (mips > 1 ? 0x20000 : 0), true);
  header.setUint32(12, height, true);
  header.setUint32(16, width, true);
  header.setUint32(28, mips, true);
  header.setUint32(76, 32, true);
  const cc = dx10 ? 'DX10' : fourCC;
  header.setUint32(80, pfFlags ?? (cc ? 4 : 0x40 | (masks[3] ? 1 : 0)), true);
  if (cc) for (let i = 0; i < 4; i++) header.setUint8(84 + i, cc.charCodeAt(i));
  header.setUint32(88, bits, true);
  masks.forEach((m, i) => header.setUint32(92 + i * 4, m, true));
  header.setUint32(108, 0x1000 | (mips > 1 ? 0x400008 : 0), true);
  header.setUint32(112, caps2, true);
  if (dx10)
    [dx10.format, dx10.dimension ?? 3, dx10.misc ?? 0, dx10.array ?? 1, dx10.misc2 ?? 0].forEach((v, i) =>
      header.setUint32(128 + i * 4, v, true),
    );
  return new Uint8Array([...new Uint8Array(header.buffer), ...data]);
}
export const sequence = (n, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i * 7) & 255);
export function mockDevice(features = []) {
  const calls = [];
  return {
    calls,
    features: new Set(features),
    limits: { maxTextureDimension2D: 8192 },
    createTexture(descriptor) {
      calls.push(['create', descriptor]);
      return { destroy: () => calls.push(['destroy']) };
    },
    queue: { writeTexture: (...args) => calls.push(['write', ...args]) },
  };
}

/** A KTX 1 file. `images[level][layer]` are tight rows; rows pad to 4 bytes unless `compressed`. */
export function ktx({
  internal,
  type = 0x1401,
  typeSize = 1,
  width,
  height,
  depth = 0,
  array = 0,
  faces = 1,
  rowBytes,
  images,
  keyValue = [],
  big = false,
  compressed = false,
  swap = 0,
  imageSize,
}) {
  const out = [];
  const u32 = (v) => {
    const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
    out.push(...(big ? b.reverse() : b));
  };
  out.push(0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a);
  u32(0x04030201);
  [
    compressed ? 0 : type,
    typeSize,
    compressed ? 0 : 0x1908,
    internal,
    0x1908,
    width,
    height,
    depth,
    array,
    faces,
    images.length,
    keyValue.length,
  ].forEach(u32);
  out.push(...keyValue);
  images.forEach((layers, level) => {
    const w = Math.max(1, width >> level),
      tight = rowBytes(w),
      stride = compressed ? tight : (tight + 3) & ~3,
      padded = layers.map((data) => {
        const rows = data.length / tight,
          face = [];
        for (let y = 0; y < rows; y++) {
          const row = [...data.subarray(y * tight, (y + 1) * tight)];
          if (swap) for (let i = 0; i < row.length; i += swap) row.splice(i, swap, ...row.slice(i, i + swap).reverse());
          face.push(...row, ...new Array(stride - tight).fill(0));
        }
        return face;
      });
    u32(imageSize?.[level] ?? (faces === 6 && !array ? padded[0].length : padded.reduce((n, f) => n + f.length, 0)));
    for (const face of padded) {
      for (const byte of face) out.push(byte);
      if (faces === 6 && !array) while (out.length % 4) out.push(0);
    }
    while (out.length % 4) out.push(0);
  });
  return new Uint8Array(out);
}

/** TIFF LZW encoder (MSB-first, 9-12 bit codes, early change). */
export function lzwEncode(data) {
  const out = [];
  let acc = 0,
    bitsHeld = 0,
    width = 9,
    next = 258,
    table = new Map();
  const emit = (code) => {
    acc = (acc << width) | code;
    bitsHeld += width;
    while (bitsHeld >= 8) {
      out.push((acc >>> (bitsHeld - 8)) & 255);
      bitsHeld -= 8;
    }
    acc &= (1 << bitsHeld) - 1;
  };
  const grow = () => {
    next++;
    if (next >= 1 << width && width < 12) width++;
  };
  emit(256);
  let current = '',
    code = -1;
  for (const byte of data) {
    const ch = String.fromCharCode(byte);
    if (!current) {
      current = ch;
      code = byte;
      continue;
    }
    const joined = current + ch;
    if (table.has(joined)) {
      current = joined;
      code = table.get(joined);
      continue;
    }
    emit(code);
    table.set(joined, next);
    grow();
    if (next === 4094) {
      emit(256);
      width = 9;
      next = 258;
      table = new Map();
    }
    current = ch;
    code = byte;
  }
  if (current) {
    emit(code);
    grow();
  }
  emit(257);
  if (bitsHeld) out.push((acc << (8 - bitsHeld)) & 255);
  return Uint8Array.from(out);
}

export function packBitsEncode(data) {
  const out = [];
  for (let i = 0; i < data.length; ) {
    let run = 1;
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run++;
    if (run > 1) {
      out.push(257 - run, data[i]);
      i += run;
    } else {
      let n = 1;
      while (i + n < data.length && n < 128 && data[i + n] !== data[i + n + 1]) n++;
      out.push(n - 1, ...data.subarray(i, i + n));
      i += n;
    }
  }
  // A no-op header must be skipped.
  out.push(128);
  return Uint8Array.from(out);
}

/** A one-IFD TIFF of chunky `samples` (`width * height * spp` values), re-laid out per the options. */
export function tiff({
  little = true,
  width,
  height,
  spp,
  bits,
  float = false,
  photometric,
  compression = 1,
  predictor = 1,
  planar = 1,
  rowsPerStrip = height,
  tile,
  extra,
  colorMap,
  samples,
  /** Compressed strips or tiles to store instead of encoding `samples` (for malformed-data tests). */
  raw,
  /** Extra [tag, type, values] IFD entries, replacing any of the same tag. */
  tags = [],
}) {
  const perPixel = planar === 2 ? 1 : spp,
    planes = planar === 2 ? spp : 1,
    [tw, th] = tile ?? [width, rowsPerStrip],
    across = Math.ceil(width / tw),
    down = Math.ceil(height / th),
    rowBytes = Math.ceil((tw * perPixel * bits) / 8),
    blocks = [];
  for (let plane = 0; plane < planes; plane++)
    for (let by = 0; by < down; by++)
      for (let bx = 0; bx < across; bx++) {
        const rows = tile ? th : Math.min(th, height - by * th),
          bytes = new Uint8Array(rowBytes * rows),
          view = new DataView(bytes.buffer);
        for (let y = 0; y < rows; y++) {
          const row = [];
          for (let x = 0; x < tw; x++)
            for (let c = 0; c < perPixel; c++) {
              const ix = bx * tw + x,
                iy = by * th + y;
              row.push(ix < width && iy < height ? samples[(iy * width + ix) * spp + plane + c] : 0);
            }
          if (predictor === 2)
            for (let i = row.length - 1; i >= perPixel; i--)
              row[i] = (row[i] - row[i - perPixel] + 2 ** bits) % 2 ** bits;
          row.forEach((v, i) => {
            const at = y * rowBytes;
            if (float) view.setFloat32(at + i * 4, v, little);
            else if (bits === 16) view.setUint16(at + i * 2, v, little);
            else if (bits === 8) bytes[at + i] = v;
            else bytes[at + ((i * bits) >> 3)] |= v << (8 - bits - ((i * bits) & 7));
          });
        }
        blocks.push(
          compression === 5
            ? lzwEncode(bytes)
            : compression === 32773
              ? packBitsEncode(bytes)
              : compression === 8 || compression === 32946
                ? deflateSync(bytes)
                : bytes,
        );
      }
  if (raw) blocks.splice(0, blocks.length, ...raw);
  const out = [0, 0, 0, 0, 0, 0, 0, 0],
    offsets = [];
  for (const block of blocks) {
    offsets.push(out.length);
    for (const byte of block) out.push(byte);
    if (out.length % 2) out.push(0);
  }
  const SHORT = 3,
    LONG = 4,
    entries = [
      [256, LONG, [width]],
      [257, SHORT, [height]],
      [258, SHORT, new Array(spp).fill(bits)],
      [259, SHORT, [compression]],
      [262, SHORT, [photometric]],
      [tile ? 324 : 273, LONG, offsets],
      [277, SHORT, [spp]],
      ...(tile ? [] : [[278, LONG, [rowsPerStrip]]]),
      [tile ? 325 : 279, LONG, blocks.map((b) => b.length)],
      [284, SHORT, [planar]],
      [305, 2, [0x4d, 0x61, 0x72, 0x67, 0x6f, 0]],
      ...(predictor !== 1 ? [[317, SHORT, [predictor]]] : []),
      ...(colorMap ? [[320, SHORT, colorMap]] : []),
      ...(tile
        ? [
            [322, SHORT, [tw]],
            [323, SHORT, [th]],
          ]
        : []),
      ...(extra !== undefined ? [[338, SHORT, [extra].flat()]] : []),
      ...(float ? [[339, SHORT, new Array(spp).fill(3)]] : []),
    ]
      .filter(([id]) => !tags.some((t) => t[0] === id))
      .concat(tags.filter((t) => t[2]))
      .sort((a, b) => a[0] - b[0]);
  const bytesOf = (type, values) => {
    const size = type === LONG ? 4 : type === SHORT ? 2 : 1,
      b = new Uint8Array(size * values.length),
      v = new DataView(b.buffer);
    values.forEach((x, i) =>
      size === 4 ? v.setUint32(i * 4, x, little) : size === 2 ? v.setUint16(i * 2, x, little) : (b[i] = x),
    );
    return b;
  };
  const fields = entries.map(([id, type, values]) => {
    const data = bytesOf(type, values);
    let at = -1;
    if (data.length > 4) {
      at = out.length;
      for (const byte of data) out.push(byte);
      if (out.length % 2) out.push(0);
    }
    return { id, type, count: values.length, data, at };
  });
  const ifd = out.length,
    table = new Uint8Array(2 + fields.length * 12 + 4),
    t = new DataView(table.buffer);
  t.setUint16(0, fields.length, little);
  fields.forEach(({ id, type, count, data, at }, i) => {
    const e = 2 + i * 12;
    t.setUint16(e, id, little);
    t.setUint16(e + 2, type, little);
    t.setUint32(e + 4, count, little);
    if (at >= 0) t.setUint32(e + 8, at, little);
    else table.set(data, e + 8);
  });
  out.push(...table);
  const file = Uint8Array.from(out),
    h = new DataView(file.buffer);
  file[0] = file[1] = little ? 0x49 : 0x4d;
  h.setUint16(2, 42, little);
  h.setUint32(4, ifd, little);
  return file;
}

export const rgbaOf = (samples, spp, f) =>
  Uint8Array.from({ length: (samples.length / spp) * 4 }, (_, i) => f(samples, Math.floor(i / 4) * spp, i % 4));
