/**
 * `@margoengine/gltf/report`: what a glTF 2.0 file holds and what is wrong with it, without a GPU (GAP-FILM-GLTFREPORT).
 * Counts, world bounds of what the default scene draws, extensions, image sizes and problems, read with the loader's own
 * accessor reader; with `alpha`, the drawn bounds of cut-out (MASK and BLEND) primitives measured by texture alpha.
 *
 * Sources: the glTF 2.0 specification (Khronos, 2021: sections 3.5 to 3.9 for nodes, meshes, accessors and materials,
 * 3.7.2.1 for the triangle modes, 3.9.4 for alpha coverage); PNG (W3C, 2003, IHDR), JPEG (ITU-T T.81, SOFn markers),
 * WebP (RFC 9649) and KTX 2.0 (Khronos) headers for image sizes; the signed volume of a closed triangle mesh as a sum
 * of signed tetrahedra (Zhang and Chen 2001, "Efficient feature extraction for 2D/3D objects in mesh representation",
 * ICIP). The rival feature check is in docs/clean-room.md (FE-4).
 */
import { GLTFAsset, container, type GLTFDecoderHooks } from './asset.js';
import { withDecoders } from './decoder-default.js';
import { supportedVersion } from './version.js';
import type { GLTFDocument, GLTFMaterial, GLTFNode, GLTFPrimitive } from '../../shared/gltf.js';

export type { GLTFDecoderHooks } from './asset.js';

/** One problem found, with a stable `code` and a sentence naming where and what. */
export interface GLTFProblem {
  code:
    | 'not-gltf'
    | 'json'
    | 'extension'
    | 'external'
    | 'image-format'
    | 'accessor'
    | 'index-range'
    | 'not-finite'
    | 'no-normals'
    | 'no-uvs'
    | 'no-material'
    | 'zero-area'
    | 'inside-out'
    | 'decode'
    | 'empty';
  detail: string;
  /** The node or mesh name the problem belongs to, when it has one. */
  where?: string;
}
/** Axis-aligned world bounds in metres. */
export interface GLTFBounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  centre: [number, number, number];
}
/** One image: index, name, the format its header says, and its size in pixels (0 when unread). */
export interface GLTFImageReport {
  index: number;
  name?: string;
  format: 'png' | 'jpeg' | 'webp' | 'ktx2' | 'unknown' | 'external';
  width: number;
  height: number;
}
/** What `reportGLTF` returns. */
export interface GLTFReport {
  /** True when `problems` is empty. */
  ok: boolean;
  counts: {
    /** Triangles the default scene draws, each instance counted (mesh instancing and node reuse). */
    triangles: number;
    /** Vertices of those draws, each instance counted. */
    vertices: number;
    /** Primitives drawn, each instance counted. */
    primitives: number;
    meshes: number;
    nodes: number;
    materials: number;
    textures: number;
    images: number;
    /** Sum of every image's width x height. */
    texturePixels: number;
    /** The largest image side in pixels. */
    largestTexture: number;
    /** Bytes the images take as uncompressed RGBA8 (texturePixels x 4, no mip chain). */
    rgbaBytes: number;
    /** Drawn triangles whose area is under `zeroArea` square metres. */
    zeroArea: number;
    /** Points and lines primitives drawn (modes 0 to 3), which hold no triangles. */
    pointsAndLines: number;
  };
  /** World bounds of every drawn triangle vertex, or null when nothing is drawn. */
  bounds: GLTFBounds | null;
  /** Bounds of what cut-out primitives draw where their texture alpha passes, with `alpha: true`; else undefined. */
  cutouts?: { primitives: number; bounds: GLTFBounds | null; samples: number };
  extensions: { used: string[]; required: string[]; unsupported: string[] };
  images: GLTFImageReport[];
  /** Each scene node that draws zero-area triangles, in scene order, so a repair knows which meshes to open. */
  zeroAreaByNode: GLTFZeroArea[];
  problems: GLTFProblem[];
}
/** The zero-area triangles one scene node draws. */
export interface GLTFZeroArea {
  /** The node's index. */
  node: number;
  /** The mesh it draws. */
  mesh: number;
  /** The node's name, or `node with mesh <mesh>`. */
  where: string;
  /** Zero-area triangles it draws, each instance counted. */
  zeroArea: number;
  /** Triangles of its primitives that hold them, each instance counted. */
  triangles: number;
}
/** Options of `reportGLTF`. */
export interface GLTFReportOptions {
  /** Aborts the report. */
  signal?: AbortSignal;
  /** A triangle under this area (square metres) counts as zero area. Default 1e-9. */
  zeroArea?: number;
  /**
   * Decode the base colour textures of MASK and BLEND primitives and measure where their alpha passes (MASK: the
   * material's `alphaCutoff`, default 0.5; BLEND: `blendCutoff`), for `cutouts`. Default false.
   */
  alpha?: boolean;
  /** Alpha at or above which a BLEND texel counts as drawn. Default 0.5. */
  blendCutoff?: number;
  /** Most texel samples taken over all cut-out triangles; past it each triangle is sampled more coarsely. Default 4,194,304. */
  maxSamples?: number;
  /** Required extensions a later load supports (a decoder hook, a materials entry): not listed as unsupported. */
  supported?: readonly string[];
  /**
   * Decoders for compressed files, as `loadGLTF` takes them. Default: the built-in decoders of
   * `@margoengine/decoders`, imported only for a file that needs one.
   */
  decoders?: GLTFDecoderHooks;
}

