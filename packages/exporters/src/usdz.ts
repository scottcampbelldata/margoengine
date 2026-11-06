import {
  collect,
  determinant3,
  drawables,
  num,
  normalizeMaterial,
  samplerOf,
  textureFiles,
  type Drawable,
  type ExportSource,
  type Geo,
  type Mat,
  type SceneOptions,
  type TextureData,
} from './scene.js';
import { crc32 } from '../../shared/crc32.js';

/** Options for {@link exportUSDZ}: the scene collector's options and where the archive keeps its images. */
export interface USDZOptions extends SceneOptions {
  /**
   * Prepended to every texture file name inside the archive, e.g. 'textures/' or 'level1_'. Letters, digits, `_`,
   * `.`, `-` and `/` only. Default 'textures/'.
   */
  texturePrefix?: string;
}

const tuples = (values: ArrayLike<number>, size: number): string => {
  const result: string[] = [];
  for (let i = 0; i < values.length; i += size) {
    let tuple = num(values[i]);
    for (let k = 1; k < size; k++) tuple += ', ' + num(values[i + k]);
    result.push(`(${tuple})`);
  }
  return `[${result.join(', ')}]`;
};
const tuple = (values: readonly number[]): string => `(${values.map(num).join(', ')})`;

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
function storedZIP(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
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
const samples = (material: Mat, set: number): boolean =>
  TEXTURES.some((slot) => material[slot] && (material[slot].texCoord ?? 0) === set);

/** One geometry in its own space: the class prim of the nodes that share it, its local bounds and the UV sets they read. */
interface Shape {
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
function shapeOf(positions: Float32Array, normals: Float32Array, indices: Uint32Array): Shape {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v++) {
    min[v % 3] = Math.min(min[v % 3], positions[v]);
    max[v % 3] = Math.max(max[v % 3], positions[v]);
  }
  return { positions, normals, indices, users: 0, sets: [false, false], min, max };
}

/** The geometry reflected in X with its winding reversed. */
function reflected({ positions, normals, indices }: Geo): Shape {
  const flip = (values: Float32Array): Float32Array => values.map((v, i) => (i % 3 ? v : -v)),
    winding = indices.slice();
  for (let i = 0; i < winding.length; i += 3) {
    winding[i + 1] = indices[i + 2];
    winding[i + 2] = indices[i + 1];
  }
  return shapeOf(flip(positions), flip(normals), winding);
}

/**
 * The shape each node draws. A node with a reflection in its matrix draws the geometry's reflected shape through
 * {@link unreflected}, so every matrix in the file keeps a positive determinant, the winding is right in the file and
 * nothing depends on how a renderer treats a negative scale. Nodes that mirror one geometry share that shape too.
 */
function localShapes(items: readonly Drawable[], fallback: Mat): Map<Drawable, Shape> {
  const plain = new Map<Geo, Shape>(),
    mirrored = new Map<Geo, Shape>(),
    drawn = new Map<Drawable, Shape>();
  for (const item of items) {
    const { geometry, material = fallback, world } = item,
      determinant = determinant3(world);
    if (!determinant || !Number.isFinite(determinant))
      throw new RangeError('Singular transform; use a transform with a non-zero determinant');
    const known = determinant > 0 ? plain : mirrored;
    let shape = known.get(geometry);
    if (!shape) {
      shape = determinant > 0 ? shapeOf(geometry.positions, geometry.normals, geometry.indices) : reflected(geometry);
      known.set(geometry, shape);
    }
    shape.users++;
    shape.sets[0] ||= samples(material, 0);
    shape.sets[1] ||= samples(material, 1);
    drawn.set(item, shape);
  }
  return drawn;
}

/** `world` with its first axis negated: applied to a reflected shape it puts every vertex where `world` puts the geometry's. */
const unreflected = (world: Float64Array): Float64Array => world.map((v, i) => (i < 3 ? -v : v));

const OUTSIDE_FLOAT32 =
  'USDZ world position exceeds Float32 range; move the model closer to the origin or lower its scale';

/**
 * Static USD meshes with UsdPreviewSurface materials in a stored, 64-byte-aligned USDZ archive. Every mesh is written in
 * its own space, with the node's world matrix as `xformOp:transform`. A geometry drawn by several nodes is written once,
 * as a `class` prim each node's Mesh references. A node with a reflection in its matrix draws a reflected shape, written
 * once for the nodes that mirror that geometry, with the reflection taken out of its matrix. A material shared by several
 * nodes is written once.
 *
 * Material textures (`TextureData`, as the glTF writers take them) become `UsdUVTexture` readers of the mesh's
 * `primvars:st` (from `uvs`, V flipped) or `primvars:st1` (from `uvs1`): base color into `diffuseColor` scaled by the
 * color factor (its alpha into `opacity` for BLEND and MASK, with `opacityThreshold` set to `alphaCutoff` for MASK),
 * metal-rough green and blue into `roughness` and `metallic`, `normal`, `occlusion` red and `emissiveColor`. The images
 * are stored as given (PNG or JPEG) under `texturePrefix`. A `baseColorTextureTransform` becomes a `UsdTransform2d`
 * that samples the same texels as the glTF transform: its rotation in degrees with the same sign (the V flip turns
 * glTF's counter-clockwise-with-v-down into USD's counter-clockwise-with-t-up), the translation re-expressed in st.
 * @throws TypeError when a textured material's geometry lacks the UV set it samples, or when vertex colors meet a
 * base color texture (USD Preview Surface cannot multiply them); RangeError for an empty scene, a world position
 * outside Float32 range or an archive over 4 GiB.
 */
export function exportUSDZ(source: ExportSource, options: USDZOptions = {}): Uint8Array {
  const items = drawables(collect(source, options));
  if (!items.length) throw new RangeError('USDZ requires at least one mesh');
  const prefix = options.texturePrefix ?? 'textures/';
  if (typeof prefix === 'string' && /^\/|(^|\/)\.\.(\/|$)/.test(prefix))
    throw new TypeError(`USDZ texturePrefix "${prefix}" leaves the archive; use a relative folder such as 'textures/'`);
  const files = textureFiles(prefix),
    fallback = normalizeMaterial({}),
    shapes = localShapes(items, fallback),
    written = new Map<string, { path: string; sets: boolean[] }>(),
    keys = new Map<Mat, number>();
  const lines = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "Margo"',
    '    metersPerUnit = 1',
    '    upAxis = "Y"',
    ')',
    'def Xform "Margo" {',
  ];
  for (let i = 0; i < items.length; i++) {
    const item = items[i],
      { geometry } = item,
      world = determinant3(item.world) > 0 ? item.world : unreflected(item.world),
      material = item.material ?? fallback,
      shape = shapes.get(item)!,
      base = material.baseColorTexture;
    for (const slot of TEXTURES) {
      const texture = material[slot];
      if (texture && !(texture.texCoord === 1 ? geometry.uvs1 : geometry.uvs))
        throw new TypeError(
          `USDZ mesh ${i} ${slot} samples ${texture.texCoord === 1 ? 'uvs1' : 'uvs'}, which its geometry lacks; add that UV set or remove the texture`,
        );
    }
    const colors = geometry.colors;
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
    // One material per object and colour stream; its prim takes the first user's number.
    if (!keys.has(material)) keys.set(material, keys.size);
    const key = `${keys.get(material)}:${colors ? 1 : 0}:${displayOpacity ? 1 : 0}`,
      known = written.get(key),
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
        `        asset inputs:file = @${files.name(texture)}@`,
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
    if (!known) written.set(key, { path, sets });
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
    const appearance = [
      `    uniform bool doubleSided = ${material.doubleSided}`,
      `    color3f[] primvars:displayColor = ${tuples(displayColor, 3)}${colors ? ' (interpolation = "vertex")' : ''}`,
      ...(displayOpacity
        ? [
            `    float[] primvars:displayOpacity = [${Array.from(displayOpacity, num).join(', ')}] (interpolation = "vertex")`,
          ]
        : []),
    ];
    // The world position of every vertex lies inside the world box of the local bounds' corners.
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? shape.max[0] : shape.min[0],
        y = corner & 2 ? shape.max[1] : shape.min[1],
        z = corner & 4 ? shape.max[2] : shape.min[2];
      for (let r = 0; r < 3; r++)
        if (!Number.isFinite(Math.fround(world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r])))
          throw new RangeError(OUTSIDE_FLOAT32);
    }
    const row = (at: number): string => tuple([world[at], world[at + 1], world[at + 2], world[at + 3]]),
      transform = [
        `    matrix4d xformOp:transform = (${row(0)}, ${row(4)}, ${row(8)}, ${row(12)})`,
        '    uniform token[] xformOpOrder = ["xformOp:transform"]',
      ];
    if (shape.users === 1) {
      lines.push(
        `def Mesh "Mesh_${i}" (apiSchemas = ["MaterialBindingAPI"]) {`,
        `    string displayName = ${JSON.stringify(item.name ?? `Mesh ${i}`)}`,
        ...transform,
        ...topology,
        ...appearance,
        ...vertexST(0, shape.sets[0]),
        ...vertexST(1, shape.sets[1]),
        `    rel material:binding = <${path}>`,
        '}',
        ...materialLines,
      );
      continue;
    }
    if (!shape.path) {
      const name = `Shape_${i}`;
      shape.path = `/Margo/${name}`;
      lines.push(
        `class Mesh "${name}" {`,
        ...topology,
        ...vertexST(0, shape.sets[0]),
        ...vertexST(1, shape.sets[1]),
        '}',
      );
    }
    lines.push(
      `def Mesh "Mesh_${i}" (`,
      '    apiSchemas = ["MaterialBindingAPI"]',
      `    references = <${shape.path}>`,
      ') {',
      `    string displayName = ${JSON.stringify(item.name ?? `Mesh ${i}`)}`,
      ...transform,
      ...appearance,
      `    rel material:binding = <${path}>`,
      '}',
      ...materialLines,
    );
  }
  lines.push('}');
  const content = new TextEncoder().encode(lines.join('\n') + '\n');
  return storedZIP([['scene.usda', content], ...files.files]);
}
