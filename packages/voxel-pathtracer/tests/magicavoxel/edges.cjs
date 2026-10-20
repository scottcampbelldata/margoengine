// Sub-pixel tile-edge positions (coverage in linear light) in MagicaVoxel's and our D board, then MagicaVoxel = a + b x ours.
const { decode } = require('./measure.cjs');
const name = process.argv[2] ?? 'D-sky-lin';
const lin = (v) => (v / 255) ** 2.2;
function edges(img, axis) {
  const s = 400 / (190 * Math.tan(Math.PI / 18)), out = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const cx = 480 + (8 * i - 28) * s, cy = 400 - (8 * j - 28) * s;
    for (const side of [-1, 1]) {
      // profile from inside the tile outward along the axis, at the tile's centre line
      const at = (k) => { const x = axis === 0 ? Math.round(cx + side * k) : Math.round(cx), y = axis === 1 ? Math.round(cy - side * k) : Math.round(cy); return lin(img.data[4 * (y * 960 + x)]); };
      const t = at(2.0 * s), g = at(4 * s);
      if (Math.abs(t - g) < 0.05) continue;
      let cover = 0;
      for (let k = Math.round(2 * s); k < Math.round(4 * s); k++) cover += Math.min(1, Math.max(0, (at(k) - g) / (t - g)));
      const edge = Math.round(2 * s) + cover; // pixels from the centre to the edge
      out.push({ i, j, side, pos: axis === 0 ? cx + side * edge : cy - side * edge, nominal: axis === 0 ? cx + side * 3 * s : cy - side * 3 * s });
    }
  }
  return out;
}
const a = decode(`${name}-mv.png`), b = decode(`${name}-ours.png`);
for (const axis of [0, 1]) {
  const ea = edges(a, axis), eb = edges(b, axis), c = axis === 0 ? 480 : 400;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  ea.forEach((e, k) => { const x = eb[k].pos - c, y = e.pos - c; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; });
  const bb = (n * sxy - sx * sy) / (n * sxx - sx * sx), aa = (sy - bb * sx) / n;
  const resid = ea.map((e, k) => e.pos - c - (aa + bb * (eb[k].pos - c)));
  console.log(axis ? 'y' : 'x', 'edges', n, 'MagicaVoxel = ', aa.toFixed(3), '+', bb.toFixed(5), 'x ours (from centre); rms residual', Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / n).toFixed(3), 'px; nominal ours offset', (eb.reduce((s, e) => s + e.pos - e.nominal, 0) / n).toFixed(3));
}