const KNOWN = new Set([
  'KHR_mesh_quantization',
  'KHR_texture_transform',
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_lights_punctual',
  'KHR_node_visibility',
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_dispersion',
  'KHR_materials_volume',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_variants',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_texture_basisu',
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'EXT_mesh_gpu_instancing',
]);
const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
/** A node's local matrix, column major (glTF 3.5.3: T * R * S). */
function local(t: readonly number[], q: readonly number[], s: readonly number[]): number[] {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + z * w) * s[0],
    2 * (x * z - y * w) * s[0],
    0,
    2 * (x * y - z * w) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + x * w) * s[1],
    0,
    2 * (x * z + y * w) * s[2],
    2 * (y * z - x * w) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
const nodeMatrix = (n: GLTFNode) =>
  n.matrix?.slice() ?? local(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]);

/** Width and height from an image's header: PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X, KTX2; undefined otherwise. */
export function imageHeader(
  b: Uint8Array,
): { format: GLTFImageReport['format']; width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47)
    return { format: 'png', width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 < b.length; ) {
      if (b[at] !== 0xff) return undefined;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = v.getUint16(at + 2);
      // SOF0 to SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { format: 'jpeg', width: v.getUint16(at + 7), height: v.getUint16(at + 5) };
      at += 2 + length;
    }
    return undefined;
  }
  if (b.length >= 30 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ')
      return { format: 'webp', width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = v.getUint32(21, true);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X')
      return {
        format: 'webp',
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    return undefined;
  }
  if (b.length >= 28 && v.getUint32(0) === 0xab4b5458 && v.getUint32(4) === 0x2032300a)
    return { format: 'ktx2', width: v.getUint32(20, true), height: Math.max(1, v.getUint32(24, true)) };
  return undefined;
}

type Placed = { index: number; node: GLTFNode; matrices: number[][] };
/** Every node the default scene reaches, with its world matrix (one per EXT_mesh_gpu_instancing instance). */
function sceneNodes(asset: GLTFAsset, problems: GLTFProblem[]): Placed[] {
  const doc = asset.doc,
    nodes = doc.nodes ?? [],
    scene = doc.scenes?.[doc.scene ?? 0],
    children = new Set(nodes.flatMap((n) => n.children ?? [])),
    roots = scene ? (scene.nodes ?? []) : nodes.map((_, i) => i).filter((i) => !children.has(i)),
    out: Placed[] = [],
    path = new Set<number>();
  const walk = (index: number, parent: number[]) => {
    const node = nodes[index];
    if (!node)
      return void problems.push({ code: 'json', detail: `the scene names node ${index}, which does not exist` });
    if (path.has(index))
      return void problems.push({ code: 'json', detail: `node ${index} is its own ancestor (a cycle)` });
    path.add(index);
    const world = multiply(parent, nodeMatrix(node));
    let matrices = [world];
    const instancing = (node.extensions as Record<string, { attributes?: Record<string, number> }> | undefined)
      ?.EXT_mesh_gpu_instancing?.attributes;
    if (instancing && node.mesh !== undefined) {
      try {
        const t = instancing.TRANSLATION === undefined ? undefined : asset.accessor(instancing.TRANSLATION),
          r = instancing.ROTATION === undefined ? undefined : asset.accessor(instancing.ROTATION),
          s = instancing.SCALE === undefined ? undefined : asset.accessor(instancing.SCALE),
          count = t ? t.length / 3 : r ? r.length / 4 : s ? s.length / 3 : 0;
        matrices = [];
        for (let i = 0; i < count; i++)
          matrices.push(
            multiply(
              world,
              local(
                t ? [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]] : [0, 0, 0],
                r ? [r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]] : [0, 0, 0, 1],
                s ? [s[i * 3], s[i * 3 + 1], s[i * 3 + 2]] : [1, 1, 1],
              ),
            ),
          );
      } catch (error) {
        problems.push({
          code: 'accessor',
          where: node.name,
          detail: `node ${node.name ?? index} instancing: ${(error as Error).message}`,
        });
      }
    }
    if (matrices.some((m) => m.some((x) => !Number.isFinite(x))))
      problems.push({
        code: 'not-finite',
        where: node.name,
        detail: `node ${node.name ?? index} has a transform that is not finite`,
      });
    out.push({ index, node, matrices });
    for (const child of node.children ?? []) walk(child, world);
    path.delete(index);
  };
  for (const root of roots) walk(root, identity());
  return out;
}
/** The triangles of a primitive as vertex index triples (glTF 3.7.2.1: list, strip, fan). */
function triangles(mode: number, order: ArrayLike<number>, out: number[]): void {
  out.length = 0;
  if (mode === 4) for (let t = 0; t + 2 < order.length; t += 3) out.push(order[t], order[t + 1], order[t + 2]);
  else if (mode === 5)
    for (let t = 0; t + 2 < order.length; t++)
      if (t % 2) out.push(order[t + 1], order[t], order[t + 2]);
      else out.push(order[t], order[t + 1], order[t + 2]);
  else for (let t = 1; t + 1 < order.length; t++) out.push(order[0], order[t], order[t + 1]);
}
const grow = (min: number[], max: number[], x: number, y: number, z: number) => {
  if (x < min[0]) min[0] = x;
  if (y < min[1]) min[1] = y;
  if (z < min[2]) min[2] = z;
  if (x > max[0]) max[0] = x;
  if (y > max[1]) max[1] = y;
  if (z > max[2]) max[2] = z;
};
const boundsOf = (min: number[], max: number[]): GLTFBounds | null =>
  min.every(Number.isFinite) && max.every(Number.isFinite)
    ? {
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        centre: [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2],
      }
    : null;
