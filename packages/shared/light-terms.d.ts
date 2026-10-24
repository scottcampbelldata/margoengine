export const legacyTerms: string;
export const decayTerms: string;
export const clusterBrdf: string;
/** WGSL cluster lookup for world point `p` (a WGSL name): declares `cell`, `count` and `result`. */
export function clusterCell(p: string): string;
/** GGX normal distribution as shader source over a2 and nh. */
export const ggxD: string;
/** {@link ggxD} with float literals. */
export const ggxDFloat: string;
/** Smith-GGX geometry term as shader source over a2, nv and nl. */
export const smithG: string;
/** {@link smithG} with float literals. */
export const smithGFloat: string;
/** GGX distribution denominator (float literals) over the name nh (default 'nh'). */
export function ggxDenominator(nh?: string): string;
/** [ggxD, smithG] over other names. */
export function ggxNamed(a2: string, nh: string, nv: string, nl: string): [string, string];
