import {
  decodeImages,
  expandCompact,
  maxBytes,
  pngSize,
  readContainer,
} from "./container.js";
import { checkCount, countLimit } from "../../shared/limits.js";
import type { EngineKernel } from "@margoengine/core";
import {
  parsePreparedPBR,
  type GLTFDocument,
  type PBRModel,
  type PreparedGeometry,
} from "@margoengine/gltf-pro/model";
import { validatePreparedGeometry } from "../../shared/prepared-geometry.js";
import { readResponse } from "../../shared/loading.js";

// The prepared glTF subset inspected below; scene and material fields remain
// unknown here because parsePreparedPBR owns their validation.
interface MargoPrimitive {
  vertices?: unknown;
  indices?: unknown;
  attributes?: unknown;
  targets?: unknown;
  extensions?: unknown;
}
interface MargoMesh {
  primitives?: MargoPrimitive[];
}
interface MargoImage {
  mimeType?: unknown;
  uri?: unknown;
  section?: unknown;
}
interface MargoDocument extends Record<string, unknown> {
  asset?: { version?: unknown };
  meshes?: MargoMesh[];
  nodes?: unknown[];
  images?: MargoImage[];
}
/** A decoded `.margo` file before any GPU work: the validated scene document, geometry views and embedded PNG bytes. */
export interface MargoAsset {
  /** The glTF-shaped scene and material document. */
  readonly document: GLTFDocument;
  /** Prepared geometry per mesh, then per primitive; shared primitives share one entry. */
  readonly geometry: readonly (readonly PreparedGeometry[])[];
  /** Embedded RGBA8 PNG files, in the order the document's `images` list them. */
  readonly images: readonly Uint8Array<ArrayBuffer>[];
}
/** Resource limits shared by the .margo decoding and loading entrypoints. */
export interface MargoOptions {
  /** Maximum scene nodes (default 100,000). */
  maxNodes?: number;
}

/**
 * Validates and decodes `.margo` bytes without a GPU. Compact vertices and uint16 indices expand once; other geometry
 * retains the input buffer, so keep the bytes alive and unmodified while the result is used.
 *
 * @example
 * const asset = decodeMargo(await (await fetch('/scene.margo')).arrayBuffer());
 * console.log(asset.document.nodes?.length);
 */