const textured = (m: GLTFMaterial) =>
  [
    m.pbrMetallicRoughness?.baseColorTexture,
    m.pbrMetallicRoughness?.metallicRoughnessTexture,
    m.normalTexture,
    m.occlusionTexture,
    m.emissiveTexture,
  ].filter((t) => !!t) as { index: number; texCoord?: number }[];

/**
 * Reports a glTF 2.0 file (GLB bytes, or glTF JSON with embedded buffers) without a GPU: counts, world bounds of what
 * the default scene draws, extensions, image sizes and problems. Never throws on a bad file: a file that is not glTF
 * gives one `'not-gltf'` problem. External buffers and images cannot be read from bytes alone and are problems.
 */
export async function reportGLTF(
  input: ArrayBuffer | ArrayBufferView | string,
  options: GLTFReportOptions = {},
): Promise<GLTFReport> {
  const problems: GLTFProblem[] = [],
    zeroLimit = options.zeroArea ?? 1e-9,
    counts: GLTFReport['counts'] = {
      triangles: 0,
      vertices: 0,
      primitives: 0,
      meshes: 0,
      nodes: 0,
      materials: 0,
      textures: 0,
      images: 0,
      texturePixels: 0,
      largestTexture: 0,
      rgbaBytes: 0,
      zeroArea: 0,
      pointsAndLines: 0,
    },
    report: GLTFReport = {
      ok: false,
      counts,
      bounds: null,
      extensions: { used: [], required: [], unsupported: [] },
      images: [],
      zeroAreaByNode: [],
      problems,
    };
  const done = () => ((report.ok = problems.length === 0), report);
  options.signal?.throwIfAborted();
  let doc: GLTFDocument, binary: Uint8Array | undefined;
  try {
    ({ doc, binary } = container(input as ArrayBuffer));
    if (!doc || typeof doc !== 'object' || !supportedVersion(doc.asset)) throw new TypeError('Expected glTF 2.0');
  } catch (error) {
    problems.push({ code: 'not-gltf', detail: (error as Error).message });
    return done();
  }
  const used = Array.isArray(doc.extensionsUsed) ? [...doc.extensionsUsed] : [],
    required = Array.isArray(doc.extensionsRequired) ? [...doc.extensionsRequired] : [],
    unsupported = required.filter((name) => !KNOWN.has(name) && !options.supported?.includes(name));
  report.extensions = { used, required, unsupported };
  for (const name of unsupported)
    problems.push({ code: 'extension', detail: `${name} is required and Margo's loaders do not read it` });
  counts.meshes = doc.meshes?.length ?? 0;
  counts.nodes = doc.nodes?.length ?? 0;
  counts.materials = doc.materials?.length ?? 0;
  counts.textures = doc.textures?.length ?? 0;
  counts.images = doc.images?.length ?? 0;
  const external = (doc.buffers ?? []).some((b) => b?.uri !== undefined && !String(b.uri).startsWith('data:'));
  if (external)
    problems.push({
      code: 'external',
      detail: 'a buffer points at a file outside these bytes; pass a GLB or embed the buffers',
    });
  let asset: GLTFAsset;
  try {
    // Unsupported required extensions are reported above; the reader is built without them so the rest can be read.
    const readable = { ...doc, extensionsRequired: required.filter((name) => !unsupported.includes(name)) };
    asset = new GLTFAsset(readable, external ? [] : binary ? [binary] : [], binary, withDecoders(options).decoders);
  } catch (error) {
    problems.push({ code: 'json', detail: (error as Error).message });
    return done();
  }
  let decoded = true;
  try {
    await asset.decode(options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    decoded = false;
    problems.push({
      code: 'decode',
      detail: `compressed geometry could not be decoded here: ${(error as Error).message}`,
    });
  }
  // Images: sizes from their headers.
  const imageBytes: (Uint8Array | undefined)[] = [];
  for (const [index, image] of (doc.images ?? []).entries()) {
    let bytes: Uint8Array | undefined;
    try {
      if (image.bufferView !== undefined) bytes = asset.view(image.bufferView);
      else if (typeof image.uri === 'string' && image.uri.startsWith('data:')) {
        const comma = image.uri.indexOf(',');
        bytes = Uint8Array.from(atob(image.uri.slice(comma + 1)), (c) => c.charCodeAt(0));
      }
    } catch (error) {
      problems.push({ code: 'json', detail: `image ${image.name ?? index}: ${(error as Error).message}` });
    }
    imageBytes.push(bytes);
    if (!bytes) {
      report.images.push({ index, name: image.name, format: 'external', width: 0, height: 0 });
      if (image.uri !== undefined)
        problems.push({
          code: 'external',
          detail: `image ${image.name ?? index} points at ${String(image.uri).slice(0, 80)}, outside these bytes`,
        });
      continue;
    }
    const header = imageHeader(bytes);
    if (!header) {
      report.images.push({ index, name: image.name, format: 'unknown', width: 0, height: 0 });
      problems.push({ code: 'image-format', detail: `image ${image.name ?? index} is not PNG, JPEG, WebP or KTX2` });
      continue;
    }
    report.images.push({ index, name: image.name, ...header });
    counts.texturePixels += header.width * header.height;
    counts.largestTexture = Math.max(counts.largestTexture, header.width, header.height);
  }
  counts.rgbaBytes = counts.texturePixels * 4;

  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity],
    cut = { primitives: 0, samples: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    cutWork: {
      positions: Float32Array;
      uvs: Float32Array;
      tris: number[];
      matrices: number[][];
      texture: number;
      cutoff: number;
    }[] = [],
    tris: number[] = [];
  // Values as stored, NaN and infinity kept (reported as not-finite below), each accessor read once.
  const values = new Map<number, Float32Array>(),
    read = (id: number) => {
      let out = values.get(id);
      if (!out) values.set(id, (out = asset.accessor(id, undefined, false)));
      return out;
    };
  const zeroByNode = new Map<number, GLTFZeroArea>();
  for (const { index, node, matrices } of sceneNodes(asset, problems)) {
    options.signal?.throwIfAborted();
    if (node.mesh === undefined) continue;
    const mesh = doc.meshes?.[node.mesh],
      label = node.name ?? `node with mesh ${node.mesh}`;
    if (!mesh) {
      problems.push({
        code: 'json',
        where: node.name,
        detail: `${label} names mesh ${node.mesh}, which does not exist`,
      });
      continue;
    }
    for (const [p, primitive] of (mesh.primitives ?? ([] as GLTFPrimitive[])).entries()) {
      const where = `${label} primitive ${p}`,
        mode = primitive.mode ?? 4,
        attributes = primitive.attributes ?? {},
        instances = matrices.length;
      counts.primitives += instances;
      if (mode < 4) {
        counts.pointsAndLines += instances;
        continue;
      }
      const material = primitive.material === undefined ? undefined : doc.materials?.[primitive.material];
      if (primitive.material === undefined)
        problems.push({
          code: 'no-material',
          where: label,
          detail: `${where} has no material (drawn with the default)`,
        });
      else if (!material)
        problems.push({
          code: 'json',
          where: label,
          detail: `${where} names material ${primitive.material}, which does not exist`,
        });
      if (
        attributes.NORMAL === undefined &&
        !(material?.extensions as Record<string, unknown> | undefined)?.KHR_materials_unlit
      )
        problems.push({
          code: 'no-normals',
          where: label,
          detail: `${where} has no NORMAL (flat normals are made at load)`,
        });
      for (const slot of material ? textured(material) : [])
        if (attributes[`TEXCOORD_${slot.texCoord ?? 0}`] === undefined) {
          problems.push({
            code: 'no-uvs',
            where: label,
            detail: `${where} is textured and has no TEXCOORD_${slot.texCoord ?? 0}`,
          });
          break;
        }
      if (attributes.POSITION === undefined) {
        problems.push({ code: 'accessor', where: label, detail: `${where} has no POSITION` });
        continue;
      }
      const compressed = !!(primitive.extensions as Record<string, unknown> | undefined)?.KHR_draco_mesh_compression;
      if (compressed && !decoded) {
        // Counts and bounds from the accessors' declared count, min and max (required for POSITION, glTF 3.6.2.5).
        const position = doc.accessors?.[attributes.POSITION],
          index = primitive.indices === undefined ? undefined : doc.accessors?.[primitive.indices],
          n = index?.count ?? position?.count ?? 0;
        counts.vertices += (position?.count ?? 0) * instances;
        counts.triangles += (mode === 4 ? Math.floor(n / 3) : Math.max(0, n - 2)) * instances;
        const lo = position?.min,
          hi = position?.max;
        if (lo && hi)
          for (const m of matrices)
            for (let c = 0; c < 8; c++) {
              const x = c & 1 ? hi[0] : lo[0],
                y = c & 2 ? hi[1] : lo[1],
                z = c & 4 ? hi[2] : lo[2];
              grow(
                min,
                max,
                m[0] * x + m[4] * y + m[8] * z + m[12],
                m[1] * x + m[5] * y + m[9] * z + m[13],
                m[2] * x + m[6] * y + m[10] * z + m[14],
              );
            }
        continue;
      }
      let positions: Float32Array, order: ArrayLike<number>;
      try {
        positions = read(attributes.POSITION);
        for (const [name, id] of Object.entries(attributes))
          if (read(id).some((x) => !Number.isFinite(x)))
            problems.push({ code: 'not-finite', where: label, detail: `${where} ${name} holds NaN or infinity` });
        const vertexCount = positions.length / 3;
        order =
          primitive.indices === undefined
            ? Uint32Array.from({ length: vertexCount }, (_, i) => i)
            : read(primitive.indices);
        if (Array.prototype.some.call(order, (i: number) => i >= vertexCount || i < 0)) {
          problems.push({
            code: 'index-range',
            where: label,
            detail: `${where} has an index past its ${vertexCount} vertices`,
          });
          continue;
        }
      } catch (error) {
        problems.push({ code: 'accessor', where: label, detail: `${where}: ${(error as Error).message}` });
        continue;
      }
      triangles(mode, order, tris);
      const vertexCount = positions.length / 3,
        touched = new Uint8Array(vertexCount);
      counts.vertices += vertexCount * instances;
      counts.triangles += (tris.length / 3) * instances;
      for (const i of tris) touched[i] = 1;
      for (const m of matrices) {
        let zero = 0;
        for (let t = 0; t < tris.length; t += 3) {
          const a = tris[t] * 3,
            b = tris[t + 1] * 3,
            c = tris[t + 2] * 3;
          const ax = m[0] * positions[a] + m[4] * positions[a + 1] + m[8] * positions[a + 2],
            ay = m[1] * positions[a] + m[5] * positions[a + 1] + m[9] * positions[a + 2],
            az = m[2] * positions[a] + m[6] * positions[a + 1] + m[10] * positions[a + 2],
            ux = m[0] * positions[b] + m[4] * positions[b + 1] + m[8] * positions[b + 2] - ax,
            uy = m[1] * positions[b] + m[5] * positions[b + 1] + m[9] * positions[b + 2] - ay,
            uz = m[2] * positions[b] + m[6] * positions[b + 1] + m[10] * positions[b + 2] - az,
            vx = m[0] * positions[c] + m[4] * positions[c + 1] + m[8] * positions[c + 2] - ax,
            vy = m[1] * positions[c] + m[5] * positions[c + 1] + m[9] * positions[c + 2] - ay,
            vz = m[2] * positions[c] + m[6] * positions[c + 1] + m[10] * positions[c + 2] - az;
          if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 < zeroLimit) zero++;
        }
        counts.zeroArea += zero;
        if (zero) {
          const row = zeroByNode.get(index) ?? {
            node: index,
            mesh: node.mesh,
            where: label,
            zeroArea: 0,
            triangles: 0,
          };
          row.zeroArea += zero;
          row.triangles += tris.length / 3;
          zeroByNode.set(index, row);
        }
        for (let v = 0; v < vertexCount; v++)
          if (touched[v]) {
            const x = positions[v * 3],
              y = positions[v * 3 + 1],
              z = positions[v * 3 + 2];
            grow(
              min,
              max,
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            );
          }
      }
      // A closed primitive (every welded edge shared by exactly two triangles) whose signed volume is negative faces in.
      // The volume is taken in the mesh's own space: a node whose world transform has a negative determinant mirrors
      // the triangles and also turns the front face to clockwise (glTF 2.0 3.7.4), so mirroring never turns a mesh in.
      const closed = insideOut(positions, tris);
      if (closed !== undefined && closed < 0)
        problems.push({
          code: 'inside-out',
          where: label,
          detail: `${where} is closed and its triangles face inward (signed volume ${closed.toPrecision(3)})`,
        });
      const base = material?.pbrMetallicRoughness?.baseColorTexture,
        alphaMode = material?.alphaMode ?? 'OPAQUE';
      if (
        options.alpha &&
        base &&
        (alphaMode === 'MASK' || alphaMode === 'BLEND') &&
        attributes[`TEXCOORD_${base.texCoord ?? 0}`] !== undefined
      ) {
        try {
          cutWork.push({
            positions,
            uvs: read(attributes[`TEXCOORD_${base.texCoord ?? 0}`]),
            tris: tris.slice(),
            matrices,
            texture: base.index,
            cutoff:
              (alphaMode === 'MASK' ? (material?.alphaCutoff ?? 0.5) : (options.blendCutoff ?? 0.5)) /
              (material?.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1),
          });
        } catch (error) {
          problems.push({ code: 'accessor', where: label, detail: `${where}: ${(error as Error).message}` });
        }
      }
    }
  }
  report.bounds = boundsOf(min, max);
  if (counts.triangles === 0 && counts.pointsAndLines === 0)
    problems.push({ code: 'empty', detail: 'the default scene draws nothing' });
  report.zeroAreaByNode = [...zeroByNode.values()];
  if (counts.zeroArea)
    problems.push({
      code: 'zero-area',
      detail: `${counts.zeroArea} of ${counts.triangles} drawn triangles have zero area`,
    });
  if (options.alpha) {
    const { decodeImage } = await import('@margoengine/decoders/image'),
      decodedImages = new Map<number, { width: number; height: number; data: Uint8Array } | null>(),
      budget = options.maxSamples ?? 4_194_304,
      triangleCount = cutWork.reduce((n, w) => n + w.tris.length / 3, 0);
    for (const work of cutWork) {
      const source = doc.textures?.[work.texture]?.source;
      if (source === undefined || !imageBytes[source]) continue;
      if (!decodedImages.has(source))
        decodedImages.set(
          source,
          await decodeImage(imageBytes[source]!, { signal: options.signal }).catch((error: Error) => {
            problems.push({
              code: 'image-format',
              detail: `image ${source} could not be decoded for alpha: ${error.message}`,
            });
            return null;
          }),
        );
      const image = decodedImages.get(source);
      if (!image) continue;
      cut.primitives++;
      cut.samples += coverage(
        work,
        image,
        Math.max(1, Math.floor(budget / Math.max(1, triangleCount))),
        cut.min,
        cut.max,
      );
    }
    report.cutouts = { primitives: cut.primitives, bounds: boundsOf(cut.min, cut.max), samples: cut.samples };
  }
  return done();
}

