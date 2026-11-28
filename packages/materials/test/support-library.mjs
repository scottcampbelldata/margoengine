// The conversions behind the measured materials library (src/measured.ts), shared by its test and its generator:
// metal F0 from tabulated n and k, dielectric dispersion from the papers' formulas, albedo from reflectance spectra.
// Every colour goes through @margoengine/optics SpectralIntegrator: CIE 1931 fit of Wyman, Sloan and Shirley (JCGT 2(2),
// 2013), a 6504 K black body, 380 to 780 nm in 5 nm steps, as the biomes ground colours do.
import { SpectralIntegrator } from '@margoengine/optics/spectrum';

const integrator = new SpectralIntegrator();
/** Wavelengths (nm) the n and k triples are reported at: red, green, blue. */
export const RGB_NM = [650, 550, 450];

/** Linear interpolation of column `c` of rows sorted by column 0, held at the ends. */
export function lerpTable(rows, nm, c) {
  if (nm <= rows[0][0]) return rows[0][c];
  const last = rows[rows.length - 1];
  if (nm >= last[0]) return last[c];
  let i = 1;
  while (rows[i][0] < nm) i++;
  const [a, b] = [rows[i - 1], rows[i]];
  const t = (nm - a[0]) / (b[0] - a[0]);
  return a[c] + (b[c] - a[c]) * t;
}
/** Normal-incidence Fresnel reflectance of a conductor of index n + ik from air. */
export const fresnelNK = (n, k) => ((n - 1) ** 2 + k * k) / ((n + 1) ** 2 + k * k);
/** Linear sRGB F0 of a metal from its [nm, n, k] rows. */
export function metalF0(points) {
  const rows = [...points].sort((a, b) => a[0] - b[0]);
  return integrator.color((nm) => fresnelNK(lerpTable(rows, nm, 1), lerpTable(rows, nm, 2)));
}
/** [n at RGB_NM, k at RGB_NM]. */
export function nkAt(points) {
  const rows = [...points].sort((a, b) => a[0] - b[0]);
  return [RGB_NM.map((nm) => lerpTable(rows, nm, 1)), RGB_NM.map((nm) => lerpTable(rows, nm, 2))];
}
/** Refractive index of a dielectric formula at `nm`. */
export function refractiveIndex(f, nm) {
  const l = nm / 1000,
    l2 = l * l;
  if (f.form === 'sellmeier') {
    let n2 = 1 + (f.A ?? 0);
    f.B.forEach((b, i) => (n2 += (b * l2) / (l2 - f.C[i])));
    return Math.sqrt(n2);
  }
  if (f.form === 'power') return f.c1 + f.c2 * l ** f.p2 + f.c4 * l ** f.p4;
  if (f.form === 'table') return lerpTable([...f.points].sort((a, b) => a[0] - b[0]), nm, 1);
  throw new Error('unknown formula ' + f.form);
}
/** n at the helium d line (587.56 nm) and the Abbe number (nd - 1) / (nF - nC). */
export function dispersion(f) {
  const nd = refractiveIndex(f, 587.56),
    nF = refractiveIndex(f, 486.13),
    nC = refractiveIndex(f, 656.27);
  return { nd, abbe: (nd - 1) / (nF - nC) };
}
/** Mean linear sRGB albedo of reflectance spectra sampled at 380, 390, ..., 780 nm. */
export function albedo(spectra) {
  const sum = [0, 0, 0];
  for (const r of spectra) {
    const c = integrator.color((nm) => {
      const x = (nm - 380) / 10,
        i = Math.min(39, Math.floor(x));
      return r[i] + (r[i + 1] - r[i]) * (x - i);
    });
    for (let j = 0; j < 3; j++) sum[j] += c[j] / spectra.length;
  }
  return sum;
}
