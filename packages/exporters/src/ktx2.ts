// encodeKTX2 and compressTextures: pixels or a GLB in, Basis Universal KTX2 out, so a texture stays compressed on the GPU
// as well as on the wire. The clean-room Rust/Wasm encoder loads on the first call, so an app that never compresses
// never fetches it.
import { encoderFile, inProcess, inWorker, loadInNode, type EncoderRequest, type ModuleBox } from './encoder-host.js';
import { joinGLB, splitGLB } from './glb.js';
import { addView, packGLB, useExtension, type JSONObject, type NewViews } from './glb-pack.js';
import type { BasisEncoderModule, BasisJob, BasisResult, KTX2Mode, RGBAImage } from './ktx2-encode.js';

export type { KTX2Mode, RGBAImage } from './ktx2-encode.js';

const EXTENSION = 'KHR_texture_basisu';

/** Encoder settings shared by {@link encodeKTX2} and {@link compressTextures}. */
export interface KTX2EncoderOptions {
  /** ETC1S quality, from 1 to 255. Higher is larger and closer to the source. Default 128. */
  quality?: number;
  /** ETC1S encoder effort, from 0 to 6. Default 2. */
  effort?: number;
  /** UASTC encoder level, from 0, the fastest, to 4, the closest to the source. Default 2. */
  uastcLevel?: number;
  /** UASTC rate-distortion pass, from 0, off, to 10. Higher is smaller on the wire and further from the source. Default 0. */
  uastcRDO?: number;
  /** Optional compatibility override holding external basis_encoder.js and basis_encoder.wasm. Unset uses Margo's lazy encoder. */
  encoderPath?: string;
  /** Stops the encode. A browser ends the worker at once; Node stops between images. */
  signal?: AbortSignal;
}

/** Options for {@link encodeKTX2}. */
export interface EncodeKTX2Options extends KTX2EncoderOptions {
  /** `'etc1s'` is the smallest; `'uastc'` keeps more detail in about twice the bytes. Default `'etc1s'`. */
  mode?: KTX2Mode;
  /** `'srgb'` for colour, `'linear'` for data such as roughness. Default `'srgb'`. */
  colorSpace?: 'srgb' | 'linear';
  /** Treats the image as a tangent-space normal map: linear, and its mips renormalized. Default false. */
  normalMap?: boolean;
  /** Writes a full mip chain. Default true. */
  mipmaps?: boolean;
}

/** Options for {@link compressTextures}. */
export interface CompressTexturesOptions extends KTX2EncoderOptions {
  /** Format of colour textures: base colour, emissive, specular colour, sheen colour. Default `'etc1s'`. */
  color?: KTX2Mode;
  /** Format of data textures: metallic-roughness, occlusion and the like. Default `'uastc'`. */
  data?: KTX2Mode;
  /** Format of normal maps. Default `'uastc'`: block artefacts in a normal map show as bumps. */
  normal?: KTX2Mode;
}

/** A texture {@link compressTextures} left as it was, and why. */
export interface KTX2SkippedTexture {
  /** Index in `textures`. */
  texture: number;
  reason: 'not-on-a-material' | 'already-compressed' | 'other-image-extension' | 'external-image' | 'not-png-or-jpeg';
}

/** What {@link compressTextures} returns. */
export interface CompressTexturesResult {
  /** The file with KTX2 images. The input bytes when no texture could be compressed. */
  glb: Uint8Array;
  /** Textures that now read a KTX2 image. A texture used as both colour and data counts once for each. */
  compressed: number;
  /** Textures left uncompressed. */
  skipped: KTX2SkippedTexture[];
}

function whole(value: number, name: string, low: number, high: number): number {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new RangeError(`KTX2 ${name} must be a whole number from ${low} to ${high}`);
  return value;
}

function mode(value: unknown, name: string): KTX2Mode {
  if (value !== 'etc1s' && value !== 'uastc') throw new RangeError(`KTX2 ${name} must be 'etc1s' or 'uastc'`);
  return value;
}

type Settings = Pick<BasisJob, 'quality' | 'effort' | 'uastcLevel' | 'uastcRDO'>;

const settingsOf = ({ quality = 128, effort = 2, uastcLevel = 2, uastcRDO = 0 }: KTX2EncoderOptions): Settings => {
  if (!(uastcRDO >= 0 && uastcRDO <= 10)) throw new RangeError('KTX2 uastcRDO must be from 0 to 10');
  return {
    quality: whole(quality, 'quality', 1, 255),
    effort: whole(effort, 'effort', 0, 6),
    uastcLevel: whole(uastcLevel, 'uastcLevel', 0, 4),
    uastcRDO,
  };
};

