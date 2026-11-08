// Height, normal and ray queries on a terrain's heightmap (entry `@margoengine/terrain/query`), on the CPU, against the
// surface the clipmap's vertex shader samples: bilinear between texels, texel (0, 0) at `origin` and the last texel at
// `origin + size`, times `heightScale` plus `heightOffset` (shader.ts `height`). Rays run down an implicit min-max
// quadtree over the cells (the maximum mipmap of Tevs, Ihrke and Seidel, "Maximum Mipmaps for Fast, Accurate, and
// Scalable Dynamic Height Field Rendering", I3D 2008), nearest child first; a cell's bilinear patch is hit exactly,
// the height along a ray being quadratic in its distance (the ray and bilinear patch of Ramsey, Potter and Hansen,
// "Ray Bilinear Patch Intersections", Journal of Graphics Tools 9(3), 2004, for a patch over a square). Our own code
// from those descriptions.
import type { EngineKernel } from '@margoengine/core';
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { margoError } from '../../shared/errors.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUTextureUsage: { COPY_SRC: number };

/** Where the heights lie and how they scale: the fields of the same name in `TerrainOptions`, so `terrain.options` fits. */
export interface TerrainQueryOptions {
  /** World XZ of the heightmap's minimum corner (its first texel). Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /** World XZ extent the heightmap covers, each above 0 (its last texel sits at `origin + size`). */
  readonly size: readonly [number, number];
  /** World Y per height sample unit. Default 100. */
  readonly heightScale?: number;
  /** World Y added to every height. Default 0. */
  readonly heightOffset?: number;
  /**
   * Hole cells to skip, as the terrain drops them (`TerrainTextures.holes`): a `TerrainHoles` from
   * `@margoengine/terrain/holes` fits. Read live, so later cuts apply without a refresh. Default none.
   */
  readonly holes?: TerrainHoleMask;
}
/** A hole mask over the heightmap's bounds: `columns * rows` bytes, row by row along +Z, 0 for a hole. */
export interface TerrainHoleMask {
  readonly mask: Uint8Array;
  readonly columns: number;
  readonly rows: number;
}
/** A ray's first hit on the terrain. Its shape is `@margoengine/animator`'s `GroundHit`, so it plants feet as it is. */
export interface TerrainHit {
  /** World distance from the ray's origin. */
  distance: number;
  /** World point of the hit. */
  position: MutableVec3;
  /** Unit shading normal there, as the terrain's vertex shader works it out (see `TerrainQuery.normal`). */
  normal: MutableVec3;
}
/** Settings of {@link TerrainQuery.read}. */
export interface TerrainReadOptions {
  /** Stops the wait for the GPU read; the promise then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}
/** What {@link TerrainQuery.read} needs of a `Terrain`: its options and its heightmap texture. */
export interface TerrainHeightSource {
  readonly options: TerrainQueryOptions;
  readonly heightmap: GPUTexture | undefined;
}

const MAX = 16384;

/**
 * Height, normal and first-hit ray queries on a terrain's heights, for picking, foot placement and game logic. Answers
 * the surface `Terrain` samples in its vertex shader; the clipmap draws it as triangles at its own cell spacing, so a
 * drawn point lies within that triangulation's error of the answer. Holds the heights it is given (no copy) and a
 * min-max tree of two thirds of their count in floats; call `refresh` after changing heights in place. CPU only, no allocation
 * per query when an `out` is passed.
 * @throws RangeError when the grid or the options are out of range.
 */
export class TerrainQuery {
  /** Height samples, row by row (`columns` per row), in heightmap units: world Y is `sample * heightScale + heightOffset`. */
  readonly heights: Float32Array;
  readonly columns: number;
  readonly rows: number;
  private readonly ox: number;
  private readonly oz: number;
  private readonly sx: number;
  private readonly sz: number;
  /** World size of one cell (texel spacing). */
  private readonly dx: number;
  private readonly dz: number;
  private readonly scale: number;
  private readonly offset: number;
  private readonly holes?: TerrainHoleMask;
  /** Min-max levels from 1 up; level l's node (i, j) covers cells [i << l, (i + 1) << l) each way, [min, max] pairs. */
  private readonly levels: Float32Array[] = [];
  private readonly widths: number[] = [];
  private readonly stack: Int32Array;
  private readonly order = new Float64Array(8);

