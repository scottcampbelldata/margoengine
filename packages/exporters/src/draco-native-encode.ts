import { margoError, wasmError } from '../../shared/errors.js';
import type { DracoEncoded, DracoJob } from './draco-encode.js';

/** The original packet ABI of the optional clean-room Rust encoder. */
export interface NativeDracoEncoder {
  memory: WebAssembly.Memory;
  encoder_alloc(length: number): number;
  encoder_free(pointer: number, length: number): void;
  encoder_encode(pointer: number, length: number): number;
  encoder_output_pointer(): number;
  encoder_output_length(): number;
  encoder_output_points(): number;
  encoder_output_faces(): number;
  encoder_clear(): void;
}

/** Load the optional encoder only when compression starts; Node accepts its file URL. */
export async function loadNativeEncoder(url: string): Promise<NativeDracoEncoder> {
  let bytes: Uint8Array;
  if (url.startsWith('file:')) {
    const name = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    bytes = await readFile(new URL(url));
  } else {
    const response = await fetch(url);
    if (!response.ok)
      throw margoError('failed', `Could not load ${url} (${response.status}); serve the Draco encoder Wasm asset`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  try {
    const { instance } = await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>);
    return instance.exports as unknown as NativeDracoEncoder;
  } catch (error) {
    throw wasmError(error);
  }
}

const scalarType = (values: DracoJob['attributes'][number]['values']): number =>
  values instanceof Float32Array
    ? 9
    : values instanceof Uint32Array
      ? 6
      : values instanceof Uint16Array
        ? 4
        : values instanceof Int16Array
          ? 3
          : values instanceof Uint8Array
            ? 2
            : 1;

const kinds = { POSITION: 0, NORMAL: 1, COLOR: 2, TEX_COORD: 3, GENERIC: 4 } as const;

/** Encode through bulk memory transfers, preserving the existing worker job/result contract. */
export function encodeNativeMesh(module: NativeDracoEncoder, job: DracoJob): DracoEncoded {
  const length =
    16 +
    job.indices.byteLength +
    job.attributes.reduce((sum, a) => sum + 8 + (a.grid ? (a.width + 1) * 4 : 0) + a.values.byteLength, 0);
  if (length > 256 * 1024 * 1024)
    throw new RangeError('Draco encoder input exceeds 256 MiB; split the mesh into smaller primitives');
  const pointer = module.encoder_alloc(length);
  if (!pointer) throw margoError('failed', 'Draco encoder could not allocate its input; split the mesh');
  try {
    const bytes = new Uint8Array(module.memory.buffer, pointer, length),
      view = new DataView(module.memory.buffer, pointer, length);
    view.setUint32(0, job.points, true);
    view.setUint32(4, job.indices.length, true);
    view.setUint32(8, job.attributes.length, true);
    view.setUint32(12, job.encodeSpeed | (job.decodeSpeed << 8), true);
    bytes.set(new Uint8Array(job.indices.buffer, job.indices.byteOffset, job.indices.byteLength), 16);
    let offset = 16 + job.indices.byteLength;
    const ids: Record<string, number> = {};
    for (const [id, a] of job.attributes.entries()) {
      ids[a.semantic] = id;
      bytes.set([kinds[a.kind], scalarType(a.values), a.width, +a.normalized, a.bits, +!!a.grid, 0, 0], offset);
      offset += 8;
      if (a.grid) {
        for (const value of [...a.grid.origin, a.grid.range]) {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
      bytes.set(new Uint8Array(a.values.buffer, a.values.byteOffset, a.values.byteLength), offset);
      offset += a.values.byteLength;
    }
    const status = module.encoder_encode(pointer, length);
    if (status === 2)
      throw margoError(
        'unsupported',
        'Draco attribute range is not representable in float32 quantization; use quantization bits 0 or rescale the attribute; see https://margoengine.com/errors#unsupported',
      );
    if (status !== 0)
      throw new RangeError('Draco could not encode the mesh; check finite attributes, quantization bits and indices');
    return {
      data: new Uint8Array(
        module.memory.buffer,
        module.encoder_output_pointer(),
        module.encoder_output_length(),
      ).slice(),
      ids,
      points: module.encoder_output_points(),
      faces: module.encoder_output_faces(),
    };
  } finally {
    module.encoder_free(pointer, length);
    module.encoder_clear();
  }
}
