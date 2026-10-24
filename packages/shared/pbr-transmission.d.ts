/** Transmission's diffuse and ambient edits: each light term's diffuse part scales by 1 - s.tr. */
export declare const transmittedDiffuse: [string, string][];
/** `code` with the transmission weight `s.tr` (zero until set) and its energy split, unless it already has them. */
export declare function transmissionWeight(code: string): string;
