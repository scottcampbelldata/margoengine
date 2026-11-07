// Wavefront OBJ writer, plus an optional MTL file and textures.
import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
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

/** Options of exportOBJ: MTL materials, usemtl grouping, textures and the file names written into the OBJ. */
export interface OBJOptions extends SceneOptions {
  /** Also write an MTL file and `usemtl` lines. Default false. */
  materials?: boolean;
  /**
   * Write a `usemtl <material name>` line before each mesh's faces without `materials`: no `mtllib` line and no MTL,
   * so the material names alone group the faces (a palette's slots, a tool's own library). Meshes without a material
   * get none. Default false; `materials` implies it.
   */
  usemtl?: boolean;
  /** File name written in `mtllib`. Default 'scene.mtl'. */
  mtlName?: string;
  /** Append vertex colors to `v` lines (a common extension) when geometry has colors. Default false. */
  colors?: boolean;
  /** Encoding of those vertex colors: 'srgb' (default) or 'linear'. */
  colorSpace?: 'srgb' | 'linear';
  /**
   * With `materials`, write `map_Kd` for base color textures (and `map_d` for MASK or BLEND materials) and return
   * the image files in `textures`. A loaded glTF model's texture comes from the model file as it is; one that is not a
   * PNG or JPEG inside that file, or a live Material's, throws. Default false.
   */
  textures?: boolean;
  /**
   * With `textures`, give each MASK or BLEND material's base color texture its own opacity map: `map_d -imfchan r`
   * names `<texture>-opacity.png`, holding its alpha in every color channel (readers mostly ignore a color file's
   * alpha in `map_d`). `exportOBJ` lists those files in `opacityMaps`; `writeOpacityMaps` encodes them. Default false.
   */
  opacityMaps?: boolean;
  /** Prepended to every texture file name, e.g. 'textures/' or 'level1_'. Default ''. */
  texturePrefix?: string;
  /** One `g` group (true, default) or one `o` object (false) per mesh. */
  groups?: boolean;
  /** Weld a mesh's corners whose position, uv, normal and written color agree within 1e-5. Default false. */
  mergeVertices?: boolean;
  /**
   * Faces share the vertices their geometry's indices share (true, default), or each face gets its own corners
   * (false): no vertex is shared between faces, as voxel editors write unwelded quads. Not with `mergeVertices`.
   */
  shareVertices?: boolean;
  /** Multiplies every position. Default 1. */
  scale?: number;
}

