import { readBytes } from '../../packages/shared/loading.js';
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  table[i] = crc >>> 0;
}
function checksum(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const passes = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

// Original PNG reconstruction; the browser's standard inflater handles the zlib stream.
export async function decodePNG(bytes, { signal } = {}) {
  signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > 64 * 1024 * 1024)
    throw new TypeError('Invalid PNG bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new TypeError('Invalid PNG signature');
  let width,
    height,
    depth,
    type,
    interlace,
    palette,
    transparency,
    ended = false,
    dataStarted = false,
    dataEnded = false;
  const compressed = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length,
      name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (end > bytes.length || checksum(bytes, offset + 4, end - 4) !== view.getUint32(end - 4))
      throw new TypeError('Invalid PNG chunk bounds or CRC');
    const data = bytes.subarray(offset + 8, end - 4);
    if (width === undefined && name !== 'IHDR') throw new TypeError('PNG IHDR must be first');
    if (name === 'IHDR') {
      if (width !== undefined || length !== 13) throw new TypeError('Invalid PNG IHDR');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      [depth, type] = data.subarray(8, 10);
      interlace = data[12];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        width * height > 16777216 ||
        !depths[type]?.includes(depth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        interlace > 1
      )
        throw new RangeError('Unsupported PNG header or dimensions');
    } else if (name === 'PLTE') {
      if (palette || dataStarted || !length || length % 3 || length > 768 || [0, 4].includes(type))
        throw new TypeError('Invalid PNG palette');
      palette = data;
    } else if (name === 'tRNS') {
      if (
        transparency ||
        dataStarted ||
        !length ||
        (type === 0 && length !== 2) ||
        (type === 2 && length !== 6) ||
        (type === 3 && (!palette || length > palette.length / 3)) ||
        [4, 6].includes(type)
      )
        throw new TypeError('Invalid PNG transparency');
      transparency = data;
    } else if (name === 'IDAT') {
      if (dataEnded || (type === 3 && !palette)) throw new TypeError('Invalid PNG IDAT order or missing palette');
      dataStarted = true;
      compressed.push(data);
    } else if (name === 'IEND') {
      if (length || !dataStarted || end !== bytes.length) throw new TypeError('Invalid PNG end');
      ended = true;
      break;
    } else {
      if (!(bytes[offset + 4] & 32)) throw new TypeError(`Unsupported PNG critical chunk ${name}`);
      if (dataStarted) dataEnded = true;
    }
    offset = end;
  }
  if (!ended || (type === 3 && palette.length / 3 > 2 ** depth))
    throw new TypeError('Incomplete PNG or oversized palette');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type],
    bits = channels * depth,
    bpp = Math.max(1, Math.ceil(bits / 8)),
    layouts = (interlace ? passes : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => ({
      x,
      y,
      dx,
      dy,
      w: Math.max(0, Math.ceil((width - x) / dx)),
      h: Math.max(0, Math.ceil((height - y) / dy)),
    }));
  const expected = layouts.reduce((sum, p) => sum + (p.w && p.h ? (Math.ceil((p.w * bits) / 8) + 1) * p.h : 0), 0),
    stream = new Blob(compressed).stream().pipeThrough(new DecompressionStream('deflate')),
    inflated = await readBytes(stream, {
      signal,
      maxBytes: expected,
      label: 'PNG expected pixel data',
      output: new Uint8Array(expected),
    });
  if (inflated.length !== expected) throw new TypeError('Truncated PNG pixels');
  const output = new Uint8Array(width * height * 4),
    maximum = 2 ** depth - 1,
    transparentView = transparency
      ? new DataView(transparency.buffer, transparency.byteOffset, transparency.byteLength)
      : null,
    samples = new Uint32Array(channels),
    scale = (v) => Math.round((v * 255) / maximum);
  let cursor = 0;
  if (transparentView && (type === 0 || type === 2))
    for (let i = 0; i < transparency.length; i += 2)
      if (transparentView.getUint16(i) > maximum) throw new TypeError('PNG transparent sample exceeds bit depth');
  for (const p of layouts) {
    if (!p.w || !p.h) continue;
    const rowBytes = Math.ceil((p.w * bits) / 8);
    let previous = new Uint8Array(rowBytes),
      row = new Uint8Array(rowBytes);
    for (let y = 0; y < p.h; y++) {
      const filter = inflated[cursor++];
      if (filter > 4) throw new TypeError('Invalid PNG filter');
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp] : 0,
          b = previous[i],
          c = i >= bpp ? previous[i - bpp] : 0;
        let predictor = 0;
        if (filter === 1) predictor = a;
        else if (filter === 2) predictor = b;
        else if (filter === 3) predictor = Math.floor((a + b) / 2);
        else if (filter === 4) {
          const estimate = a + b - c,
            da = Math.abs(estimate - a),
            db = Math.abs(estimate - b),
            dc = Math.abs(estimate - c);
          predictor = da <= db && da <= dc ? a : db <= dc ? b : c;
        }
        row[i] = inflated[cursor++] + predictor;
      }
      for (let x = 0; x < p.w; x++) {
        for (let c = 0; c < channels; c++) {
          const bit = (x * channels + c) * depth,
            byte = bit >> 3;
          samples[c] =
            depth === 16
              ? row[byte] * 256 + row[byte + 1]
              : depth === 8
                ? row[byte]
                : (row[byte] >> (8 - depth - (bit % 8))) & maximum;
        }
        const o = ((p.y + y * p.dy) * width + p.x + x * p.dx) * 4;
        let alpha = 255;
        if (type === 3) {
          const i = samples[0];
          if (i >= palette.length / 3) throw new TypeError('PNG palette index out of bounds');
          output.set(palette.subarray(i * 3, i * 3 + 3), o);
          alpha = transparency?.[i] ?? 255;
        } else if (type === 0 || type === 4) {
          output.fill(scale(samples[0]), o, o + 3);
          if (type === 4) alpha = scale(samples[1]);
          else if (transparentView && samples[0] === transparentView.getUint16(0)) alpha = 0;
        } else {
          for (let c = 0; c < 3; c++) output[o + c] = scale(samples[c]);
          if (type === 6) alpha = scale(samples[3]);
          else if (
            transparentView &&
            samples[0] === transparentView.getUint16(0) &&
            samples[1] === transparentView.getUint16(2) &&
            samples[2] === transparentView.getUint16(4)
          )
            alpha = 0;
        }
        output[o + 3] = alpha;
      }
      [previous, row] = [row, previous];
    }
  }
  return { width, height, data: output };
}
