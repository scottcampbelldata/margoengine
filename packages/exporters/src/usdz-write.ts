// What the USDZ writers share: numbers as USD text, the stored archive, materials and mesh prims. `exportUSDZ` and
// `exportAnimatedUSDZ` write the same materials and shapes and differ in how they place them.
import { num, samplerOf, textureFiles } from './scene.js';
import type { Geo, Mat, SceneOptions, TextureData } from './scene.js';
import { crc32 } from '../../shared/crc32.js';

/** Options for {@link exportUSDZ}: the scene collector's options and where the archive keeps its images. */
export interface USDZOptions extends SceneOptions {
  /**
   * Prepended to every texture file name inside the archive, e.g. 'textures/' or 'level1_'. Letters, digits, `_`,
   * `.`, `-` and `/` only. Default 'textures/'.
   */
  texturePrefix?: string;
  /**
   * The model's height in metres in its rest pose. AR Quick Look shows a file at real size, so a model authored in other
   * units needs this: Fox.glb is 79 metres tall as written. It scales the whole model evenly from the origin with one
   * transform on the root prim, so proportions and animation data stay as they are. Default: the size the source says,
   * which glTF defines as metres.
   */
  height?: number;
  /** Moves the model up or down so its rest pose's lowest point is on the floor, y = 0. Default false. */
  ground?: boolean;
}

/** An axis-aligned box in metres. */
export interface USDZBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** How to place a model on the stage: the even scale and the lift of {@link USDZOptions}. */
export interface Placement {
  scale: number;
  lift: number;
}

/** A box holding nothing. */
export const emptyBox = (): USDZBox => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

/** Grows `box` to hold a point. */
export function growBox({ min, max }: USDZBox, x: number, y: number, z: number): void {
  if (x < min[0]) min[0] = x;
  if (x > max[0]) max[0] = x;
  if (y < min[1]) min[1] = y;
  if (y > max[1]) max[1] = y;
  if (z < min[2]) min[2] = z;
  if (z > max[2]) max[2] = z;
}

/** Grows `box` to hold `positions` through the column-major matrix `m`. */
export function growBoxWith(box: USDZBox, positions: ArrayLike<number>, m: ArrayLike<number>): void {
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v],
      y = positions[v + 1],
      z = positions[v + 2];
    growBox(
      box,
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  }
}

/** The three side lengths of `box`. */
export const boxSize = ({ min, max }: USDZBox): [number, number, number] => [
  max[0] - min[0],
  max[1] - min[1],
  max[2] - min[2],
];

/** `box` after `placement`. */
export const placedBox = ({ min, max }: USDZBox, { scale, lift }: Placement): USDZBox => ({
  min: [min[0] * scale, min[1] * scale + lift, min[2] * scale],
  max: [max[0] * scale, max[1] * scale + lift, max[2] * scale],
});

/** Refuses a bad `height` or `ground` before any work is done. */
export function checkPlacement({ height, ground }: USDZOptions): void {
  if (height !== undefined && !(typeof height === 'number' && height > 0 && Number.isFinite(height)))
    throw new RangeError(`USDZ height is ${String(height)}; pass the model's height in metres, above 0`);
  if (ground !== undefined && typeof ground !== 'boolean') throw new TypeError('USDZ ground must be boolean');
}

/** The placement `options` ask of a model whose rest pose fills `rest`. */
export function placementOf(rest: USDZBox, { height, ground }: USDZOptions): Placement {
  const tall = rest.max[1] - rest.min[1];
  if (height !== undefined && !(tall > 0))
    throw new RangeError('USDZ height needs a model with some height; this one is flat in Y, so leave height out');
  const scale = height === undefined ? 1 : height / tall;
  return { scale, lift: ground ? -rest.min[1] * scale : 0 };
}

/** The transform lines of the root prim: none for a model left as it is, so such a file does not change. */
export const rootTransform = ({ scale, lift }: Placement): string[] =>
  scale === 1 && lift === 0
    ? []
    : [
        `    matrix4d xformOp:transform = ((${num(scale)}, 0, 0, 0), (0, ${num(scale)}, 0, 0), (0, 0, ${num(scale)}, 0), (0, ${num(lift)}, 0, 1))`,
        '    uniform token[] xformOpOrder = ["xformOp:transform"]',
      ];

export const tuples = (values: ArrayLike<number>, size: number): string => {
  const result: string[] = [];
  for (let i = 0; i < values.length; i += size) {
    let tuple = num(values[i]);
    for (let k = 1; k < size; k++) tuple += ', ' + num(values[i + k]);
    result.push(`(${tuple})`);
  }
  return `[${result.join(', ')}]`;
};
export const tuple = (values: readonly number[]): string => `(${values.map(num).join(', ')})`;

