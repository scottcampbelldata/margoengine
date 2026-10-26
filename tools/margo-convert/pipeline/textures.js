// @ts-check
// Texture handling for margo-convert: sizes, resizing, PNG writing, mip chains and the model texture pass.
//
// `sharp` (libvips) does the resizing and the WebP, AVIF and JPEG encoding when the project has it installed; nothing
// is downloaded and it is never required. Without it PNG textures are resized with the area filter below and
// rewritten with node:zlib, and other formats are left as they are (Node has no WebP, AVIF or JPEG encoder).
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePNG } from '@margoengine/decoders/png';
import { eachTextureInfo, imagesOf } from './passes.js';

/** @typedef {any} Sharp the `sharp` module's default export (typed loosely: it is an optional tool) */
/** @typedef {import('./presets.js').TexturePreset} TexturePreset */
/** @typedef {'color'|'data'|'normal'} Role */

/** @type {Promise<Sharp|null>|undefined} */
let sharpPromise;

/**
 * The `sharp` module if it is installed, otherwise null. Looked up once: first where this package can see it, then in
 * the project the command runs in (`npx margo-convert` runs from a cache folder that cannot see the project's modules).
 * @returns {Promise<Sharp|null>}
 */
export function loadSharp() {
  sharpPromise ??= (async () => {
    for (const find of [
      () => import('sharp'),
      () => import(pathToFileURL(createRequire(join(process.cwd(), 'noop.js')).resolve('sharp')).href),
    ]) {
      try {
        const module = await find();
        return module.default ?? module;
      } catch {
        // not installed there
      }
    }
    return null;
  })();
  return sharpPromise;
}

/**
 * The size an image is scaled to: never larger than it is, at most `maxSize` on the long side, rounded down to a power
 * of two or a multiple of `multipleOf` as the preset asks. Aspect ratio is kept as far as rounding allows.
 * @param {number} width @param {number} height @param {TexturePreset} preset
 * @returns {{width: number, height: number}}
 */
export function targetSize(width, height, preset) {
  const scale = Math.min(1, preset.maxSize / Math.max(width, height));
  const fit = (/** @type {number} */ n) => {
    let v = Math.max(1, Math.round(n * scale));
    if (preset.powerOfTwo === 'down') v = 2 ** Math.floor(Math.log2(v));
    else if (preset.multipleOf > 1 && v >= preset.multipleOf) v -= v % preset.multipleOf;
    return Math.min(v, n);
  };
  return { width: fit(width), height: fit(height) };
}

// ------------------------------------------------------------------------------------------------ pixels

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** @param {number} v linear 0..1 @returns {number} sRGB 0..255 */
const toSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/**
 * Scales RGBA8 pixels to `nw` x `nh` by area averaging (every source pixel contributes to the output pixels it
 * overlaps in proportion to the overlap), separably. Colour is averaged in linear light and weighted by alpha when
 * `color` is true; data maps are averaged as stored.
 * @param {Uint8Array} src @param {number} w @param {number} h @param {number} nw @param {number} nh @param {boolean} color
 * @returns {Uint8Array}
 */
