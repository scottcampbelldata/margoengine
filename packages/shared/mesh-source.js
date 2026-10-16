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
