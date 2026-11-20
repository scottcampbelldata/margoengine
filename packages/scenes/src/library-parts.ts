// A library model as textured mesh parts for a biome scatter (`BiomeViewOptions.meshes`): one part per glTF material,
// with its texture coordinates and its maps, so a scanned fir draws its bark and needle textures instead of one flat
// colour. Part of the `/library` entry.
//
// Reads the Khronos glTF 2.0 specification (2021): materials (section 3.9: baseColorTexture, metallicRoughnessTexture,
// normalTexture, alphaMode, alphaCutoff), TEXCOORD_0, node transforms (5.25), and KHR_texture_transform (offset,
// rotation, scale applied to the texture coordinates, uv' = T * R * S * uv).
import { margoError } from '../../shared/errors.js';
import type { ScatterImage, ScatterTextures } from '@margoengine/scatter';
import { KINDS, mul, nodeMatrix, type Doc, type LibraryMeshOptions } from './library-mesh.js';

/** Options of {@link libraryParts}. */
export interface LibraryPartsOptions extends Omit<LibraryMeshOptions, 'color' | 'kind'> {
  /** The look of materials that are not foliage. Default `'bark'`. */
  readonly kind?: 'bark' | 'stone';
  /**
   * Whether a material is foliage (sways, shades as clusters, follows the seasons). Default: alphaMode MASK or BLEND,
   * or a name with twig, leaf, needle, foliage or frond in it.
   */
  readonly foliage?: (name: string) => boolean;
  /** Decodes an image file. Default `createImageBitmap` on the fetched bytes. */
  readonly decode?: (bytes: ArrayBuffer, mimeType: string) => Promise<ScatterImage>;
}

/** Vertices of one part (one level). */
export interface LibraryGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** One textured part, ready for `BiomeViewOptions.meshes`. */
export interface LibraryTexturedPart {
  readonly geometry: LibraryGeometry | readonly [LibraryGeometry, LibraryGeometry, LibraryGeometry];
  /** The material's baseColorFactor (white for most scans): it multiplies the base colour map. */
  readonly color: readonly [number, number, number];
  readonly kind: 'bark' | 'foliage' | 'stone';
  readonly textures: ScatterTextures;
  /** The glTF material name. */
  readonly name: string;
}

type TextureRef = {
  index: number;
  extensions?: { KHR_texture_transform?: { offset?: number[]; rotation?: number; scale?: number[] } };
};
type Material = {
  name?: string;
  alphaMode?: string;
  alphaCutoff?: number;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: TextureRef; metallicRoughnessTexture?: TextureRef };
  normalTexture?: TextureRef;
};
type Full = Doc & {
  materials?: Material[];
  textures?: { source?: number }[];
  images?: { uri?: string; mimeType?: string }[];
};

const FOLIAGE = /twig|leaf|leaves|needle|foliage|frond/i;

/**
 * Loads a glTF model (`.gltf` with external buffers and images) as one textured part per material, every triangle
 * primitive of the default scene under its node transforms, its base on y = 0 and centred on x = z = 0. Each part
 * carries its TEXCOORD_0 (with the material's KHR_texture_transform applied) and its base colour, normal and
 * metallic-roughness images; the metallic-roughness image is read as occlusion-roughness-metal (R occlusion, the
 * packing of Poly Haven and most scan libraries). BLEND materials draw as MASK (a scatter has no sorted blending).
 * Heavy scans need a lighter level first (`maxTriangles`, counted per part). Three URLs (near, middle, far levels of
 * one model, such as decimations of a scan) give each part one geometry per LOD ring, matched by material name.
 * @throws TypeError for a document with no textured triangles; RangeError for a part over `maxTriangles`; Error for a
 *   file that does not load.
 * @example
 * const fir = await libraryParts('/asset-library/big-burn-1910/plants/fir_tree_01/forest/fir_tree_01_a_near.gltf');
 * const scene = await attach(engine, { meshes: { 'procedural:conifer': fir } });
 */