export function resizeArea(src, w, h, nw, nh, color) {
  // Premultiplied float working copy: rgb in the averaging space, alpha 0..1.
  const f = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = src[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++)
      f[i * 4 + k] = (color ? SRGB_TO_LINEAR[src[i * 4 + k]] : src[i * 4 + k] / 255) * (color ? a : 1);
    f[i * 4 + 3] = a;
  }
  /** @param {Float32Array} from @param {number} fw @param {number} fh @param {number} tw @param {number} th @param {boolean} horizontal */
  const pass = (from, fw, fh, tw, th, horizontal) => {
    const to = new Float32Array(tw * th * 4);
    const length = horizontal ? fw : fh,
      target = horizontal ? tw : th,
      ratio = length / target;
    for (let t = 0; t < target; t++) {
      const lo = t * ratio,
        hi = lo + ratio;
      const first = Math.floor(lo),
        last = Math.min(length - 1, Math.ceil(hi) - 1);
      for (let line = 0; line < (horizontal ? fh : fw); line++) {
        const sum = [0, 0, 0, 0];
        for (let s = first; s <= last; s++) {
          const weight = Math.min(hi, s + 1) - Math.max(lo, s);
          if (weight <= 0) continue;
          const at = (horizontal ? line * fw + s : s * fw + line) * 4;
          for (let k = 0; k < 4; k++) sum[k] += from[at + k] * weight;
        }
        const out = (horizontal ? line * tw + t : t * tw + line) * 4;
        for (let k = 0; k < 4; k++) to[out + k] = sum[k] / ratio;
      }
    }
    return to;
  };
  const across = pass(f, w, h, nw, h, true),
    down = pass(across, nw, h, nw, nh, false);
  const out = new Uint8Array(nw * nh * 4);
  for (let i = 0; i < nw * nh; i++) {
    const a = down[i * 4 + 3];
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    for (let k = 0; k < 3; k++) {
      const v = color ? (a > 0 ? down[i * 4 + k] / a : 0) : down[i * 4 + k];
      out[i * 4 + k] = color ? toSrgb(v) : Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ PNG writing

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
/** @param {Uint8Array} bytes @returns {number} */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data @returns {Uint8Array} */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Writes RGBA8 pixels as a PNG: the narrowest colour type that holds them exactly (grey, grey + alpha, RGB or RGBA),
 * each row filtered with whichever of the five PNG filters gives the smallest sum of absolute values, deflated at
 * level 9 by node:zlib.
 * @param {Uint8Array} rgba @param {number} width @param {number} height @returns {Uint8Array}
 */
export function encodePNG(rgba, width, height) {
  let opaque = true,
    grey = true;
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] !== 255) opaque = false;
    if (rgba[i * 4] !== rgba[i * 4 + 1] || rgba[i * 4] !== rgba[i * 4 + 2]) grey = false;
  }
  const channels = grey ? (opaque ? 1 : 2) : opaque ? 3 : 4,
    colorType = grey ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const pixels = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    if (grey) {
      pixels[i * channels] = rgba[i * 4];
      if (!opaque) pixels[i * channels + 1] = rgba[i * 4 + 3];
    } else {
      pixels.set(rgba.subarray(i * 4, i * 4 + (opaque ? 3 : 4)), i * channels);
    }
  }
  const stride = width * channels,
    raw = new Uint8Array((stride + 1) * height),
    candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride),
      up = y ? pixels.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0,
        b = up[x],
        c = x >= channels ? up[x - channels] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      candidates[0][x] = row[x];
      candidates[1][x] = (row[x] - a) & 255;
      candidates[2][x] = (row[x] - b) & 255;
      candidates[3][x] = (row[x] - ((a + b) >> 1)) & 255;
      candidates[4][x] = (row[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    let best = 0,
      bestSum = Infinity;
    candidates.forEach((candidate, filter) => {
      let sum = 0;
      for (let x = 0; x < stride; x++) sum += candidate[x] < 128 ? candidate[x] : 256 - candidate[x];
      if (sum < bestSum) {
        bestSum = sum;
        best = filter;
      }
    });
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best], y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colorType;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ mips and DDS

/**
 * The full mip chain of RGBA8 pixels, level 0 first, each level the area average of the one above (halving, with
 * odd sizes handled by the area filter).
 * @param {Uint8Array} rgba @param {number} width @param {number} height @param {boolean} color
 * @returns {{width: number, height: number, data: Uint8Array}[]}
 */
export function mipChain(rgba, width, height, color) {
  const levels = [{ width, height, data: rgba }];
  while (width > 1 || height > 1) {
    const nw = Math.max(1, width >> 1),
      nh = Math.max(1, height >> 1);
    const previous = levels[levels.length - 1];
    levels.push({ width: nw, height: nh, data: resizeArea(previous.data, width, height, nw, nh, color) });
    width = nw;
    height = nh;
  }
  return levels;
}

/**
 * An uncompressed RGBA8 DirectDraw Surface with the given mip levels (Microsoft's DDS_HEADER with a DDS_PIXELFORMAT of
 * 32 bits and R, G, B, A masks), which Margo's `@margoengine/decoders/dds` reads.
 * @param {{width: number, height: number, data: Uint8Array}[]} levels
 * @returns {Uint8Array}
 */
export function encodeDDS(levels) {
  const out = new Uint8Array(128 + levels.reduce((n, l) => n + l.data.length, 0)),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x20534444, true); // 'DDS '
  view.setUint32(4, 124, true);
  // CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | MIPMAPCOUNT
  view.setUint32(8, 0x1 | 0x2 | 0x4 | 0x8 | 0x1000 | 0x20000, true);
  view.setUint32(12, levels[0].height, true);
  view.setUint32(16, levels[0].width, true);
  view.setUint32(20, levels[0].width * 4, true);
  view.setUint32(28, levels.length, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, 0x1 | 0x40, true); // ALPHAPIXELS | RGB
  view.setUint32(88, 32, true);
  view.setUint32(92, 0x000000ff, true);
  view.setUint32(96, 0x0000ff00, true);
  view.setUint32(100, 0x00ff0000, true);
  view.setUint32(104, 0xff000000, true);
  view.setUint32(108, 0x1000 | 0x8 | 0x400000, true); // TEXTURE | COMPLEX | MIPMAP
  let at = 128;
  for (const level of levels) {
    out.set(level.data, at);
    at += level.data.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ one image

/**
 * What became of one image.
 * @typedef {object} ImageResult
 * @property {Uint8Array} bytes the image to write (the input when unchanged)
 * @property {string} mimeType
 * @property {string} note one line for the manifest, empty when nothing changed
 * @property {{width: number, height: number}|null} size pixel size of the output, when known
 */

const FORMATS = /** @type {Record<string, string>} */ ({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
});
const MIME_OF = /** @type {Record<string, string>} */ ({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
});

/**
 * Resizes and re-encodes one image for a preset. The result is never larger than the input unless the image had to be
 * made smaller in pixels (then it is whichever re-encoding is smallest).
 * @param {Uint8Array} bytes @param {string} mimeType @param {Role} role @param {TexturePreset} preset @param {Sharp|null} sharp
 * @returns {Promise<ImageResult>}
 */
export async function processImage(bytes, mimeType, role, preset, sharp) {
  const unchanged = (/** @type {string} */ why) => ({ bytes, mimeType, note: why, size: null });
  const kind = FORMATS[mimeType];
  if (!kind) return unchanged(`${mimeType} left as it is (not PNG, JPEG, WebP or AVIF)`);
  const lossless = role !== 'color' && preset.losslessData;
  /** @type {{width: number, height: number}} */ let size;
  /** @type {Array<{bytes: Uint8Array, format: string}>} */ const candidates = [];
  let resized = false;

  if (sharp) {
    const meta = await sharp(bytes, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return unchanged('unreadable image left as it is');
    size = targetSize(meta.width, meta.height, preset);
    resized = size.width !== meta.width || size.height !== meta.height;
    // A JPEG that is kept as a JPEG and needs no resizing stays as the artist saved it: re-encoding only loses quality.
    if (preset.format === 'keep' && kind === 'jpeg' && !resized) return unchanged('');
    const base = () => {
      const s = sharp(bytes, { failOn: 'none', ignoreIcc: role !== 'color' ? true : false }).rotate(0);
      return resized ? s.resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' }) : s;
    };
    const wanted = preset.format === 'keep' ? kind : preset.format;
    const formats = new Set([wanted]);
    if (wanted !== kind && !resized) formats.add(kind);
    if (resized) formats.add(kind);
    for (const format of formats) {
      try {
        let s = base();
        if (format === 'webp')
          s = s.webp(lossless ? { lossless: true, effort: 6 } : { quality: preset.quality, effort: 6 });
        else if (format === 'avif')
          s = s.avif(lossless ? { lossless: true, effort: 6 } : { quality: preset.quality, effort: 6 });
        else if (format === 'png') s = s.png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true });
        else if (format === 'jpeg')
          s = s.jpeg({
            quality: lossless ? 95 : preset.quality,
            mozjpeg: true,
            chromaSubsampling: lossless ? '4:4:4' : '4:2:0',
          });
        else continue;
        candidates.push({ bytes: new Uint8Array(await s.toBuffer()), format });
      } catch {
        // this build of libvips cannot write the format; the other candidates remain
      }
    }
  } else {
    if (kind !== 'png')
      return unchanged(
        `${kind.toUpperCase()} left as it is (no encoder: Node cannot write ${kind.toUpperCase()}; install sharp to convert and resize it)`,
      );
    const png = decodePNG(bytes);
    size = targetSize(png.width, png.height, preset);
    resized = size.width !== png.width || size.height !== png.height;
    const pixels = resized
      ? resizeArea(png.data, png.width, png.height, size.width, size.height, role === 'color')
      : png.data;
    candidates.push({ bytes: encodePNG(pixels, size.width, size.height), format: 'png' });
    if (preset.format === 'webp' || preset.format === 'avif') {
      // Not an error: the preset asks for a format this machine cannot write, so the PNG is the answer.
    }
  }

  candidates.sort((a, b) => a.bytes.length - b.bytes.length);
  const best = candidates[0];
  if (!best || (!resized && best.bytes.length >= bytes.length)) return unchanged('');
  const missing = sharp
    ? ''
    : preset.format === 'webp' || preset.format === 'avif'
      ? `; ${preset.format.toUpperCase()} needs sharp, kept PNG`
      : '';
  const mime = MIME_OF[best.format];
  const note = `${kind}${resized ? ` ${size.width}x${size.height}` : ''} ${best.format === kind ? 'recompressed' : `-> ${best.format}`} (${bytes.length} -> ${best.bytes.length} bytes)${missing}`;
  return { bytes: best.bytes, mimeType: mime, note, size };
}

// ------------------------------------------------------------------------------------------------ models

/** Material texture slots whose pixels are colours (sRGB); every other slot holds data. */
const COLOR_SLOTS = new Set([
  'baseColorTexture',
  'emissiveTexture',
  'diffuseTexture',
  'diffuseTransmissionColorTexture',
  'sheenColorTexture',
  'specularColorTexture',
]);
const NORMAL_SLOTS = new Set(['normalTexture', 'clearcoatNormalTexture']);

/**
 * The role of every image of a model, from how its textures are used (a normal map wins over data, data over colour).
 * @param {any} json @returns {Map<number, Role>}
 */
function rolesOf(json) {
  /** @type {Map<number, Role>} */ const roles = new Map();
  const rank = { color: 0, data: 1, normal: 2 };
  for (const material of json.materials ?? [])
    eachTextureInfo(material, (info, key) => {
      const texture = json.textures?.[info.index];
      if (!texture) return;
      /** @type {Role} */
      const role = NORMAL_SLOTS.has(key) ? 'normal' : COLOR_SLOTS.has(key) ? 'color' : 'data';
      for (const image of imagesOf(texture)) {
        const known = roles.get(image);
        if (!known || rank[role] > rank[known]) roles.set(image, role);
      }
    });
  return roles;
}

/**
 * Resizes and re-encodes the images of a model for a preset, and points textures at WebP or AVIF images through
 * EXT_texture_webp / EXT_texture_avif (listed as required: there is no fallback copy). Images that are only reached
 * through an extension (KTX2, an existing WebP) are left alone.
 * @param {import('./gltf-io.js').Model} model @param {TexturePreset} preset @param {Sharp|null} sharp
 * @param {import('./passes.js').ModelStats} stats
 */
export async function processModelTextures(model, preset, sharp, stats) {
  const json = model.json,
    textures = json.textures ?? [],
    roles = rolesOf(json);
  const core = new Set(
    textures.map((/** @type {any} */ t) => t.source).filter((/** @type {any} */ s) => s !== undefined),
  );
  for (let i = 0; i < model.images.length; i++) {
    const image = model.images[i];
    stats.imageBytesBefore += image.bytes.length;
    if (!core.has(i)) {
      stats.imageBytesAfter += image.bytes.length;
      continue;
    }
    const result = await processImage(image.bytes, image.mimeType, roles.get(i) ?? 'data', preset, sharp);
    if (result.bytes !== image.bytes) {
      model.images[i] = { bytes: result.bytes, mimeType: result.mimeType };
      stats.imagesProcessed++;
    }
    if (result.note) stats.notes.push(`image ${json.images?.[i]?.name ?? i}: ${result.note}`);
    stats.imageBytesAfter += model.images[i].bytes.length;
  }
  const used = new Set(json.extensionsUsed ?? []),
    required = new Set(json.extensionsRequired ?? []);
  for (const texture of textures) {
    const mime = texture.source === undefined ? '' : model.images[texture.source].mimeType;
    const extension = mime === 'image/webp' ? 'EXT_texture_webp' : mime === 'image/avif' ? 'EXT_texture_avif' : '';
    if (!extension) continue;
    texture.extensions = { ...texture.extensions, [extension]: { source: texture.source } };
    delete texture.source;
    used.add(extension);
    required.add(extension);
  }
  if (used.size) json.extensionsUsed = [...used];
  if (required.size) json.extensionsRequired = [...required];
}

// ------------------------------------------------------------------------------------------------ standalone files

/**
 * The role of a texture file from its name: normal maps and packed data maps are data, the rest is colour.
 * @param {string} name @returns {Role}
 */
export function roleOfName(name) {
  const stem = name.toLowerCase();
  if (/(^|[^a-z])(normal|nrm|nor)([^a-z]|$)|_n\.[a-z]+$/.test(stem)) return 'normal';
  if (/(rough|metal|orm|occlusion|ambient|_ao|mask|height|bump|spec|gloss|arm|packed)/.test(stem)) return 'data';
  return 'color';
}

/**
 * RGBA8 pixels of an image: PNG with the built-in decoder, anything else through sharp.
 * @param {Uint8Array} bytes @param {string} mimeType @param {Sharp|null} sharp
 * @returns {Promise<{width: number, height: number, data: Uint8Array}|null>}
 */
export async function decodeRgba(bytes, mimeType, sharp) {
  if (mimeType === 'image/png') return decodePNG(bytes);
  if (!sharp) return null;
  const { data, info } = await sharp(bytes, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}
