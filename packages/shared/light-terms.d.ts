export const legacyTerms: string;
export const decayTerms: string;
export const clusterBrdf: string;
/** WGSL cluster lookup for world point `p` (a WGSL name): declares `cell`, `count` and `result`. */
export function clusterCell(p: string): string;
/** GGX normal distribution as shader source over the unit vectors named `n` and `h`, and a2 and nh (KB6016c form). */
export function ggxDOf(n: string, h: string): string;
/** GGX normal distribution as shader source over n, h, a2 and nh. */
export const ggxD: string;
/** {@link ggxD} (float literals). */
export const ggxDFloat: string;
/** Height-correlated Smith-GGX G2 (Heitz 2014, eq. 99) over a2, nv and nl. */
export const smithGCorrelated: string;
/** {@link smithGCorrelated} with float literals. */
export const smithGCorrelatedFloat: string;
/** GGX distribution denominator `(max(|n x h|^2, step(nh, 0)) + a2 nh^2)` over vector names n and h (KB6016d). */
export function ggxDenominatorOf(n: string, h: string, nh?: string, a2?: string): string;
/** [ggxD, smithGCorrelated] over other names; n and h are the unit normal and half vector. */
export function ggxNamed(a2: string, nh: string, nv: string, nl: string, n: string, h: string): [string, string];
