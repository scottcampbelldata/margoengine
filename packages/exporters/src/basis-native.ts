// One optional, lazy Rust/Wasm encoder. Public API and image decoding stay TS.
import { MargoError } from '@margoengine/math/errors';
import { imageForBasisJob, type BasisJob, type BasisResult, type RGBAImage } from './ktx2-encode.js';
import { encodeBasisLZ, packKTX2, type EncodedLevel } from './basis-wire.js';

export interface NativeBasis extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  encode_uastc(input: number, output: number, blocks: number, level: number, perceptual: number): number;
  condition_uastc(input: number, output: number, blocks: number, lambda: number, perceptual: number): number;
  encode_etc1s_shared(
    input: number,
    output: number,
    blocks: number,
    quality: number,
    effort: number,
    perceptual: number,
  ): number;
  encode_etc1s_shared_mips(
    input: number, output: number, blocks: number, quality: number, effort: number,
    perceptual: number, dimensions: number, slices: number,
  ): number;
  encode_zstd(input: number, length: number, output: number, capacity: number): number;
  mip_rgba(input: number, output: number, width: number, height: number, srgb: number, normal: number): number;
}
const failed = (): MargoError =>
  new MargoError('failed', 'KTX2 encoder rejected the image; check its pixels and dimensions');
/** Loading happens only after an encode starts, in Node or the encoder worker. */
export async function loadNativeBasis(url: URL): Promise<NativeBasis> {
  let bytes: Uint8Array;
  if (url.protocol === 'file:') {
    const name = 'node:fs/promises',
      { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    bytes = await readFile(url);
  } else {
    const response = await fetch(url);
    if (!response.ok)
      throw new MargoError('failed', `Could not load the KTX2 encoder (${response.status}); check its Wasm URL`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const { instance } = await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, {});
  return instance.exports as NativeBasis;
}
function run(
  api: NativeBasis,
  source: Uint8Array,
  size: number,
  encode: (input: number, output: number) => number,
  variable = false,
): Uint8Array {
  const input = api.allocate(source.length);
  let output: number | undefined;
  try {
    output = api.allocate(size);
    new Uint8Array(api.memory.buffer, input, source.length).set(source);
    const result = encode(input, output);
    if (variable ? !result : result !== 0) throw failed();
    return new Uint8Array(api.memory.buffer, output, variable ? result : size).slice();
  } finally {
    if (output !== undefined) api.release(output, size);
    api.release(input, source.length);
  }
}
function blockPixels({ data, width, height }: RGBAImage, alpha: boolean): Uint8Array {
  const bx = Math.ceil(width / 4),
    by = Math.ceil(height / 4),
    out = new Uint8Array(bx * by * 64);
  for (let y = 0; y < by; y++)
    for (let x = 0; x < bx; x++)
      for (let t = 0; t < 16; t++) {
        const px = Math.min(width - 1, x * 4 + (t & 3)),
          py = Math.min(height - 1, y * 4 + (t >> 2)),
          at = (py * width + px) * 4,
          destination = ((y * bx + x) * 16 + t) * 4;
        if (alpha) out.set([data[at + 3], data[at + 3], data[at + 3], 255], destination);
        else out.set(data.subarray(at, at + 4), destination);
      }
  return out;
}
/** One complete image, including all mip and alpha slices. */
export function encodeNativeBasis(api: NativeBasis, job: BasisJob): BasisResult {
  const image = imageForBasisJob(job),
    images: RGBAImage[] = [image];
  let alpha = false;
  for (let i = 3; i < image.data.length; i += 4)
    if (image.data[i] !== 255) {
      alpha = true;
      break;
    }
  if (job.mipmaps)
    while (images.at(-1)!.width > 1 || images.at(-1)!.height > 1) {
      const source = images.at(-1)!,
        width = Math.max(1, source.width >> 1),
        height = Math.max(1, source.height >> 1),
        data = run(
          api,
          new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
          width * height * 4,
          (input, output) =>
            api.mip_rgba(input, output, source.width, source.height, Number(job.srgb), Number(job.normalMap)),
        );
      images.push({ width, height, data });
    }
  const dimensions: [number, number][] = [],
    pixels: Uint8Array[] = [];
  for (const image of images) {
    pixels.push(blockPixels(image, false));
    dimensions.push([image.width, image.height]);
    if (job.mode === 'etc1s' && alpha) {
      pixels.push(blockPixels(image, true));
      dimensions.push([image.width, image.height]);
    }
  }
  let levels: EncodedLevel[], global: Uint8Array | undefined;
  if (job.mode === 'etc1s') {
    const length = pixels.reduce((n, p) => n + p.length, 0),
      all = new Uint8Array(length);
    let at = 0;
    for (const data of pixels) {
      all.set(data, at);
      at += data.length;
    }
    const metadata = api.allocate(dimensions.length * 8);
    let fitted: Uint8Array;
    try {
      const view = new DataView(api.memory.buffer, metadata, dimensions.length * 8);
      dimensions.forEach(([width, height], i) => {
        view.setUint32(i * 8, width, true); view.setUint32(i * 8 + 4, height, true);
      });
      fitted = run(api, all, length / 8, (input, output) =>
        api.encode_etc1s_shared_mips(input, output, length / 64, job.quality, job.effort, Number(job.srgb), metadata, dimensions.length),
      );
    } finally {
      api.release(metadata, dimensions.length * 8);
    }
    const slices: Uint8Array[] = [];
    at = 0;
    for (const data of pixels) {
      slices.push(fitted.subarray(at, at + data.length / 8));
      at += data.length / 8;
    }
    ({ levels, global } = encodeBasisLZ(slices, dimensions, alpha));
  } else {
    // The transfer function controls metadata and mip filtering above. UASTC
    // fits stored RGB components equally, including its rate-distortion pass;
    // luma weights otherwise sacrifice chromatic detail in sRGB images.
    levels = pixels.map((data) => {
      let fitted = run(api, data, data.length / 4, (input, output) =>
        api.encode_uastc(input, output, data.length / 64, job.uastcLevel, 0),
      );
      if (job.uastcRDO > 0) {
        const input = api.allocate(data.length),
          output = api.allocate(fitted.length);
        try {
          new Uint8Array(api.memory.buffer, input, data.length).set(data);
          new Uint8Array(api.memory.buffer, output, fitted.length).set(fitted);
          if (api.condition_uastc(input, output, data.length / 64, job.uastcRDO, 0) !== 0)
            throw failed();
          fitted = new Uint8Array(api.memory.buffer, output, fitted.length).slice();
        } finally {
          api.release(input, data.length);
          api.release(output, fitted.length);
        }
      }
      return {
        data: run(
          api,
          fitted,
          fitted.length * 2 + 65536,
          (input, output) => api.encode_zstd(input, fitted.length, output, fitted.length * 2 + 65536),
          true,
        ),
        rawLength: fitted.length,
      };
    });
  }
  return {
    data: packKTX2(image.width, image.height, levels, job.mode, alpha, job.srgb, global),
    width: image.width,
    height: image.height,
  };
}
