// Which image pixel (u, v) and intensity each MagicaVoxel panorama direction shows (ramp.hdr: R = 0.02 + 0.46 u,
// G = 0.02 + 0.46 (1 - v), B = 0.25). Panorama: az = 90 - (x - 480) * 0.225 (from +x toward +y), el = (400 - y) * 0.225.
const { decode, sample } = require('./measure.cjs');
const lin = (v) => (v / 255) ** 2.2;
for (const n of process.argv.slice(2)) {
  const img = decode(`${n}-mv.png`);
  console.log(n);
  for (const [az, el] of [
    [90, 0],
    [0, 0],
    [180, 0],
    [45, 0],
    [90, 45],
    [90, -45],
    [0, 30],
    [135, -20],
    [60, 70],
  ]) {
    const x = 480 + (90 - az) / 0.225,
      y = 400 - el / 0.225;
    if (x < 2 || x > 957 || y < 2 || y > 797) {
      console.log(`  az ${az} el ${el}: off image`);
      continue;
    }
    const c = sample(img, x, y, 2).map(lin),
      I = c[2] / 0.25,
      u = (c[0] / I - 0.02) / 0.46,
      v = 1 - (c[1] / I - 0.02) / 0.46;
    console.log(
      `  az ${String(az).padStart(4)} el ${String(el).padStart(4)}: I ${I.toFixed(3)} u ${u.toFixed(3)} v ${v.toFixed(3)}  raw ${sample(img, x, y, 2).map(Math.round).join('/')}`,
    );
  }
}
