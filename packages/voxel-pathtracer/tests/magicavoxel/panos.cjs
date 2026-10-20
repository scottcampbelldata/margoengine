// node panos.cjs [suffix...]: the atmosphere panoramas (A-pano-*, ground off), MagicaVoxel's against ours: the sky
// half per pixel (within 3 levels), the half below the horizon on 3 x 2-degree blocks (MagicaVoxel's is too noisy per
// pixel): mean |difference| in levels and share of blocks within 3. An empty suffix is the plain -ours render.
const { decode } = require('./measure.cjs');
const lin = (v) => (v / 255) ** 2.2,
  show = (x) => 255 * Math.min(1, x) ** (1 / 2.2);
const suffixes = process.argv.slice(2);
const names = require('fs')
  .readdirSync('.')
  .filter((f) => /^A-pano-.*-mv\.png$/.test(f))
  .map((f) => f.slice(7, -7));
const tot = suffixes.map(() => ({ sky: 0, mean: 0, w3: 0, n: 0 }));
for (const n of names) {
  const a = decode(`A-pano-${n}-mv.png`),
    row = [n.padEnd(9)];
  suffixes.forEach((suf, si) => {
    const b = decode(`A-pano-${n}-ours${suf}.png`);
    let w = 0,
      k = 0;
    for (let y = 0; y < 398; y++)
      for (let x = 0; x < 960; x++) {
        const i = 4 * (y * 960 + x);
        let m = 0;
        for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]));
        if (m <= 3) w++;
        k++;
      }
    let sum = 0,
      cnt = 0,
      w3 = 0;
    for (let y0 = 402; y0 + 9 <= 795; y0 += 9)
      for (let x0 = 2; x0 + 13 <= 958; x0 += 13) {
        const ma = [0, 0, 0],
          mb = [0, 0, 0];
        for (let y = y0; y < y0 + 9; y++)
          for (let x = x0; x < x0 + 13; x++) {
            const i = 4 * (y * 960 + x);
            for (let c = 0; c < 3; c++) {
              ma[c] += lin(a.data[i + c]);
              mb[c] += lin(b.data[i + c]);
            }
          }
        const d = ma.map((v, c) => Math.abs(show(v / 117) - show(mb[c] / 117))),
          mx = Math.max(...d);
        sum += d.reduce((p, q) => p + q, 0) / 3;
        cnt++;
        if (mx <= 3) w3++;
      }
    const sky = (100 * w) / k,
      mean = sum / cnt,
      wp = (100 * w3) / cnt;
    tot[si].sky += sky;
    tot[si].mean += mean;
    tot[si].w3 += wp;
    tot[si].n++;
    row.push(
      `${suf || 'now'}: sky ${sky.toFixed(2)}%  below mean ${mean.toFixed(1)}  blocks within 3 ${wp.toFixed(1)}%`,
    );
  });
  console.log(row.join(' | '));
}
console.log(
  'average',
  tot
    .map(
      (t, i) =>
        `${suffixes[i] || 'now'}: sky ${(t.sky / t.n).toFixed(2)}%  below mean ${(t.mean / t.n).toFixed(1)}  blocks within 3 ${(t.w3 / t.n).toFixed(1)}%`,
    )
    .join(' | '),
);
