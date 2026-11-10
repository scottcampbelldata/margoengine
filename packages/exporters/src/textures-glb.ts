import { MargoError } from '@margoengine/math/errors';
import { splitGLB, joinGLB } from './glb.js';
import { addView, packGLB, useExtension, type JSONObject } from './glb-pack.js';
import { encodeTexture, type EncodeTextureOptions, type TextureFormat } from './textures.js';
import type { RGBAImage } from './ktx2-encode.js';

/** GLB texture processing settings. Material usage determines sRGB versus linear filtering. */
export interface TransformTexturesOptions extends Omit<EncodeTextureOptions, 'colorSpace' | 'premultiplyAlpha'> {
  /** Embed a resized PNG/JPEG core source alongside WebP/AVIF. Default false, making the extension required. */
  fallback?: 'png' | 'jpeg';
  /** Resolve external image URIs. Default rejects external images rather than fetching without consent. */
  resolveImage?: (uri: string, signal?: AbortSignal) => Promise<Uint8Array>;
}

/** A processed GLB and number of texture/colour-space pairs encoded. */
export interface TransformTexturesResult {
  glb: Uint8Array;
  transformed: number;
}

const FORMATS: Record<string, TextureFormat> = { EXT_texture_webp: 'webp', EXT_texture_avif: 'avif' };
const IMAGE_EXTENSIONS = [...Object.keys(FORMATS), 'KHR_texture_basisu', 'MSFT_texture_dds'];
const COLOR_FIELDS = /^(baseColor|emissive|diffuse|specularGlossiness|specularColor|sheenColor|diffuseTransmissionColor)Texture$/;

function references(object: JSONObject, visit: (info: JSONObject, color: boolean) => void): void {
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (key === 'extras' || !value || typeof value !== 'object') continue;
    if (key.endsWith('Texture') && Number.isInteger(value.index)) visit(value, COLOR_FIELDS.test(key));
    else references(value, visit);
  }
}

async function bytesOf(image: JSONObject, json: JSONObject, bin: Uint8Array | null, options: TransformTexturesOptions): Promise<Uint8Array> {
  if (image.bufferView !== undefined) {
    const view = json.bufferViews?.[image.bufferView], offset = view?.byteOffset ?? 0;
    if (!view || view.buffer !== 0 || !bin || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 || offset + view.byteLength > bin.length)
      throw new RangeError('Texture image bufferView is outside the GLB; repair the embedded image range');
    return bin.slice(offset, offset + view.byteLength);
  }
  const uri = image.uri;
  if (typeof uri !== 'string') throw new TypeError('Texture image has no source; supply a bufferView or URI');
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new TypeError('Texture data URI is malformed; supply a complete data URI');
    return uri.slice(0, comma).endsWith(';base64') ? Uint8Array.from(atob(uri.slice(comma + 1)), c => c.charCodeAt(0)) : Uint8Array.from(decodeURIComponent(uri.slice(comma + 1)), c => c.charCodeAt(0));
  }
  if (!options.resolveImage)
    throw new MargoError('unsupported', `External texture ${uri} needs resolveImage; supply a URI resolver. https://margoengine.com/docs/exporters#textures`);
  return options.resolveImage(uri, options.signal);
}

function compactImages(json: JSONObject): void {
  const holders: JSONObject[] = [];
  for (const texture of json.textures ?? []) {
    holders.push(texture);
    for (const value of Object.values(texture.extensions ?? {}))
      if (value && typeof value === 'object') holders.push(value as JSONObject);
  }
  const live = new Set(holders.map(holder => holder.source)), remap = new Map<number, number>();
  json.images = (json.images ?? []).filter((_: unknown, i: number) => {
    if (!live.has(i)) return false;
    remap.set(i, remap.size);
    return true;
  });
  for (const holder of holders) if (holder.source !== undefined) holder.source = remap.get(holder.source);
}

/**
 * Resizes and re-encodes GLB images. Shared colour/data textures split so each uses the correct transfer function.
 * Image bytes are embedded, obsolete images removed, samplers/material metadata and unknown GLB chunks retained.
 * @throws MargoError for an unavailable platform format or unresolved URI; use a supported encoder or resolver.
 * @throws RangeError for malformed image references or options; repair the input or use documented settings.
 */
