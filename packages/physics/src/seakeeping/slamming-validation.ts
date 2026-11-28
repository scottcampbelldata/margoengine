import { hullError } from './errors.js';
import type { HullMesh } from './wetted.js';

/** Check a closed strip surface, including meshes which duplicate shared vertices at shading seams. */
export function validateSlamInputs(mesh: HullMesh, density: number, stations: number, levels: number): void {
  const { vertices, indices } = mesh ?? {};
  if (
    !vertices ||
    !indices ||
    vertices.length < 12 ||
    indices.length < 12 ||
    vertices.length % 3 !== 0 ||
    indices.length % 3 !== 0
  )
    throw hullError(
      'unsupported',
      'Slamming needs a closed hull mesh. Supply body-local vertices and closed triangles.',
    );
  if (!(density > 0 && Number.isFinite(density)))
    throw hullError('unsupported', 'Slam density is invalid. Supply finite positive kilograms per cubic metre.');
  if (
    !Number.isSafeInteger(stations) ||
    stations < 1 ||
    !Number.isSafeInteger(levels) ||
    levels < 1 ||
    (levels + 1) * stations * Float64Array.BYTES_PER_ELEMENT > 0x1_0000_0000
  )
    throw hullError(
      'unsupported',
      'Slam table dimensions are invalid. Use positive integer stations and levels within Wasm memory.',
    );

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let scale = 0;
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]!;
    if (!Number.isFinite(v))
      throw hullError('unsupported', 'A slam hull vertex is invalid. Supply finite coordinates in local metres.');
    scale = Math.max(scale, Math.abs(v));
    min[i % 3] = Math.min(min[i % 3]!, v);
    max[i % 3] = Math.max(max[i % 3]!, v);
  }
  const extent = max.map((value, i) => value - min[i]!);
  if (
    extent.some((value) => !(value > 0 && Number.isFinite(value))) ||
    !Number.isFinite(density * extent[2]! * extent[2]!)
  )
    throw hullError(
      'unsupported',
      'The slam hull has no representable breadth, height or length. Use local SI geometry and density.',
    );
  const welded = weld(vertices, Math.max(Number.MIN_VALUE, 16 * Number.EPSILON * scale));
  const edges = new Map<string, { count: number; orientation: number }>();
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    if (triangle.some((v) => !Number.isInteger(v) || v < 0 || v >= welded.length))
      throw hullError(
        'unsupported',
        'A slam triangle names a missing vertex. Keep indices inside the hull vertex array.',
      );
    const [a, b, c] = triangle.map((v) => welded[v]!) as [number, number, number];
    if (a === b || b === c || c === a) continue; // A duplicated pole can collapse one otherwise redundant triangle.
    for (const [start, end] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      const key = `${from},${to}`;
      const edge = edges.get(key) ?? { count: 0, orientation: 0 };
      edge.count++;
      edge.orientation += start < end ? 1 : -1;
      edges.set(key, edge);
    }
  }
  if (edges.size === 0 || [...edges.values()].some(({ count, orientation }) => count !== 2 || orientation !== 0))
    throw hullError(
      'unsupported',
      'The slam hull has an open or inconsistently wound seam. Close every edge with two opposite faces.',
    );
}

/** Match duplicate vertices to roundoff in body space. F64 work below still uses the mesh as supplied. */
function weld(vertices: ArrayLike<number>, span: number): Int32Array {
  const result = new Int32Array(vertices.length / 3);
  const bins = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    const x = vertices[3 * i]!;
    const y = vertices[3 * i + 1]!;
    const z = vertices[3 * i + 2]!;
    const a = Math.floor(x / span);
    const b = Math.floor(y / span);
    const c = Math.floor(z / span);
    let match = i;
    find: for (let u = -1; u <= 1; u++)
      for (let v = -1; v <= 1; v++)
        for (let w = -1; w <= 1; w++) {
          const bin = bins.get(`${a + u},${b + v},${c + w}`);
          if (!bin) continue;
          for (const point of bin)
            if (
              Math.abs(x - vertices[3 * point]!) <= span &&
              Math.abs(y - vertices[3 * point + 1]!) <= span &&
              Math.abs(z - vertices[3 * point + 2]!) <= span
            ) {
              match = point;
              break find;
            }
        }
    if (match === i) {
      const key = `${a},${b},${c}`;
      const bin = bins.get(key);
      if (bin) bin.push(i);
      else bins.set(key, [i]);
    }
    result[i] = match;
  }
  return result;
}