let native: Promise<import('./basis-native.js').NativeBasis> | undefined;

// Basis prints each encode's statistics otherwise.
const silent = { print() {}, printErr() {} };

async function encode(jobs: BasisJob[], options: KTX2EncoderOptions): Promise<BasisResult[]> {
  if (options.encoderPath === undefined) {
    const wasm = new URL('./basis-encoder/margo_basis_encoder.wasm', import.meta.url);
    if (typeof Worker === 'undefined') {
      const implementation = await import('./basis-native.js');
      native ??= implementation.loadNativeBasis(wasm).catch((error) => {
        native = undefined;
        throw error;
      });
      const api = await native;
      return inProcess(jobs, (job) => implementation.encodeNativeBasis(api, job), options.signal);
    }
    return inWorker<BasisResult>(
      jobs.map((job) => ({ kind: 'basis-native', wrapperURL: '', wasmURL: wasm.href, job })),
      (request) => {
        const { source } = request.job as BasisJob;
        return [(source instanceof Uint8Array ? source : source.data).buffer as ArrayBuffer];
      },
      options.signal,
    );
  }
  const { encoderPath, signal } = options,
    wrapper = encoderFile(encoderPath, 'basis_encoder.js'),
    wasm = encoderFile(encoderPath, 'basis_encoder.wasm');
  if (typeof Worker === 'undefined') {
    const start = (): Promise<ModuleBox<BasisEncoderModule>> => loadInNode<BasisEncoderModule>(wrapper, wasm, silent),
      [{ module }, { encodeBasis }] = await Promise.all([start(), import('./ktx2-encode.js')]);
    return inProcess(jobs, (job) => encodeBasis(module, job), signal);
  }
  return inWorker<BasisResult>(
    jobs.map((job) => ({ kind: 'basis', wrapperURL: wrapper.href, wasmURL: wasm.href, job })),
    (request: EncoderRequest) => {
      const { source } = request.job as BasisJob;
      return [(source instanceof Uint8Array ? source : source.data).buffer as ArrayBuffer];
    },
    signal,
  );
}

/**
 * Encodes one image to a .ktx2 file: a PNG or JPEG file's bytes, or RGBA8 pixels. Runs in a worker in a browser and in
 * process in Node; the caller's bytes are copied, so they stay usable.
 *
 * @example
 * ```ts
 * import { encodeKTX2 } from '@margoengine/exporters/ktx2';
 *
 * const data = new Uint8Array(64 * 64 * 4).fill(200);
 * const file = await encodeKTX2({ width: 64, height: 64, data }, { mode: 'uastc' });
 * ```
 *
 * @throws RangeError when an option is out of range or `data` does not match the size.
 * @throws TypeError when `source` is neither a PNG, a JPEG nor pixels.
 * @throws What the image readers throw for a damaged file, and the signal's reason on an abort.
 */
export async function encodeKTX2(source: Uint8Array | RGBAImage, options: EncodeKTX2Options = {}): Promise<Uint8Array> {
  const { mode: format = 'etc1s', colorSpace = 'srgb', normalMap = false, mipmaps = true } = options;
  if (colorSpace !== 'srgb' && colorSpace !== 'linear')
    throw new RangeError("KTX2 colorSpace must be 'srgb' or 'linear'");
  const srgb = colorSpace === 'srgb' && !normalMap;
  let copy: BasisJob['source'];
  if (source instanceof Uint8Array) copy = source.slice();
  else {
    const { width, height, data } = source;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new RangeError('KTX2 image width and height must be whole numbers from 1');
    if (data?.length !== width * height * 4)
      throw new RangeError(`KTX2 pixels must be ${width * height * 4} bytes of RGBA8 for ${width} x ${height}`);
    copy = { width, height, data: data.slice() };
  }
  const job: BasisJob = {
      source: copy,
      mode: mode(format, 'mode'),
      srgb,
      normalMap: Boolean(normalMap),
      mipmaps: Boolean(mipmaps),
      wholeBlocks: false,
      ...settingsOf(options),
    },
    [result] = await encode([job], options);
  return result.data;
}

type Role = 'color' | 'data' | 'normal';

const COLOR = new Set([
  'baseColorTexture',
  'emissiveTexture',
  'diffuseTexture',
  'specularGlossinessTexture',
  'specularColorTexture',
  'sheenColorTexture',
  'diffuseTransmissionColorTexture',
]);
const NORMAL = new Set(['normalTexture', 'clearcoatNormalTexture']);

const roleOf = (key: string): Role => (COLOR.has(key) ? 'color' : NORMAL.has(key) ? 'normal' : 'data');