export function decodeMargo(
  input: ArrayBuffer | ArrayBufferView,
  { maxNodes = 100_000 }: MargoOptions = {},
): MargoAsset {
  countLimit("maxNodes", maxNodes);
  const { buffer, sections, manifest } = readContainer(input, false),
    doc = manifest as MargoDocument | null;
  if (
    !doc ||
    doc.asset?.version !== "2.0" ||
    !Array.isArray(doc.meshes) ||
    !doc.meshes.length ||
    !Array.isArray(doc.nodes) ||
    !doc.nodes.length
  )
    throw new TypeError(
      "Invalid .margo scene; it needs glTF asset version 2.0 plus at least one mesh and one node, so re-export it from Blender",
    );
  checkCount("Too many .margo nodes", doc.nodes.length, maxNodes, "maxNodes");
  for (const key of [
    "buffers",
    "bufferViews",
    "accessors",
    "skins",
    "animations",
    "extensionsRequired",
  ])
    if (doc[key] !== undefined)
      throw new TypeError(
        `Unsupported .margo ${key}; remove it from the scene (.margo carries geometry in sections, not glTF ${key})`,
      );
  for (const key of ["materials", "images", "textures", "samplers", "scenes"])
    if (doc[key] !== undefined && !Array.isArray(doc[key]))
      throw new TypeError(
        `Invalid .margo ${key}; it must be an array, so re-export the file from Blender`,
      );
  const section = (id: unknown, type: number) => {
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      sections[id]?.type !== type
    )
      throw new TypeError(
        "Invalid .margo section reference; a mesh or image points at a missing section of the wrong type, so re-export the file",
      );
    return sections[id];
  };
  const shared = new Map<string, PreparedGeometry>();
  let geometryBytes = 0;
  const geometry = doc.meshes.map((mesh) => {
    if (!mesh || !Array.isArray(mesh.primitives) || !mesh.primitives.length)
      throw new TypeError(
        "Invalid .margo primitives; every mesh needs at least one primitive, so re-export the file from Blender",
      );
    return mesh.primitives.map((p) => {
      if (!p || p.attributes || p.targets || p.extensions)
        throw new TypeError(
          "Unsupported .margo primitive; remove attributes, morph targets and extensions (.margo primitives use packed sections)",
        );
      const { bytes: vertices, stride } = section(p.vertices, 2),
        { bytes: indices, stride: indexStride } = section(p.indices, 3);
      const key = `${p.vertices}:${p.indices}`;
      let geometry = shared.get(key);
      if (!geometry) {
        const count = vertices.byteLength / stride;
        geometryBytes += count * 80 + (indices.byteLength / indexStride) * 4;
        if (count < 3 || count > 1_000_000 || geometryBytes > maxBytes)
          throw new RangeError(
            ".margo geometry exceeds decoded size limit; split the scene into smaller files (3 to 1,000,000 vertices per mesh)",
          );
        let packed = new Float32Array(
          buffer,
          vertices.byteOffset,
          vertices.byteLength / 4,
        );
        if (stride === 24) packed = expandCompact(packed, count);
        const packedIndices =
          indexStride === 2
            ? Uint32Array.from(
                new Uint16Array(
                  buffer,
                  indices.byteOffset,
                  indices.byteLength / 2,
                ),
              )
            : new Uint32Array(
                buffer,
                indices.byteOffset,
                indices.byteLength / 4,
              );
        geometry = { vertices: packed, indices: packedIndices };
        validatePreparedGeometry(geometry);
        shared.set(key, geometry);
      }
      return geometry;
    });
  });
  let decoded = 0;
  const images = (doc.images ?? []).map((image) => {
    if (!image || image.mimeType !== "image/png" || image.uri !== undefined)
      throw new TypeError(
        ".margo images must be embedded PNG; export textures as embedded PNG sections, not URIs",
      );
    const { bytes } = section(image.section, 4),
      [width, height] = pngSize(bytes);
    decoded += width * height * 4;
    if (decoded > maxBytes)
      throw new RangeError(
        ".margo images exceed decoded size limit; use textures of at most 4096 x 4096 pixels",
      );
    return bytes;
  });
  // The untrusted metadata has passed the .margo scene and resource checks above.
  return { document: doc as GLTFDocument, geometry, images };
}

/**
 * Decodes `.margo` bytes and attaches the scene to `engine` as a glTF Pro `PBRModel` (WebGPU only). Aborting `signal`
 * rejects with its reason and closes any decoded images. `maxNodes` defaults to 100,000.
 *
 * @example
 * const model = await parseMargo(engine, await file.arrayBuffer(), { signal });
 */
export async function parseMargo(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes }: MargoOptions & { signal?: AbortSignal } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const asset = decodeMargo(input, { maxNodes }),
    images = await decodeImages(asset.images, signal);
  try {
    signal?.throwIfAborted();
    return parsePreparedPBR(engine, asset.document, asset.geometry, images, {
      maxNodes,
    });
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}

/**
 * Fetches a .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and parses it like parseMargo.
 *
 * @example
 * const model = await loadMargo(engine, '/scene.margo', { signal: AbortSignal.timeout(10_000) });
 */
export async function loadMargo(
  engine: EngineKernel,
  url: string | URL,
  {
    signal,
    maxNodes,
    fetch: get = globalThis.fetch,
  }: MargoOptions & { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargo",
    );
  const bytes = await readResponse(await get(target, { signal }), {
    maxBytes,
    signal,
    label: ".margo download",
  });
  return parseMargo(engine, bytes, { signal, maxNodes });
}
