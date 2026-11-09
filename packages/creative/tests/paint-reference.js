// Independent double-precision, direct rectangular sums. Test-only, not a runtime fallback.
export function reference(data, width, height, options = {}, rect = [0, 0, width, height]) {
  const result = new Uint8Array(width * height * 4),
    [ox, oy, rw, rh] = rect;
  const sample = (x, y) => {
    const i = 4 * (Math.max(oy, Math.min(oy + rh - 1, y)) * width + Math.max(ox, Math.min(ox + rw - 1, x)));
    return Array.from(data.slice(i, i + 3), (v) => v / 255);
  };
  const luma = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  const edge = (x, y, r) => {
    const a = [-1, 0, 1].map((dy) => [-1, 0, 1].map((dx) => luma(sample(x + dx * r, y + dy * r))));
    const dx = a[0][2] + 2 * a[1][2] + a[2][2] - a[0][0] - 2 * a[1][0] - a[2][0];
    const dy = a[2][0] + 2 * a[2][1] + a[2][2] - a[0][0] - 2 * a[0][1] - a[0][2];
    return Math.min(1, Math.hypot(dx, dy) / 4);
  };
  const radius = options.radius ?? 3,
    strength = options.enabled === false ? 0 : (options.strength ?? 1);
  for (let y = oy; y < oy + rh; y++)
    for (let x = ox; x < ox + rw; x++) {
      const centre = sample(x, y);
      let colour;
      if (options.mode === 'sketch') {
        const tone = luma(centre),
          a = (x - ox + y - oy) % 6 === 0 && tone < 0.75 ? 0.45 : 0;
        const b = (x - ox - y + oy + rh) % 6 === 0 && tone < 0.4 ? 0.6 : 0;
        colour = Array(3).fill((1 - 0.85 * edge(x, y, radius)) * (1 - Math.max(a, b)));
      } else {
        let best = Infinity;
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          const pixels = [];
          for (let dy = 0; dy <= radius; dy++)
            for (let dx = 0; dx <= radius; dx++) pixels.push(sample(x + sx * dx, y + sy * dy));
          const mean = [0, 1, 2].map((c) => pixels.reduce((s, p) => s + p[c], 0) / pixels.length);
          // Squared deviations from the mean, independently of the shader's E[x*x]-E[x]^2.
          const variance =
            pixels.reduce((s, p) => s + p.reduce((v, a, c) => v + (a - mean[c]) ** 2, 0), 0) / pixels.length;
          if (variance < best) {
            best = variance;
            colour = mean;
          }
        }
        if (options.mode === 'watercolour') {
          const grain = (((x - ox) * 13 + (y - oy) * 7) % 17) / 16;
          colour = colour.map(
            (v) => (0.15 + (0.85 * Math.floor(v * 7 + 0.5)) / 7) * (1 - 0.2 * edge(x, y, 1)) * (0.96 + 0.04 * grain),
          );
        }
      }
      const i = 4 * (y * width + x);
      for (let c = 0; c < 3; c++)
        result[i + c] = Math.round(255 * (centre[c] * (1 - strength) + Math.max(0, Math.min(1, colour[c])) * strength));
      result[i + 3] = data[i + 3];
    }
  return result;
}
