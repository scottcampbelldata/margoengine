// gltf-pro and materials route a primitive after the opaque phase when its effective extension asks for it.
// gltf-pro's prepareMaterialExtension refuses a non-boolean `afterOpaque`.
export function primitiveAfterOpaque(primitive) {
  return (primitive.extension ?? primitive.material.extension)?.afterOpaque === true;
}
