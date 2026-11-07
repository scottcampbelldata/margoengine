import { decodeImages, maxBytes, readContainer } from "./container.js";
import { countLimit } from "../../shared/limits.js";
import { decodeScene } from "./scene.js";
import type { EngineKernel } from "@margoengine/core";
import {
  parsePreparedPBR,
  type GLTFDocument,
  type PBRModel,
  type PreparedGeometry,
} from "@margoengine/gltf-pro/model";
import { readResponse } from "../../shared/loading.js";

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
  const { buffer, sections, manifest } = readContainer(input, 0);
  return decodeScene(buffer, sections, manifest, maxNodes);
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
