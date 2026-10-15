import { loadAsset, type GLTFAsset, type GLTFDocument, type GLTFImage } from './asset.js';
import { decodeExtras, packPrimitive } from './pack.js';
import type { PreparedGeometry } from './index.js';
/** A glTF parsed off the main thread: everything PBRModel needs except GPU uploads. Every buffer is transferable. */
export interface PreparedGLTF {
  doc: GLTFDocument;
  buffers: Uint8Array[];
  images: GLTFImage[];
  /** Packed geometry per mesh and primitive; null where packing failed (the main thread repeats it and reports the error). */
  geometry: (PreparedGeometry | null)[][];
  /** Decoded accessors by index (geometry, skins, morph targets, animation samplers, GPU instancing), as GLTFAsset caches them. */
  accessors: [number, Float32Array][];
  /** The load's `maxDownloadBytes`, so the main thread's asset keeps the same budgets (absent: the default). */
  maxDownloadBytes?: number;
  /** The load's `maxNodes` (absent: the default). */
  maxNodes?: number;
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
  const geometry = (doc.meshes ?? []).map((mesh: any) =>
    (Array.isArray(mesh?.primitives) ? mesh.primitives : []).map((p: any) => attempt(() => packPrimitive(asset, p))),
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
): Promise<PreparedGLTF> {
  const { asset, images } = await loadAsset(url, { buffers, maxDownloadBytes, maxNodes, allowedURLs }, input);
  return prepareAsset(asset, images);
}
