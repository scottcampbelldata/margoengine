export const legacyTerms: string;
export const decayTerms: string;
export const clusterBrdf: string;
/** WGSL cluster lookup for world point `p` (a WGSL name): declares `cell`, `count` and `result`. */
export function clusterCell(p: string): string;
/** GGX distribution denominator `nh^2 (a2 - 1) + 1` as shader source over the given names. */
export function ggxDenominator(a2: string, nh: string, float?: boolean): string;
/** GGX normal distribution as shader source over the given names. */
export function ggxD(a2: string, nh: string, float?: boolean): string;
/** Smith-GGX geometry term as shader source over the given names. */
export function smithG(a2: string, nv: string, nl: string, float?: boolean): string;