/** A UsdPrimvarReader feeding the surface from the mesh's `varname` primvar. */
const reader = (name: string, type: string, varname: string, fallback: string): string[] => [
  `    def Shader "${name}" {`,
  `        uniform token info:id = "UsdPrimvarReader_${type}"`,
  `        string inputs:varname = "${varname}"`,
  `        ${type} inputs:fallback = ${fallback}`,
  `        ${type} outputs:result`,
  '    }',
];

/** glTF uvs (v down, origin top left) as USD st (t up, origin bottom left). */
const st = (uvs: Float32Array): Float64Array => Float64Array.from(uvs, (v, i) => (i % 2 ? 1 - v : v));

/**
 * One stored ZIP holding `entries` in order, each file's data starting at a multiple of 64 bytes (padded with an
 * extra field in its local header), as the USDZ package rules require.
 */
export function storedZIP(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const encoder = new TextEncoder(),
    plan = entries.map(([name, data]) => ({ name: encoder.encode(name), data, crc: crc32(data), at: 0, extra: 0 }));
  let at = 0;
  for (const entry of plan) {
    const padding = (64 - ((at + 30 + entry.name.length) % 64)) % 64;
    entry.extra = padding >= 4 ? padding : padding + 64;
    entry.at = at;
    at += 30 + entry.name.length + entry.extra + entry.data.length;
  }
  const central = at;
  for (const entry of plan) at += 46 + entry.name.length;
  if (at + 22 > 0xffffffff)
    throw new RangeError('USDZ exceeds the 4 GiB ZIP32 limit; export fewer or smaller meshes and textures');
  const out = new Uint8Array(at + 22),
    view = new DataView(out.buffer);
  at = central;
  for (const { name, data, crc, at: local, extra } of plan) {
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint32(local + 14, crc, true);
    view.setUint32(local + 18, data.length, true);
    view.setUint32(local + 22, data.length, true);
    view.setUint16(local + 26, name.length, true);
    view.setUint16(local + 28, extra, true);
    out.set(name, local + 30);
    view.setUint16(local + 30 + name.length, 0x1986, true);
    view.setUint16(local + 32 + name.length, extra - 4, true);
    out.set(data, local + 30 + name.length + extra);
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint32(at + 16, crc, true);
    view.setUint32(at + 20, data.length, true);
    view.setUint32(at + 24, data.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, local, true);
    out.set(name, at + 46);
    at += 46 + name.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, plan.length, true);
  view.setUint16(at + 10, plan.length, true);
  view.setUint32(at + 12, at - central, true);
  view.setUint32(at + 16, central, true);
  return out;
}

const TEXTURES = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;

/** Whether a material samples UV set `set`. */
export const samples = (material: Mat, set: number): boolean =>
  TEXTURES.some((slot) => material[slot] && (material[slot].texCoord ?? 0) === set);

/** One geometry in its own space: the class prim of the nodes that share it, its local bounds and the UV sets they read. */
export interface Shape {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  users: number;
  sets: [boolean, boolean];
  path?: string;
  min: number[];
  max: number[];
}

/** A shape's data with no users yet. */
export function shapeOf(positions: Float32Array, normals: Float32Array, indices: Uint32Array): Shape {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v++) {
    min[v % 3] = Math.min(min[v % 3], positions[v]);
    max[v % 3] = Math.max(max[v % 3], positions[v]);
  }
  return { positions, normals, indices, users: 0, sets: [false, false], min, max };
}

/** The geometry reflected in X with its winding reversed. */
export function reflected({ positions, normals, indices }: Geo): Shape {
  const flip = (values: Float32Array): Float32Array => values.map((v, i) => (i % 3 ? v : -v)),
    winding = indices.slice();
  for (let i = 0; i < winding.length; i += 3) {
    winding[i + 1] = indices[i + 2];
    winding[i + 2] = indices[i + 1];
  }
  return shapeOf(flip(positions), flip(normals), winding);
}

/** A material as a mesh uses it: its prim, written once, and the mesh's own colour lines. */
export interface BoundMaterial {
  /** The Material prim's path; empty for a mesh written unbound (paint only, see `bind`). */
  path: string;
  /** The Material prim, or nothing when another mesh brought it. */
  lines: string[];
  appearance: string[];
}

