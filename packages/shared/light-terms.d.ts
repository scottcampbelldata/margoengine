export const legacyTerms: string;
export const decayTerms: string;
export const clusterBrdf: string;
/** WGSL cluster lookup for world point `p` (a WGSL name): declares `cell`, `count` and `result`. */
export function clusterCell(p: string): string;
