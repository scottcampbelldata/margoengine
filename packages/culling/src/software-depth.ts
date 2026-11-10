// Clean room: Greene, Kass and Miller (1993); Hasselgren et al. (2005), docs/clean-room.md.
/** Interleaved xyz/normal vertices and triangle indices accepted by the software depth buffer. */
export interface TriangleGeometry {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/** @internal Local position extrema. */
export function localBox(geometry: TriangleGeometry, stride = 6): Float64Array {
  const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < geometry.vertices.length; i += stride)
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k], geometry.vertices[i + k]);
      box[k + 3] = Math.max(box[k + 3], geometry.vertices[i + k]);
    }
  return box;
}

/** @internal Column-major homogeneous transform. */
export function transform(m: ArrayLike<number>, x: number, y: number, z: number): number[] {
  return [0, 1, 2, 3].map((k) => m[k] * x + m[k + 4] * y + m[k + 8] * z + m[k + 12]);
}

/** CPU depth buffer. Each cell stores a far depth only when a real triangle covers its entire area. */
export class SoftwareDepthBuffer {
  readonly depth: Float64Array;
  private camera: ArrayLike<number> = new Float32Array(16);
  constructor(
    readonly width = 128,
    readonly height = 128,
  ) {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= 2048))
      throw new RangeError('Depth dimensions must be integers from 1 to 2048; choose a smaller buffer');
    this.depth = new Float64Array(width * height);
  }
  /** Start a frame using a reversed-Z view-projection matrix; previous depths are discarded. */
  clear(camera: ArrayLike<number>): void {
    if (camera.length !== 16 || !Array.from(camera).every(Number.isFinite))
      throw new TypeError('Camera must contain 16 finite values; pass a view-projection matrix');
    this.camera = camera;
    this.depth.fill(0);
  }
  /** Add real opaque triangles. Default single-sided; near-plane crossings conservatively do not occlude. */
  rasterize(geometry: TriangleGeometry, matrix: ArrayLike<number>, doubleSided = false): void {
    const { vertices, indices } = geometry;
    const points: number[][] = [];
    for (let i = 0; i < vertices.length; i += 6) {
      const p = transform(matrix, vertices[i], vertices[i + 1], vertices[i + 2]);
      points.push(transform(this.camera, p[0], p[1], p[2]));
    }
    const det =
      matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
      matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) +
      matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
    for (let i = 0; i < indices.length; i += 3) {
      const clip = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      // Crossing the near/eye plane cannot occlude safely without clipping. Keep those triangles out.
      if (clip.some((p) => !p || !p.every(Number.isFinite) || p[3] <= 1e-6 || p[2] < 0 || p[2] >= p[3])) continue;
      const p = clip.map((q) => [
        ((q[0] / q[3]) * 0.5 + 0.5) * this.width,
        (0.5 - (q[1] / q[3]) * 0.5) * this.height,
        q[2] / q[3],
      ]);
      const edge = (a: number[], b: number[], x: number, y: number) =>
        (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      const area = edge(p[0], p[1], p[2][0], p[2][1]);
      if (!area || (!doubleSided && area * det >= 0)) continue;
      const sign = Math.sign(area),
        far = Math.min(...p.map((v) => v[2])) - 1e-5,
        x0 = Math.max(0, Math.floor(Math.min(...p.map((v) => v[0])))),
        x1 = Math.min(this.width - 1, Math.floor(Math.max(...p.map((v) => v[0])))),
        y0 = Math.max(0, Math.floor(Math.min(...p.map((v) => v[1])))),
        y1 = Math.min(this.height - 1, Math.floor(Math.max(...p.map((v) => v[1]))));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          let covered = true;
          for (let e = 0; e < 3 && covered; e++) {
            const a = p[e],
              b = p[(e + 1) % 3],
              margin = 1e-4 * (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]));
            for (let c = 0; c < 4; c++) if (sign * edge(a, b, x + (c & 1), y + (c >> 1)) < margin) covered = false;
          }
          if (covered) this.depth[y * this.width + x] = Math.max(this.depth[y * this.width + x], far);
        }
    }
  }
  /** Test local [minX,minY,minZ,maxX,maxY,maxZ] bounds under an affine world matrix. Uncertainty stays visible. */
  visible(box: ArrayLike<number>, matrix: ArrayLike<number>): boolean {
    let left = Infinity,
      top = -Infinity,
      right = -Infinity,
      bottom = Infinity,
      near = 0;
    for (let i = 0; i < 8; i++) {
      const p = transform(matrix, box[i & 1 ? 3 : 0], box[i & 2 ? 4 : 1], box[i & 4 ? 5 : 2]),
        q = transform(this.camera, p[0], p[1], p[2]),
        pad = 1e-5 * (1 + Math.hypot(p[0], p[1], p[2])),
        error = [0, 1, 2, 3].map(
          (k) => pad * (Math.abs(this.camera[k]) + Math.abs(this.camera[k + 4]) + Math.abs(this.camera[k + 8])),
        );
      if (!q.every(Number.isFinite) || q[3] - error[3] <= 1e-6) return true;
      const xs = [],
        ys = [];
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          xs.push((q[0] + a * error[0]) / (q[3] + b * error[3]));
          ys.push((q[1] + a * error[1]) / (q[3] + b * error[3]));
        }
      left = Math.min(left, ...xs);
      right = Math.max(right, ...xs);
      top = Math.max(top, ...ys);
      bottom = Math.min(bottom, ...ys);
      near = Math.max(near, (q[2] + error[2]) / (q[3] - error[3]));
    }
    if (near >= 1 || left > 1 || right < -1 || bottom > 1 || top < -1) return true;
    const x0 = Math.max(0, Math.floor((left * 0.5 + 0.5) * this.width)),
      x1 = Math.min(this.width - 1, Math.floor((right * 0.5 + 0.5) * this.width)),
      y0 = Math.max(0, Math.floor((0.5 - top * 0.5) * this.height)),
      y1 = Math.min(this.height - 1, Math.floor((0.5 - bottom * 0.5) * this.height));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (near >= this.depth[y * this.width + x]) return true;
    return false;
  }
}
