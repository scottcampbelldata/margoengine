// Minimal Radiance .hdr reader (flat or RLE scanlines) -> { width, height, data: Float32Array RGB }.
const fs = require('fs');
function readHdr(file) {
  const b = fs.readFileSync(file);
  let o = 0;
  const line = () => {
    const e = b.indexOf(10, o);
    const s = b.toString('latin1', o, e);
    o = e + 1;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance file');
  while (line() !== '');
  const m = /-Y (\d+) \+X (\d+)/.exec(line()),
    H = +m[1],
    W = +m[2],
    data = new Float32Array(W * H * 3),
    row = new Uint8Array(W * 4);
  for (let y = 0; y < H; y++) {
    if (W >= 8 && W < 32768 && b[o] === 2 && b[o + 1] === 2 && ((b[o + 2] << 8) | b[o + 3]) === W) {
      o += 4;
      for (let c = 0; c < 4; c++)
        for (let x = 0; x < W; ) {
          let n = b[o++];
          if (n > 128) {
            n -= 128;
            const v = b[o++];
            while (n--) row[4 * x++ + c] = v;
          } else while (n--) row[4 * x++ + c] = b[o++];
        }
    } else {
      row.set(b.subarray(o, o + 4 * W));
      o += 4 * W;
    }
    for (let x = 0; x < W; x++) {
      const e = row[4 * x + 3],
        f = e ? 2 ** (e - 136) : 0;
      data.set([row[4 * x] * f, row[4 * x + 1] * f, row[4 * x + 2] * f], 3 * (y * W + x));
    }
  }
  return { width: W, height: H, data };
}
module.exports = { readHdr };
if (require.main === module) {
  const h = readHdr(process.argv[2]);
  for (const [x, y] of [
    [0, 0],
    [256, 128],
    [511, 255],
  ])
    console.log(
      x,
      y,
      [...h.data.subarray(3 * (y * h.width + x), 3 * (y * h.width + x) + 3)].map((v) => v.toFixed(4)).join(' '),
    );
}
