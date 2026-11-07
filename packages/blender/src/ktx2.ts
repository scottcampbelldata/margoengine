// @margoengine/blender/ktx2: .margo scenes whose textures are KTX2 (Basis Universal) instead of PNG, so they download
// smaller and, on an engine created with the texture-compression features, stay compressed on the GPU. compressMargo turns an exported file's PNG sections into KTX2 sections with
// @margoengine/exporters/ktx2 (Node or browser); parseMargoKTX2 transcodes them with @margoengine/decoders' KTX2Decoder
// and draws the scene as parseMargo does. Both codecs load only when called.
import type { EngineKernel } from "@margoengine/core";
import { parsePreparedPBR, type GLTFImage, type PBRModel } from "@margoengine/gltf-pro/model";
import { countLimit } from "../../shared/limits.js";
import { readResponse } from "../../shared/loading.js";
import { decodeImages, maxBytes, readContainer } from "./container.js";
import type { MargoAsset, MargoOptions } from "./index.js";
import { decodeScene } from "./scene.js";

/** A KTX2 transcoder: `KTX2Decoder` of @margoengine/decoders, or anything with its `transcode`. */
export interface MargoKTX2Transcoder {
  transcode(
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<{ width: number; height: number; format: GPUTextureFormat; mipmaps: readonly { data: Uint8Array; width: number; height: number }[] }>;
}
/** Options of compressMargo: the Basis Universal settings of @margoengine/exporters/ktx2's encodeKTX2. */
export interface CompressMargoOptions {
  /** `etc1s` (the default: smallest) or `uastc` (closer to the PNG, larger). */
  mode?: "etc1s" | "uastc";
  /** Mipmaps for every texture (default true). */
  mipmaps?: boolean;
}
/** Options of parseMargoKTX2 and loadMargoKTX2. */
export interface MargoKTX2Options extends MargoOptions {
  /** Rejects with its reason and closes any decoded images. */
  signal?: AbortSignal;
  /** A transcoder to reuse; by default one KTX2Decoder on the engine's device is made and disposed for this file. */
  ktx2?: MargoKTX2Transcoder;
}

/** Texture slots whose images hold colour (sRGB); every other slot holds linear data. */
const colourSlots = new Set(["baseColorTexture", "emissiveTexture", "sheenColorTexture", "specularColorTexture"]),
  normalSlots = new Set(["normalTexture", "clearcoatNormalTexture"]);

/** How each image is sampled: by the material slots that read it (the first one wins). */
function imageUses(doc: Record<string, unknown>): Map<number, "srgb" | "linear" | "normal"> {
  const textures = (doc.textures as { source?: number }[] | undefined) ?? [],
    uses = new Map<number, "srgb" | "linear" | "normal">();
  const visit = (value: unknown, slot: string) => {
    if (!value || typeof value !== "object") return;
    const index = (value as { index?: unknown }).index;
    if (slot.endsWith("Texture") && typeof index === "number") {
      const source = textures[index]?.source;
      if (typeof source === "number" && !uses.has(source))
        uses.set(source, colourSlots.has(slot) ? "srgb" : normalSlots.has(slot) ? "normal" : "linear");
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, key);
  };
  for (const material of (doc.materials as unknown[] | undefined) ?? []) visit(material, "");
  return uses;
}

/** Writes a .margo container: the manifest, then `sections` in order, with header `flags` (FORMAT.md). */
function writeMargo(
  manifest: unknown,
  sections: readonly { type: number; flags: number; bytes: Uint8Array }[],
  flags: number,
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(manifest)),
    all = [{ type: 1, flags: 0, bytes: json }, ...sections],
    pad = (n: number) => (n + 3) & ~3;
  let length = 64 + all.length * 16;
  for (const s of all) length += pad(s.bytes.byteLength);
  if (length > maxBytes || json.byteLength > 1024 * 1024)
    throw new RangeError(".margo exceeds 256 MiB or its 1 MiB manifest after compression; split the scene");
  const out = new Uint8Array(length),
    view = new DataView(out.buffer);
  [0x4f47524d, 1, length, all.length, 64, flags, 80].forEach((v, i) => view.setUint32(i * 4, v, true));
  let at = 64 + all.length * 16;
  all.forEach((s, i) => {
    view.setUint32(64 + i * 16, s.type, true);
    view.setUint32(68 + i * 16, at, true);
    view.setUint32(72 + i * 16, s.bytes.byteLength, true);
    view.setUint32(76 + i * 16, s.flags, true);
    out.set(s.bytes, at);
    at += pad(s.bytes.byteLength);
  });
  return out;
}

/**
 * Returns a copy of a static `.margo` file with every embedded PNG re-encoded as KTX2 (Basis Universal, section type
 * 8): colour textures as sRGB, normal maps as normal maps, metallic-roughness and other data as linear. Geometry and
 * the scene keep their bytes. The file then loads with parseMargoKTX2; loadMargo refuses it by name. Runs in Node or a
 * browser (the encoder loads in a worker there).
 *
 * @example
 * import { readFile, writeFile } from 'node:fs/promises';
 * await writeFile('scene-ktx2.margo', await compressMargo(await readFile('scene.margo')));
 */