/** Calls `visit` on every texture reference in `value`, a material or part of one, with the field that holds it. */
function eachTextureInfo(value: unknown, visit: (info: JSONObject, field: string) => void): void {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, field] of Object.entries(value)) {
    if (key === 'extras' || typeof field !== 'object' || field === null) continue;
    if (key.endsWith('Texture') && Number.isSafeInteger((field as JSONObject).index)) visit(field as JSONObject, key);
    eachTextureInfo(field, visit);
  }
}

/** The bytes of an image inside the file, or undefined for one in an outside file. */
function imageBytes(json: JSONObject, bin: Uint8Array | null, image: JSONObject): Uint8Array | undefined {
  if (Number.isSafeInteger(image.bufferView)) {
    const view = json.bufferViews?.[image.bufferView],
      start = view?.byteOffset ?? 0;
    if (!view || view.buffer !== 0 || !bin || start + view.byteLength > bin.length)
      throw new RangeError(`glTF image buffer view ${image.bufferView} is outside the BIN chunk; repair the GLB`);
    return bin.slice(start, start + view.byteLength);
  }
  const data = /^data:[^,]*;base64,/.exec(image.uri ?? '');
  if (!data) return undefined;
  return Uint8Array.from(atob((image.uri as string).slice(data[0].length)), (c) => c.charCodeAt(0));
}

const isPNGOrJPEG = (bytes: Uint8Array): boolean =>
  (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff);

/** The glTF extensions whose images this reads: a decoder turns them into pixels, and the KTX2 image takes their place. */
const HELD_IN = ['EXT_texture_webp', 'EXT_texture_avif', 'MSFT_texture_dds'];

/** Drops images no texture reads any more and renumbers the rest. */
function dropUnusedImages(json: JSONObject): void {
  const sources = (texture: JSONObject): JSONObject[] => [
      texture,
      ...Object.values<JSONObject>(texture.extensions ?? {}).filter((field) => Number.isSafeInteger(field?.source)),
    ],
    used = new Set<number>();
  for (const texture of json.textures)
    for (const holder of sources(texture)) if (holder.source !== undefined) used.add(holder.source);
  const renumbered = new Map<number, number>(),
    kept: JSONObject[] = [];
  (json.images as JSONObject[]).forEach((image, index) => {
    if (!used.has(index)) return;
    renumbered.set(index, kept.length);
    kept.push(image);
  });
  json.images = kept;
  for (const texture of json.textures)
    for (const holder of sources(texture))
      if (holder.source !== undefined) holder.source = renumbered.get(holder.source);
}

/**
 * Stores the textures of a GLB as KTX2 images (`KHR_texture_basisu`): colour as ETC1S, normal maps and data as UASTC, each
 * with a full mip chain. The role of a texture comes from the material fields that read it; a texture read in two roles
 * is split in two. Images held in WebP or DDS (`EXT_texture_webp`, `MSFT_texture_dds`) are decoded first. The source images
 * leave the file, so the extension becomes required.
 *
 * @example
 * ```ts
 * import { exportGLB } from '@margoengine/exporters';
 * import { compressTextures } from '@margoengine/exporters/ktx2';
 *
 * declare const source: Parameters<typeof exportGLB>[0];
 * const { glb, compressed, skipped } = await compressTextures(exportGLB(source));
 * ```
 *
 * @throws RangeError when an option is out of range or a buffer view of an image is damaged.
 * @throws What {@link splitGLB} throws for bytes that are no GLB, what the image readers throw for a damaged image, and
 * the signal's reason on an abort.
 */
