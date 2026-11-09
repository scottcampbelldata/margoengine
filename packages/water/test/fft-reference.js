// Independent O(N^4) Fourier oracle written from the published equations, deliberately no FFT butterflies.
// Correctness-only small grids; not imported by the package or used as a rendering fallback.
export function referenceOcean(options, time) {
  const n = options.resolution,
    cells = n * n,
    tau = 2 * Math.PI;
  const windLength = Math.hypot(...options.windDirection);
  const wind = options.windDirection.map((v) => Math.fround(v / windLength));
  const amplitudes = [];
  function hash(value) {
    value = Math.imul(value ^ (value >>> 16), 2246822519);
    value = Math.imul(value ^ (value >>> 13), 3266489917);
    return (value ^ (value >>> 16)) >>> 0;
  }
  const random = (value) => ((hash(value) >>> 8) + 0.5) / 16777216;
  for (let c = 0; c < options.cascades.length; c++) {
    const band = options.cascades[c],
      length = band.length;
    const h0 = new Float64Array(cells * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const kx = ((i < n / 2 ? i : i - n) * tau) / length;
        const kz = ((j < n / 2 ? j : j - n) * tau) / length;
        const k = Math.hypot(kx, kz),
          omega = Math.sqrt(9.81 * k);
        const radialIndex = Math.hypot(i < n / 2 ? i : i - n, j < n / 2 ? j : j - n);
        if (
          !k ||
          i === n / 2 ||
          j === n / 2 ||
          radialIndex < length / (band.maxWavelength ?? length) ||
          radialIndex >= length / (band.minWavelength ?? (2 * length) / n)
        )
          continue;
        const spread = ((kx * wind[0] + kz * wind[1]) / k) ** 2;
        let power;
        if (options.spectrum === 'phillips') {
          const longest = options.windSpeed ** 2 / 9.81;
          power = ((options.amplitude * Math.exp(-1 / (k * longest) ** 2)) / k ** 4) * spread * Math.exp(-k * k * 0.01);
        } else {
          const peak = 22 * (9.81 ** 2 / (options.windSpeed * options.fetch)) ** (1 / 3);
          const alpha = 0.076 * (options.windSpeed ** 2 / (options.fetch * 9.81)) ** 0.22;
          const sigma = omega <= peak ? 0.07 : 0.09;
          const r = Math.exp(-0.5 * ((omega - peak) / (sigma * peak)) ** 2);
          power =
            ((alpha * 9.81 ** 2) / omega ** 5) * Math.exp(-1.25 * (peak / omega) ** 4) * options.peakEnhancement ** r;
          power *= (((spread / Math.PI) * Math.sqrt(9.81 / k) * 0.5) / k) * options.amplitude;
        }
        const seed = (c * cells + j * n + i + Math.imul(options.seed, 747796405)) >>> 0;
        const radius = Math.sqrt(-2 * Math.log(random(seed)) * power * (tau / length) ** 2 * 0.5);
        const angle = tau * random(seed + 1);
        h0[(j * n + i) * 2] = radius * Math.cos(angle);
        h0[(j * n + i) * 2 + 1] = radius * Math.sin(angle);
      }
    const fields = new Float64Array(cells * 6);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const target = (z * n + x) * 6;
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const kx = ((i < n / 2 ? i : i - n) * tau) / length;
            const kz = ((j < n / 2 ? j : j - n) * tau) / length;
            const k = Math.hypot(kx, kz),
              omega = Math.sqrt(9.81 * k);
            if (!k) continue;
            const a = (j * n + i) * 2,
              b = (((n - j) % n) * n + ((n - i) % n)) * 2;
            const phase = omega * time,
              cos = Math.cos(phase),
              sin = Math.sin(phase);
            const ar = h0[a] * cos - h0[a + 1] * sin,
              ai = h0[a] * sin + h0[a + 1] * cos;
            const br = h0[b] * cos - h0[b + 1] * sin,
              bi = -h0[b] * sin - h0[b + 1] * cos;
            const hr = ar + br,
              hi = ai + bi,
              vr = -(ai - bi) * omega,
              vi = (ar - br) * omega;
            const angle = (tau * (i * x + j * z)) / n,
              cr = Math.cos(angle),
              si = Math.sin(angle);
            const h = hr * cr - hi * si,
              horizontal = hi * cr + hr * si;
            const v = vr * cr - vi * si,
              vh = vi * cr + vr * si;
            fields[target] += ((horizontal * kx) / k) * options.choppiness;
            fields[target + 1] += h;
            fields[target + 2] += ((horizontal * kz) / k) * options.choppiness;
            fields[target + 3] += ((vh * kx) / k) * options.choppiness;
            fields[target + 4] += v;
            fields[target + 5] += ((vh * kz) / k) * options.choppiness;
          }
      }
    amplitudes.push(fields);
  }
  return amplitudes;
}
