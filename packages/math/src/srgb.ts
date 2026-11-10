// The scalar sRGB transfer curves. A module of its own so Color and convertColor can share the mirrored forms
// without adding them to any package entry.

/**
 * sRGB transfer function, decoded (display value to linear light). Below 0 it continues the linear segment (c / 12.92),
 * bit for bit as the package copies it replaced (examples/package-benchmarks/proofs/math-consolidation.proof.js);
 * Color and convertColor mirror negatives instead, as CSS Color 4 does.
 */
export const SRGBToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** sRGB transfer function, encoded (linear light to display value); below 0 linear, as {@link SRGBToLinear}. */
export const LinearToSRGB = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
// The CSS Color 4 sample code (lin_sRGB, gam_sRGB) mirrors the curve through the origin, f(-c) = -f(c), so an
// out-of-gamut channel (Display P3 green in sRGB has r = -0.51 encoded) keeps the same curve. Equal to the exported
// curves, bit for bit, for c >= 0.
export const decodeSRGB = (c: number): number => (c < 0 ? -SRGBToLinear(-c) : SRGBToLinear(c));
export const encodeSRGB = (c: number): number => (c < 0 ? -LinearToSRGB(-c) : LinearToSRGB(c));
