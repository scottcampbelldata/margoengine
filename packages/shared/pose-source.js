// A deformer that writes a primitive's pose on the GPU (`primitive.deformed`) registers the same arithmetic on the CPU
// here, so a synchronous CPU query (@margoengine/bvh) tests the pose that is drawn instead of the bind pose. A GPU
// buffer cannot be read back synchronously, so without a source such a query has no pose to test.
// Independently bundled optional packages must see the same weak registry.
const key = Symbol.for('margoengine.pose-sources.v1');
const sources = globalThis[key] ?? new WeakMap();
if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: sources });

/** Registers `source` as the CPU pose of `primitive`. */
export function setPoseSource(primitive, source) {
  sources.set(primitive, source);
}
/** Removes `source` if it is still the one registered for `primitive`. */
export function clearPoseSource(primitive, source) {
  if (sources.get(primitive) === source) sources.delete(primitive);
}
/** The current pose of `primitive` from its registered source, or undefined when it has none (or the source declines). */
export function posedVertices(primitive) {
  return sources.get(primitive)?.();
}
