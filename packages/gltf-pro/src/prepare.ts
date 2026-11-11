import { loadAsset, overBudget, type GLTFAsset, type GLTFDocument, type GLTFImage } from './asset.js';
import { decodeExtras, packPrimitive } from './pack.js';
import type { PreparedGeometry } from './index.js';
/** A glTF parsed off the main thread: everything PBRModel needs except GPU uploads. Every buffer is transferable. */
export interface PreparedGLTF {
  doc: GLTFDocument;
  /** Compressed inputs are transferred back for automatic decoding on the GPU-owning thread. */
  deferred?: boolean;
  baseURL?: string;
  downloadedBytes?: number;
  buffers: Uint8Array[];
  images: GLTFImage[];
  /** Packed geometry per mesh and primitive; null where packing failed (the main thread repeats it and reports the error). */
  geometry: (PreparedGeometry | readonly PreparedGeometry[] | null)[][];
  /** Decoded accessors by index (geometry, skins, morph targets, animation samplers, GPU instancing), as GLTFAsset caches them. */
  accessors: [number, Float32Array][];
  /** The load's `maxDownloadBytes`, so the main thread's asset keeps the same budgets (absent: the default). */
  maxDownloadBytes?: number;
  /** The load's `maxNodes` (absent: the default). */
  maxNodes?: number;
  /** The load's `maxPartVertices` (absent: the default). */
  maxPartVertices?: number;
}
/** Decode what PBRModel and @margoengine/animation read from an asset: packed primitives and their accessors. */
export function prepareAsset(asset: GLTFAsset, images: GLTFImage[]): PreparedGLTF {
  const doc = asset.doc,
    attempt = <T>(f: () => T) => {
      try {
        return f();
      } catch {
        return null;
      }
    };
  // Packed geometry counts toward the decoded budget as on the main thread (PBRModel), so a file that repeats its
  // meshes cannot make the worker pack far more than its size allows.
  let geometryBytes = 0;
  const geometry = (doc.meshes ?? []).map((mesh) =>
    (Array.isArray(mesh?.primitives) ? mesh.primitives : []).map((p) => {
      const packed = attempt(() => packPrimitive(asset, p));
      for (const g of packed ?? [])
        geometryBytes += g.vertices.byteLength + g.indices.byteLength + (g.uvs?.byteLength ?? 0);
      if (geometryBytes > asset.maxBytes * 4)
        throw overBudget('Decoded glTF geometry exceeds byte budget', asset.maxBytes * 4);
      // One element for a primitive that fits one part, the parts otherwise.
      return packed && packed.length === 1 ? packed[0] : packed;
    }),
  );
  decodeExtras(asset);
  // GLTFAsset's accessor cache is private to the package; the worker entry seeds a fresh asset's cache with it.
  return {
    doc,
    buffers: asset.buffers,
    images,
    geometry,
    accessors: [...asset['cache']],
    maxDownloadBytes: asset.maxBytes,
    maxNodes: asset.maxNodes,
    maxPartVertices: asset.partVertices,
  };
}
/** Fetch (url) or parse (input) and prepare a glTF; no decoders (Draco, meshopt, KTX2 need the main-thread path). */
export async function prepareGLTF(
  url: string | URL | undefined,
  input?: string | object | ArrayBuffer | ArrayBufferView,
  buffers?: Array<ArrayBuffer | ArrayBufferView>,
  maxDownloadBytes?: number,
  maxNodes?: number,
  allowedURLs?: readonly string[],
  optimize?: boolean,
  maxPartVertices?: number,
): Promise<PreparedGLTF> {
  const { asset, images, deferred, baseURL, downloadedBytes } = await loadAsset(
    url,
    { buffers, maxDownloadBytes, maxNodes, allowedURLs, optimize, maxPartVertices },
    input,
    {},
    true,
  );
  if (deferred)
    return {
      doc: asset.doc,
      buffers: asset.buffers,
      images,
      geometry: [],
      accessors: [],
      maxDownloadBytes: asset.maxBytes,
      maxNodes: asset.maxNodes,
      maxPartVertices: asset.partVertices,
      deferred,
      baseURL,
      downloadedBytes,
    };
  return prepareAsset(asset, images);
}
