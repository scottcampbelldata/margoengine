// SOG (Spatially Ordered Gaussians) reader. Written from the public SOG format description (PlayCanvas developer
// documentation, version 2); no other implementation was read.
import { type DecodedImage, decodeWebpLossless } from '@margoengine/decoders/webp-lossless';
import { MargoError } from '@margoengine/math/errors';
import type { SplatData } from './data.js';
import { type GaussianAttributes, splatsFromAttributes } from './ply.js';
import { readZip } from './zip.js';

/** The loose files of an unbundled SOG, by file name; must include `meta.json`. */
export type SogFiles = Record<string, ArrayBuffer | ArrayBufferView>;
/** Options for {@link parseSog}. */
export interface ParseSogOptions {
  /** Aborts decoding; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

interface SogMeta {
  version: number;
  count: number;
  model?: string;
  means: { mins: number[]; maxs: number[]; files: string[] };
  scales: { codebook: number[]; files: string[] };
  quats: { files: string[] };
  sh0: { codebook: number[]; files: string[] };
  shN?: { count: number; bands: number; codebook: number[]; files: string[] };
}

const asBytes = (v: ArrayBuffer | ArrayBufferView): Uint8Array =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const COEFFICIENTS = [0, 3, 8, 15];

/**
 * Decodes a SOG Gaussian-splat scene (version 2) to {@link SplatData}: either a bundled `.sog` file (a ZIP archive) or
 * the loose files of an unbundled one (`meta.json` plus its lossless WebP textures). Positions, scales, rotations,
 * colours, opacity and spherical harmonics are dequantised as the format describes; the splats keep the file's
 * coordinate frame. The textures are decoded by a built-in lossless WebP decoder, so it works in any runtime with
 * `DecompressionStream`.
 * @throws TypeError when `input` is not bytes or a file map; RangeError for a damaged archive, texture or `meta.json`
 * or an unknown SOG version; MargoError `unsupported` for lossy textures, ZIP64 or a missing `DecompressionStream`.
 * @example
 * const splats = await parseSog(await (await fetch('scene.sog')).arrayBuffer());
 */
export async function parseSog(
  input: ArrayBuffer | ArrayBufferView | SogFiles,
  options: ParseSogOptions = {},
): Promise<SplatData> {
  const { signal } = options;
  let files: Map<string, Uint8Array>;
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = asBytes(input);
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
      throw new RangeError('Not a SOG file: a bundled .sog is a ZIP archive; pass the whole file or its loose files.');
    files = await readZip(bytes, signal);
  } else if (input && typeof input === 'object') {
    files = new Map(
      Object.entries(input).map(([name, bytes]) => {
        if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes))
          throw new TypeError(`SOG file ${name} must be an ArrayBuffer or typed array`);
        return [name, asBytes(bytes)];
      }),
    );
  } else
    throw new TypeError(
      'Expected .sog bytes or a map of SOG file names to bytes; pass an ArrayBuffer, typed array or file map',
    );
  const metaBytes = files.get('meta.json');
  if (!metaBytes) throw new RangeError('The SOG has no meta.json; pass the complete archive or all of its files.');
  let meta: SogMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch {
    throw new RangeError('The SOG meta.json is not valid JSON; check that the file is complete.');
  }
  if (meta.version !== 2)
    throw new RangeError(
      `SOG version ${meta.version} is not supported; this reader handles version 2, re-export the scene.`,
    );
  if (meta.model !== undefined && meta.model !== 'antialiased')
    throw new MargoError(
      'unsupported',
      `SOG model ${meta.model} is not supported; 2D Gaussian scenes cannot be drawn here.`,
    );
  const count = meta.count;
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
    throw new RangeError('A SOG needs 1 to 3,000,000 splats.');
  const image = (name: string | undefined): DecodedImage => {
    signal?.throwIfAborted();
    const bytes = name === undefined ? undefined : files.get(name);
    if (!bytes) throw new RangeError(`The SOG is missing the texture ${name}; pass the complete archive.`);
    try {
      return decodeWebpLossless(bytes);
    } catch (cause) {
      if ((cause as MargoError).code === 'unsupported')
        throw new MargoError(
          'unsupported',
          `The SOG texture ${name} is lossy WebP; re-export the SOG with lossless textures.`,
        );
      throw new RangeError(`The SOG texture ${name} is damaged; re-export the SOG with lossless textures.`, { cause });
    }
  };
  const [lowName, highName] = meta.means?.files ?? [],
    low = image(lowName),
    high = image(highName),
    scales = image(meta.scales?.files?.[0]),
    quats = image(meta.quats?.files?.[0]),
    sh0 = image(meta.sh0?.files?.[0]);
  for (const t of [high, scales, quats, sh0])
    if (t.width !== low.width || t.height !== low.height)
      throw new RangeError('The SOG textures differ in size; the file is damaged.');
  if (low.width * low.height < count)
    throw new RangeError('The SOG textures hold fewer pixels than its splat count; the file is damaged, re-export it');
  for (const book of [meta.scales?.codebook, meta.sh0?.codebook])
    if (!Array.isArray(book) || book.length !== 256) throw new RangeError('A SOG codebook must have 256 entries.');
  if (
    !Array.isArray(meta.means.mins) ||
    !Array.isArray(meta.means.maxs) ||
    meta.means.mins.length !== 3 ||
    meta.means.maxs.length !== 3
  )
    throw new RangeError('The SOG means need three mins and three maxs.');
  const raw: GaussianAttributes = {
    count,
    positions: new Float32Array(count * 3),
    logScales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    dc: new Float32Array(count * 3),
    alphas: new Float32Array(count),
  };
  const { mins, maxs } = meta.means,
    scaleBook = meta.scales.codebook,
    dcBook = meta.sh0.codebook;
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    for (let a = 0; a < 3; a++) {
      const q = high.data[p + a] * 256 + low.data[p + a],
        n = mins[a] + ((maxs[a] - mins[a]) * q) / 65535;
      raw.positions[i * 3 + a] = Math.sign(n) * (Math.exp(Math.abs(n)) - 1);
      raw.logScales[i * 3 + a] = scaleBook[scales.data[p + a]];
      raw.dc[i * 3 + a] = dcBook[sh0.data[p + a]];
    }
    raw.alphas[i] = sh0.data[p + 3] / 255;
    const mode = quats.data[p + 3] - 252;
    if (mode < 0 || mode > 3) throw new RangeError('A SOG rotation has a reserved mode; the file is damaged.');
    // The three stored components are (w, x, y, z) without the omitted one, each in -sqrt(1/2)..sqrt(1/2).
    const q4 = [0, 0, 0, 0];
    let sum = 0,
      read = 0;
    for (let k = 0; k < 4; k++) {
      if (k === mode) continue;
      const c = ((quats.data[p + read++] / 255) * 2 - 1) * Math.SQRT1_2;
      q4[k] = c;
      sum += c * c;
    }
    q4[mode] = Math.sqrt(Math.max(0, 1 - sum));
    raw.rotations.set(q4, i * 4);
  }
  if (meta.shN) {
    const sh = meta.shN,
      coeffs = COEFFICIENTS[sh.bands];
    if (!coeffs || !Array.isArray(sh.codebook) || sh.codebook.length !== 256 || !Array.isArray(sh.files))
      throw new RangeError('The SOG shN block is damaged; bands must be 1 to 3 and the codebook 256 entries.');
    const centroids = image(sh.files[0]),
      labels = image(sh.files[1]);
    if (labels.width * labels.height < count || centroids.width < 64 * coeffs)
      throw new RangeError(
        'The SOG spherical-harmonic textures are too small for its splat count; the file is damaged, re-export it',
      );
    raw.rest = new Float32Array(count * coeffs * 3);
    for (let i = 0; i < count; i++) {
      const label = labels.data[i * 4] + labels.data[i * 4 + 1] * 256;
      if (label >= sh.count)
        throw new RangeError(
          'A SOG spherical-harmonic label is outside its palette; the file is damaged, re-export it',
        );
      for (let c = 0; c < coeffs; c++) {
        const at = ((label >> 6) * centroids.width + (label & 63) * coeffs + c) * 4;
        if (at + 2 >= centroids.data.length)
          throw new RangeError('A SOG palette entry lies outside its texture; the file is damaged, re-export it');
        for (let ch = 0; ch < 3; ch++) raw.rest[(i * coeffs + c) * 3 + ch] = sh.codebook[centroids.data[at + ch]];
      }
    }
  }
  return splatsFromAttributes(raw);
}
