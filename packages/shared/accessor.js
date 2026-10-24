// glTF 2.0 accessor tables and the one component read (specification section 3.6.2), shared by the gltf and gltf-pro
// loaders and the exporters GLB readers. Null-prototype tables, so an untrusted type name never finds an inherited key.

/** Components per element, keyed by accessor `type`. */
export const ACCESSOR_WIDTHS = /* @__PURE__ */ Object.freeze(
  Object.assign(Object.create(null), { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }),
);
/** Bytes per component, keyed by `componentType`. */
export const COMPONENT_BYTES = /* @__PURE__ */ Object.freeze(
  Object.assign(Object.create(null), { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }),
);

/** One little-endian component of `componentType` at byte `at` of `view` (byte, short, unsigned int or float). */
export function readComponent(view, at, componentType) {
  if (componentType === 5126) return view.getFloat32(at, true);
  if (componentType === 5125) return view.getUint32(at, true);
  if (componentType === 5123) return view.getUint16(at, true);
  if (componentType === 5122) return view.getInt16(at, true);
  return componentType === 5121 ? view.getUint8(at) : view.getInt8(at);
}
