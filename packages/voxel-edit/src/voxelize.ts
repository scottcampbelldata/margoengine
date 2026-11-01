// Mesh to voxels: triangle-box overlap for the surface, crossing parity along x rows for the solid, median cut palette.
import type { MutableVec3 } from '@margoengine/math';
import { cellLimit, checkOptions, type GridLimits, sizeCells, type VoxelGrid } from './grid.js';

/** An RGBA8 image, the shape of `ImageData`: `width * height * 4` bytes, row 0 first (glTF's v = 0). */
export interface VoxelizeTexture {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Where voxel colours come from. `vertex` holds RGB or RGBA per vertex, bytes in a `Uint8Array` and 0 to 1 otherwise.
 * `texture` is read at nearest texel through `uvs` (two per vertex, repeating). Values reach the palette unconverted
 * and alpha is ignored.
 */
export type VoxelizeColors = { vertex: ArrayLike<number> } | { uvs: ArrayLike<number>; texture: VoxelizeTexture };

/** Options of {@link voxelizeMesh}. Pass exactly one of `voxelSize` and `size`. */
export interface VoxelizeOptions extends GridLimits {
  /** Edge of one cubic cell, in mesh units. */
  voxelSize?: number;
  /** Cells along the mesh's longest axis, a positive integer; the other axes follow with cubic cells. */
  size?: number;
  /** `'surface'` fills every cell a triangle touches; `'solid'` every cell whose centre is inside. Default `'surface'`. */
  fill?: 'surface' | 'solid';
  /** Colour source. Default none: every filled cell is index 1, white. */
  colors?: VoxelizeColors;
  /** Most palette colours, 1 to 255. Default 255. */
  paletteSize?: number;
  /** Stops the work; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link voxelizeMesh} returns. Cell (x, y, z) covers `origin + [x, y, z] * voxelSize` to one `voxelSize` above. */
export interface VoxelizedMesh {
  /** The voxels, Y up as in the mesh. */
  grid: VoxelGrid;
  /** 256 RGBA8 colours, index i at `4 * i`. */
  palette: Uint8Array;
  /** Mesh position of the grid's low corner: the low corner of the mesh's bounds. */
  origin: MutableVec3;
  /** Edge of one cell, in mesh units. */
  voxelSize: number;
  /** True when the mesh held more colours than `paletteSize`, so median cut merged some. */
  colorsReduced: boolean;
  /** With `'solid'`, x rows crossing the mesh an odd number of times: a hole in it. Their last crossing is ignored. */
  openRows: number;
}

type Rgb = (t: number, u: number, v: number, w: number) => number;

const CHANNELS = [16, 8, 0];

/**
 * Turn a triangle mesh into a voxel grid and palette, yielding to the event loop while it works. The surface fill uses
 * the triangle-box separating axis test; the solid fill counts crossings along each x row through cell centres, so a
 * closed mesh stays exact even when a ray meets a shared edge.
 *
 * @param positions xyz per vertex.
 * @param indices Three vertex indexes per triangle, or null for one triangle per three vertices.
 * @param options Cell size, fill, colours, limits and abort.
 * @returns The grid, its palette and where it sits.
 * @throws RangeError when the mesh is empty or malformed or the grid would pass `maxCells`.
 *
 * @example
 * ```ts
 * import { voxelizeMesh } from '@margoengine/voxel-edit/voxelize';
 *
 * const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
 * const { grid, palette } = await voxelizeMesh(positions, [0, 1, 2], { size: 16 });
 * console.log(grid.size, palette.length);
 * ```
 */
export async function voxelizeMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  options: VoxelizeOptions,
): Promise<VoxelizedMesh> {
  checkOptions(options, 'voxelizeMesh');
  const { signal, colors, fill = 'surface', paletteSize = 255, voxelSize, size } = options;
  signal?.throwIfAborted();
  if (fill !== 'surface' && fill !== 'solid') throw new TypeError(`fill is unknown; pass 'surface' or 'solid'`);
  if (!Number.isInteger(paletteSize) || paletteSize < 1 || paletteSize > 255)
    throw new RangeError('paletteSize is out of range; pass an integer from 1 to 255');
  if ((voxelSize === undefined) === (size === undefined))
    throw new TypeError('voxelizeMesh needs one cell size; pass voxelSize or size, not both');
  const vertexCount = positions.length / 3;
  if (!Number.isInteger(vertexCount)) throw new RangeError('positions do not hold xyz triples; pass 3 per vertex');
  const triangles = (indices ? indices.length : vertexCount) / 3;
  if (!Number.isInteger(triangles) || triangles === 0)
    throw new RangeError('The mesh holds no whole triangles; pass 3 indexes per triangle');
  const corner = (t: number, c: number) => (indices ? indices[3 * t + c] : 3 * t + c);

  const low: MutableVec3 = [Infinity, Infinity, Infinity],
    high: MutableVec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles * 3; i++) {
    const v = indices ? indices[i] : i;
    if (!Number.isInteger(v) || v < 0 || v >= vertexCount)
      throw new RangeError(`Index ${v} is outside the ${vertexCount} vertices; fix the indices`);
    for (let a = 0; a < 3; a++) {
      const p = positions[3 * v + a];
      if (!Number.isFinite(p)) throw new RangeError(`Vertex ${v} is not finite; pass finite positions`);
      if (p < low[a]) low[a] = p;
      if (p > high[a]) high[a] = p;
    }
  }
  const longest = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 1))
    throw new RangeError('size is not a cell count; pass a positive integer');
  if (voxelSize !== undefined && !(voxelSize > 0 && Number.isFinite(voxelSize)))
    throw new RangeError('voxelSize is not positive; pass a positive finite number');
  const cell = voxelSize ?? (longest / (size as number) || 1);
  // Single precision positions land a hair past a whole cell count; that hair is not another cell.
  const dims: MutableVec3 = [0, 1, 2].map((a) => {
    const cells = (high[a] - low[a]) / cell;
    return Math.max(1, Math.ceil(cells - 1e-6 * Math.max(1, cells)));
  }) as MutableVec3;
  const total = sizeCells(dims, cellLimit(options), 'Voxelized grid');
  const [sx, sy, sz] = dims;
  const voxels = new Uint8Array(total);

  // All the geometry below is in cell units: cell (x, y, z) spans x to x + 1.
  const at = new Float64Array(triangles * 9);
  for (let t = 0; t < triangles; t++)
    for (let c = 0; c < 3; c++)
      for (let a = 0; a < 3; a++) at[9 * t + 3 * c + a] = (positions[3 * corner(t, c) + a] - low[a]) / cell;

  const rgb = colors ? colorReader(colors, vertexCount, corner) : null;
  const store = rgb ? new Uint32Array(total) : null,
    nearest = rgb ? new Float32Array(total) : null;

  let tick = 0,
    last = performance.now();
  const pause = async () => {
    if (performance.now() - last < 16) return;
    await new Promise((resolve) => setTimeout(resolve));
    signal?.throwIfAborted();
    last = performance.now();
  };

  if (fill === 'surface' || rgb) {
    const axes = new Float64Array(60);
    for (let t = 0; t < triangles; t++) {
      if (!(t & 255)) await pause();
      prepareAxes(at, 9 * t, axes);
      const from = [0, 1, 2].map((a) => Math.floor(lowest(at, 9 * t, a))),
        to = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.floor(highest(at, 9 * t, a))));
      for (let a = 0; a < 3; a++) from[a] = Math.min(from[a], dims[a] - 1);
      for (let y = from[1]; y <= to[1]; y++)
        for (let z = from[2]; z <= to[2]; z++) {
          if (!(++tick & 4095)) await pause();
          for (let x = from[0]; x <= to[0]; x++) {
            if (!overlaps(axes, x + 0.5, y + 0.5, z + 0.5)) continue;
            const i = x + sx * (z + sz * y);
            if (fill === 'surface') voxels[i] = 1;
            if (rgb && store && nearest) {
              const color = sample(at, t, x + 0.5, y + 0.5, z + 0.5, rgb);
              if (!store[i] || color.distance < nearest[i]) {
                store[i] = color.packed;
                nearest[i] = color.distance;
              }
            }
          }
        }
    }
  }

  let openRows = 0;
  if (fill === 'solid') {
    const rows = new Map<number, [number, number][]>();
    for (let t = 0; t < triangles; t++) {
      if (!(t & 255)) await pause();
      const o = 9 * t,
        fromY = Math.max(0, Math.ceil(lowest(at, o, 1) - 0.5)),
        toY = Math.min(sy - 1, Math.floor(highest(at, o, 1) - 0.5)),
        fromZ = Math.max(0, Math.ceil(lowest(at, o, 2) - 0.5)),
        toZ = Math.min(sz - 1, Math.floor(highest(at, o, 2) - 0.5));
      for (let y = fromY; y <= toY; y++)
        for (let z = fromZ; z <= toZ; z++) {
          if (!covers(at, o, y + 0.5, z + 0.5)) continue;
          const key = z + sz * y;
          let row = rows.get(key);
          if (!row) rows.set(key, (row = []));
          row.push([crossingX(at, o, y + 0.5, z + 0.5), t]);
        }
    }
    for (const [key, row] of rows) {
      if (!(++tick & 255)) await pause();
      row.sort((a, b) => a[0] - b[0]);
      if (row.length & 1) openRows++;
      const z = key % sz,
        y = (key - z) / sz;
      for (let p = 0; p + 1 < row.length; p += 2) {
        const enter = row[p],
          leave = row[p + 1],
          to = Math.min(sx - 1, Math.ceil(leave[0] - 0.5) - 1);
        for (let x = Math.max(0, Math.ceil(enter[0] - 0.5)); x <= to; x++) {
          const i = x + sx * (z + sz * y);
          voxels[i] = 1;
          // An inner cell no triangle touched takes the colour of the row's nearer crossing.
          if (rgb && store && !store[i]) {
            const hit = x + 0.5 - enter[0] <= leave[0] - x - 0.5 ? enter : leave;
            store[i] = sample(at, hit[1], x + 0.5, y + 0.5, z + 0.5, rgb).packed;
          }
        }
      }
    }
  }

  const palette = new Uint8Array(1024);
  let colorsReduced = false;
  if (store) {
    const counts = new Map<number, number>();
    for (let i = 0; i < total; i++) if (voxels[i]) counts.set(store[i], (counts.get(store[i]) ?? 0) + 1);
    colorsReduced = counts.size > paletteSize;
    const lookup = medianCut(counts, paletteSize, palette);
    for (let i = 0; i < total; i++) if (voxels[i]) voxels[i] = lookup.get(store[i]) as number;
  } else palette.fill(255, 4, 8);
  signal?.throwIfAborted();
  return { grid: { size: dims, voxels }, palette, origin: low, voxelSize: cell, colorsReduced, openRows };
}