  /**
   * @param heights `columns * rows` finite samples, row by row from the `origin` corner along +X, rows along +Z, the
   * layout `queue.writeTexture` uploads to the heightmap.
   */
  constructor(heights: Float32Array, columns: number, rows: number, options: TerrainQueryOptions) {
    if (
      !(heights instanceof Float32Array) ||
      ![columns, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= MAX) ||
      heights.length !== columns * rows
    )
      throw new RangeError(
        `Invalid terrain query grid; pass a Float32Array of columns * rows samples, each count an integer 2..${MAX}.`,
      );
    const origin = options?.origin ?? [0, 0],
      size = options?.size;
    this.scale = options?.heightScale ?? 100;
    this.offset = options?.heightOffset ?? 0;
    if (
      !size ||
      ![origin[0], origin[1], size[0], size[1], this.scale, this.offset].every(Number.isFinite) ||
      !(size[0] > 0 && size[1] > 0)
    )
      throw new RangeError(
        'Invalid terrain query options; give a size above 0 each way and a finite origin, heightScale and heightOffset.',
      );
    const holes = options?.holes;
    if (
      holes !== undefined &&
      (!(holes?.mask instanceof Uint8Array) ||
        !Number.isInteger(holes.columns) ||
        !Number.isInteger(holes.rows) ||
        holes.columns < 1 ||
        holes.rows < 1 ||
        holes.mask.length !== holes.columns * holes.rows)
    )
      throw new RangeError('Invalid terrain query holes; pass a mask of columns * rows bytes (a TerrainHoles fits).');
    this.holes = holes;
    this.heights = heights;
    this.columns = columns;
    this.rows = rows;
    [this.ox, this.oz] = origin;
    [this.sx, this.sz] = size;
    this.dx = size[0] / (columns - 1);
    this.dz = size[1] / (rows - 1);
    let w = columns - 1,
      h = rows - 1;
    while (w > 1 || h > 1) {
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
      this.widths.push(w);
      this.levels.push(new Float32Array(w * h * 2));
    }
    this.stack = new Int32Array(3 * (3 * (this.levels.length + 1) + 4));
    this.refresh();
  }