/** Signed volume of a primitive when it is closed (every welded edge used by two triangles), else undefined. */
function insideOut(positions: Float32Array, tris: number[]): number | undefined {
  const weld = new Map<string, number>(),
    id = new Int32Array(positions.length / 3);
  for (let v = 0; v < id.length; v++) {
    const key = `${Math.round(positions[v * 3] * 1e5)},${Math.round(positions[v * 3 + 1] * 1e5)},${Math.round(positions[v * 3 + 2] * 1e5)}`;
    let w = weld.get(key);
    if (w === undefined) weld.set(key, (w = weld.size));
    id[v] = w;
  }
  const edges = new Map<number, number>(),
    n = weld.size;
  let volume = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3,
      b = tris[t + 1] * 3,
      c = tris[t + 2] * 3,
      p = positions;
    volume +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
    for (let e = 0; e < 3; e++) {
      const i = id[tris[t + e]],
        j = id[tris[t + ((e + 1) % 3)]];
      if (i === j) continue;
      const key = Math.min(i, j) * n + Math.max(i, j);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (!edges.size) return undefined;
  for (const count of edges.values()) if (count !== 2) return undefined;
  return volume;
}

/**
 * Grows `min`/`max` by the world points of each triangle where the texture's alpha (nearest texel, repeat wrap) is at
 * or above `cutoff`, sampled on a barycentric grid about one sample per texel the triangle covers, at most `limit`
 * samples per triangle. Returns the samples taken.
 */
function coverage(
  work: { positions: Float32Array; uvs: Float32Array; tris: number[]; matrices: number[][]; cutoff: number },
  image: { width: number; height: number; data: Uint8Array },
  limit: number,
  min: number[],
  max: number[],
): number {
  const { positions: p, uvs, tris } = work,
    { width: w, height: h, data } = image,
    cutoff = Math.min(1, Math.max(0, work.cutoff)) * 255;
  let samples = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ua = uvs[a * 2] * w,
      va = uvs[a * 2 + 1] * h,
      ub = uvs[b * 2] * w,
      vb = uvs[b * 2 + 1] * h,
      uc = uvs[c * 2] * w,
      vc = uvs[c * 2 + 1] * h;
    const area = Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) / 2,
      steps = Math.max(1, Math.min(Math.ceil(Math.sqrt(2 * area)), Math.floor(Math.sqrt(2 * limit))));
    for (let i = 0; i <= steps; i++)
      for (let j = 0; j <= steps - i; j++) {
        const s = i / steps,
          r = j / steps,
          q = 1 - s - r;
        const u = q * ua + s * ub + r * uc,
          v = q * va + s * vb + r * vc,
          x = ((Math.floor(u) % w) + w) % w,
          y = ((Math.floor(v) % h) + h) % h;
        samples++;
        if (data[(y * w + x) * 4 + 3] < cutoff) continue;
        const px = q * p[a * 3] + s * p[b * 3] + r * p[c * 3],
          py = q * p[a * 3 + 1] + s * p[b * 3 + 1] + r * p[c * 3 + 1],
          pz = q * p[a * 3 + 2] + s * p[b * 3 + 2] + r * p[c * 3 + 2];
        for (const m of work.matrices)
          grow(
            min,
            max,
            m[0] * px + m[4] * py + m[8] * pz + m[12],
            m[1] * px + m[5] * py + m[9] * pz + m[13],
            m[2] * px + m[6] * py + m[10] * pz + m[14],
          );
      }
  }
  return samples;
}