export async function transformTextures(glb: Uint8Array, options: TransformTexturesOptions = {}): Promise<TransformTexturesResult> {
  options.signal?.throwIfAborted();
  if (options.fallback !== undefined && options.fallback !== 'png' && options.fallback !== 'jpeg')
    throw new RangeError('Texture fallback must be png or jpeg; choose a core glTF image format');
  const parts = splitGLB(glb), json = parts.json as JSONObject, textures: JSONObject[] = json.textures ?? [];
  const roles = new Map<number, Map<boolean, JSONObject[]>>();
  for (const material of json.materials ?? []) references(material, (info, color) => {
    let group = roles.get(info.index);
    if (!group) roles.set(info.index, group = new Map());
    const list = group.get(color) ?? [];
    list.push(info);
    group.set(color, list);
  });
  const views = new Map<number, Uint8Array>();
  const encoded = new Map<string, { source: number; fallback?: number }>();
  const decoded = new Map<number, RGBAImage>();
  const format = options.format ?? 'webp', extension = Object.keys(FORMATS).find(name => FORMATS[name] === format);
  let transformed = 0;
  const count = textures.length;
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted();
    const texture = textures[i];
    const source = texture.source ?? IMAGE_EXTENSIONS.map(name => texture.extensions?.[name]?.source).find(index => index !== undefined);
    if (source === undefined) continue; // A sampler-only texture is valid glTF.
    const image = json.images?.[source];
    if (!image) throw new RangeError(`Texture ${i} image ${source} does not exist; repair the image reference`);
    if (json.buffers?.[0]?.uri !== undefined)
      throw new RangeError('Texture output needs an embedded first GLB buffer; embed buffer 0 before processing');
    const group = roles.get(i) ?? new Map([[true, []]]);
    let first = true;
    for (const [color, infos] of group) {
      const target = first ? texture : structuredClone(texture);
      if (!first) {
        textures.push(target);
        for (const info of infos) info.index = textures.length - 1;
      }
      first = false;
      const key = `${source}:${color}`;
      let result = encoded.get(key);
      if (!result) {
        let pixels = decoded.get(source);
        if (!pixels) {
          const bytes = await bytesOf(image, json, parts.bin, options);
          pixels = await (await import('./texture-decode.js')).decodeTexture(bytes, options.signal);
          decoded.set(source, pixels);
        }
        const settings = { ...options, colorSpace: color ? 'srgb' as const : 'linear' as const };
        const output = await encodeTexture(pixels, settings);
        const store = (data: Uint8Array, mimeType: string): number => {
          const index = json.images.length;
          const stored = { ...image, mimeType, bufferView: addView(json, views, data) };
          delete stored.uri;
          json.images.push(stored);
          return index;
        };
        result = { source: store(output.data, output.mimeType) };
        if (extension && options.fallback) {
          const fallback = await encodeTexture(pixels, { ...settings, format: options.fallback });
          result.fallback = store(fallback.data, fallback.mimeType);
        }
        encoded.set(key, result);
      }
      for (const name of IMAGE_EXTENSIONS) delete target.extensions?.[name];
      if (extension) {
        target.extensions = { ...target.extensions, [extension]: { source: result.source } };
        if (result.fallback === undefined) delete target.source;
        else target.source = result.fallback;
      } else target.source = result.source;
      if (target.extensions && !Object.keys(target.extensions).length) delete target.extensions;
      transformed++;
    }
  }
  if (!transformed) return { glb, transformed };
  compactImages(json);
  for (const name of IMAGE_EXTENSIONS) {
    const readers = textures.filter(texture => texture.extensions?.[name]);
    for (const key of ['extensionsUsed', 'extensionsRequired'])
      if (json[key]) json[key] = json[key].filter((value: string) => value !== name);
    if (readers.length) useExtension(json, name, readers.some(texture => texture.source === undefined));
  }
  for (const key of ['extensionsUsed', 'extensionsRequired']) if (!json[key]?.length) delete json[key];
  json.buffers ??= [{ byteLength: 0 }];
  json.buffers[0] ??= { byteLength: 0 };
  options.signal?.throwIfAborted();
  return { glb: joinGLB(packGLB(parts, views)), transformed };
}
