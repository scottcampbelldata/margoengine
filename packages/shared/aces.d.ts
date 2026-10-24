/**
 * WGSL `fn aces(v: vec3f) -> vec3f`: Margo's own fit of an ACES 1.x RRT + sRGB 100-nit ODT style display transform.
 * Linear Rec.709 scene light in (non-negative, exposure already applied, no extra scale), display-linear Rec.709 out,
 * each channel clamped to 0..1, before the sRGB encoding. Black maps to 0 and greys stay grey. Self-contained: no
 * bindings, no other top-level names.
 */
export const acesShader: string;
/**
 * WGSL `fn acesNarkowicz(c: vec3f) -> vec3f`: Krzysztof Narkowicz's fit of the ACES film curve (2016), after the 0.6
 * pre-scale of his reference, clamped to 0..1.
 */
export const acesNarkowiczShader: string;
/** Same curve as {@link acesNarkowiczShader} on the CPU. Writes into `out` when given and returns it. */
export function acesNarkowicz(c: ArrayLike<number>, out?: number[]): number[];