function lowest(at: Float64Array, o: number, a: number): number {
  return Math.min(at[o + a], at[o + 3 + a], at[o + 6 + a]);
}

function highest(at: Float64Array, o: number, a: number): number {
  return Math.max(at[o + a], at[o + 3 + a], at[o + 6 + a]);
}

/** Separating axes of Akenine-Moller's test past the box's own three: nine edge crosses and the normal, six values each. */
function prepareAxes(at: Float64Array, o: number, out: Float64Array): void {
  const ex = [at[o + 3] - at[o], at[o + 6] - at[o + 3], at[o] - at[o + 6]],
    ey = [at[o + 4] - at[o + 1], at[o + 7] - at[o + 4], at[o + 1] - at[o + 7]],
    ez = [at[o + 5] - at[o + 2], at[o + 8] - at[o + 5], at[o + 2] - at[o + 8]];
  let n = 0;
  const add = (x: number, y: number, z: number) => {
    const p0 = x * at[o] + y * at[o + 1] + z * at[o + 2],
      p1 = x * at[o + 3] + y * at[o + 4] + z * at[o + 5],
      p2 = x * at[o + 6] + y * at[o + 7] + z * at[o + 8];
    out[n] = x;
    out[n + 1] = y;
    out[n + 2] = z;
    out[n + 3] = Math.min(p0, p1, p2);
    out[n + 4] = Math.max(p0, p1, p2);
    out[n + 5] = (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 2;
    n += 6;
  };
  for (let e = 0; e < 3; e++) {
    add(0, -ez[e], ey[e]);
    add(ez[e], 0, -ex[e]);
    add(-ey[e], ex[e], 0);
  }
  add(ey[0] * ez[1] - ez[0] * ey[1], ez[0] * ex[1] - ex[0] * ez[1], ex[0] * ey[1] - ey[0] * ex[1]);
}

function overlaps(axes: Float64Array, cx: number, cy: number, cz: number): boolean {
  for (let n = 0; n < 60; n += 6) {
    const s = axes[n] * cx + axes[n + 1] * cy + axes[n + 2] * cz;
    if (axes[n + 3] - s > axes[n + 5] || axes[n + 4] - s < -axes[n + 5]) return false;
  }
  return true;
}

/**
 * Whether the x ray through (py, pz) meets the triangle. Each edge is read in one fixed vertex order and owns its low
 * end, so two triangles sharing an edge always agree and a closed mesh gives every row an even crossing count, also
 * for a ray exactly on a shared edge.
 */
function covers(at: Float64Array, o: number, py: number, pz: number): boolean {
  let inside = false;
  for (let e = 0; e < 3; e++) {
    let a = o + 3 * e,
      b = o + 3 * ((e + 1) % 3);
    if (at[a + 1] > at[b + 1] || (at[a + 1] === at[b + 1] && at[a + 2] > at[b + 2])) [a, b] = [b, a];
    const az = at[a + 2],
      bz = at[b + 2];
    if (az <= pz !== bz <= pz && at[a + 1] + ((pz - az) * (at[b + 1] - at[a + 1])) / (bz - az) > py) inside = !inside;
  }
  return inside;
}

/** The x where the ray through (py, pz) meets the triangle's plane, held to the triangle's own x range. */
function crossingX(at: Float64Array, o: number, py: number, pz: number): number {
  const uy = at[o + 4] - at[o + 1],
    uz = at[o + 5] - at[o + 2],
    vy = at[o + 7] - at[o + 1],
    vz = at[o + 8] - at[o + 2],
    d = uy * vz - uz * vy,
    q = py - at[o + 1],
    r = pz - at[o + 2],
    s = d ? (q * vz - r * vy) / d : 1 / 3,
    t = d ? (r * uy - q * uz) / d : 1 / 3,
    x = at[o] + s * (at[o + 3] - at[o]) + t * (at[o + 6] - at[o]);
  return Math.min(highest(at, o, 0), Math.max(lowest(at, o, 0), x));
}

/** The colour at the triangle's point closest to (px, py, pz), by clamped barycentric weights, and how far away it is. */
function sample(
  at: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
  rgb: Rgb,
): { packed: number; distance: number } {
  const o = 9 * t,
    ux = at[o + 3] - at[o],
    uy = at[o + 4] - at[o + 1],
    uz = at[o + 5] - at[o + 2],
    vx = at[o + 6] - at[o],
    vy = at[o + 7] - at[o + 1],
    vz = at[o + 8] - at[o + 2],
    qx = px - at[o],
    qy = py - at[o + 1],
    qz = pz - at[o + 2],
    uu = ux * ux + uy * uy + uz * uz,
    uv = ux * vx + uy * vy + uz * vz,
    vv = vx * vx + vy * vy + vz * vz,
    qu = qx * ux + qy * uy + qz * uz,
    qv = qx * vx + qy * vy + qz * vz,
    d = uu * vv - uv * uv;
  let b = d ? (vv * qu - uv * qv) / d : 0,
    c = d ? (uu * qv - uv * qu) / d : 0,
    a = 1 - b - c;
  a = Math.max(0, a);
  b = Math.max(0, b);
  c = Math.max(0, c);
  const sum = a + b + c;
  a /= sum;
  b /= sum;
  c /= sum;
  const dx = b * ux + c * vx - qx,
    dy = b * uy + c * vy - qy,
    dz = b * uz + c * vz - qz;
  return { packed: rgb(t, a, b, c), distance: dx * dx + dy * dy + dz * dz };
}

function colorReader(colors: VoxelizeColors, vertexCount: number, corner: (t: number, c: number) => number): Rgb {
  if (typeof colors !== 'object' || colors === null)
    throw new TypeError('colors is not a colour source; pass {vertex} or {uvs, texture}');
  const packed = (r: number, g: number, b: number) => (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
  if ('vertex' in colors) {
    const data = colors.vertex,
      stride = data.length / vertexCount,
      scale = data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 1 : 255;
    if (stride !== 3 && stride !== 4)
      throw new RangeError(`colors.vertex holds ${data.length} values; pass 3 or 4 per vertex`);
    const channel = (t: number, u: number, v: number, w: number, k: number) => {
      const value =
        u * data[stride * corner(t, 0) + k] + v * data[stride * corner(t, 1) + k] + w * data[stride * corner(t, 2) + k];
      return Math.min(255, Math.max(0, Math.round(value * scale)));
    };
    return (t, u, v, w) => packed(channel(t, u, v, w, 0), channel(t, u, v, w, 1), channel(t, u, v, w, 2));
  }
  const { uvs, texture } = colors;
  if (uvs?.length !== vertexCount * 2) throw new RangeError('colors.uvs does not match the mesh; pass 2 per vertex');
  const { width, height, data } = texture ?? {};
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data?.length !== 4 * width * height
  )
    throw new RangeError('colors.texture is not RGBA8; pass width, height and width * height * 4 bytes');
  const coord = (t: number, u: number, v: number, w: number, k: number) => {
    const value = u * uvs[2 * corner(t, 0) + k] + v * uvs[2 * corner(t, 1) + k] + w * uvs[2 * corner(t, 2) + k];
    return value - Math.floor(value);
  };
  return (t, u, v, w) => {
    const x = Math.min(width - 1, Math.floor(coord(t, u, v, w, 0) * width)),
      y = Math.min(height - 1, Math.floor(coord(t, u, v, w, 1) * height)),
      i = 4 * (x + width * y);
    return packed(data[i], data[i + 1], data[i + 2]);
  };
}

/** Heckbert's median cut over a colour histogram: writes means from index 1 of `palette`, returns colour to index. */
function medianCut(counts: Map<number, number>, limit: number, palette: Uint8Array): Map<number, number> {
  const widest = (box: [number, number][]) => {
    let best = 0,
      channel = 0;
    for (const shift of CHANNELS) {
      let low = 255,
        high = 0;
      for (const [c] of box) {
        const value = (c >>> shift) & 255;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (high - low > best) {
        best = high - low;
        channel = shift;
      }
    }
    return { box, range: best, channel };
  };
  const first = [...counts].sort((a, b) => a[0] - b[0]);
  const boxes = first.length ? [widest(first)] : [];
  while (boxes.length < limit) {
    let pick = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].range > boxes[pick].range) pick = i;
    if (!boxes[pick]?.range) break;
    const { box, channel } = boxes[pick];
    box.sort((a, b) => ((a[0] >>> channel) & 255) - ((b[0] >>> channel) & 255));
    let weight = 0;
    for (const [, n] of box) weight += n;
    let at = 0,
      sum = 0;
    while (at < box.length - 2 && sum + box[at][1] < weight / 2) sum += box[at++][1];
    const cut = at + 1;
    boxes[pick] = widest(box.slice(0, cut));
    boxes.push(widest(box.slice(cut)));
  }
  const lookup = new Map<number, number>();
  boxes.forEach(({ box }, b) => {
    let weight = 0;
    const mean = [0, 0, 0];
    for (const [c, n] of box) {
      weight += n;
      CHANNELS.forEach((shift, k) => {
        mean[k] += n * ((c >>> shift) & 255);
      });
      lookup.set(c, b + 1);
    }
    palette.set([...mean.map((m) => Math.round(m / weight)), 255], 4 * (b + 1));
  });
  return lookup;
}
