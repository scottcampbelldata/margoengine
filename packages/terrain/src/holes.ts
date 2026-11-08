// Holes and cutouts: a mask over a terrain's bounds whose hole cells the terrain does not draw, in its colour, SSR
// capture, shadow and occluder passes alike (`TerrainTextures.holes`, tested beside the terrain's own edge test), and
// that `TerrainQuery` skips (`TerrainQueryOptions.holes`). Shapes are rasterised by cell centre: a cell is a hole when
// its centre lies in the shape (the point sampling of rasterisation; polygons by the even-odd crossing rule, Shimrat
// 1962, "Algorithm 112: Position of point relative to polygon", CACM 5(8)).
import type { Terrain, TerrainOptions } from './index.js';
import type { TerrainHoleMask } from './query.js';
export type { TerrainHoleMask } from './query.js';

/**
 * A hole mask for a terrain: one byte a cell over the terrain's `origin` and `size` (255 ground, 0 hole). Cut shapes,
 * make the texture for `TerrainTextures.holes` with `texture(device)`, and send later edits with `upload(terrain)`.
 */
export class TerrainHoles implements TerrainHoleMask {
  readonly mask: Uint8Array;
  readonly #ox: number;
  readonly #oz: number;
  readonly #cx: number;
  readonly #cz: number;
  #dirty?: [number, number, number, number];
  #device?: GPUDevice;

  /**
   * @param options the terrain's `origin` and `size` (`terrain.options` fits).
   * @param columns mask cells along X, 1 to 8,192: one per heightmap cell (heightmap columns - 1) cuts holes cell by
   * cell, as `TerrainQuery` hits them exactly.
   * @param rows mask cells along Z. Default `columns`.
   * @throws RangeError for a bad size or cell count.
   */
  constructor(
    options: Pick<TerrainOptions, 'origin' | 'size'>,
    readonly columns: number,
    readonly rows = columns,
  ) {
    const [ox, oz] = options?.origin ?? [0, 0],
      size = options?.size;
    if (
      !size ||
      ![ox, oz, size[0], size[1]].every(Number.isFinite) ||
      !(size[0] > 0 && size[1] > 0) ||
      ![columns, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 8192)
    )
      throw new RangeError(
        'Invalid terrain holes; give the terrain origin and a size above 0, and whole numbers of cells from 1 to 8192.',
      );
    this.#ox = ox;
    this.#oz = oz;
    this.#cx = size[0] / columns;
    this.#cz = size[1] / rows;
    this.mask = new Uint8Array(columns * rows).fill(255);
  }

  /** Whether world (x, z) lies in a hole (false outside the mask). */
  hole(x: number, z: number): boolean {
    const u = Math.floor((x - this.#ox) / this.#cx),
      v = Math.floor((z - this.#oz) / this.#cz);
    return u >= 0 && v >= 0 && u < this.columns && v < this.rows && this.mask[v * this.columns + u] === 0;
  }

  /** Cuts (or with `hole` false, fills) the cells whose centres lie within `radius` of world (x, z). */
  circle(x: number, z: number, radius: number, hole = true): this {
    if (![x, z, radius].every(Number.isFinite) || radius < 0)
      throw new RangeError('Invalid terrain hole circle; pass a finite centre and a radius of 0 or more.');
    return this.#cells(
      x - radius,
      z - radius,
      x + radius,
      z + radius,
      hole,
      (px, pz) => (px - x) ** 2 + (pz - z) ** 2 <= radius * radius,
    );
  }

  /** Cuts (or fills) the cells whose centres lie in the world rectangle from (x0, z0) to (x1, z1). */
  rect(x0: number, z0: number, x1: number, z1: number, hole = true): this {
    if (![x0, z0, x1, z1].every(Number.isFinite))
      throw new RangeError('Invalid terrain hole rectangle; pass finite corners.');
    const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0],
      [az, bz] = z0 < z1 ? [z0, z1] : [z1, z0];
    return this.#cells(ax, az, bx, bz, hole, () => true);
  }

  /** Cuts (or fills) the cells whose centres lie inside a world XZ polygon (3 or more points, even-odd rule). */
  polygon(points: readonly (readonly [number, number])[], hole = true): this {
    if (
      !Array.isArray(points) ||
      points.length < 3 ||
      !points.every((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))
    )
      throw new RangeError('Invalid terrain hole polygon; pass 3 or more finite [x, z] points.');
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity;
    for (const [x, z] of points)
      (x0 = Math.min(x0, x)), (z0 = Math.min(z0, z)), (x1 = Math.max(x1, x)), (z1 = Math.max(z1, z));
    return this.#cells(x0, z0, x1, z1, hole, (px, pz) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, zi] = points[i],
          [xj, zj] = points[j];
        if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    });
  }

