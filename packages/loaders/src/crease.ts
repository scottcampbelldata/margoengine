// Sharp edges for a mesh whose file has no normals: createMeshes and createPBRMeshes smooth only across faces within
// a crease angle of each other, so a box keeps its edges and a curved surface stays smooth.
import { creasedNormals } from '@margoengine/geometry/utils';
import { type LoadedGeometry, LoaderError } from './types.js';

/** The crease angle in degrees when none is given, as for create3MFMesh. */
const CREASE_ANGLE = 40;

/**
 * `loaded` with a normal for every corner: a vertex whose corners get different normals is copied, at the end of each
 * per-vertex array, so indices into the first vertices (lines included) keep their meaning. Groups are unchanged.
 * Returned as it is when it has normals of its own, has no triangles, or `angle` is 180.
 */
export function creased(loaded: LoadedGeometry, angle = CREASE_ANGLE): LoadedGeometry {
  if (!(angle >= 0 && angle <= 180)) throw new LoaderError('Engine', 'range', 'creaseAngle must be 0 to 180 degrees');
  const { positions, indices, normals } = loaded;
  if (loaded.kind !== 'mesh' || normals || !indices?.length || angle === 180) return loaded;
  const count = positions.length / 3;
  // A malformed mesh is left for toGeometries to refuse.
  if (indices.length % 3 || indices.some((v) => v >= count)) return loaded;
  const corners = new Float32Array(indices.length * 3);
  for (let c = 0; c < indices.length; c++)
    for (let k = 0; k < 3; k++) corners[c * 3 + k] = positions[indices[c] * 3 + k];
  const own = creasedNormals(corners, { angle, tolerance: 0 }),
    out = indices.slice(),
    /** The input vertex of each output vertex, and the first corner that gave it its normal. */
    source = Array.from({ length: count }, (_, v) => v),
    corner = new Array<number>(count).fill(-1),
    next = new Array<number>(count).fill(-1);
  for (let c = 0; c < indices.length; c++) {
    let at = indices[c];
    while (corner[at] >= 0 && ![0, 1, 2].every((k) => own[corner[at] * 3 + k] === own[c * 3 + k])) {
      if (next[at] < 0) {
        next[at] = source.length;
        source.push(indices[c]);
        corner.push(-1);
        next.push(-1);
      }
      at = next[at];
    }
    if (corner[at] < 0) corner[at] = c;
    out[c] = at;
  }
  const copied = (values: Float32Array): Float32Array => {
    const size = values.length / count;
    if (!Number.isInteger(size)) return values;
    const result = new Float32Array(source.length * size);
    result.set(values);
    for (let v = count; v < source.length; v++)
      result.set(values.subarray(source[v] * size, (source[v] + 1) * size), v * size);
    return result;
  };
  const made = new Float32Array(source.length * 3);
  corner.forEach((c, v) => {
    if (c >= 0) made.set(own.subarray(c * 3, c * 3 + 3), v * 3);
  });
  const result: LoadedGeometry = { ...loaded, positions: copied(positions), normals: made, indices: out };
  if (loaded.colors) result.colors = copied(loaded.colors);
  if (loaded.uvs) result.uvs = copied(loaded.uvs);
  if (loaded.attributes)
    result.attributes = Object.fromEntries(
      Object.entries(loaded.attributes).map(([name, values]) => [name, copied(values)]),
    );
  return result;
}
