import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
// Wavefront OBJ writer, plus an optional MTL file and textures.
import {
  collect,
  drawables,
  num,
  polygons,
  textureFiles,
  toWorld,
  token,
  type ExportSource,
  type Mat,
  type SceneOptions,
} from './scene.js';

export interface OBJOptions extends SceneOptions {
  /** Also write an MTL file and `usemtl` lines. Default false. */
  materials?: boolean;
  /** File name written in `mtllib`. Default 'scene.mtl'. */
  mtlName?: string;
  /** Append vertex colors to `v` lines (a common extension) when geometry has colors. Default false. */
  colors?: boolean;
  /** Encoding of those vertex colors: 'srgb' (default) or 'linear'. */
  colorSpace?: 'srgb' | 'linear';
  /**
   * With `materials`, write `map_Kd` for base color textures (and `map_d` for MASK or BLEND materials) and return
   * the image files in `textures`. Default false.
   */
  textures?: boolean;
  /** Prepended to every texture file name, e.g. 'textures/' or 'level1_'. Default ''. */
  texturePrefix?: string;
  /** One `g` group (true, default) or one `o` object (false) per mesh. */
  groups?: boolean;
  /** Weld a mesh's corners whose position, uv, normal and written color agree within 1e-5. Default false. */
  mergeVertices?: boolean;
  /** Multiplies every position. Default 1. */
  scale?: number;
}

export interface OBJResult {
  obj: string;
  /** The MTL text when `materials` is true, else null. */
  mtl: string | null;
  /** The texture files the MTL names, keyed by that relative path; save each beside the OBJ. Empty unless `textures`. */
  textures: Map<string, Uint8Array>;
}

const linear = (v: number): number => v;

/**
 * Exports world-space OBJ with one group per mesh, normals, UVs when present, and 1-based indices. Geometry
 * `faceSizes` quads are written as 4-corner faces.
 */
