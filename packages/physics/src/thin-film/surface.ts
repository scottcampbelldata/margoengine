import { hypot } from '@margoengine/math/pinned';
import { cross } from '@margoengine/math/vec3';

type Vec3 = readonly [number, number, number];

/** Renderer mesh of the free surface, in the same plane and units used to create the film. */
export interface ThinFilmSurfaceGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

/** Reconstruct the cell-centred film, extending the outermost cells to the actual patch boundary. */
export function makeFilmSurface(
  nx: number,
  ny: number,
  spacing: number,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  depth: Float64Array,
  substrate: Float64Array,
): ThinFilmSurfaceGeometry {
  if (!depth.some((h) => h > 0))
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  const width = nx + 2;
  const count = width * (ny + 2);
  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array(2 * count);
  const indices: number[] = [];
  const normal = cross(u, v);
  const patchWidth = nx * spacing;
  const patchHeight = ny * spacing;
  const height = (x: number, y: number) => {
    const i = x + y * nx;
    return substrate[i]! + depth[i]!;
  };
  const wet = new Uint8Array(count);
  for (let j = 0; j < ny + 2; j++) {
    const y = Math.max(0, Math.min(ny - 1, j - 1));
    const loY = Math.max(0, y - 1);
    const hiY = Math.min(ny - 1, y + 1);
    const alongV = Math.max(0, Math.min(patchHeight, (j - 0.5) * spacing));
    for (let i = 0; i < width; i++) {
      const x = Math.max(0, Math.min(nx - 1, i - 1));
      const loX = Math.max(0, x - 1);
      const hiX = Math.min(nx - 1, x + 1);
      const alongU = Math.max(0, Math.min(patchWidth, (i - 0.5) * spacing));
      const at = i + j * width;
      const h = height(x, y);
      const slopeU = loX === hiX ? 0 : (height(hiX, y) - height(loX, y)) / ((hiX - loX) * spacing);
      const slopeV = loY === hiY ? 0 : (height(x, hiY) - height(x, loY)) / ((hiY - loY) * spacing);
      const invLength = 1 / hypot(1, slopeU, slopeV);
      for (let axis = 0; axis < 3; axis++) {
        positions[at * 3 + axis] = origin[axis]! + alongU * u[axis]! + alongV * v[axis]! + h * normal[axis]!;
        normals[at * 3 + axis] = (normal[axis]! - slopeU * u[axis]! - slopeV * v[axis]!) * invLength;
      }
      uvs[2 * at] = alongU / patchWidth;
      uvs[2 * at + 1] = 1 - alongV / patchHeight;
      wet[at] = Number(depth[x + y * nx]! > 0);
      if (i > 0 && j > 0) {
        const top = at - width;
        const left = at - 1;
        const corner = top - 1;
        if (wet[corner] || wet[top] || wet[left]) indices.push(corner, top, left);
        if (wet[top] || wet[at] || wet[left]) indices.push(top, at, left);
      }
    }
  }
  return { positions, normals, uvs, indices: Uint32Array.from(indices) };
}
