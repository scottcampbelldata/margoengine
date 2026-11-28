// Accessor reading shared by the loader and its optional entries (glTF 2.0 specification, section 3.6.2).
import { fault, rangeError, typeError } from '@margoengine/core/extension';
import { COMPONENT_BYTES, readComponent } from '../../shared/accessor.js';
import type { GLTFAccessor, GLTFDocument } from '../../shared/gltf.js';

export const integer = (value: unknown, label: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw typeError(`Invalid glTF ${label}`, 'gltf-invalid');
  return value;
};
export const entry = <T>(array: readonly T[] | undefined, id: unknown, label: string): T => {
  const value = array?.[integer(id, label)];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw typeError(`Missing glTF ${label}`, 'gltf-invalid');
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
  const a = entry(doc.accessors, id, 'accessor');
  // Section 3.6.2.1: an accessor without a bufferView holds zeros (sparse values, which this loader does not read,
  // could override them).
  if (a.bufferView === undefined && !a.sparse) {
    if (!accepts(a))
      throw fault('unsupported', 'Unsupported glTF accessor for the light loader', 'gltf-light');
    const count = integer(a.count, 'accessor count', 1);
    if (count > 1_000_000)
      throw fault('unsupported', 'glTF accessor holds over one million values, the light loader limit', 'gltf-light');
    return index ? new Uint32Array(count) : new Float32Array(count * components);
  }
  const v = entry(doc.bufferViews, a.bufferView, 'bufferView'),
    buffer = buffers[integer(v.buffer, 'buffer reference')];
  if (!buffer || a.sparse || !accepts(a))
    throw fault('unsupported', 'Unsupported glTF accessor for the light loader', 'gltf-light');
  const size: number = COMPONENT_BYTES[a.componentType],
    count = integer(a.count, 'accessor count', 1),
    offset = integer(a.byteOffset ?? 0, 'accessor offset'),
    start = integer(v.byteOffset ?? 0, 'view offset'),
    length = integer(v.byteLength, 'view length', 1),
    stride = integer(v.byteStride ?? size * components, 'stride', size * components);
  if (count > 1_000_000)
    throw fault('unsupported', 'glTF accessor holds over one million values, the light loader limit', 'gltf-light');
  if (
    start + length > buffer.length ||
    offset + (count - 1) * stride + components * size > length ||
    start % size ||
    offset % size ||
    stride % size ||
    stride > 252 ||
    (index && v.byteStride !== undefined)
  )
    throw rangeError('Invalid glTF accessor bounds/stride', 'gltf-invalid');
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
