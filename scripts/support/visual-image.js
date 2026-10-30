// Image helpers shared by the visual check (scripts/visual-regression.js) and its WebGL2 compatibility run
// (scripts/visual-compat.mjs): PNG encoding, box downsampling and the per-pixel comparison.
import { deflateSync, crc32 } from 'node:zlib';

/** A pixel off by more than about 10% in some channel counts as hot. */
export const HOT = 24;

// PNG: 8-bit RGB, per-row filter chosen by the minimum-sum heuristic.
export function encodePNG({ width, height, data }) {
  const stride = width * 3,
    raw = Buffer.alloc((stride + 1) * height),
    row = new Uint8Array(stride),
    prev = new Uint8Array(stride),
    cand = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) row[x * 3 + c] = data[(y * width + x) * 4 + c];
    let best = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0,
          b = prev[i],
          c = i >= 3 ? prev[i - 3] : 0,
          p = a + b - c;
        const pred =
          f === 0
            ? 0
            : f === 1
              ? a
              : f === 2
                ? b
                : f === 3
                  ? (a + b) >> 1
                  : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
                    ? a
                    : Math.abs(p - b) <= Math.abs(p - c)
                      ? b
                      : c;
        cand[i] = row[i] - pred;
        sum += cand[i] < 128 ? cand[i] : 256 - cand[i];
      }
      if (sum < best) {
        best = sum;
        raw[y * (stride + 1)] = f;
        raw.set(cand, y * (stride + 1) + 1);
      }
    }
    prev.set(row);
  }
  const chunk = (type, body) => {
    const b = Buffer.alloc(body.length + 12);
    b.writeUInt32BE(body.length);
    b.write(type, 4, 'latin1');
    body.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function downsample({ width, height, data }, f) {
  const w = Math.floor(width / f),
    h = Math.floor(height / f),
    o = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += data[((y * f + j) * width + x * f + i) * 4 + c];
        o[(y * w + x) * 4 + c] = Math.round(sum / (f * f));
      }
  return { width: w, height: h, data: o };
}
export function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height)
    return { changed: 1, hot: 1, mean: 255, max: 255, size: `${b.width}x${b.height} vs ${a.width}x${a.height}` };
  const n = a.width * a.height,
    diff = new Uint8Array(n * 4);
  let sum = 0,
    changed = 0,
    hot = 0,
    max = 0;
  for (let p = 0; p < n; p++) {
    const k = p * 4,
      d = Math.max(
        Math.abs(a.data[k] - b.data[k]),
        Math.abs(a.data[k + 1] - b.data[k + 1]),
        Math.abs(a.data[k + 2] - b.data[k + 2]),
      );
    sum += d;
    if (d) changed++;
    if (d > HOT) hot++;
    if (d > max) max = d;
    const gray = (a.data[k] + a.data[k + 1] + a.data[k + 2]) / 10; // dimmed baseline; any changed pixel shows red
    diff[k] = d ? Math.min(255, gray + 48 + d * 8) : gray;
    diff[k + 1] = diff[k + 2] = gray;
    diff[k + 3] = 255;
  }
  return {
    changed: changed / n,
    hot: hot / n,
    mean: sum / n,
    max,
    image: { width: a.width, height: a.height, data: diff },
  };
}
