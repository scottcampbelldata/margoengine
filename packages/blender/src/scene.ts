import {
  expandCompact,
  maxBytes,
  pngSize,
  type MargoSection,
} from "./container.js";
import { checkCount } from "../../shared/limits.js";
import type {
  GLTFDocument,
  PreparedGeometry,
} from "@margoengine/gltf-pro/model";
import { validatePreparedGeometry } from "../../shared/prepared-geometry.js";
import type { MargoAsset } from "./index.js";

// The prepared glTF subset decodeScene inspects; scene and material fields remain
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
/**
 * Checks a static scene manifest against its sections and decodes its geometry and images (decodeMargo's work after
 * the container checks); the curves entry runs it on a shapes file's meshes.
 */
export function decodeScene(
  buffer: ArrayBuffer,
  sections: readonly MargoSection[],
  manifest: unknown,
  maxNodes: number,
): MargoAsset {
  const doc = manifest as MargoDocument | null;
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
