// The in-memory glTF of a textured Box, Sphere or Plane, loaded with the shape (a dynamic import), so a plain-colour
// shape does not carry it.
import type { GeometryData } from '@margoengine/geometry';
import { MargoError } from '@margoengine/math/errors';
import type { TextureSource } from './textured.js';

const PNG = [0x89, 0x50, 0x4e, 0x47],
  JPEG = [0xff, 0xd8, 0xff];
/** The image's media type from its first bytes: glTF 2.0 allows PNG and JPEG for `image/*` in a buffer view. */
function mimeOf(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if (PNG.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (JPEG.every((byte, i) => bytes[i] === byte)) return 'image/jpeg';
  throw new MargoError(
    'unsupported',
    'Textured shape: the map is neither PNG nor JPEG; convert it to one of the two, or use a glTF <Model> for KTX2 and WebP textures.',
  );
}
export async function bytesOf(source: TextureSource, fetcher: typeof fetch, signal: AbortSignal): Promise<Uint8Array> {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  const response = await fetcher(source as string | URL, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Textured shape: ${String(source)} answered HTTP ${response.status}; check the map URL, or pass the image bytes.`,
    );
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The glTF 2.0 document of one primitive with a base colour texture, its binary buffer holding the attributes, indices
 * and image (spec sections 3.6 to 3.9: accessors, buffer views, materials, textures). Positions carry min and max, as
 * the spec requires.
 */
export function texturedDocument(
  data: GeometryData,
  image: Uint8Array,
  material: { color: number[]; roughness: number; metalness: number },
): { doc: object; buffer: Uint8Array } {
  const parts = [data.positions, data.normals, data.uvs, data.indices].map(
      (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    ),
    views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  let length = 0;
  const offsets: number[] = [];
  for (const part of [...parts, image]) {
    offsets.push(length);
    length += Math.ceil(part.byteLength / 4) * 4;
  }
  const buffer = new Uint8Array(length);
  [...parts, image].forEach((part, i) => {
    buffer.set(part, offsets[i]);
    views.push({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: part.byteLength,
      ...(i < 3 ? { target: 34962 } : i === 3 ? { target: 34963 } : {}),
    });
  });
  const count = data.positions.length / 3,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], data.positions[i * 3 + k]);
      max[k] = Math.max(max[k], data.positions[i * 3 + k]);
    }
  const doc = {
    asset: { version: '2.0', generator: 'margoengine react/geometry' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: data.indices.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: length }],
    images: [{ bufferView: 4, mimeType: mimeOf(image) }],
    // Linear filtering with mipmaps, repeat wrap: the glTF defaults a renderer may pick, spelled out.
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    textures: [{ source: 0, sampler: 0 }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: material.color,
          roughnessFactor: material.roughness,
          metallicFactor: material.metalness,
        },
      },
    ],
  };
  return { doc, buffer };
}