export async function compressMargo(
  input: ArrayBuffer | ArrayBufferView,
  { mode = "etc1s", mipmaps = true }: CompressMargoOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { buffer, sections, manifest, flags } = readContainer(input, 0);
  // The checks decodeMargo runs: a file that would not load is not compressed either.
  decodeScene(buffer, sections, manifest, 100_000, true);
  const doc = manifest as Record<string, unknown>,
    images = (doc.images as { section: number; mimeType: string }[] | undefined) ?? [],
    uses = imageUses(doc),
    { encodeKTX2 } = await import("@margoengine/exporters/ktx2"),
    encoded = new Map<number, Uint8Array>();
  for (const [index, image] of images.entries()) {
    if (image.mimeType !== "image/png" || encoded.has(image.section)) continue;
    const use = uses.get(index) ?? "srgb";
    encoded.set(
      image.section,
      await encodeKTX2(new Uint8Array(sections[image.section].bytes), {
        mode,
        mipmaps,
        colorSpace: use === "srgb" ? "srgb" : "linear",
        normalMap: use === "normal",
      }),
    );
  }
  const next = sections.slice(1).map((s, i) => {
    const bytes = encoded.get(i + 1);
    return bytes ? { type: 8, flags: 0, bytes } : { type: s.type, flags: s.flags, bytes: s.bytes };
  });
  const out = {
    ...doc,
    images: images.map((image) => (encoded.has(image.section) ? { ...image, mimeType: "image/ktx2" } : image)),
  };
  return writeMargo(out, next, flags);
}

/**
 * Validates and decodes `.margo` bytes as decodeMargo does, accepting KTX2 images (`images` then holds each image's
 * KTX2 or PNG bytes, in the document's order). No GPU and no transcoder are needed.
 *
 * @example
 * const asset = decodeMargoKTX2(await (await fetch('/scene-ktx2.margo')).arrayBuffer());
 */
export function decodeMargoKTX2(
  input: ArrayBuffer | ArrayBufferView,
  { maxNodes = 100_000 }: MargoOptions = {},
): MargoAsset {
  countLimit("maxNodes", maxNodes);
  const { buffer, sections, manifest } = readContainer(input, 0);
  return decodeScene(buffer, sections, manifest, maxNodes, true);
}

/**
 * Decodes `.margo` bytes with KTX2 textures and attaches the scene to `engine` as a glTF Pro `PBRModel` (WebGPU only):
 * each KTX2 image is transcoded to a compressed format the device has (BC7, ASTC or ETC2, else RGBA8) and uploads with
 * its mipmaps. A device has those formats only when the engine asked for them: create it with
 * `features: ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2']`, or the textures hold
 * RGBA8; PNG images decode as parseMargo decodes them.
 *
 * @example
 * const model = await parseMargoKTX2(engine, await file.arrayBuffer(), { signal });
 */
export async function parseMargoKTX2(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  { signal, maxNodes, ktx2 }: MargoKTX2Options = {},
): Promise<PBRModel> {
  signal?.throwIfAborted();
  const asset = decodeMargoKTX2(input, { maxNodes }),
    kinds = ((asset.document.images ?? []) as { mimeType?: string }[]).map((image) => image.mimeType),
    pngs = asset.images.filter((_, i) => kinds[i] !== "image/ktx2"),
    bitmaps = await decodeImages(pngs, signal);
  let owned: { dispose(): void } | undefined;
  try {
    let transcoder = ktx2;
    if (!transcoder && kinds.includes("image/ktx2")) {
      const { KTX2Decoder } = await import("@margoengine/decoders");
      const decoder = new KTX2Decoder({ device: engine.gpu ?? undefined });
      owned = decoder;
      transcoder = decoder;
    }
    const images: GLTFImage[] = [];
    let next = 0;
    for (const [i, bytes] of asset.images.entries()) {
      signal?.throwIfAborted();
      images.push(kinds[i] === "image/ktx2" ? await transcoder!.transcode(bytes, { signal }) : bitmaps[next++]);
    }
    signal?.throwIfAborted();
    return parsePreparedPBR(engine, asset.document, asset.geometry, images, { maxNodes });
  } catch (error) {
    for (const image of bitmaps) image.close();
    throw error;
  } finally {
    owned?.dispose();
  }
}

/**
 * Fetches a .margo file over HTTP(S) through `fetch` (default `globalThis.fetch`) and parses it like parseMargoKTX2.
 *
 * @example
 * const model = await loadMargoKTX2(engine, '/scene-ktx2.margo', { signal: AbortSignal.timeout(10_000) });
 */
export async function loadMargoKTX2(
  engine: EngineKernel,
  url: string | URL,
  { fetch: get = globalThis.fetch, ...options }: MargoKTX2Options & { fetch?: typeof fetch } = {},
): Promise<PBRModel> {
  options.signal?.throwIfAborted();
  const target = new URL(url, globalThis.location?.href);
  if (!["http:", "https:"].includes(target.protocol))
    throw new TypeError(
      ".margo URL must use HTTP(S); pass an http: or https: URL, or read the file yourself and call parseMargoKTX2",
    );
  const bytes = await readResponse(await get(target, { signal: options.signal }), {
    maxBytes,
    signal: options.signal,
    label: ".margo download",
  });
  return parseMargoKTX2(engine, bytes, options);
}
