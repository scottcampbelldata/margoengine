// node diff.cjs <name> [x0 y0 x1 y1]: whole-image (or region) MagicaVoxel vs ours: mean |difference| per channel,
// share of pixels within 3 / 6 / 10 levels; writes <name>-diff.png (MagicaVoxel | ours | |difference| x 4).
const fs = require('fs'), zlib = require('zlib');
const { decode } = require('./measure.cjs');
function encode(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function diff(name, region) {
  const a = decode(`${name}-mv.png`), b = decode(`${name}-ours.png`), w = a.width, h = a.height;
  const [x0, y0, x1, y1] = region ?? [0, 0, w, h];
  let n = 0, sum = [0, 0, 0], w3 = 0, w6 = 0, w10 = 0;
  const out = new Uint8Array(w * 3 * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = 4 * (y * w + x); let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p + c] - b.data[p + c]); m = Math.max(m, d);
      out[3 * (y * 3 * w + x) + c] = a.data[p + c]; out[3 * (y * 3 * w + w + x) + c] = b.data[p + c]; out[3 * (y * 3 * w + 2 * w + x) + c] = Math.min(255, 4 * d);
      if (x >= x0 && x < x1 && y >= y0 && y < y1) sum[c] += d;
    }
    if (x >= x0 && x < x1 && y >= y0 && y < y1) { n++; if (m <= 3) w3++; if (m <= 6) w6++; if (m <= 10) w10++; }
  }
  fs.writeFileSync(`${name}-diff.png`, encode(3 * w, h, out));
  return { name, mean: sum.map((s) => +(s / n).toFixed(2)), within3: +((100 * w3) / n).toFixed(1), within6: +((100 * w6) / n).toFixed(1), within10: +((100 * w10) / n).toFixed(1) };
}
module.exports = { diff, encode };
if (require.main === module) console.log(JSON.stringify(diff(process.argv[2], process.argv.length > 6 ? process.argv.slice(3, 7).map(Number) : undefined)));