export function exportOBJ(source: ExportSource, options: OBJOptions = {}): OBJResult {
  const withMaterials = options.materials ?? false,
    mtlName = options.mtlName ?? 'scene.mtl',
    colors = options.colors ?? false,
    colorSpace = options.colorSpace ?? 'srgb',
    withTextures = options.textures ?? false,
    groups = options.groups ?? true,
    merge = options.mergeVertices ?? false,
    scale = options.scale ?? 1;
  if (typeof withMaterials !== 'boolean' || typeof colors !== 'boolean')
    throw new TypeError('materials and colors must be boolean');
  if (typeof withTextures !== 'boolean' || typeof groups !== 'boolean' || typeof merge !== 'boolean')
    throw new TypeError('textures, groups and mergeVertices must be boolean');
  if (typeof mtlName !== 'string' || !/^[^\s#]+$/.test(mtlName))
    throw new TypeError('mtlName must be a file name without spaces');
  if (colorSpace !== 'srgb' && colorSpace !== 'linear') throw new TypeError("colorSpace must be 'srgb' or 'linear'");
  if (withTextures && !withMaterials) throw new TypeError('textures needs materials: true to write the MTL');
  if (typeof scale !== 'number') throw new TypeError('scale must be a number');
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('scale must be positive and finite');
  const lines = ['# Margo Engine OBJ export'],
    mtl = ['# Margo Engine MTL export'],
    names = new Map<Mat, string>(),
    groupNames = new Set<string>(),
    files = textureFiles(options.texturePrefix ?? ''),
    encode = colorSpace === 'srgb' ? toSrgb : linear;
  if (withMaterials) lines.push(`mtllib ${mtlName}`);
  let vertexBase = 1,
    uvBase = 1,
    index = 0;
  for (const item of drawables(collect(source, options))) {
    const { positions, normals, indices } = toWorld(item),
      geo = item.geometry,
      uvs = geo.uvs,
      vertexColors = colors ? geo.colors : undefined;
    let group = token(item.name, `mesh_${index}`);
    for (let n = 2; groupNames.has(group); n++) group = `${token(item.name, `mesh_${index}`)}_${n}`;
    groupNames.add(group);
    index++;
    lines.push(`${groups ? 'g' : 'o'} ${group}`);
    if (withMaterials && item.material) {
      let name = names.get(item.material);
      if (!name) {
        const base = token(item.material.name, `material_${names.size}`);
        name = base;
        for (let n = 2; [...names.values()].includes(name); n++) name = `${base}_${n}`;
        names.set(item.material, name);
        const m = item.material,
          kd = m.color.slice(0, 3).map((v) => num(toSrgb(v)));
        mtl.push(
          `newmtl ${name}`,
          `Kd ${kd.join(' ')}`,
          'Ka 0 0 0',
          ...(m.shading === 'phong'
            ? [`Ks ${m.specular.map((v) => num(toSrgb(v))).join(' ')}`, `Ns ${num(m.shininess)}`]
            : ['Ks 0 0 0']),
          `Ke ${m.emissive.map((v) => num(toSrgb(v))).join(' ')}`,
          `Pr ${num(m.roughness)}`,
          `Pm ${num(m.metalness)}`,
          `d ${num(m.color[3])}`,
          // MTL illumination models: 1 diffuse only, 2 diffuse plus highlight.
          m.shading === 'lambert' ? 'illum 1' : 'illum 2',
        );
        if (withTextures && m.baseColorTexture) {
          const file = files.name(m.baseColorTexture);
          mtl.push(`map_Kd ${file}`);
          if (m.alphaMode !== 'OPAQUE') mtl.push(`map_d ${file}`);
        }
        mtl.push('');
      }
      lines.push(`usemtl ${name}`);
    }
    // Written vertices: every source vertex, or with `merge` the first corner of each welded set.
    // ponytail: welding buckets values on a 1e-5 grid, so corners straddling a cell edge stay apart.
    const remap = new Uint32Array(geo.count),
      kept: number[] = [],
      seen = new Map<string, number>();
    for (let i = 0; i < geo.count; i++) {
      let at: number | undefined;
      if (merge) {
        const key = [...positions.subarray(i * 3, i * 3 + 3), ...normals.subarray(i * 3, i * 3 + 3)];
        if (uvs) key.push(uvs[i * 2], uvs[i * 2 + 1]);
        if (vertexColors) key.push(...vertexColors.subarray(i * geo.colorSize, i * geo.colorSize + 3));
        const text = key.map((v) => Math.round(v * 1e5)).join();
        at = seen.get(text);
        if (at === undefined) seen.set(text, kept.length);
      }
      if (at === undefined) at = kept.push(i) - 1;
      remap[i] = at;
    }
    for (const i of kept) {
      let line = `v ${num(positions[i * 3] * scale)} ${num(positions[i * 3 + 1] * scale)} ${num(positions[i * 3 + 2] * scale)}`;
      if (vertexColors) {
        const c = i * geo.colorSize;
        line += ` ${num(encode(vertexColors[c]))} ${num(encode(vertexColors[c + 1]))} ${num(encode(vertexColors[c + 2]))}`;
      }
      lines.push(line);
    }
    // OBJ texture coordinates have v up; glTF and Margo Engine have v down.
    if (uvs) for (const i of kept) lines.push(`vt ${num(uvs[i * 2])} ${num(1 - uvs[i * 2 + 1])}`);
    for (const i of kept) lines.push(`vn ${num(normals[i * 3])} ${num(normals[i * 3 + 1])} ${num(normals[i * 3 + 2])}`);
    const t = uvBase - vertexBase;
    for (const face of polygons(geo.faceSizes, indices))
      lines.push(
        `f ${face
          .map((i) => {
            const a = remap[i] + vertexBase;
            return uvs ? `${a}/${a + t}/${a}` : `${a}//${a}`;
          })
          .join(' ')}`,
      );
    vertexBase += kept.length;
    if (uvs) uvBase += kept.length;
  }
  lines.push('');
  return { obj: lines.join('\n'), mtl: withMaterials ? mtl.join('\n') : null, textures: files.files };
}
