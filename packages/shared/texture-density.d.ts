/** A primitive's bounding sphere and, per UV set, the local length one whole texture spans on its surface. */
export interface Surface {
  centre: [number, number, number];
  radius: number;
  spans: number[];
}
export function measureSurface(vertices: Float32Array, indices: Uint32Array, uvs?: Float32Array): Surface;
export function scaleOf(m: ArrayLike<number>, o?: number): number;
