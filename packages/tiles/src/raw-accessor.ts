import type { GLTFAsset } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { ACCESSOR_WIDTHS, COMPONENT_BYTES, readComponent } from '../../shared/accessor.js';
import type { PropertyReadOptions } from './properties.js';
export function rawAccessor(asset: GLTFAsset, index: number, options: PropertyReadOptions): Uint8Array {
  const definition = asset.doc.accessors?.[index];
  if (!definition) throw new TypeError('Property accessor is missing; correct the primitive attribute index');
  const size = COMPONENT_BYTES[definition.componentType],
    width = ACCESSOR_WIDTHS[definition.type],
    count = definition.count;
  if (!size || !width || !Number.isInteger(count) || count < 0)
    throw new TypeError('Property accessor has an invalid component type, shape or count; re-export valid glTF');
  const byteLength = count * width * size,
    maximum = options.maximumDecodedBytes ?? asset.maxBytes * 4;
  if (!Number.isSafeInteger(byteLength) || !Number.isFinite(maximum) || maximum < 0 || byteLength > maximum)
    throw new RangeError(
      'Property accessor exceeds the decoded byte limit; reduce the data or raise maximumDecodedBytes',
    );
  const provided = options.accessor?.(index);
  if (provided) {
    if (provided.length !== byteLength)
      throw new RangeError('Decoded property accessor byte count is wrong; supply tightly packed components');
    return provided;
  }
  const output = new Uint8Array(byteLength);
  const matrix = definition.type.startsWith('MAT') ? Number(definition.type[3]) : 0,
    column = matrix ? Math.ceil((matrix * size) / 4) * 4 : 0,
    element = matrix ? matrix * column : width * size;
  const copy = (view: Uint8Array, offset: number, stride: number, rows: number, indices?: readonly number[]) => {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % size ||
      !Number.isInteger(stride) ||
      stride < element ||
      stride % size ||
      (matrix && offset % 4) ||
      (rows > 0 && offset + (rows - 1) * stride + element > view.length)
    )
      throw new RangeError(
        'Property accessor runs past its buffer view or is unaligned; correct its offsets/count/stride',
      );
    for (let i = 0; i < rows; i++)
      for (let c = 0; c < width; c++) {
        const at = offset + i * stride + (matrix ? Math.floor(c / matrix) * column + (c % matrix) * size : c * size);
        output.set(view.subarray(at, at + size), ((indices?.[i] ?? i) * width + c) * size);
      }
  };
  if (definition.bufferView !== undefined)
    copy(
      asset.view(definition.bufferView),
      definition.byteOffset ?? 0,
      asset.doc.bufferViews?.[definition.bufferView]?.byteStride ?? element,
      count,
    );
  else if (
    asset.doc.meshes?.some((m) =>
      m.primitives.some(
        (p) => p.extensions?.KHR_draco_mesh_compression && Object.values(p.attributes ?? {}).includes(index),
      ),
    )
  ) {
    // The asset's async geometry decoder retains decoded custom attributes. It must have completed before this read.
    if (definition.componentType === 5125)
      throw new MargoError(
        'state',
        'Decoded UINT32 metadata can lose integer precision in the float accessor cache; supply original packed accessor bytes',
      );
    const values = asset.accessor(index),
      view = new DataView(output.buffer),
      limits: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 };
    if (values.length !== count * width)
      throw new RangeError(
        'Decoded property accessor count is wrong; complete geometry decoding or provide packed accessor bytes',
      );
    values.forEach((value, i) => {
      if (definition.normalized) {
        if (value === -1)
          throw new MargoError(
            'state',
            'Decoded signed normalized metadata has ambiguous raw sentinel bits; supply original packed accessor bytes',
          );
        value = Math.round(value * limits[definition.componentType]);
      }
      const at = i * size;
      if (definition.componentType === 5126) view.setFloat32(at, value, true);
      else if (definition.componentType === 5120) view.setInt8(at, value);
      else if (definition.componentType === 5121) view.setUint8(at, value);
      else if (definition.componentType === 5122) view.setInt16(at, value, true);
      else if (definition.componentType === 5123) view.setUint16(at, value, true);
      else view.setUint32(at, value, true);
    });
  }
  if (definition.sparse) {
    const sparse = definition.sparse,
      indices = sparse.indices,
      indexSize = COMPONENT_BYTES[indices.componentType],
      bytes = asset.view(indices.bufferView),
      data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      at = indices.byteOffset ?? 0;
    if (
      ![5121, 5123, 5125].includes(indices.componentType) ||
      !Number.isInteger(at) ||
      at < 0 ||
      at % indexSize ||
      !Number.isInteger(sparse.count) ||
      sparse.count < 1 ||
      at + sparse.count * indexSize > bytes.length ||
      sparse.count > count
    )
      throw new RangeError('Sparse property indices are invalid; correct sparse count and index storage');
    const ids: number[] = [];
    for (let i = 0; i < sparse.count; i++) {
      const id = readComponent(data, at + i * indexSize, indices.componentType);
      if (id >= count || (i > 0 && id <= ids[i - 1]))
        throw new RangeError(
          'Sparse property indices must increase within the accessor count; correct the sparse indices',
        );
      ids.push(id);
    }
    copy(asset.view(sparse.values.bufferView), sparse.values.byteOffset ?? 0, element, sparse.count, ids);
  }
  return output;
}