/** The materials of one archive: each written once, and the images they read. */
export class USDMaterials {
  private readonly textures: ReturnType<typeof textureFiles>;
  private readonly written = new Map<string, { path: string; sets: boolean[] }>();
  private readonly keys = new Map<Mat, number>();
  constructor(prefix: string = 'textures/') {
    if (typeof prefix === 'string' && /^\/|(^|\/)\.\.(\/|$)/.test(prefix))
      throw new TypeError(
        `USDZ texturePrefix "${prefix}" leaves the archive; use a relative folder such as 'textures/'`,
      );
    this.textures = textureFiles(prefix);
  }
  /** The images, for the archive. */
  get files(): typeof this.textures.files {
    return this.textures.files;
  }
  /** Records the UV sets `material` reads from `shape`, before the shape is written. */
  note(shape: Shape, material: Mat): void {
    shape.sets[0] ||= samples(material, 0);
    shape.sets[1] ||= samples(material, 1);
  }
  /** Mesh `i`'s material: builds its prim the first time, and the colour lines for this geometry. */
  bind(i: number, geometry: Geo, material: Mat): BoundMaterial {
    for (const slot of TEXTURES) {
      const texture = material[slot];
      if (texture && !(texture.texCoord === 1 ? geometry.uvs1 : geometry.uvs))
        throw new TypeError(
          `USDZ mesh ${i} ${slot} samples ${texture.texCoord === 1 ? 'uvs1' : 'uvs'}, which its geometry lacks; add that UV set or remove the texture`,
        );
    }
    const colors = geometry.colors,
      base = material.baseColorTexture;
    if (colors && base)
      throw new TypeError(
        `USDZ mesh ${i} has vertex colors and a baseColorTexture, which UsdPreviewSurface cannot multiply; bake the colors into the texture or drop one`,
      );
    // A MASK cutoff of 0 keeps every texel, which USD writes as an opaque surface (threshold 0 would mean blending).
    const cutoff = material.alphaCutoff ?? 0.5,
      opaque = material.alphaMode === 'OPAQUE' || (material.alphaMode === 'MASK' && cutoff <= 0),
      displayColor = colors ? new Float32Array(geometry.count * 3) : material.color.slice(0, 3),
      opacity = opaque ? 1 : material.color[3],
      displayOpacity = colors && geometry.colorSize === 4 && !opaque ? new Float32Array(geometry.count) : undefined;
    if (colors)
      for (let v = 0; v < geometry.count; v++) {
        for (let c = 0; c < 3; c++) displayColor[v * 3 + c] = colors[v * geometry.colorSize + c] * material.color[c];
        if (displayOpacity) displayOpacity[v] = colors[v * 4 + 3] * opacity;
      }
    const appearance = (): string[] => [
      `    uniform bool doubleSided = ${material.doubleSided}`,
      `    color3f[] primvars:displayColor = ${tuples(displayColor, 3)}${colors ? ' (interpolation = "vertex")' : ''}`,
      ...(displayOpacity
        ? [
            `    float[] primvars:displayOpacity = [${Array.from(displayOpacity, num).join(', ')}] (interpolation = "vertex")`,
          ]
        : []),
    ];
    // Apple's renderer does not follow a UsdPrimvarReader into a surface input, so a painted mesh under a material draws
    // grey in Quick Look, but an unbound mesh draws its displayColor. A material that says nothing but the paint (no
    // texture, metalness 0, roughness 1, no emission, opaque) is left out, and the mesh is written unbound.
    if (
      colors &&
      opaque &&
      material.metalness === 0 &&
      material.roughness === 1 &&
      material.emissive.every((v) => v * material.emissiveStrength === 0) &&
      TEXTURES.every((slot) => !material[slot])
    )
      return { path: '', lines: [], appearance: appearance() };
    // One material per object and colour stream; its prim takes the first user's number.
    if (!this.keys.has(material)) this.keys.set(material, this.keys.size);
    const key = `${this.keys.get(material)}:${colors ? 1 : 0}:${displayOpacity ? 1 : 0}`,
      known = this.written.get(key),
      path = known?.path ?? `/Margo/Material_${i}`;
    // Texture shaders, built first so the surface can name their outputs.
    const shaders: string[] = [],
      sets: boolean[] = known?.sets ?? [];
    const uv = (set: number): string => {
      if (!sets[set]) {
        sets[set] = true;
        shaders.push(...reader(set ? 'UV1' : 'UV', 'float2', set ? 'st1' : 'st', '(0, 0)'));
      }
      return `${path}/${set ? 'UV1' : 'UV'}.outputs:result`;
    };
    const sample = (
      name: string,
      texture: TextureData,
      color: boolean,
      scale: readonly number[],
      bias?: readonly number[],
    ): string => {
      const { wrapS, wrapT } = samplerOf(texture);
      let coordinates = uv(texture.texCoord ?? 0);
      if (name === 'BaseColorTexture' && material.baseColorTextureTransform) {
        // KHR_texture_transform in glTF uv space (v down): uv' = O + R S uv, R = [[c, s], [-s, c]] (gltf-pro's
        // reading: the uvs turn counter-clockwise as seen with v down, the image clockwise). With st = F uv + (0, 1),
        // F = diag(1, -1): st' = (F R F) S st + F O + F R S (0, 1) + (0, 1). F R F = [[c, -s], [s, c]] is
        // UsdTransform2d's counter-clockwise rotation (t up) by the same angle, so the sign is kept; the translation
        // picks up the turned v axis: (ox + s sy, 1 - c sy - oy).
        const { offset, scale: repeat, rotation = 0 } = material.baseColorTextureTransform;
        const c = Math.cos(rotation),
          s = Math.sin(rotation);
        shaders.push(
          '    def Shader "BaseColorTransform" {',
          '        uniform token info:id = "UsdTransform2d"',
          `        float2 inputs:in.connect = <${coordinates}>`,
          ...(rotation ? [`        float inputs:rotation = ${num((rotation * 180) / Math.PI)}`] : []),
          `        float2 inputs:scale = ${tuple(repeat)}`,
          `        float2 inputs:translation = ${tuple([offset[0] + s * repeat[1], 1 - c * repeat[1] - offset[1]])}`,
          '        float2 outputs:result',
          '    }',
        );
        coordinates = `${path}/BaseColorTransform.outputs:result`;
      }
      shaders.push(
        `    def Shader "${name}" {`,
        '        uniform token info:id = "UsdUVTexture"',
        `        asset inputs:file = @${this.textures.name(texture)}@`,
        `        float2 inputs:st.connect = <${coordinates}>`,
        `        token inputs:wrapS = "${wrapS}"`,
        `        token inputs:wrapT = "${wrapT}"`,
        `        token inputs:sourceColorSpace = "${color ? 'sRGB' : 'raw'}"`,
        `        float4 inputs:scale = ${tuple(scale)}`,
        ...(bias ? [`        float4 inputs:bias = ${tuple(bias)}`] : []),
        '        float outputs:r',
        '        float outputs:g',
        '        float outputs:b',
        '        float outputs:a',
        '        float3 outputs:rgb',
        '    }',
      );
      return `${path}/${name}.outputs:`;
    };
    const surface = (): string[] => {
      const baseOut = base && sample('BaseColorTexture', base, true, material.color),
        metalRough =
          material.metallicRoughnessTexture &&
          sample('MetallicRoughnessTexture', material.metallicRoughnessTexture, false, [
            1,
            material.roughness,
            material.metalness,
            1,
          ]),
        s = material.normalScale,
        normal =
          material.normalTexture &&
          sample('NormalTexture', material.normalTexture, false, [2 * s, 2 * s, 2, 1], [-s, -s, -1, 0]),
        k = material.occlusionStrength,
        occlusion =
          material.occlusionTexture &&
          sample(
            'OcclusionTexture',
            material.occlusionTexture,
            false,
            [k, k, k, 1],
            k === 1 ? undefined : [1 - k, 1 - k, 1 - k, 0],
          ),
        emissive = material.emissive.map((v) => v * material.emissiveStrength),
        emission =
          material.emissiveTexture && sample('EmissiveTexture', material.emissiveTexture, true, [...emissive, 1]);
      return [
        `def Material "Material_${i}" {`,
        `    token outputs:surface.connect = <${path}/Surface.outputs:surface>`,
        '    def Shader "Surface" {',
        '        uniform token info:id = "UsdPreviewSurface"',
        baseOut
          ? `        color3f inputs:diffuseColor.connect = <${baseOut}rgb>`
          : colors
            ? `        color3f inputs:diffuseColor.connect = <${path}/Color.outputs:result>`
            : `        color3f inputs:diffuseColor = ${tuple(material.color.slice(0, 3))}`,
        emission
          ? `        color3f inputs:emissiveColor.connect = <${emission}rgb>`
          : `        color3f inputs:emissiveColor = ${tuple(emissive)}`,
        metalRough
          ? `        float inputs:roughness.connect = <${metalRough}g>`
          : `        float inputs:roughness = ${num(material.roughness)}`,
        metalRough
          ? `        float inputs:metallic.connect = <${metalRough}b>`
          : `        float inputs:metallic = ${num(material.metalness)}`,
        baseOut && !opaque
          ? `        float inputs:opacity.connect = <${baseOut}a>`
          : displayOpacity
            ? `        float inputs:opacity.connect = <${path}/Opacity.outputs:result>`
            : `        float inputs:opacity = ${num(opacity)}`,
        ...(material.alphaMode === 'MASK' && !opaque ? [`        float inputs:opacityThreshold = ${num(cutoff)}`] : []),
        ...(normal ? [`        normal3f inputs:normal.connect = <${normal}rgb>`] : []),
        ...(occlusion ? [`        float inputs:occlusion.connect = <${occlusion}r>`] : []),
        '        token outputs:surface',
        '    }',
        ...(colors ? reader('Color', 'float3', 'displayColor', '(1, 1, 1)') : []),
        ...(displayOpacity ? reader('Opacity', 'float', 'displayOpacity', '1') : []),
        ...shaders,
        '}',
      ];
    };
    // Built before the mesh, which writes the UV sets the material reads; written after it.
    const materialLines = known ? [] : surface();
    if (!known) this.written.set(key, { path, sets });
    return { path, lines: materialLines, appearance: appearance() };
  }
}

