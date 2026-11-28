/**
 * A problem in a glTF file that the loaders work around instead of refusing the file, listed once on
 * `model.warnings` (both loaders). `code` says which kind; the other fields name what it concerns.
 */
export interface GLTFWarning {
  /**
   * `'missing-texcoord'`: a material's map reads a TEXCOORD set that a primitive using the material lacks. glTF 2.0
   * section 5.24 (`textureInfo.texCoord`) has the map read `TEXCOORD_<texCoord>`; the loaders draw that primitive with
   * the map left out (its factor only), as other loaders do, instead of stopping the load (KB-GLTFA A2).
   */
  readonly code: 'missing-texcoord';
  /** What happened and how to fix the file. */
  readonly message: string;
  /** The glTF material index. */
  readonly material: number;
  /** The map's glTF property, for example `'baseColorTexture'` or `'normalTexture'`. */
  readonly map: string;
  /** The TEXCOORD set the map reads and the primitive lacks. */
  readonly texCoord: number;
}

/** The warning for material `material` whose `map` reads `TEXCOORD_<texCoord>`, which a primitive lacks. */
export function missingTexCoord(material: number, name: unknown, map: string, texCoord: number): GLTFWarning {
  const label = typeof name === 'string' && name ? `glTF material ${material} ("${name}")` : `glTF material ${material}`;
  return {
    code: 'missing-texcoord',
    message: `${label} reads its ${map} from TEXCOORD_${texCoord}, which a primitive using it lacks; that primitive draws without the map (glTF 2.0 section 5.24 textureInfo.texCoord). Add TEXCOORD_${texCoord} to the mesh or point texCoord at a set it has`,
    material,
    map,
    texCoord,
  };
}

/** Adds `warning` to `list` unless one with the same code, material, map and set is there (each is reported once). */
export function addWarning(list: GLTFWarning[], warning: GLTFWarning): void {
  if (
    !list.some(
      (w) =>
        w.code === warning.code &&
        w.material === warning.material &&
        w.map === warning.map &&
        w.texCoord === warning.texCoord,
    )
  )
    list.push(warning);
}
