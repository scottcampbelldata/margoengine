// Mesh files straight to colliders: binary and ASCII STL, and Wavefront OBJ, read from the public format descriptions (STL's 80 byte
// header, a count and 50 bytes a triangle, or `facet`/`vertex` text; OBJ's `v` and `f` lines). It runs off the step path, so it may use `Math`.
import type { ColliderOptions } from './shapes.js';

/** A triangle mesh read from a file: `vertices` as x, y, z and `indices` three to a triangle. */
export interface MeshFile {
  vertices: Float32Array;
  indices: Uint32Array;
}

/** Which collider to make of a file's mesh. */
export type MeshFileShape = 'trimesh' | 'convexHull';

const text = (input: ArrayBuffer | Uint8Array | string): string =>
  typeof input === 'string'
    ? input
    : new TextDecoder().decode(input instanceof Uint8Array ? input : new Uint8Array(input));

/** Welds triangle corners that sit at the same point, so a closed surface shares its vertices and a trimesh knows its neighbours. */
function weld(corners: number[]): MeshFile {
  const seen = new Map<string, number>(),
    vertices: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < corners.length; i += 3) {
    const key = `${corners[i]},${corners[i + 1]},${corners[i + 2]}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      seen.set(key, at);
      vertices.push(corners[i]!, corners[i + 1]!, corners[i + 2]!);
    }
    indices.push(at);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/**
 * Reads an STL file, binary or ASCII, into a welded triangle mesh.
 * @throws RangeError for a file that is neither, or that holds no triangle.
 */
export function parseSTL(input: ArrayBuffer | Uint8Array | string): MeshFile {
  const corners: number[] = [];
  if (typeof input !== 'string') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        count = view.getUint32(80, true);
      if (84 + count * 50 === bytes.length) {
        for (let t = 0; t < count; t++)
          for (let v = 0; v < 3; v++)
            for (let c = 0; c < 3; c++) corners.push(view.getFloat32(84 + t * 50 + 12 + v * 12 + c * 4, true));
        return finish(corners, 'STL');
      }
    }
  }
  for (const line of text(input).split(/\r?\n/)) {
    const part = line.trim().split(/\s+/);
    if (part[0]?.toLowerCase() === 'vertex' && part.length >= 4)
      corners.push(Number(part[1]), Number(part[2]), Number(part[3]));
  }
  return finish(corners, 'STL');
}

/**
 * Reads a Wavefront OBJ file into a triangle mesh: `v` lines are vertices, `f` lines faces of any size (fanned from their first corner),
 * with 1-based or negative (from the end) indices and `v/vt/vn` corners; everything else is ignored.
 * @throws RangeError for a face that names a vertex the file does not have, or a file with no triangle.
 */
export function parseOBJ(input: ArrayBuffer | Uint8Array | string): MeshFile {
  const vertices: number[] = [],
    indices: number[] = [];
  for (const line of text(input).split(/\r?\n/)) {
    const part = line.trim().split(/\s+/);
    if (part[0] === 'v') vertices.push(Number(part[1]), Number(part[2]), Number(part[3]));
    else if (part[0] === 'f') {
      const face = part.slice(1).map((corner) => {
        const n = Number.parseInt(corner.split('/')[0]!, 10),
          have = vertices.length / 3,
          at = n < 0 ? have + n : n - 1;
        if (!(at >= 0 && at < have))
          throw new RangeError(`An OBJ face names vertex ${n}, which the file does not have; fix the face line.`);
        return at;
      });
      for (let k = 1; k + 1 < face.length; k++) indices.push(face[0]!, face[k]!, face[k + 1]!);
    }
  }
  if (!indices.length || !vertices.every(Number.isFinite))
    throw new RangeError('The OBJ file holds no triangle with finite vertices; pass a file with `v` and `f` lines.');
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

function finish(corners: number[], name: string): MeshFile {
  if (!corners.length || !corners.every(Number.isFinite))
    throw new RangeError(
      `The ${name} file holds no triangle with finite vertices; pass a binary or ASCII ${name} file.`,
    );
  return weld(corners);
}

/**
 * The collider options for a mesh file, ready for `physics.addBody`: a `trimesh` of it (the default, for fixed bodies) or the convex
 * hull of its points (for a dynamic body). `format` is read from the file when left out: STL if it starts `solid` or has an STL size, else OBJ.
 * @throws RangeError for a file that cannot be read.
 */
export function meshFileCollider(
  input: ArrayBuffer | Uint8Array | string,
  options: { format?: 'stl' | 'obj'; shape?: MeshFileShape } = {},
): ColliderOptions {
  const head = text(
    typeof input === 'string'
      ? input.slice(0, 64)
      : new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input)).slice(0, 64),
  );
  const format = options.format ?? (/^\s*(v |#|o |g )/.test(head) ? 'obj' : 'stl'),
    mesh = format === 'obj' ? parseOBJ(input) : parseSTL(input);
  if (options.shape === 'convexHull') return { shape: 'convexHull', points: mesh.vertices } as ColliderOptions;
  return { shape: 'trimesh', vertices: mesh.vertices, indices: mesh.indices } as ColliderOptions;
}
