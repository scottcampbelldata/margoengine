// @ts-check
// Build presets for margo-convert. A preset is plain data: what the model passes do, how textures are resized and
// encoded, and what happens to audio. `web` is the default.

/**
 * Texture settings of a preset.
 * @typedef {object} TexturePreset
 * @property {number} maxSize Largest width or height in pixels; larger images are scaled down (never up).
 * @property {false|'down'} powerOfTwo `'down'` resizes to the power of two at or below the size (never up);
 *   `false` leaves sizes alone (apart from `multipleOf`).
 * @property {number} multipleOf Round sizes down to a multiple of this (4 for GPU block compression).
 * @property {'webp'|'avif'|'png'|'jpeg'|'keep'} format Output format for colour maps. `keep` writes PNG for PNG and
 *   JPEG for JPEG. WebP and AVIF need `sharp`; without it textures keep their format (PNG is recompressed).
 * @property {number} quality Lossy quality, 1 to 100.
 * @property {boolean} losslessData Encode normal, occlusion/roughness/metalness and other data maps losslessly.
 * @property {boolean} mipmaps Also write a DDS file with a full mip chain (uncompressed RGBA8) for each standalone texture.
 *   Off in every preset: WebP, PNG and JPEG hold one level and Margo builds the others on the GPU.
 */

/**
 * Audio settings of a preset.
 * @typedef {object} AudioPreset
 * @property {number} maxSampleRate WAV files above this rate are resampled down (Hz); 0 keeps the rate.
 * @property {boolean} mono Mix WAV files down to one channel.
 * @property {'keep'|'ogg'} format `ogg` converts WAV and FLAC to Ogg Vorbis when an ffmpeg with libvorbis is installed.
 *   MP3, AAC, Opus and Ogg files are web formats already and are never re-encoded.
 * @property {boolean} requireCompressed The target wants a compressed format (ogg or mp3); WAV files are reported.
 */

/**
 * @typedef {object} Preset
 * @property {string} title
 * @property {string} summary
 * @property {import('./optimize.js').ModelOptions} model
 * @property {TexturePreset} texture
 * @property {AudioPreset} audio
 */

/** The names a preset can have. */
export const PRESET_NAMES = /** @type {const} */ (['web', 'mobile', 'unity', 'unreal', 'godot', 'roblox']);

/** @typedef {typeof PRESET_NAMES[number]} PresetName */

const ALL_QUANTIZED = { position: true, normal: /** @type {8} */ (8), uv: true, color: true, weights: true };
const PLAIN_MODEL = {
  prune: true,
  pruneEmptyNodes: false,
  dedupe: true,
  weld: true,
  merge: false,
  quantize: /** @type {false} */ (false),
  meshopt: false,
};

/** @type {Record<PresetName, Preset>} */
export const PRESETS = {
  web: {
    title: 'Web',
    summary:
      'Smallest download for a browser: quantised, meshopt-compressed GLB, textures up to 2048 px as WebP, static meshes merged, WAV to Ogg Vorbis.',
    model: {
      prune: true,
      pruneEmptyNodes: true,
      dedupe: true,
      weld: true,
      merge: true,
      quantize: ALL_QUANTIZED,
      meshopt: true,
    },
    texture: {
      maxSize: 2048,
      powerOfTwo: false,
      multipleOf: 4,
      format: 'webp',
      quality: 82,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 0, mono: false, format: 'ogg', requireCompressed: false },
  },
  mobile: {
    title: 'Mobile web',
    summary:
      'Web, tuned for phones: textures up to 1024 px at power-of-two sizes, lower WebP quality, audio mixed to mono at 22.05 kHz.',
    model: {
      prune: true,
      pruneEmptyNodes: true,
      dedupe: true,
      weld: true,
      merge: true,
      quantize: ALL_QUANTIZED,
      meshopt: true,
    },
    texture: {
      maxSize: 1024,
      powerOfTwo: 'down',
      multipleOf: 4,
      format: 'webp',
      quality: 72,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 22050, mono: true, format: 'ogg', requireCompressed: false },
  },
  unity: {
    title: 'Unity',
    summary:
      'Plain GLB for Unity importers (no required extensions): hierarchy and empty nodes kept, PNG/JPEG textures up to 4096 px in multiples of 4.',
    model: PLAIN_MODEL,
    texture: {
      maxSize: 4096,
      powerOfTwo: false,
      multipleOf: 4,
      format: 'keep',
      quality: 90,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 0, mono: false, format: 'keep', requireCompressed: false },
  },
  unreal: {
    title: 'Unreal Engine',
    summary:
      'Plain GLB for Unreal importers: hierarchy kept, PNG/JPEG textures at power-of-two sizes up to 4096 px (Unreal builds mip chains and streams from them).',
    model: PLAIN_MODEL,
    texture: {
      maxSize: 4096,
      powerOfTwo: 'down',
      multipleOf: 4,
      format: 'keep',
      quality: 90,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 0, mono: false, format: 'keep', requireCompressed: false },
  },
  godot: {
    title: 'Godot',
    summary:
      'Plain GLB for Godot: hierarchy and empty nodes (often used as attachment points) kept, PNG/JPEG textures up to 4096 px.',
    model: PLAIN_MODEL,
    texture: {
      maxSize: 4096,
      powerOfTwo: false,
      multipleOf: 1,
      format: 'keep',
      quality: 90,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 0, mono: false, format: 'keep', requireCompressed: false },
  },
  roblox: {
    title: 'Roblox',
    summary:
      'Plain GLB for the Roblox importer: PNG/JPEG textures up to 1024 px (Roblox scales larger images down); audio must be mp3 or ogg, so WAV files become Ogg Vorbis (with ffmpeg) or are reported.',
    model: PLAIN_MODEL,
    texture: {
      maxSize: 1024,
      powerOfTwo: false,
      multipleOf: 1,
      format: 'keep',
      quality: 90,
      losslessData: true,
      mipmaps: false,
    },
    audio: { maxSampleRate: 0, mono: false, format: 'ogg', requireCompressed: true },
  },
};

/**
 * The preset called `name`.
 * @param {string} name
 * @returns {Preset}
 * @throws {RangeError} for a name that is not a preset, listing the valid ones
 */
export function preset(name) {
  if (!Object.hasOwn(PRESETS, name))
    throw new RangeError(`unknown preset "${name}"; use one of ${PRESET_NAMES.join(', ')}`);
  return PRESETS[/** @type {PresetName} */ (name)];
}