export async function compressTextures(
  glb: Uint8Array,
  options: CompressTexturesOptions = {},
): Promise<CompressTexturesResult> {
  const formats: Record<Role, KTX2Mode> = {
      color: mode(options.color ?? 'etc1s', 'color'),
      data: mode(options.data ?? 'uastc', 'data'),
      normal: mode(options.normal ?? 'uastc', 'normal'),
    },
    settings = settingsOf(options),
    parts = splitGLB(glb),
    json = parts.json as JSONObject,
    skipped: KTX2SkippedTexture[] = [],
    references = new Map<number, Map<Role, JSONObject[]>>();
  for (const material of json.materials ?? [])
    eachTextureInfo(material, (info, field) => {
      const roles = references.get(info.index) ?? new Map<Role, JSONObject[]>(),
        role = roleOf(field);
      references.set(info.index, roles);
      roles.set(role, [...(roles.get(role) ?? []), info]);
    });

  // Pixels of each decoded image, once, however many textures read it.
  const pixelsOf = new Map<number, Promise<RGBAImage>>(),
    decoded = (image: number, bytes: Uint8Array, signal?: AbortSignal): Promise<RGBAImage> => {
      let pixels = pixelsOf.get(image);
      if (!pixels) {
        pixels = import('@margoengine/decoders/image').then(({ decodeImage }) => decodeImage(bytes, { signal }));
        pixelsOf.set(image, pixels);
      }
      return pixels;
    },
    canDecode = async (bytes: Uint8Array): Promise<boolean> => {
      const format = (await import('@margoengine/decoders/image')).imageFormat(bytes);
      return format === 'webp' || format === 'dds';
    };

  // One job for each image in each role, however many textures read it.
  const jobs = new Map<string, { job: BasisJob; name?: string; textures: JSONObject[] }>(),
    textures: JSONObject[] = json.textures ?? [];
  let compressed = 0;
  const count = textures.length;
  for (let index = 0; index < count; index++) {
    const texture = textures[index],
      roles = references.get(index),
      extensions = Object.keys(texture.extensions ?? {}),
      skip = (reason: KTX2SkippedTexture['reason']): void => void skipped.push({ texture: index, reason });
    if (extensions.includes(EXTENSION)) skip('already-compressed');
    else if (!roles) skip('not-on-a-material');
    else if (extensions.some((name) => /^(EXT|MSFT)_texture_/.test(name) && !HELD_IN.includes(name)))
      skip('other-image-extension');
    else if (texture.source === undefined && !extensions.some((name) => HELD_IN.includes(name)))
      skip('other-image-extension');
    else {
      // A plain PNG or JPEG fallback needs no decoding, so it goes first.
      const held = [texture.source, ...HELD_IN.map((name) => texture.extensions?.[name]?.source)].filter(
          (source) => source !== undefined,
        ),
        images = held.map((source) => {
          const image = json.images?.[source];
          if (!image)
            throw new RangeError(`glTF texture ${index} reads image ${source}, which does not exist; repair the GLB`);
          return { source, image, bytes: imageBytes(json, parts.bin, image) };
        }),
        stored = images.filter(({ bytes }) => bytes),
        {
          source: imageIndex,
          image,
          bytes,
        } = stored.find(({ bytes }) => isPNGOrJPEG(bytes!)) ?? stored[0] ?? images[0];
      const readable = bytes && (isPNGOrJPEG(bytes) || (await canDecode(bytes)));
      if (!bytes) skip('external-image');
      else if (!readable) skip('not-png-or-jpeg');
      else {
        const pixels = isPNGOrJPEG(bytes) ? bytes.slice() : await decoded(imageIndex, bytes, options.signal);
        let first = true;
        for (const [role, infos] of roles) {
          // The first role keeps this texture; each other role gets a copy, which comes after every original.
          let target = texture;
          if (!first) {
            target = structuredClone(texture);
            textures.push(target);
            for (const info of infos) info.index = textures.length - 1;
          }
          first = false;
          const key = `${imageIndex} ${role}`,
            planned = jobs.get(key);
          if (planned) planned.textures.push(target);
          else
            jobs.set(key, {
              name: image.name,
              textures: [target],
              job: {
                source: pixels,
                mode: formats[role],
                srgb: role === 'color',
                normalMap: role === 'normal',
                mipmaps: true,
                wholeBlocks: true,
                ...settings,
              },
            });
          compressed++;
        }
      }
    }
  }
  if (!jobs.size) return { glb, compressed: 0, skipped };

  const entries = [...jobs.values()],
    results = await encode(
      entries.map(({ job }) => job),
      options,
    ),
    views: NewViews = new Map();
  json.buffers ??= [];
  json.buffers[0] ??= { byteLength: 0 };
  if (json.buffers[0].uri !== undefined)
    throw new RangeError(
      'A GLB whose first buffer is an outside file has no BIN chunk to take KTX2 images; embed the buffer first',
    );
  entries.forEach(({ name, textures: readers }, i) => {
    const bufferView = addView(json, views, results[i].data),
      source = json.images.length;
    json.images.push({ ...(name === undefined ? {} : { name }), bufferView, mimeType: 'image/ktx2' });
    for (const texture of readers) {
      delete texture.source;
      for (const held of HELD_IN) delete texture.extensions?.[held];
      texture.extensions = { ...texture.extensions, [EXTENSION]: { source } };
    }
  });
  dropUnusedImages(json);
  for (const held of HELD_IN)
    if (!textures.some((texture) => texture.extensions?.[held])) {
      json.extensionsUsed = json.extensionsUsed?.filter((name: string) => name !== held);
      json.extensionsRequired = json.extensionsRequired?.filter((name: string) => name !== held);
    }
  if (!json.extensionsRequired?.length) delete json.extensionsRequired;
  useExtension(json, EXTENSION, true);
  return { glb: joinGLB(packGLB(parts, views)), compressed, skipped };
}
