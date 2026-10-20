// Our image-sky lookup (helper's rotation and intensity, the shader's envUV and bilinear filter) against
// MagicaVoxel's panoramas of ramp.hdr, in 8-bit levels over every pixel.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decode } = require('./measure.cjs');
const { readHdr } = require('./hdr.cjs');
const { read } = require('./voxchunks.cjs');
const pt = await import('../../dist/index.js');
const hdr = readHdr('ramp.hdr');
for (const n of process.argv.slice(2)) {
  const objs = read(`${n}.vox`)
    .chunks.filter((c) => c.id === 'rOBJ')
    .map((c) => c.dict);
  const { environment: e } = pt.magicaVoxelLighting(objs, { imageSky: hdr });
  const m = e.map,
    img = decode(`${n}-mv.png`),
    W = m.width,
    H = m.height;
  const at = (x, y) => {
    x = ((x % W) + W) % W;
    y = Math.max(0, Math.min(H - 1, y));
    const i = 3 * (y * W + x);
    return [m.data[i], m.data[i + 1], m.data[i + 2]];
  };
  let n3 = 0,
    tot = 0,
    worst = 0;
  for (let py = 4; py < 796; py += 3)
    for (let px = 4; px < 956; px += 3) {
      const az = ((90 - (px + 0.5 - 480) * 0.225) * Math.PI) / 180,
        el = ((400 - (py + 0.5)) * 0.225 * Math.PI) / 180;
      const mv = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)],
        d = [mv[0], mv[2], -mv[1]];
      let u = Math.atan2(d[0], -d[2]) / (2 * Math.PI) + 0.5 - m.rotation / (2 * Math.PI);
      u -= Math.floor(u);
      const v = Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI;
      const fx = u * W - 0.5,
        fy = Math.max(0, Math.min(H - 1, v * H - 0.5)),
        x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        ax = fx - x0,
        ay = fy - y0;
      const a = at(x0, y0),
        b = at(x0 + 1, y0),
        c = at(x0, y0 + 1),
        dd = at(x0 + 1, y0 + 1);
      const L = [0, 1, 2].map(
        (k) => ((a[k] * (1 - ax) + b[k] * ax) * (1 - ay) + (c[k] * (1 - ax) + dd[k] * ax) * ay) * m.intensity,
      );
      const ours = L.map((x) => 255 * Math.min(1, x) ** (1 / 2.2)),
        i = 4 * (py * 960 + px),
        ref = [img.data[i], img.data[i + 1], img.data[i + 2]];
      const dmax = Math.max(...ours.map((x, k) => Math.abs(x - ref[k])));
      tot++;
      if (dmax <= 3) n3++;
      worst = Math.max(worst, dmax);
    }
  console.log(
    `${n.padEnd(12)} intensity ${m.intensity.toFixed(2)} rotation ${((m.rotation * 180) / Math.PI).toFixed(1)} deg: within 3 levels ${((100 * n3) / tot).toFixed(2)}% worst ${worst.toFixed(1)}`,
  );
}