/** The OBJ text, plus the MTL text, texture files and opacity maps that go beside it. */
export interface OBJResult {
  obj: string;
  /** The MTL text when `materials` is true, else null. */
  mtl: string | null;
  /** The texture files the MTL names, keyed by that relative path; save each beside the OBJ. Empty unless `textures`. */
  textures: Map<string, Uint8Array>;
  /** With `opacityMaps`: each opacity map's file name and the texture file whose alpha it holds. */
  opacityMaps: Map<string, string>;
  /**
   * Files the MTL names that a loaded model does not yet hold as PNG or JPEG: the bytes of a WebP, KTX2, DDS or AVIF
   * image, or the URL of a file beside the model. Decoding and fetching take time, so `await writeTextures(result)`
   * moves each into `textures`.
   */
  undecoded: Map<string, Uint8Array | URL>;
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
    withOpacity = options.opacityMaps ?? false,
    groups = options.groups ?? true,
    merge = options.mergeVertices ?? false,
    share = options.shareVertices ?? true,
    usemtl = options.usemtl ?? false,
    scale = options.scale ?? 1;
  if (typeof withMaterials !== 'boolean' || typeof colors !== 'boolean')
    throw new TypeError('materials and colors must be boolean');
  if (typeof withTextures !== 'boolean' || typeof groups !== 'boolean' || typeof merge !== 'boolean')
    throw new TypeError('textures, groups and mergeVertices must be boolean');
  if (typeof mtlName !== 'string' || !/^[^\s#]+$/.test(mtlName))
    throw new TypeError('mtlName must be a file name without spaces');
  if (colorSpace !== 'srgb' && colorSpace !== 'linear') throw new TypeError("colorSpace must be 'srgb' or 'linear'");
  if (withTextures && !withMaterials) throw new TypeError('textures needs materials: true to write the MTL');
  if (typeof withOpacity !== 'boolean') throw new TypeError('opacityMaps must be boolean');
  if (withOpacity && !withTextures) throw new TypeError('opacityMaps needs textures: true to name the texture files');
  if (typeof usemtl !== 'boolean' || typeof share !== 'boolean')
    throw new TypeError('usemtl and shareVertices must be boolean');
  if (merge && !share)
    throw new TypeError('mergeVertices welds corners that shareVertices: false keeps apart; pass one of them');
  if (typeof scale !== 'number') throw new TypeError('scale must be a number');
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('scale must be positive and finite');
  const lines = ['# Margo Engine OBJ export'],
    mtl = ['# Margo Engine MTL export'],
    names = new Map<Mat, string>(),
    groupNames = new Set<string>(),
    files = textureFiles(options.texturePrefix ?? ''),
    opacity = new Map<string, string>(),
    encode = colorSpace === 'srgb' ? toSrgb : linear;
  if (withMaterials) lines.push(`mtllib ${mtlName}`);
  let vertexBase = 1,
    uvBase = 1,
    index = 0;
  for (const item of drawables(collect(source, options, undefined, withTextures ? 'baseColor' : 'shape'))) {
    const { positions, normals, indices } = toWorld(item),
      geo = item.geometry,
      uvs = geo.uvs,
      vertexColors = colors ? geo.colors : undefined;
    let group = token(item.name, `mesh_${index}`);
    for (let n = 2; groupNames.has(group); n++) group = `${token(item.name, `mesh_${index}`)}_${n}`;
    groupNames.add(group);
    index++;
    lines.push(`${groups ? 'g' : 'o'} ${group}`);
    if ((withMaterials || usemtl) && item.material) {
      let name = names.get(item.material);
      if (!name) {
        const base = token(item.material.name, `material_${names.size}`);
        name = base;
        for (let n = 2; [...names.values()].includes(name); n++) name = `${base}_${n}`;
        names.set(item.material, name);
      }
      if (withMaterials && !mtl.includes(`newmtl ${name}`)) {
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
          // An opaque material ignores its color's alpha.
          `d ${m.alphaMode === 'OPAQUE' ? 1 : num(m.color[3])}`,
          // MTL illumination models: 0 color only (unlit), 1 diffuse only, 2 diffuse plus highlight.
          m.unlit ? 'illum 0' : m.shading === 'lambert' ? 'illum 1' : 'illum 2',
        );
        if (withTextures && m.baseColorTexture) {
          const file = files.name(m.baseColorTexture);
          mtl.push(`map_Kd ${file}`);
          if (m.alphaMode !== 'OPAQUE' && withOpacity) {
            const map = file.replace(/\.(?:png|jpg)$/, '-opacity.png');
            opacity.set(map, file);
            mtl.push(`map_d -imfchan r ${map}`);
          } else if (m.alphaMode !== 'OPAQUE') mtl.push(`map_d ${file}`);
        }
        mtl.push('');
      }
      lines.push(`usemtl ${name}`);
    }
    // Written vertices: every source vertex, with `merge` the first corner of each welded set, or without `share`
    // each face corner in face order (faces then index written vertices 0, 1, 2, ...).
    // ponytail: welding buckets values on a 1e-5 grid, so corners straddling a cell edge stay apart.
    const faces = polygons(geo.faceSizes, indices),
      remap = new Uint32Array(geo.count),
      kept: number[] = share ? [] : faces.flat(),
      seen = new Map<string, number>();
    for (let i = 0; share && i < geo.count; i++) {
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
    // OBJ texture coordinates have v up; glTF and Margo Engine have v down. MTL has no rotation, so a texture
    // transform goes into the coordinates: the glTF matrix, offset * rotation * scale.
    const { offset = [0, 0], scale: repeat = [1, 1], rotation = 0 } =
        (withTextures && item.material?.baseColorTextureTransform) || {},
      cos = Math.cos(rotation),
      sin = Math.sin(rotation);
    if (uvs)
      for (const i of kept) {
        const u = uvs[i * 2] * repeat[0],
          v = uvs[i * 2 + 1] * repeat[1];
        lines.push(`vt ${num(offset[0] + cos * u + sin * v)} ${num(1 - (offset[1] - sin * u + cos * v))}`);
      }
    for (const i of kept) lines.push(`vn ${num(normals[i * 3])} ${num(normals[i * 3 + 1])} ${num(normals[i * 3 + 2])}`);
    const t = uvBase - vertexBase;
    let corner = 0;
    for (const face of faces)
      lines.push(
        `f ${face
          .map((i) => {
            const a = (share ? remap[i] : corner++) + vertexBase;
            return uvs ? `${a}/${a + t}/${a}` : `${a}//${a}`;
          })
          .join(' ')}`,
      );
    vertexBase += kept.length;
    if (uvs) uvBase += kept.length;
  }
  lines.push('');
  return {
    obj: lines.join('\n'),
    mtl: withMaterials ? mtl.join('\n') : null,
    textures: files.files,
    opacityMaps: opacity,
    undecoded: files.held,
  };
}

/**
 * Fetches and decodes the images an `exportOBJ` result lists in `undecoded` and adds each to `result.textures` under
 * the name the MTL gives it, so a model exports whatever its textures are held in. Does nothing when `undecoded` is empty.
 *
 * @example
 * import {exportOBJ, writeTextures} from 'margoengine/exporters';
 * declare const engine: Parameters<typeof exportOBJ>[0];
 * const result = exportOBJ(engine, {materials: true, textures: true});
 * await writeTextures(result);
 *
 * @throws MargoError `failed` when a file beside the model cannot be fetched; what `decodeImage` from
 * `@margoengine/decoders/image` throws for a damaged image or one it cannot read.
 */
export async function writeTextures(result: OBJResult, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!result.undecoded.size) return;
  const { decodeImage, imageFormat } = await import('@margoengine/decoders/image');
  const { encodePNG } = await import('./capture.js');
  for (const [file, held] of result.undecoded) {
    let bytes: Uint8Array;
    if (held instanceof URL) {
      const response = await fetch(held, { signal: options.signal });
      if (!response.ok)
        throw new MargoError('failed', `Could not fetch ${held.href} (${response.status}); keep the image beside the model`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else bytes = held;
    const format = imageFormat(bytes);
    result.textures.set(
      file,
      format === 'png' || format === 'jpeg' ? bytes : await encodePNG(await decodeImage(bytes, options)),
    );
    result.undecoded.delete(file);
  }
}

/**
 * Encodes the opacity maps an `exportOBJ` result with `opacityMaps` names: each texture's alpha in every color
 * channel, fully opaque, as PNG, added to `result.textures`. Runs {@link writeTextures} first, as a map may read one.
 * @throws TypeError when such a texture is not PNG (JPEG has no alpha); what decodePNG and encodePNG throw.
 */
export async function writeOpacityMaps(result: OBJResult): Promise<void> {
  if (!result.opacityMaps.size) return;
  await writeTextures(result);
  const { decodePNG } = await import('@margoengine/decoders/png');
  const { encodePNG } = await import('./capture.js');
  for (const [map, file] of result.opacityMaps) {
    if (!file.endsWith('.png')) throw new TypeError(`${file} is not PNG; give a MASK or BLEND material a PNG texture`);
    const image = decodePNG(result.textures.get(file)!),
      data = new Uint8Array(image.data.length);
    for (let i = 0; i < data.length; i += 4) {
      const alpha = image.data[i + 3];
      data[i] = data[i + 1] = data[i + 2] = alpha;
      data[i + 3] = 255;
    }
    result.textures.set(map, await encodePNG({ width: image.width, height: image.height, data }));
  }
}