export async function libraryParts(
  url: string | readonly [near: string, middle: string, far: string],
  options: LibraryPartsOptions = {},
): Promise<LibraryTexturedPart[]> {
  if (typeof url !== 'string') {
    // Three levels of one model, finest first: each material's part draws one level per LOD ring, the near level's maps.
    if (!Array.isArray(url) || url.length !== 3) throw new TypeError('libraryParts takes one URL or three; pass a string or [near, middle, far]');
    const levels = await Promise.all(url.map((u) => libraryParts(u, options)));
    return levels[0].map((near) => {
      const at = levels.map((l) => l.find((p) => p.name === near.name));
      if (at.some((p) => !p)) throw new TypeError(`libraryParts: material ${near.name} is missing from a level; export every level with the same materials`);
      const [a, b, c] = at as LibraryTexturedPart[];
      return {
        ...near,
        geometry: [a.geometry, b.geometry, c.geometry],
        textures: { ...near.textures, uvs: [a.textures.uvs, b.textures.uvs, c.textures.uvs] as const },
      } as unknown as LibraryTexturedPart;
    });
  }
  const get = options.fetch ?? (globalThis.fetch as unknown as NonNullable<LibraryMeshOptions['fetch']>),
    init = options.signal ? { signal: options.signal } : {},
    response = await get(url, init);
  if (!response.ok) throw margoError('failed', `libraryParts: ${url} answered ${response.status}; check the URL and that the server serves the file`);
  const doc = (await response.json()) as Full,
    base = url.slice(0, url.lastIndexOf('/') + 1);
  if (!doc.meshes?.length || !doc.accessors || !doc.bufferViews || !doc.buffers || !doc.nodes)
    throw new TypeError(`libraryParts: ${url} holds no meshes; pass a .gltf with meshes, nodes and buffers`);
  const fetchBytes = async (uri: string) => {
    if (uri.startsWith('data:')) throw new TypeError('libraryParts reads a .gltf with external buffers and images; export the model as glTF separate');
    const r = await get(base + uri, init);
    if (!r.ok) throw margoError('failed', `libraryParts: ${base + uri} answered ${r.status}; check that the file sits beside the .gltf`);
    return r.arrayBuffer();
  };
  const buffers = await Promise.all(doc.buffers.map((b) => fetchBytes(b.uri ?? 'data:')));
  const read = (id: number, components: number, index: boolean): Float32Array | Uint32Array => {
    const a = doc.accessors![id],
      v = a ? doc.bufferViews![a.bufferView ?? -1] : undefined,
      kind = a ? KINDS[a.componentType] : undefined;
    if (!a || !v) throw new TypeError('libraryParts: an accessor without a buffer view; use a model whose accessors all have buffer views');
    if (!kind || index === (a.componentType === 5126))
      throw new TypeError(`libraryParts: unsupported accessor component type ${a.componentType}; use float vertices and uvs and integer indices`);
    const [size, at] = kind,
      stride = v.byteStride ?? size * components,
      view = new DataView(buffers[v.buffer], (v.byteOffset ?? 0) + (a.byteOffset ?? 0)),
      out = index ? new Uint32Array(a.count * components) : new Float32Array(a.count * components);
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < components; c++) out[i * components + c] = at(view, i * stride + c * size);
    return out;
  };
  type Group = { positions: number[]; normals: number[]; uvs: number[]; indices: number[] };
  const groups = new Map<number, Group>();
  const visit = (id: number, parent: number[]) => {
    const node = doc.nodes![id],
      m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined)
      for (const p of doc.meshes![node.mesh].primitives) {
        const a = p.attributes;
        if ((p.mode ?? 4) !== 4 || a.POSITION === undefined || a.NORMAL === undefined || a.TEXCOORD_0 === undefined)
          continue;
        const key = p.material ?? -1,
          g = groups.get(key) ?? { positions: [], normals: [], uvs: [], indices: [] },
          pos = read(a.POSITION, 3, false),
          nor = read(a.NORMAL, 3, false),
          uv = read(a.TEXCOORD_0, 2, false),
          first = g.positions.length / 3,
          count = pos.length / 3;
        groups.set(key, g);
        for (let i = 0; i < count; i++) {
          const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]],
            [nx, ny, nz] = [nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]];
          g.positions.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
          const tx = m[0] * nx + m[4] * ny + m[8] * nz,
            ty = m[1] * nx + m[5] * ny + m[9] * nz,
            tz = m[2] * nx + m[6] * ny + m[10] * nz,
            l = Math.hypot(tx, ty, tz) || 1;
          g.normals.push(tx / l, ty / l, tz / l);
          g.uvs.push(uv[i * 2], uv[i * 2 + 1]);
        }
        const idx = p.indices !== undefined ? read(p.indices, 1, true) : Uint32Array.from({ length: count }, (_, i) => i);
        for (const i of idx) g.indices.push(first + i);
      }
    for (const c of node.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of doc.scenes?.[doc.scene ?? 0]?.nodes ?? doc.nodes.map((_, i) => i)) visit(r, identity);
  if (!groups.size) throw new TypeError(`libraryParts: ${url} holds no triangles with positions, normals and uvs; export the model with normals and TEXCOORD_0`);
  // One frame for every part: the base of the whole model on y = 0, centred on x = z = 0.
  let minY = Infinity,
    x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const g of groups.values())
    for (let i = 0; i < g.positions.length; i += 3) {
      minY = Math.min(minY, g.positions[i + 1]);
      x0 = Math.min(x0, g.positions[i]);
      x1 = Math.max(x1, g.positions[i]);
      z0 = Math.min(z0, g.positions[i + 2]);
      z1 = Math.max(z1, g.positions[i + 2]);
    }
  const k = options.scale ?? 1,
    cx = (x0 + x1) / 2,
    cz = (z0 + z1) / 2,
    most = options.maxTriangles ?? 120000,
    isFoliage = options.foliage ?? ((name: string) => FOLIAGE.test(name)),
    decode =
      options.decode ??
      (async (bytes: ArrayBuffer, mimeType: string) =>
        createImageBitmap(new Blob([bytes], { type: mimeType }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })),
    images = new Map<number, Promise<ScatterImage>>();
  const image = (ref: TextureRef | undefined): Promise<ScatterImage> | undefined => {
    const source = ref === undefined ? undefined : doc.textures?.[ref.index]?.source;
    if (source === undefined) return undefined;
    const img = doc.images?.[source];
    if (!img?.uri) throw new TypeError('libraryParts reads images by uri; export the model as glTF separate');
    if (!images.has(source))
      images.set(
        source,
        fetchBytes(img.uri).then((b) => decode(b, img.mimeType ?? (img.uri!.endsWith('.png') ? 'image/png' : 'image/jpeg'))),
      );
    return images.get(source);
  };
  const parts: Promise<LibraryTexturedPart>[] = [];
  for (const [key, g] of groups) {
    const triangles = g.indices.length / 3;
    if (triangles > most)
      throw new RangeError(
        `libraryParts: ${url} has ${triangles} triangles in one part, over maxTriangles ${most}; export a lighter level of it`,
      );
    const mat: Material = doc.materials?.[key] ?? {},
      pbr = mat.pbrMetallicRoughness ?? {},
      name = mat.name ?? `material ${key}`,
      positions = new Float32Array(g.positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = (g.positions[i] - cx) * k;
      positions[i + 1] = (g.positions[i + 1] - minY) * k;
      positions[i + 2] = (g.positions[i + 2] - cz) * k;
    }
    // KHR_texture_transform of the base colour map, applied to the coordinates every map of the part reads.
    const t = pbr.baseColorTexture?.extensions?.KHR_texture_transform,
      [ox, oy] = t?.offset ?? [0, 0],
      [sx, sy] = t?.scale ?? [1, 1],
      c = Math.cos(t?.rotation ?? 0),
      s = Math.sin(t?.rotation ?? 0),
      uvs = new Float32Array(g.uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
      const u = g.uvs[i] * sx,
        v = g.uvs[i + 1] * sy;
      uvs[i] = c * u + s * v + ox;
      uvs[i + 1] = -s * u + c * v + oy;
    }
    const masked = mat.alphaMode === 'MASK' || mat.alphaMode === 'BLEND',
      f = pbr.baseColorFactor ?? [1, 1, 1, 1],
      [baseColor, normal, orm] = [
        image(pbr.baseColorTexture),
        image(mat.normalTexture),
        image(pbr.metallicRoughnessTexture),
      ];
    parts.push(
      Promise.all([baseColor, normal, orm]).then(([b, n, o]) => ({
        geometry: { positions, normals: Float32Array.from(g.normals), indices: Uint32Array.from(g.indices) },
        color: [f[0], f[1], f[2]] as const,
        kind: masked || isFoliage(name) ? 'foliage' : (options.kind ?? 'bark'),
        name,
        textures: {
          uvs,
          ...(b ? { baseColor: b } : {}),
          ...(n ? { normal: n } : {}),
          ...(o ? { occlusionRoughnessMetal: o } : {}),
          alphaCutoff: masked && b ? (mat.alphaCutoff ?? 0.5) : 0,
        },
      })),
    );
  }
  return Promise.all(parts);
}
