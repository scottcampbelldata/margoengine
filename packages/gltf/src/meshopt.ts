// EXT_meshopt_compression for the light loader. The decoder module is imported only when a file uses the extension.
import { MargoError } from '@margoengine/math/errors';
import { entry, integer } from './accessor.js';
import type { GLTFExtension } from './index.js';

const NAMES = ['EXT_meshopt_compression', 'KHR_meshopt_compression'],
  // The most decoded bytes per file, the loader's own budget for buffers.
  budget = 64 * 1024 * 1024;
interface Compressed {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: string;
  filter?: string;
}
const compressed = (view: { extensions?: Record<string, unknown> }): Compressed | undefined =>
  (view.extensions?.[NAMES[0]] ?? view.extensions?.[NAMES[1]]) as Compressed | undefined;

async function decoder(): Promise<typeof import('@margoengine/decoders/meshopt')> {
  try {
    return await import('@margoengine/decoders/meshopt');
  } catch (error) {
    if (/Cannot find|Failed to resolve|dynamically imported module/i.test((error as Error).message))
      throw new MargoError('failed', 'Meshopt glTF needs a decoder; install @margoengine/decoders');
    throw error;
  }
}

/**
 * Lets the light loader read meshopt compressed buffers (`EXT_meshopt_compression` and `KHR_meshopt_compression`,
 * every mode and filter). `@margoengine/decoders/meshopt` is imported on the first file that uses it, so install that
 * package beside this one; a file with no compressed views never loads it. A fallback buffer is not downloaded.
 * Decoded data counts toward a 64 MiB budget. Needs `loadGLTF` or `parseGLTFAsync`.
 * @example const model = await loadGLTF(engine, '/small.glb', { extensions: [meshopt, quantized] });
 */
export const meshopt: GLTFExtension = {
  handles: NAMES,
  async load(file) {
    const views = file.doc.bufferViews ?? [];
    if (!views.some(compressed)) return;
    const { meshoptDecodeGltfBuffer } = await decoder(),
      buffers = [...file.buffers],
      definitions = [...(file.doc.buffers ?? [])];
    let total = 0;
    const bufferViews = views.map((view) => {
      const source = compressed(view);
      if (!source) return view;
      const data = buffers[integer(source.buffer, 'meshopt buffer')],
        start = integer(source.byteOffset ?? 0, 'meshopt offset'),
        length = integer(source.byteLength, 'meshopt length', 1),
        count = integer(source.count, 'meshopt count', 1),
        stride = integer(source.byteStride, 'meshopt stride', 1);
      if (!data || start + length > data.length) throw new RangeError('glTF meshopt data is outside its buffer; re-export the file');
      total += count * stride;
      if (total > budget)
        throw new RangeError('glTF meshopt data decodes past 64 MiB; load a smaller file or split it');
      const decoded = meshoptDecodeGltfBuffer(
        data.subarray(start, start + length),
        count,
        stride,
        source.mode,
        source.filter,
      );
      if (decoded.length < integer(view.byteLength, 'view length', 1))
        throw new RangeError('glTF meshopt data is shorter than its bufferView; re-export the file');
      const { extensions, ...rest } = view,
        others = Object.fromEntries(Object.entries(extensions!).filter(([name]) => !NAMES.includes(name)));
      buffers.push(decoded);
      definitions.push({ byteLength: decoded.length });
      return {
        ...rest,
        buffer: buffers.length - 1,
        byteOffset: 0,
        ...(Object.keys(others).length ? { extensions: others } : {}),
      };
    });
    file.buffers = buffers;
    file.doc = { ...file.doc, buffers: definitions, bufferViews };
  },
};