/** How {@link meshPrim} places a mesh and what else it holds. */
export interface MeshPlacement {
  transform: readonly string[];
  /** The `apiSchemas` list. Default MaterialBindingAPI alone. */
  schemas?: string;
  /** Lines of the prim beyond the mesh's own. */
  extra?: readonly string[];
}

/**
 * Writes mesh `i` into `lines`, and into `shared` what lives at the root: a shape several meshes reference, and its material.
 * A shape with one user holds its data in the mesh itself.
 */
export function meshPrim(
  lines: string[],
  shared: string[],
  i: number,
  name: string | undefined,
  geometry: Geo,
  shape: Shape,
  { path, lines: materialLines, appearance }: BoundMaterial,
  { transform, schemas = '"MaterialBindingAPI"', extra = [] }: MeshPlacement,
): void {
  // An unbound mesh has no material binding and so no MaterialBindingAPI.
  if (!path) schemas = schemas.replace(/"MaterialBindingAPI"(, )?/, '');
  const binding = path ? [`    rel material:binding = <${path}>`] : [];
  const vertexST = (set: 0 | 1, wanted: boolean): string[] => {
    const uvs = set ? geometry.uvs1 : geometry.uvs;
    return wanted && uvs
      ? [`    texCoord2f[] primvars:st${set ? '1' : ''} = ${tuples(st(uvs), 2)} (interpolation = "vertex")`]
      : [];
  };
  const topology = [
    `    float3[] extent = ${tuples([...shape.min, ...shape.max], 3)}`,
    `    point3f[] points = ${tuples(shape.positions, 3)}`,
    `    normal3f[] normals = ${tuples(shape.normals, 3)} (interpolation = "vertex")`,
    `    int[] faceVertexCounts = [3${', 3'.repeat(shape.indices.length / 3 - 1)}]`,
    `    int[] faceVertexIndices = [${shape.indices.join(', ')}]`,
    '    uniform token subdivisionScheme = "none"',
  ];
  if (shape.users === 1) {
    lines.push(
      schemas ? `def Mesh "Mesh_${i}" (apiSchemas = [${schemas}]) {` : `def Mesh "Mesh_${i}" {`,
      `    string displayName = ${JSON.stringify(name ?? `Mesh ${i}`)}`,
      ...transform,
      ...topology,
      ...appearance,
      ...vertexST(0, shape.sets[0]),
      ...vertexST(1, shape.sets[1]),
      ...extra,
      ...binding,
      '}',
    );
    shared.push(...materialLines);
    return;
  }
  if (!shape.path) {
    const className = `Shape_${i}`;
    shape.path = `/Margo/${className}`;
    shared.push(
      `class Mesh "${className}" {`,
      ...topology,
      ...vertexST(0, shape.sets[0]),
      ...vertexST(1, shape.sets[1]),
      '}',
    );
  }
  lines.push(
    `def Mesh "Mesh_${i}" (`,
    ...(schemas ? [`    apiSchemas = [${schemas}]`] : []),
    `    references = <${shape.path}>`,
    ') {',
    `    string displayName = ${JSON.stringify(name ?? `Mesh ${i}`)}`,
    ...transform,
    ...appearance,
    ...extra,
    ...binding,
    '}',
  );
  shared.push(...materialLines);
}
