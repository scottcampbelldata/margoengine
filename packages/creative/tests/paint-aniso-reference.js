// Independent scalar oracle: RGB Sobel tensor, separable binomial smoothing, eigensystem and eight sectors.
export function anisoReference(data, width, height, options = {}, rect = [0, 0, width, height]) {
  const [left, top, w, h] = rect,
    clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const index = (x, y) => 4 * (clamp(y, top, top + h - 1) * width + clamp(x, left, left + w - 1));
  const read = (x, y) => {
    const i = index(x, y);
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
  };
  const tensor = new Float32Array(width * height * 3),
    horizontal = new Float32Array(tensor.length),
    smooth = new Float32Array(tensor.length),
    kernel = [1, 4, 6, 4, 1];
  for (let y = top; y < top + h; y++)
    for (let x = left; x < left + w; x++) {
      const a = read(x - 1, y - 1),
        b = read(x, y - 1),
        c = read(x + 1, y - 1),
        d = read(x - 1, y),
        e = read(x + 1, y),
        f = read(x - 1, y + 1),
        g = read(x, y + 1),
        i = read(x + 1, y + 1);
      const dx = a.map((_, k) => (c[k] + 2 * e[k] + i[k] - a[k] - 2 * d[k] - f[k]) / 8),
        dy = a.map((_, k) => (f[k] + 2 * g[k] + i[k] - a[k] - 2 * b[k] - c[k]) / 8);
      const at = (y * width + x) * 3;
      tensor[at] = dx.reduce((s, v) => s + v * v, 0);
      tensor[at + 1] = dx.reduce((s, v, k) => s + v * dy[k], 0);
      tensor[at + 2] = dy.reduce((s, v) => s + v * v, 0);
    }
  for (const [source, dest, axis] of [
    [tensor, horizontal, 0],
    [horizontal, smooth, 1],
  ])
    for (let y = top; y < top + h; y++)
      for (let x = left; x < left + w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++)
            sum +=
              source[
                (clamp(y + (axis ? k : 0), top, top + h - 1) * width + clamp(x + (axis ? 0 : k), left, left + w - 1)) *
                  3 +
                  c
              ] * kernel[k + 2];
          dest[(y * width + x) * 3 + c] = sum / 16;
        }
  const out = data.slice(),
    r = options.radius ?? 3,
    strength = options.enabled === false ? 0 : (options.strength ?? 1),
    dirs = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);
  if (strength === 0) return out;
  for (let y = top; y < top + h; y++)
    for (let x = left; x < left + w; x++) {
      const at = (y * width + x) * 3,
        E = smooth[at],
        F = smooth[at + 1],
        G = smooth[at + 2],
        trace = E + G;
      const angle = trace > 1e-8 ? Math.atan2(2 * F, E - G) / 2 + Math.PI / 2 : 0,
        A = trace > 1e-8 ? clamp(Math.hypot(E - G, 2 * F) / trace, 0, 1) * (options.anisotropy ?? 1) : 0;
      const cs = Math.cos(angle),
        sn = Math.sin(angle),
        a = r * (1 + A),
        b = r / (1 + A),
        bound = Math.ceil(a),
        zeta = 2 / r,
        eta = 2 * (zeta + Math.SQRT1_2);
      const sums = Array.from({ length: 8 }, () => [0, 0, 0]),
        squares = Array.from({ length: 8 }, () => [0, 0, 0]),
        weights = Array(8).fill(0);
      for (let j = -bound; j <= bound; j++)
        for (let i = -bound; i <= bound; i++) {
          const qx = (i * cs + j * sn) / a,
            qy = (-i * sn + j * cs) / b,
            r2 = qx * qx + qy * qy;
          if (r2 > 1) continue;
          const sectors = dirs.map(
              ([dx, dy]) => Math.max(0, zeta + qx * dx + qy * dy - eta * (-qx * dy + qy * dx) ** 2) ** 2,
            ),
            total = sectors.reduce((a, b) => a + b, 0),
            radial =
              (Math.exp(-3.125 * r2) * Math.max(0, 1 - Math.sqrt(r2)) ** 4 * (1 + 4 * Math.sqrt(r2))) /
              Math.max(total, 1e-20),
            colour = read(x + i, y + j);
          for (let k = 0; k < 8; k++) {
            const weight = sectors[k] * radial;
            weights[k] += weight;
            for (let c = 0; c < 3; c++) {
              sums[k][c] += colour[c] * weight;
              squares[k][c] += colour[c] * colour[c] * weight;
            }
          }
        }
      const value = [0, 0, 0];
      let total = 0;
      for (let k = 0; k < 8; k++) {
        const mean = sums[k].map((v) => v / weights[k]),
          variance = mean.reduce((s, v, c) => s + Math.max(0, squares[k][c] / weights[k] - v * v), 0),
          weight = 1 / (1 + (100 * Math.sqrt(variance)) ** (options.sharpness ?? 8));
        total += weight;
        for (let c = 0; c < 3; c++) value[c] += weight * mean[c];
      }
      const centre = read(x, y);
      for (let c = 0; c < 3; c++)
        out[(y * width + x) * 4 + c] = Math.round(
          255 * (centre[c] + (clamp(value[c] / total, 0, 1) - centre[c]) * strength),
        );
    }
  return out;
}
