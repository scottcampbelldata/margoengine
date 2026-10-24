// Structural gltf-pro model shapes shared by @margoengine/bvh, @margoengine/selection and @margoengine/physics, which
// read PBRModels without importing gltf-pro (types in model.d.ts).

/** gltf-pro shape: a `root` node and `primitives` with 20-float CPU vertices (the first one is checked). */
export const isModel = (value) =>
  !!value &&
  typeof value === 'object' &&
  !!value.root &&
  Array.isArray(value.primitives) &&
  (!value.primitives.length || value.primitives[0].vertices instanceof Float32Array);

/** Proxies from every engine plugin with a `pickProxies()` method (an @margoengine/lod `LODSystem`), in a new array. */
export function engineProxies(engine) {
  const out = [];
  // Structural engines (tests, tools) may have no plugin map.
  for (const plugin of engine.plugins?.values() ?? [])
    if (typeof plugin?.pickProxies === 'function') out.push(...plugin.pickProxies());
  return out;
}
