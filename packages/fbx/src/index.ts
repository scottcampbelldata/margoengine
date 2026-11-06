import type { EngineKernel } from '@margoengine/core';
import { parseGLTF, type PBRModel } from '@margoengine/gltf-pro';
import { readResponse } from '../../shared/loading.js';
import { convert } from './convert.js';
import type { FBXExtension } from './extension.js';
export type { FBXExtension } from './extension.js';
/**
 * Options of the FBX functions: where to resolve texture paths, an AbortSignal, a custom fetch and an allow-list of URLs the file may reference.
 */
export interface FBXOptions {
  resourcePath?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  allowedURLs?: readonly string[];
  /** Optional parts of the import, from this package's entries, such as `sceneExtras`. Default none. */
  extensions?: readonly FBXExtension[];
}
const budget = 64 * 1024 * 1024;

/** Converts native binary or ASCII FBX through Margo's first-party glTF writer. */
export async function convertFBX(
  input: ArrayBuffer | ArrayBufferView,
  { resourcePath = '', signal, fetch: get, allowedURLs, extensions }: FBXOptions = {},
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (
    (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) ||
    input.byteLength < 32 ||
    input.byteLength > budget
  )
    throw new RangeError('Invalid FBX byte budget; pass a 32 byte to 64 MiB FBX file');
  if (resourcePath && !['http:', 'https:'].includes(new URL(resourcePath, globalThis.location?.href).protocol))
    throw new TypeError('FBX resources need HTTP(S)');
  return convert(input, resourcePath, signal, { fetch: get, allowedURLs, extensions });
}

/**
 * Converts FBX bytes and uploads the result as a PBRModel. @throws RangeError when the file exceeds an import limit; TypeError for unsupported features. Aborts with `options.signal`.
 */
export async function parseFBX(
  engine: EngineKernel,
  input: ArrayBuffer | ArrayBufferView,
  options: FBXOptions = {},
): Promise<PBRModel> {
  const glb = await convertFBX(input, options),
    view = new DataView(glb),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))),
    images: ImageBitmap[] = [];
  const binaryStart = 28 + jsonLength;
  try {
    let pixels = 0;
    for (const image of doc.images ?? []) {
      options.signal?.throwIfAborted();
      const source = doc.bufferViews[image.bufferView];
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(glb, binaryStart + (source.byteOffset ?? 0), source.byteLength)], {
          type: image.mimeType,
        }),
        { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
      );
      images.push(bitmap);
      pixels += bitmap.width * bitmap.height;
      if (pixels > 16_000_000)
        throw new RangeError(
          'FBX texture pixel budget exceeded; simplify or split the scene, the import limits are listed in the README',
        );
    }
    options.signal?.throwIfAborted();
    return parseGLTF(engine, glb, [], images);
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}
/**
 * Fetches an HTTP(S) FBX file and parses it into a PBRModel; texture paths resolve against the final response URL. Aborts with `options.signal`.
 */
export async function loadFBX(engine: EngineKernel, url: string | URL, options: FBXOptions = {}): Promise<PBRModel> {
  const target = new URL(url, globalThis.location?.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('FBX URL needs HTTP(S)');
  const response = await (options.fetch ?? fetch)(target, { signal: options.signal }),
    bytes = await readResponse(response, { maxBytes: budget, signal: options.signal, label: 'FBX' });
  return parseFBX(engine, bytes, {
    ...options,
    resourcePath: options.resourcePath ?? new URL('.', response.url || target).href,
  });
}
