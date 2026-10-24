import {
  collect,
  drawables,
  num,
  toWorld,
  normalizeMaterial,
  samplerOf,
  textureFiles,
  type ExportSource,
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

/**
 * Static, world-space USD meshes with UsdPreviewSurface materials in a stored, 64-byte-aligned USDZ archive.
 *
 * Material textures (`TextureData`, as the glTF writers take them) become `UsdUVTexture` readers of the mesh's
 * `primvars:st` (from `uvs`, V flipped) or `primvars:st1` (from `uvs1`): base color into `diffuseColor` scaled by the
 * color factor (its alpha into `opacity` for BLEND and MASK, with `opacityThreshold` set to `alphaCutoff` for MASK),
 * metal-rough green and blue into `roughness` and `metallic`, `normal`, `occlusion` red and `emissiveColor`. The images
 * are stored as given (PNG or JPEG) under `texturePrefix`. A `baseColorTextureTransform` becomes a `UsdTransform2d`.
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
  const files = textureFiles(prefix);
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
      { positions, normals, indices } = toWorld(item),
      material = item.material ?? normalizeMaterial({}),
      path = `/Margo/Material_${i}`,
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
    for (let v = 0; v < positions.length; v++)
      if (!Number.isFinite(Math.fround(positions[v])))
        throw new RangeError('USDZ world position exceeds Float32 range');
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < positions.length; v++) {
      const axis = v % 3;
      min[axis] = Math.min(min[axis], positions[v]);
      max[axis] = Math.max(max[axis], positions[v]);
    }
    // Texture shaders, built first so the surface can name their outputs.
    const shaders: string[] = [],
      sets: boolean[] = [];
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
        // KHR_texture_transform in glTF uv space (v down), re-expressed in st space (t = 1 - v).
        const { offset, scale: repeat } = material.baseColorTextureTransform;
        shaders.push(
          '    def Shader "BaseColorTransform" {',
          '        uniform token info:id = "UsdTransform2d"',
          `        float2 inputs:in.connect = <${coordinates}>`,
          `        float2 inputs:scale = ${tuple(repeat)}`,
          `        float2 inputs:translation = ${tuple([offset[0], 1 - repeat[1] - offset[1]])}`,
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
    const vertexST = (set: 0 | 1): string[] => {
      const uvs = set ? geometry.uvs1 : geometry.uvs;
      return sets[set] && uvs
        ? [`    texCoord2f[] primvars:st${set ? '1' : ''} = ${tuples(st(uvs), 2)} (interpolation = "vertex")`]
        : [];
    };
    lines.push(
      `def Mesh "Mesh_${i}" (apiSchemas = ["MaterialBindingAPI"]) {`,
      `    string displayName = ${JSON.stringify(item.name ?? `Mesh ${i}`)}`,
      `    float3[] extent = ${tuples([...min, ...max], 3)}`,
      `    point3f[] points = ${tuples(positions, 3)}`,
      `    normal3f[] normals = ${tuples(normals, 3)} (interpolation = "vertex")`,
      `    int[] faceVertexCounts = [3${', 3'.repeat(indices.length / 3 - 1)}]`,
      `    int[] faceVertexIndices = [${indices.join(', ')}]`,
      '    uniform token subdivisionScheme = "none"',
      `    uniform bool doubleSided = ${material.doubleSided}`,
      `    color3f[] primvars:displayColor = ${tuples(displayColor, 3)}${colors ? ' (interpolation = "vertex")' : ''}`,
      ...(displayOpacity
        ? [
            `    float[] primvars:displayOpacity = [${Array.from(displayOpacity, num).join(', ')}] (interpolation = "vertex")`,
          ]
        : []),
      ...vertexST(0),
      ...vertexST(1),
      `    rel material:binding = <${path}>`,
      '}',
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
    );
  }
  lines.push('}');
  const content = new TextEncoder().encode(lines.join('\n') + '\n');
  return storedZIP([['scene.usda', content], ...files.files]);
}