  /**
   * Reads a live terrain's heightmap back from the GPU into a new query, once (later edits to the texture need a new
   * read or `refresh` on your own copy). The heightmap needs `GPUTextureUsage.COPY_SRC`; `r32float`, `rgba16float` and
   * `rgba8unorm` (R channel, 0..1) are read as the shader reads them.
   * @throws MargoError `'state'` when the terrain has no heightmap yet (attach it first) or it lacks COPY_SRC.
   */
  static async read(
    engine: EngineKernel,
    terrain: TerrainHeightSource,
    { signal }: TerrainReadOptions = {},
  ): Promise<TerrainQuery> {
    signal?.throwIfAborted();
    const device = (engine as { gpu?: GPUDevice }).gpu,
      texture = terrain?.heightmap;
    if (!device || !texture || !(texture.usage & GPUTextureUsage.COPY_SRC))
      throw margoError(
        'state',
        'TerrainQuery.read needs an attached WebGPU Terrain whose heightmap has GPUTextureUsage.COPY_SRC; add it in your textures factory or pass the heights to new TerrainQuery',
      );
    const bytes = { r32float: 4, rgba16float: 8, rgba8unorm: 4 }[texture.format as string];
    if (!bytes)
      throw new TypeError(
        'Unsupported heightmap format for TerrainQuery.read; use r32float, rgba16float or rgba8unorm, or pass the heights to new TerrainQuery',
      );
    const columns = texture.width,
      rows = texture.height,
      stride = Math.ceil((columns * bytes) / 256) * 256,
      buffer = device.createBuffer({ size: stride * rows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride, rowsPerImage: rows }, [columns, rows]);
      device.queue.submit([encoder.finish()]);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        buffer.mapAsync(GPUMapMode.READ).then(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          (error: unknown) => {
            signal?.removeEventListener('abort', abort);
            reject(error);
          },
        );
      });
      const view = new DataView(buffer.getMappedRange()),
        heights = new Float32Array(columns * rows);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < columns; x++) {
          const at = y * stride + x * bytes;
          heights[y * columns + x] =
            bytes === 8
              ? half(view.getUint16(at, true))
              : texture.format === 'r32float'
                ? view.getFloat32(at, true)
                : view.getUint8(at) / 255;
        }
      buffer.unmap();
      return new TerrainQuery(heights, columns, rows, terrain.options);
    } finally {
      buffer.destroy();
    }
  }

  /**
   * Rebuilds the min-max tree over a rectangle of samples after you changed `heights` in place (the whole grid by
   * default). Costs about the rectangle's sample count.
   * @throws RangeError when a sample is not finite.
   */
  refresh(x = 0, z = 0, width = this.columns - x, depth = this.rows - z): void {
    const c = this.columns,
      cells = c - 1,
      cellRows = this.rows - 1,
      x0 = Math.max(0, Math.floor(x) - 1),
      z0 = Math.max(0, Math.floor(z) - 1),
      x1 = Math.min(cells - 1, Math.ceil(x + width) - 1),
      z1 = Math.min(cellRows - 1, Math.ceil(z + depth) - 1),
      data = this.heights;
    if (x1 < x0 || z1 < z0) return;
    for (let j = Math.max(0, Math.floor(z)); j < Math.min(this.rows, Math.ceil(z + depth)); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(c, Math.ceil(x + width)); i++)
        if (!Number.isFinite(data[j * c + i]))
          throw new RangeError(
            `Terrain query height at (${i}, ${j}) is not finite; write finite heights before refresh`,
          );
    // Level 1 from the samples: node (i, j) covers samples [2i, min(2i + 2, cells)] each way.
    for (let l = 0; l < this.levels.length; l++) {
      const level = this.levels[l],
        w = this.widths[l],
        h = level.length / 2 / w,
        a0 = x0 >> (l + 1),
        b0 = z0 >> (l + 1),
        a1 = Math.min(w - 1, x1 >> (l + 1)),
        b1 = Math.min(h - 1, z1 >> (l + 1));
      for (let j = b0; j <= b1; j++)
        for (let i = a0; i <= a1; i++) {
          let lo = Infinity,
            hi = -Infinity;
          if (l === 0) {
            for (let y = 2 * j; y <= Math.min(2 * j + 2, cellRows); y++)
              for (let s = 2 * i; s <= Math.min(2 * i + 2, cells); s++) {
                const v = data[y * c + s];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
          } else {
            const below = this.levels[l - 1],
              bw = this.widths[l - 1],
              bh = below.length / 2 / bw;
            for (let y = 2 * j; y < Math.min(2 * j + 2, bh); y++)
              for (let s = 2 * i; s < Math.min(2 * i + 2, bw); s++) {
                const k = (y * bw + s) * 2;
                if (below[k] < lo) lo = below[k];
                if (below[k + 1] > hi) hi = below[k + 1];
              }
          }
          level[(j * w + i) * 2] = lo;
          level[(j * w + i) * 2 + 1] = hi;
        }
    }
  }

  /** World height at world (x, z), or undefined outside the heightmap's rectangle (where the terrain draws nothing). */
  height(x: number, z: number): number | undefined {
    if (!(x >= this.ox && x <= this.ox + this.sx && z >= this.oz && z <= this.oz + this.sz) || this.hole(x, z))
      return undefined;
    return this.sample(x, z);
  }

  /**
   * Unit shading normal at world (x, z), as the vertex shader works it out without a normal map: central differences
   * of the height one texel either way (heights clamped at the edges). Undefined outside the heightmap's rectangle.
   */
  normal(x: number, z: number, out: MutableVec3 = [0, 0, 0]): MutableVec3 | undefined {
    if (!(x >= this.ox && x <= this.ox + this.sx && z >= this.oz && z <= this.oz + this.sz) || this.hole(x, z))
      return undefined;
    const nx = (this.sample(x - this.dx, z) - this.sample(x + this.dx, z)) / (2 * this.dx),
      nz = (this.sample(x, z - this.dz) - this.sample(x, z + this.dz)) / (2 * this.dz),
      length = Math.hypot(nx, 1, nz);
    out[0] = nx / length;
    out[1] = 1 / length;
    out[2] = nz / length;
    return out;
  }

  /**
   * The first point where a ray from world `origin` along `direction` (any length above 0) meets the terrain within
   * `maxDistance`, from above or below, or null. Inside the heightmap's rectangle only. Pass `out` to reuse a hit.
   * `(origin, direction) => query.raycast(origin, direction)` is a `FootIK` raycast as it is.
   * @throws TypeError when the origin or direction is not finite or the direction has no length.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance = Infinity, out?: TerrainHit): TerrainHit | null {
    const length = Math.hypot(direction?.[0], direction?.[1], direction?.[2]);
    if (!(length > 0 && Number.isFinite(length)) || ![origin?.[0], origin?.[1], origin?.[2]].every(Number.isFinite))
      throw new TypeError('Invalid terrain raycast; pass a finite origin and a finite direction of length above 0');
    if (!(maxDistance >= 0)) return null;
    const ox = origin[0],
      oy = origin[1],
      oz = origin[2],
      vx = direction[0] / length,
      vy = direction[1] / length,
      vz = direction[2] / length,
      ix = 1 / vx,
      iz = 1 / vz,
      iy = 1 / vy,
      cells = this.columns - 1,
      cellRows = this.rows - 1,
      stack = this.stack,
      top = this.levels.length,
      order = this.order;
    let sp = 0;
    stack[sp++] = top;
    stack[sp++] = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const j = stack[--sp],
        i = stack[--sp],
        l = stack[--sp],
        cx0 = i << l,
        cz0 = j << l,
        cx1 = Math.min((i + 1) << l, cells),
        cz1 = Math.min((j + 1) << l, cellRows);
      let lo: number, hi: number;
      if (l === 0) {
        const c = this.columns,
          d = this.heights,
          a = d[cz0 * c + cx0],
          b = d[cz0 * c + cx0 + 1],
          e = d[(cz0 + 1) * c + cx0],
          f = d[(cz0 + 1) * c + cx0 + 1];
        lo = Math.min(a, b, e, f);
        hi = Math.max(a, b, e, f);
      } else {
        const level = this.levels[l - 1],
          k = (j * this.widths[l - 1] + i) * 2;
        lo = level[k];
        hi = level[k + 1];
      }
      const y0 = this.scale >= 0 ? lo * this.scale + this.offset : hi * this.scale + this.offset,
        y1 = this.scale >= 0 ? hi * this.scale + this.offset : lo * this.scale + this.offset;
      // Slab test of the node's box: columns in XZ, the node's height range in Y.
      let t0 = 0,
        t1 = maxDistance;
      const xa = this.ox + cx0 * this.dx,
        xb = this.ox + cx1 * this.dx,
        za = this.oz + cz0 * this.dz,
        zb = this.oz + cz1 * this.dz;
      if (vx !== 0) {
        const p = (xa - ox) * ix,
          q = (xb - ox) * ix;
        t0 = Math.max(t0, Math.min(p, q));
        t1 = Math.min(t1, Math.max(p, q));
      } else if (ox < xa || ox > xb) continue;
      if (vz !== 0) {
        const p = (za - oz) * iz,
          q = (zb - oz) * iz;
        t0 = Math.max(t0, Math.min(p, q));
        t1 = Math.min(t1, Math.max(p, q));
      } else if (oz < za || oz > zb) continue;
      if (vy !== 0) {
        const p = (y0 - oy) * iy,
          q = (y1 - oy) * iy;
        t0 = Math.max(t0, Math.min(p, q));
        t1 = Math.min(t1, Math.max(p, q));
      } else if (oy < y0 || oy > y1) continue;
      if (t0 > t1) continue;
      if (l === 0) {
        // The cell's box interval [t0, t1] (finite: a ray is not both vertical and horizontal) holds any hit on its
        // patch, whose height along the ray is quadratic in t.
        const t = this.patch(cx0, cz0, ox, oy, oz, vx, vy, vz, t0, t1);
        if (t === undefined) continue;
        const px = ox + vx * t,
          pz = oz + vz * t;
        // A hit in a hole cell passes through, as the drawn terrain has no ground there.
        if (this.hole(px, pz)) continue;
        const hit = out ?? { distance: 0, position: [0, 0, 0], normal: [0, 0, 0] };
        hit.distance = t;
        hit.position[0] = px;
        hit.position[1] = oy + vy * t;
        hit.position[2] = pz;
        const x = Math.min(Math.max(px, this.ox), this.ox + this.sx),
          z = Math.min(Math.max(pz, this.oz), this.oz + this.sz);
        this.normal(x, z, hit.normal);
        return hit;
      }
      // Children, nearest column first: pushed far to near so the nearest pops next.
      let n = 0;
      for (let b = 0; b < 2; b++)
        for (let a = 0; a < 2; a++) {
          const ci = 2 * i + a,
            cj = 2 * j + b,
            span = 1 << (l - 1);
          if (ci * span >= cells || cj * span >= cellRows) continue;
          const xa2 = this.ox + ci * span * this.dx,
            xb2 = this.ox + Math.min((ci + 1) * span, cells) * this.dx,
            za2 = this.oz + cj * span * this.dz,
            zb2 = this.oz + Math.min((cj + 1) * span, cellRows) * this.dz;
          let e = 0;
          if (vx !== 0) e = Math.max(e, Math.min((xa2 - ox) * ix, (xb2 - ox) * ix));
          if (vz !== 0) e = Math.max(e, Math.min((za2 - oz) * iz, (zb2 - oz) * iz));
          let k = n++;
          while (k > 0 && order[(k - 1) * 2] < e) {
            order[k * 2] = order[(k - 1) * 2];
            order[k * 2 + 1] = order[(k - 1) * 2 + 1];
            k--;
          }
          order[k * 2] = e;
          order[k * 2 + 1] = b * 2 + a;
        }
      for (let k = 0; k < n; k++) {
        const q = order[k * 2 + 1];
        stack[sp++] = l - 1;
        stack[sp++] = 2 * i + (q & 1);
        stack[sp++] = 2 * j + (q >> 1);
      }
    }
    return null;
  }

  /** Smallest t in [t0, t1] where the ray meets cell (cx, cz)'s bilinear patch, or undefined. */
  private patch(
    cx: number,
    cz: number,
    ox: number,
    oy: number,
    oz: number,
    vx: number,
    vy: number,
    vz: number,
    t0: number,
    t1: number,
  ): number | undefined {
    const c = this.columns,
      d = this.heights,
      s = this.scale,
      o = this.offset,
      h00 = d[cz * c + cx] * s + o,
      h10 = d[cz * c + cx + 1] * s + o,
      h01 = d[(cz + 1) * c + cx] * s + o,
      h11 = d[(cz + 1) * c + cx + 1] * s + o,
      // Cell coordinates at t0 and their rates, so the polynomial is in r = t - t0 (no cancellation on long rays).
      u = (ox + vx * t0 - (this.ox + cx * this.dx)) / this.dx,
      v = (oz + vz * t0 - (this.oz + cz * this.dz)) / this.dz,
      du = vx / this.dx,
      dv = vz / this.dz,
      b = h10 - h00,
      e = h01 - h00,
      k = h00 - h10 - h01 + h11,
      // f(r) = ray y - patch height = A r^2 + B r + C.
      A = -k * du * dv,
      B = vy - (b * du + e * dv + k * (u * dv + v * du)),
      C = oy + vy * t0 - (h00 + b * u + e * v + k * u * v),
      span = t1 - t0,
      tol = 1e-9 * Math.max(1, span);
    if (Math.abs(C) <= 1e-12 * Math.max(1, Math.abs(h00), Math.abs(oy))) return t0;
    let r: number | undefined;
    if (A === 0 || Math.abs(A) * span <= 1e-12 * Math.abs(B)) {
      if (B !== 0) r = -C / B;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) return undefined;
      const q = -0.5 * (B + (B >= 0 ? 1 : -1) * Math.sqrt(disc)),
        r1 = q / A,
        r2 = q !== 0 ? C / q : r1;
      const lo = Math.min(r1, r2),
        hi = Math.max(r1, r2);
      r = lo >= -tol ? lo : hi;
    }
    if (r === undefined || r < -tol || r > span + tol) return undefined;
    return t0 + Math.min(Math.max(r, 0), span);
  }

  /** Bilinear world height at (x, z), clamped to the heightmap like the shader's `height`. */
  /** Whether world (x, z) is in a hole cell of `holes` (the cell the terrain's fragment test reads there). */
  private hole(x: number, z: number): boolean {
    const h = this.holes;
    if (!h) return false;
    const u = Math.min(Math.max(Math.floor(((x - this.ox) / this.sx) * h.columns), 0), h.columns - 1),
      v = Math.min(Math.max(Math.floor(((z - this.oz) / this.sz) * h.rows), 0), h.rows - 1);
    return h.mask[v * h.columns + u] < 128;
  }

  private sample(x: number, z: number): number {
    const c = this.columns,
      px = Math.min(Math.max((x - this.ox) / this.sx, 0), 1) * (c - 1),
      pz = Math.min(Math.max((z - this.oz) / this.sz, 0), 1) * (this.rows - 1),
      x0 = Math.floor(px),
      z0 = Math.floor(pz),
      x1 = Math.min(x0 + 1, c - 1),
      z1 = Math.min(z0 + 1, this.rows - 1),
      tx = px - x0,
      tz = pz - z0,
      d = this.heights,
      a = d[z0 * c + x0] + (d[z0 * c + x1] - d[z0 * c + x0]) * tx,
      b = d[z1 * c + x0] + (d[z1 * c + x1] - d[z1 * c + x0]) * tx;
    return (a + (b - a) * tz) * this.scale + this.offset;
  }
}

/** IEEE 754 binary16 bits to a number. */
function half(bits: number): number {
  const exponent = (bits >> 10) & 31,
    mantissa = bits & 1023,
    sign = bits & 32768 ? -1 : 1;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
