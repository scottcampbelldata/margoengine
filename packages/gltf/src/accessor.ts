// Accessor reading shared by the loader and its optional entries (glTF 2.0 specification, section 3.6.2).
import { MargoError } from '@margoengine/math/errors';
import { COMPONENT_BYTES, readComponent } from '../../shared/accessor.js';
import type { GLTFAccessor, GLTFDocument } from '../../shared/gltf.js';

export const integer = (value: unknown, label: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new TypeError(
      `Invalid glTF ${label}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
    );
  return value;
};
export const entry = <T>(array: readonly T[] | undefined, id: unknown, label: string): T => {
  const value = array?.[integer(id, label)];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(
      `Missing glTF ${label}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`,
    );
  return value;
};
// The divisor of a normalized integer, by componentType (specification section 3.11). A Map: componentType is untrusted.
const ranges = /* @__PURE__ */ new Map([
  [5120, 127],
  [5121, 255],
  [5122, 32767],
  [5123, 65535],
]);

/**
 * The `components` values of each element of accessor `id`, bounds checked. `accepts` says which accessors the caller
 * takes; anything else is an `'unsupported'` MargoError. A normalized integer reads as a float in -1..1 or 0..1.
 * @throws RangeError for bounds or a stride outside the view.
 */
export function readAccessor(
  { doc, buffers }: { doc: GLTFDocument; buffers: readonly Uint8Array[] },
  id: unknown,
  components: number,
  accepts: (accessor: GLTFAccessor) => boolean,
  index = false,
): Float32Array | Uint32Array {
  const a = entry(doc.accessors, id, 'accessor'),
    v = entry(doc.bufferViews, a.bufferView, 'bufferView'),
    buffer = buffers[integer(v.buffer, 'buffer reference')];
  if (!buffer || a.sparse || !accepts(a))
    throw new MargoError(
      'unsupported',
      'Unsupported glTF accessor; use float positions and unsigned integer indices, add @margoengine/gltf/quantized for quantized meshes, or load it with @margoengine/gltf-pro',
    );
  const size: number = COMPONENT_BYTES[a.componentType],
    count = integer(a.count, 'accessor count', 1),
    offset = integer(a.byteOffset ?? 0, 'accessor offset'),
    start = integer(v.byteOffset ?? 0, 'view offset'),
    length = integer(v.byteLength, 'view length', 1),
    stride = integer(v.byteStride ?? size * components, 'stride', size * components);
  if (count > 1_000_000)
    throw new MargoError(
      'unsupported',
      'glTF accessor holds over one million values, the limit of the light loader; load it with @margoengine/gltf-pro',
    );
  if (
    start + length > buffer.length ||
    offset + (count - 1) * stride + components * size > length ||
    start % size ||
    offset % size ||
    stride % size ||
    stride > 252 ||
    (index && v.byteStride !== undefined)
  )
    throw new RangeError(
      'Invalid glTF accessor bounds/stride; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const view = new DataView(buffer.buffer, buffer.byteOffset + start, length),
    out = index ? new Uint32Array(count) : new Float32Array(count * components),
    range = a.normalized ? ranges.get(a.componentType) : undefined;
  for (let i = 0; i < count; i++)
    for (let c = 0; c < components; c++) {
      const value = readComponent(view, offset + i * stride + c * size, a.componentType);
      out[i * components + c] = range ? Math.max(value / range, -1) : value;
    }
  return out;
}
