/** Per-import caps. All values are positive safe integers, in bytes or counts as named. */
export interface FBXImportLimits {
  inputBytes: number;
  decodedBytes: number;
  arrayBytes: number;
  nodes: number;
  properties: number;
  parseWork: number;
  sceneBytes: number;
  sceneWork: number;
  morphBytes: number;
  vertices: number;
  corners: number;
  geometryWork: number;
  textureBytes: number;
  texturePixels: number;
  outputBytes: number;
}
export const defaultLimits: Readonly<FBXImportLimits> = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  decodedBytes: 128 * 1024 * 1024,
  arrayBytes: 128 * 1024 * 1024,
  nodes: 100_000,
  properties: 2_000_000,
  parseWork: 128_000_000,
  sceneBytes: 128 * 1024 * 1024,
  sceneWork: 128_000_000,
  morphBytes: 64 * 1024 * 1024,
  vertices: 1_000_000,
  corners: 3_000_000,
  geometryWork: 40_000_000,
  textureBytes: 64 * 1024 * 1024,
  texturePixels: 16_000_000,
  outputBytes: 128 * 1024 * 1024,
});
export function importLimits(
  extensions: readonly { limits?: Readonly<Partial<FBXImportLimits>> }[] = [],
): Readonly<FBXImportLimits> {
  let out = defaultLimits,
    found = false;
  for (const extension of extensions)
    if (extension.limits) {
      if (found) throw new TypeError('Multiple FBX limit configurations; pass one largeFBX extension');
      found = true;
      out = { ...defaultLimits, ...extension.limits };
      for (const key of Object.keys(out) as (keyof FBXImportLimits)[])
        if (!(key in defaultLimits) || !Number.isSafeInteger(out[key]) || out[key] < 1)
          throw new RangeError(`FBX limit ${key} must be a positive safe integer; set a finite import cap`);
    }
  return out;
}