  /** Visits the cells whose centres lie in the bounds and sets those `inside` accepts. */
  #cells(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    hole: boolean,
    inside: (x: number, z: number) => boolean,
  ): this {
    const u0 = Math.max(0, Math.ceil((x0 - this.#ox) / this.#cx - 0.5)),
      v0 = Math.max(0, Math.ceil((z0 - this.#oz) / this.#cz - 0.5)),
      u1 = Math.min(this.columns - 1, Math.floor((x1 - this.#ox) / this.#cx - 0.5)),
      v1 = Math.min(this.rows - 1, Math.floor((z1 - this.#oz) / this.#cz - 0.5)),
      value = hole ? 0 : 255;
    let touched = false;
    for (let v = v0; v <= v1; v++)
      for (let u = u0; u <= u1; u++)
        if (
          inside(this.#ox + (u + 0.5) * this.#cx, this.#oz + (v + 0.5) * this.#cz) &&
          this.mask[v * this.columns + u] !== value
        ) {
          this.mask[v * this.columns + u] = value;
          touched = true;
        }
    if (touched) {
      const d = this.#dirty;
      this.#dirty = d
        ? [Math.min(d[0], u0), Math.min(d[1], v0), Math.max(d[2], u1 + 1), Math.max(d[3], v1 + 1)]
        : [u0, v0, u1 + 1, v1 + 1];
    }
    return this;
  }

  /** Makes an `r8unorm` texture of the mask for `TerrainTextures.holes` (call it in the terrain's `textures` factory). */
  texture(device: GPUDevice): GPUTexture {
    const texture = device.createTexture({ size: [this.columns, this.rows], format: 'r8unorm', usage: 6 });
    device.queue.writeTexture({ texture }, this.mask as Uint8Array<ArrayBuffer>, { bytesPerRow: this.columns }, [
      this.columns,
      this.rows,
    ]);
    this.#dirty = undefined;
    this.#device = device;
    return texture;
  }

  /**
   * Sends the cells changed since the last `texture` or `upload` to the terrain's holes texture (its `holes`, made by
   * `texture`), and invalidates its shadow. Returns whether anything was sent.
   * @throws TypeError when the terrain has no holes texture of this mask's size.
   */
  upload(terrain: Terrain): boolean {
    const texture = terrain?.holes;
    if (
      !texture ||
      !this.#device ||
      texture.width !== this.columns ||
      texture.height !== this.rows ||
      texture.format !== 'r8unorm'
    )
      throw new TypeError(
        'Terrain holes upload needs a terrain whose holes texture came from this mask; return holes.texture(device) from its textures factory.',
      );
    const d = this.#dirty;
    if (!d) return false;
    this.#dirty = undefined;
    const [u0, v0, u1, v1] = d,
      width = u1 - u0,
      rows = new Uint8Array(width * (v1 - v0));
    for (let v = v0; v < v1; v++)
      rows.set(this.mask.subarray(v * this.columns + u0, v * this.columns + u1), (v - v0) * width);
    this.#device.queue.writeTexture({ texture, origin: [u0, v0] }, rows, { bytesPerRow: width }, [width, v1 - v0]);
    terrain.invalidate();
    return true;
  }
}
