// Per-vertex glTF data of one part of a split primitive. @margoengine/gltf/pbr splits a primitive with more vertices than
// `maxPartVertices` into parts (packages/gltf/src/parts.ts); each part numbers its own vertices and names the file's
// vertex of each in `part.vertexMap`. Every per-vertex accessor (JOINTS_n, WEIGHTS_n, morph target deltas, ids, UVs)
// is read through that map, so a part deforms exactly as the same vertices do in the whole primitive: skinning
// (glTF 2.0 section 3.7.3) and morphing (section 3.7.2.2) are functions of one vertex's own attributes.

const cache = new WeakMap();
/**
 * The elements of `values` (`width` numbers each) at the source vertices `vertexMap` names, in local vertex order;
 * `values` itself when there is no map. Gathered once per map and source array.
 */
export function vertexValues(values, width, vertexMap) {
  if (!vertexMap) return values;
  let bySource = cache.get(vertexMap);
  if (!bySource) cache.set(vertexMap, (bySource = new WeakMap()));
  let out = bySource.get(values);
  if (out) return out;
  out = new values.constructor(vertexMap.length * width);
  for (let k = 0; k < vertexMap.length; k++) {
    const at = vertexMap[k] * width;
    if (at + width > values.length)
      throw new RangeError('Part vertex out of range; every per-vertex accessor needs one element per vertex');
    for (let c = 0; c < width; c++) out[k * width + c] = values[at + c];
  }
  bySource.set(values, out);
  return out;
}
