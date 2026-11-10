// @margoengine/blender/pbr-ext: a static .margo scene drawn with glTF Pro's physical material shader, so the
// Principled BSDF's transmission, IOR, coat, sheen and subsurface that the add-on writes as glTF material extensions
// (KHR_materials_transmission, _ior, _clearcoat, _sheen, _diffuse_transmission, _volume and _volume_scatter) draw as
// authored. `loadMargo` keeps the plain PBR shader and ignores them; this entry pulls in the physical shader's WGSL
// only for apps that import it.
import type { EngineKernel } from "@margoengine/core";
import { GLTFAsset, PBRModel } from "@margoengine/gltf-pro/model";
import { readResponse } from "../../shared/loading.js";
import { decodeImages, maxBytes } from "./container.js";
import { decodeMargo, type MargoOptions } from "./index.js";

/** The glTF material extensions the Blender add-on writes for the Principled BSDF, in its manifest's `extensionsUsed`. */
export const margoMaterialExtensions = [
  "KHR_materials_clearcoat",
  "KHR_materials_diffuse_transmission",
  "KHR_materials_ior",
  "KHR_materials_sheen",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_volume_scatter",
] as const;

/** Options of parseMargoPBR and loadMargoPBR. */
export interface MargoPBROptions extends MargoOptions {
  /** Rejects with its reason and closes any decoded images. */
  signal?: AbortSignal;
}

/**
 * Decodes `.margo` bytes and attaches the scene to `engine` as a glTF Pro `PBRModel` drawn with the physical material
 * shader (`@margoengine/gltf-pro/extended`), which reads the extensions in margoMaterialExtensions. A scene without
 * them draws as with parseMargo. WebGPU only.
 *
 * @example
 * const model = await parseMargoPBR(engine, await file.arrayBuffer(), { signal });
 */
export async function parseMargoPBR(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes }: MargoPBROptions = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const asset = decodeMargo(input, { maxNodes });
  // Both settle before either error is thrown: images decoded while the shader import fails must still be closed.
  const [shader, decoded] = await Promise.allSettled([
    import("@margoengine/gltf-pro/extended"),
    decodeImages(asset.images, signal),
  ]);
  if (shader.status === "rejected") {
    if (decoded.status === "fulfilled") for (const image of decoded.value) image.close();
    throw shader.reason;
  }
  // decodeImages closes what it decoded before it rejects.
  if (decoded.status === "rejected") throw decoded.reason;
  const { extendedMaterials } = shader.value;
  const images = decoded.value;
  let model: PBRModel | undefined;
  try {
    signal?.throwIfAborted();
    const gltf = new GLTFAsset(asset.document, [], undefined, { materials: extendedMaterials }, undefined, maxNodes);
    model = new PBRModel(engine, gltf, images, asset.geometry);
    engine.use(model);
    return model;
  } catch (error) {
    model?.dispose();
    for (const image of images) image.close();
    throw error;
  }
}

/**
 * Fetches a .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and parses it like parseMargoPBR.
 *
 * @example
 * const model = await loadMargoPBR(engine, '/glass.margo', { signal: AbortSignal.timeout(10_000) });
 */
export async function loadMargoPBR(
  engine: EngineKernel,
  url: string | URL,
  { fetch: get = globalThis.fetch, ...options }: MargoPBROptions & { fetch?: typeof fetch } = {},
): Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargoPBR",
    );
  const bytes = await readResponse(await get(target, { signal: options.signal }), {
    maxBytes,
    signal: options.signal,
    label: ".margo download",
  });
  return parseMargoPBR(engine, bytes, options);
}
