import { hexagonalHaloProfile, minimumDeviation as deviationAtMinimum, minimumDeviationIncidence, prismDeviation } from '@margoengine/optics/refraction';

export const rad = Math.PI / 180;
export const apex = 60 * rad;
// Ice at red, green and blue (Warren 1984).
export const indices = Object.freeze([1.3080, 1.3110, 1.3157]);
export const representativeIndex = indices[1];
export const minIncidence = 28;
export const maxIncidence = 72;
export const prismRadius = .140;
export const prismHeight = .295;
export const minAt = (n = representativeIndex) => minimumDeviationIncidence(apex, n) / rad;
export const minimumDeviation = (n = representativeIndex) => deviationAtMinimum(apex, n) / rad;
export const minRadius = 17;
export const maxRadius = 33;
export const bins = 256;
export const skyHalfAngle = 33;
const root3 = Math.sqrt(3);

export function refraction(incidence, n = representativeIndex) {
  const ray = prismDeviation(apex, incidence * rad, n);
  return ray && { incident: ray.incidence, inside: ray.inside, exitInternal: ray.exitInternal, exitAngle: ray.exit, deviation: ray.deviation / rad };
}
export const prismVertices = Array.from({ length: 6 }, (_, i) => [prismRadius * Math.cos(i * Math.PI / 3), prismRadius * Math.sin(i * Math.PI / 3)]);

/** Lays the ray out across the prism's 60 degree wedge, in the prism's plan. */
export function tracePrism(incidence) {
  const ray = refraction(incidence);
  const [left, right] = [prismVertices[3], prismVertices[4]];
  const p = left.map((value, i) => value + .60 * (right[i] - value));
  const angles = [Math.PI / 6 + ray.incident, Math.PI / 6 + ray.inside, Math.PI / 2 - ray.exitAngle];
  const [inDir, midDir, outDir] = angles.map((a) => [Math.cos(a), Math.sin(a)]);
  const exitZ = prismRadius * root3 / 2;
  const exit = [p[0] + (exitZ - p[1]) / midDir[1] * midDir[0], exitZ];
  return { ...ray, entry: p, exit, inDir, midDir, outDir };
}

/** The halo ring by scattering angle, one colour channel per ice index, as an RGBA8 strip. */
export function haloProfile() {
  const intensity = hexagonalHaloProfile({ indices, minAngle: minRadius, maxAngle: maxRadius, bins });
  const texture = new Uint8Array(bins * 4);
  for (let i = 0; i < bins; i++) {
    for (let c = 0; c < 3; c++) texture[4 * i + c] = Math.round(255 * intensity[3 * i + c]);
    texture[4 * i + 3] = 255;
  }
  return texture;
}
