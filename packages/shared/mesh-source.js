// Independently bundled optional packages must see the same weak registry.
// Core never imports this module; the stage only reads existing source records.
const key = Symbol.for('margoengine.mesh-sources.v1');
const sources = globalThis[key] ?? new WeakMap();
if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: sources });

export function setMeshSource(mesh, source) {
  sources.set(mesh, source);
}
export function clearMeshSource(mesh) {
  sources.delete(mesh);
}
export function meshTriangles(mesh) {
  if (mesh?.geometry) return { kind: 'core', geometry: mesh.geometry };
  const source = mesh && sources.get(mesh);
  if (!source || source.model.disposed) return null;
  try {
    mesh.check?.();
  } catch {
    return null;
  }
  return { kind: 'pbr', source };
}

/**
 * The triangles of gltf-pro primitives (20-float vertices) in one list: positions (and normals with `normals`) per
 * vertex, indices offset per primitive. `check(vertexCount, indexCount)` runs before anything is allocated.
 */
export function mergePrimitives(primitives, normals = false, check) {
  let vertexCount = 0,
    indexCount = 0;
  for (const primitive of primitives) {
    if (primitive.vertices.length % 20)
      throw new RangeError(
        'PBR vertex array length is not a multiple of its stride; pass gltf-pro primitives with 20-float vertices',
      );
    vertexCount += primitive.vertices.length / 20;
    indexCount += primitive.indices.length;
  }
  check?.(vertexCount, indexCount);
  const stride = normals ? 6 : 3,
    vertices = new Float32Array(vertexCount * stride),
    indices = new Uint32Array(indexCount);
  let vertexOffset = 0,
    indexOffset = 0;
  for (const primitive of primitives) {
    const count = primitive.vertices.length / 20;
    for (let i = 0; i < count; i++) {
      vertices.set(primitive.vertices.subarray(i * 20, i * 20 + 3), (vertexOffset + i) * stride);
      if (normals) vertices.set(primitive.vertices.subarray(i * 20 + 4, i * 20 + 7), (vertexOffset + i) * stride + 3);
    }
    for (const index of primitive.indices) indices[indexOffset++] = vertexOffset + index;
    vertexOffset += count;
  }
  return { vertices, indices, stride };
}
