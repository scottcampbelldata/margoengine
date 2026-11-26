// CPU oracle of ColorEnhance, written from the README's formulas (not from the shader): scene-linear RGB after exposure
// in, scene-linear RGB out.
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function enhanceOracle(input, o = {}) {
  const rows = [o.mixer?.red ?? [1, 0, 0], o.mixer?.green ?? [0, 1, 0], o.mixer?.blue ?? [0, 0, 1]];
  let c = rows.map((r) => Math.max(0, r[0] * input[0] + r[1] * input[1] + r[2] * input[2]));
  const air = o.hazeColor ?? [1, 1, 1],
    amount = o.dehaze ?? 0;
  if (amount > 0) {
    const v = 0.5 * amount * Math.min(...c.map((x, i) => Math.min(1, x / air[i])));
    c = c.map((x, i) => (x >= air[i] ? x : (x - air[i]) / (1 - v) + air[i]));
  } else if (amount < 0) {
    const t = 1 + 0.5 * amount;
    c = c.map((x, i) => x * t + air[i] * (1 - t));
  }
  const e = Math.log2(Math.max(luma(c), 1e-6) / 0.18),
    low = smooth(-7, 0, e),
    high = smooth(0, 7, e),
    gain = 2 ** ((o.shadows ?? 0) * (1 - low) + (o.midtones ?? 0) * (low - high) + (o.highlights ?? 0) * high);
  c = c.map((x) => x * gain);
  const hi = Math.max(...c),
    saturation = (hi - Math.min(...c)) / Math.max(hi, 1e-6),
    y = luma(c);
  return c.map((x) => Math.max(0, x + (x - y) * (o.vibrance ?? 0) * (1 - saturation)));
}
