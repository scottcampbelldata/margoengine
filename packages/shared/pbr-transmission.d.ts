/** Transmission's diffuse and ambient edits: each light term's diffuse part scales by 1 - s.tr. */
export declare const transmittedDiffuse: [string, string][];
/** `code` with the transmission weight `s.tr` (zero until set) and its energy split, unless it already has them. */
export declare function transmissionWeight(code: string): string;
/** A material gltf-pro draws as native glass: it transmits, has no explicit render state and no physical-replacing extension. */
/** Reads `tint`, `renderState` and `extension.replacesPhysical` of a gltf-pro material (or a PBR source's). */
export declare function nativeGlassMaterial(m: object): boolean;
