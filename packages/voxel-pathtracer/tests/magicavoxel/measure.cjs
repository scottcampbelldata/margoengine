// Mean colour of each board tile's centre in a top-down render (MagicaVoxel snapshot or ours).
// node measure.cjs <png> <board D|G|E> [json-out]
const fs = require('fs'), zlib = require('zlib');

function decode(file) {
  const b = fs.readFileSync(file); let o = 8, w, h, ct, depth; const idat = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8);
    if (t === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); depth = b[o + 16]; ct = b[o + 17]; }
    if (t === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  if (depth !== 8) throw new Error('8-bit PNG only');
  const ch = { 2: 3, 6: 4, 0: 1 }[ct], raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, up = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      cur[x] = (line[x] + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[4 * (y * w + x) + k] = k < ch ? cur[x * ch + Math.min(k, ch - 1)] : 255;
    if (ch === 1) for (let x = 0; x < w; x++) { const v = cur[x]; out.set([v, v, v, 255], 4 * (y * w + x)); }
    prev = cur;
  }
  return { width: w, height: h, data: out };
}

/** Tile centre in pixels for a top-down camera `radius` above focus z (fov vertical degrees). */
function tilePixel(img, i, j, top, { radius = 190, focusZ = 1, fov = 20 } = {}) {
  const dist = focusZ + radius - top, scale = img.height / 2 / (dist * Math.tan((fov * Math.PI) / 360));
  return { x: img.width / 2 + (8 * i - 28) * scale, y: img.height / 2 - (8 * j - 28) * scale, voxel: scale };
}

function sample(img, cx, cy, half) {
  const s = [0, 0, 0]; let n = 0;
  for (let y = Math.round(cy - half); y < Math.round(cy + half); y++) for (let x = Math.round(cx - half); x < Math.round(cx + half); x++) {
    const p = 4 * (y * img.width + x); s[0] += img.data[p]; s[1] += img.data[p + 1]; s[2] += img.data[p + 2]; n++;
  }
  return s.map((v) => +(v / n).toFixed(2));
}

function measure(file, board) {
  const img = decode(file), layout = JSON.parse(fs.readFileSync(__dirname + '/boards.json', 'utf8')).boards[board].layout;
  return layout.map((t) => {
    const top = t.height ? 1 + t.height : 1, p = tilePixel(img, t.i, t.j, top);
    return { i: t.i, j: t.j, index: t.index, color: t.color, mat: t.mat, base: t.base, rgb: sample(img, p.x, p.y, 1.2 * p.voxel) };
  });
}
module.exports = { decode, measure, tilePixel, sample };
if (require.main === module) {
  const r = measure(process.argv[2], process.argv[3]);
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(r, null, 1));
  for (const t of r) console.log(t.i, t.j, JSON.stringify(t.color), JSON.stringify(t.mat).slice(0, 90), '->', t.rgb.join(' '));
}
