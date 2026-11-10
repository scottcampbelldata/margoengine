// Rough glass and dispersion for the refracted bake: GGX visible-normal sampling with Smith masking (Heitz, "Sampling
// the GGX Distribution of Visible Normals", JCGT 7(4), 2018, Listing 1 and eq. 2), a Cauchy index fitted to an Abbe
// number, and wavelength to linear RGB through the CIE 1931 fit of Wyman, Sloan and Shirley, "Simple Analytic
// Approximations to the CIE XYZ Color Matching Functions", JCGT 2(2), 2013, Listing 1, and the sRGB matrix of
// IEC 61966-2-1.
import type { MutableVec3 as V3 } from '@margoengine/math';
import { cross, dot, normalize } from '@margoengine/math/vec3';

/** Smith masking G1 of an isotropic GGX surface with `alpha` for a direction at `cosine` to the macro normal. */
export function smithG1(cosine: number, alpha: number): number {
  if (!(cosine > 0)) return 0;
  if (cosine >= 1 || alpha === 0) return 1;
  const tan2 = (1 - cosine * cosine) / (cosine * cosine);
  return 2 / (1 + Math.sqrt(1 + alpha * alpha * tan2));
}

/**
 * A GGX microfacet normal seen from `view` (unit, on the side of the unit macro `normal`), sampled in proportion to
 * its visible projected area with two uniform numbers; returned in world space.
 */
export function sampleVisibleNormal(view: V3, normal: V3, alpha: number, u1: number, u2: number): V3 {
  // Any tangent frame works for an isotropic surface.
  const t = normalize(Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0])),
    b = cross(normal, t),
    // Stretch the view to the unit hemisphere configuration.
    vh = normalize([alpha * dot(view, t), alpha * dot(view, b), Math.max(0, dot(view, normal))]),
    lensq = vh[0] * vh[0] + vh[1] * vh[1],
    t1: V3 = lensq > 0 ? [-vh[1] / Math.sqrt(lensq), vh[0] / Math.sqrt(lensq), 0] : [1, 0, 0],
    t2 = cross(vh, t1),
    r = Math.sqrt(u1),
    phi = 2 * Math.PI * u2,
    p1 = r * Math.cos(phi),
    s = 0.5 * (1 + vh[2]),
    p2 = (1 - s) * Math.sqrt(1 - p1 * p1) + s * r * Math.sin(phi),
    pz = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2)),
    nh = [0, 1, 2].map((k) => p1 * t1[k] + p2 * t2[k] + pz * vh[k]),
    // Unstretch back to the rough configuration.
    x = alpha * nh[0],
    y = alpha * nh[1],
    z = Math.max(0, nh[2]),
    l = Math.hypot(x, y, z) || 1;
  return [0, 1, 2].map((k) => (x * t[k] + y * b[k] + z * normal[k]) / l) as V3;
}

const D = 0.5876,
  F = 0.4861,
  C = 0.6563;

/**
 * Cauchy's n(l) = A + B / l^2 (l in micrometres) through `ior` at the helium d line (587.6 nm) with Abbe number
 * (n_d - 1) / (n_F - n_C) over the hydrogen F (486.1 nm) and C (656.3 nm) lines.
 */
export function cauchy(ior: number, abbe: number): (nanometres: number) => number {
  const b = (ior - 1) / (abbe * (1 / (F * F) - 1 / (C * C))),
    a = ior - b / (D * D);
  return (nm) => a + b / ((nm / 1000) * (nm / 1000));
}

/** Shortest and longest wavelengths a dispersive photon may carry, nm. */
export const visible = [380, 780] as const;

const lobe = (x: number, mu: number, below: number, above: number) => {
  const t = (x - mu) * (x < mu ? below : above);
  return Math.exp(-0.5 * t * t);
};

/** Linear sRGB of one nanometre of a flat spectrum at `nm`, negatives (outside the gamut) clipped to zero. */
export function wavelengthRgb(nm: number): V3 {
  const x =
      0.362 * lobe(nm, 442, 0.0624, 0.0374) +
      1.056 * lobe(nm, 599.8, 0.0264, 0.0323) -
      0.065 * lobe(nm, 501.1, 0.049, 0.0382),
    y = 0.821 * lobe(nm, 568.8, 0.0213, 0.0247) + 0.286 * lobe(nm, 530.9, 0.0613, 0.0322),
    z = 1.217 * lobe(nm, 437, 0.0845, 0.0278) + 0.681 * lobe(nm, 459, 0.0385, 0.0725);
  return [
    Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z),
    Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z),
    Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z),
  ];
}
