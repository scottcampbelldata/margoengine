import { GraphModel, gridDimensions, gridIndex, type GraphOptions, type GraphTile } from './graph.js';
/** Rectangular storage of axial coordinates or staggered odd/even row/column coordinates. */
export type HexLayout = 'axial' | 'odd-r' | 'even-r' | 'odd-q' | 'even-q';
/** Six side rules in paired order: E,W,SE,NW,NE,SW; prisms add +Y,-Y. */
export interface HexTile extends GraphTile {}
/** Defaults: axial layout, no wrapping and every cell active. A zero mask cell returns sentinel 65535. */
export interface HexGridOptions {
  layout?: HexLayout;
  periodic?: boolean;
  mask?: ArrayLike<number | boolean>;
}
/** Pin a tile at a stored column,row,layer coordinate. */
export interface HexPin {
  position: readonly [number, number, number];
  tile: number;
}
/** Seeded bounded search with optional fixed tile cells. */
export interface HexSolveOptions extends GraphOptions {
  pins?: readonly HexPin[];
}
const directions = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];
function layoutCheck(layout: HexLayout) {
  if (!['axial', 'odd-r', 'even-r', 'odd-q', 'even-q'].includes(layout))
    throw new RangeError('Invalid hex layout; use axial, odd-r, even-r, odd-q or even-q');
}
function axial(x: number, y: number, layout: HexLayout): [number, number] {
  return layout.endsWith('-r')
    ? [x - (y + (layout === 'even-r' ? y & 1 : -(y & 1))) / 2, y]
    : layout.endsWith('-q')
      ? [x, y - (x + (layout === 'even-q' ? x & 1 : -(x & 1))) / 2]
      : [x, y];
}
function stored(q: number, r: number, layout: HexLayout): [number, number] {
  return layout.endsWith('-r')
    ? [q + (r + (layout === 'even-r' ? r & 1 : -(r & 1))) / 2, r]
    : layout.endsWith('-q')
      ? [q, r + (q + (layout === 'even-q' ? q & 1 : -(q & 1))) / 2]
      : [q, r];
}
/** Hexagonal WFC on six-neighbor planes or eight-neighbor hex prisms, with seeded backtracking and pins. */
export class HexWFC {
  /** Copied column,row,layer dimensions. */
  readonly dimensions: readonly [number, number, number];
  /** Counts from the last solve. */
  readonly stats: { attempts: number; backtracks: number; decisions: number };
  private readonly solver: GraphModel;
  private readonly layout: HexLayout;
  private readonly periodic: boolean;
  private readonly mask: Uint8Array;
  /** 1..4096 tiles, <=1000000 cells and <=16777216 cell/tile pairs. Staggered periodic axes need an even length. */
  constructor(
    dimensions: readonly [number, number, number],
    tiles: readonly HexTile[],
    { layout = 'axial', periodic = false, mask }: HexGridOptions = {},
  ) {
    this.dimensions = gridDimensions(dimensions);
    layoutCheck(layout);
    this.layout = layout;
    this.periodic = periodic;
    const count = this.dimensions.reduce((a, b) => a * b, 1),
      faces = tiles[0]?.neighbors.length;
    if (
      typeof periodic !== 'boolean' ||
      (faces !== 6 && faces !== 8) ||
      (this.dimensions[2] > 1 && faces !== 8) ||
      count * tiles.length > 16777216 ||
      (periodic &&
        ((layout.endsWith('-r') && dimensions[1] % 2 !== 0) || (layout.endsWith('-q') && dimensions[0] % 2 !== 0)))
    )
      throw new RangeError(
        'Invalid hex grid; provide six side rules or eight prism rules and even staggered wrap dimensions within the pair limit',
      );
    if (
      mask &&
      (mask.length !== count || Array.from(mask).some((v) => v !== 0 && v !== 1 && v !== false && v !== true))
    )
      throw new RangeError('Invalid hex mask; provide one boolean or 0/1 value per stored cell');
    this.mask = mask ? Uint8Array.from(mask, Number) : new Uint8Array(count).fill(1);
    this.solver = new GraphModel(tiles, faces);
    this.stats = this.solver.stats;
  }
  private neighborIndex(i: number, d: number): number {
    if (!this.mask[i]) return -1;
    const [W, H, D] = this.dimensions,
      x = i % W,
      y = Math.floor(i / W) % H,
      z = Math.floor(i / (W * H));
    let nx = x,
      ny = y,
      nz = z;
    if (d < 6) {
      const [q, r] = axial(x, y, this.layout);
      [nx, ny] = stored(q + directions[d][0], r + directions[d][1], this.layout);
    } else nz += d === 6 ? 1 : -1;
    if (!this.periodic && (nx < 0 || nx >= W || ny < 0 || ny >= H || nz < 0 || nz >= D)) return -1;
    const wrap = (n: number, size: number) => ((n % size) + size) % size,
      j = wrap(nx, W) + W * (wrap(ny, H) + H * wrap(nz, D));
    return this.mask[j] ? j : -1;
  }
  /** Stored coordinate of a neighboring active cell, or null at an open boundary/mask hole. */
  neighbor(position: readonly [number, number, number], direction: number): readonly [number, number, number] | null {
    if (!Number.isInteger(direction) || direction < 0 || direction >= this.solver.directions)
      throw new RangeError('Invalid hex direction; use a side index 0..5 or prism index 0..7');
    const i = this.neighborIndex(gridIndex(position, this.dimensions), direction),
      [W, H] = this.dimensions;
    return i < 0 ? null : [i % W, Math.floor(i / W) % H, Math.floor(i / (W * H))];
  }
  /** Return Uint16 tile IDs in column,row,layer order; inactive cells are 65535. */
  solve({ pins = [], ...options }: HexSolveOptions = {}): Uint16Array {
    options.signal?.throwIfAborted();
    const restrictions = Array.from(pins, (p) => {
      if (!p || !Number.isInteger(p.tile) || p.tile < 0 || p.tile >= this.solver.tiles.length)
        throw new RangeError('Invalid hex pin; provide an existing tile ID and active coordinate');
      const cell = gridIndex(p.position, this.dimensions);
      if (!this.mask[cell]) throw new RangeError('Invalid hex pin; choose an active mask cell');
      return { cell, tiles: [p.tile] };
    });
    for (let i = 0; i < this.mask.length; i++) if (!this.mask[i]) restrictions.push({ cell: i, tiles: [0] });
    const result = this.solver.solve(this.mask.length, (i, d) => this.neighborIndex(i, d), restrictions, options);
    for (let i = 0; i < result.length; i++) if (!this.mask[i]) result[i] = 65535;
    return result;
  }
}
/** World-space cell center. Radius and layer height default to 1; orientation defaults to pointy. */
export function hexCellCenter(
  position: readonly [number, number, number],
  {
    layout = 'axial',
    radius = 1,
    layerHeight = 1,
    orientation = 'pointy',
  }: { layout?: HexLayout; radius?: number; layerHeight?: number; orientation?: 'pointy' | 'flat' } = {},
): [number, number, number] {
  layoutCheck(layout);
  if (
    position.length !== 3 ||
    Array.from(position).some((n) => !Number.isSafeInteger(n)) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Number.isFinite(layerHeight) ||
    layerHeight <= 0 ||
    !['pointy', 'flat'].includes(orientation)
  )
    throw new RangeError(
      'Invalid hex placement; provide safe integer coordinates, positive finite radius/height and pointy/flat orientation',
    );
  const [q, r] = axial(position[0], position[1], layout),
    out: [number, number, number] =
      orientation === 'pointy'
        ? [Math.sqrt(3) * radius * (q + r / 2), position[2] * layerHeight, 1.5 * radius * r]
        : [1.5 * radius * q, position[2] * layerHeight, Math.sqrt(3) * radius * (r + q / 2)];
  if (out.some((n) => !Number.isFinite(n)))
    throw new RangeError('Hex world coordinate overflow; reduce coordinates or scale');
  return out;
}
/** Authored six-side or eight-face socket labels; rotations default to all six, reflections default false. */
export interface HexSocketTile {
  sockets: readonly string[];
  weight?: number;
  rotations?: 'all' | 'none';
  reflections?: boolean;
}
/** Expanded socket rule and source transform, usable by an application to place hex tile geometry. */
export interface HexVariant extends HexTile {
  source: number;
  rotation: readonly number[];
  sockets: readonly string[];
}
/** Expand six 60-degree orientations and optional mirrored copies; source weights are split across orientations. */
export function buildHexSocketTiles(sources: readonly HexSocketTile[]): HexVariant[] {
  if (!sources.length || sources.length > 4096)
    throw new RangeError('Invalid hex sockets; provide 1..4096 source tiles');
  const out: HexVariant[] = [],
    ring = [0, 3, 1, 4, 5, 2],
    faces = sources[0]?.sockets.length;
  for (let source = 0; source < sources.length; source++) {
    const t = sources[source];
    if (
      !t ||
      ![6, 8].includes(faces) ||
      t.sockets.length !== faces ||
      Array.from(t.sockets).some((s) => typeof s !== 'string') ||
      !['all', 'none'].includes(t.rotations ?? 'all') ||
      (t.reflections !== undefined && typeof t.reflections !== 'boolean')
    )
      throw new RangeError(
        'Invalid hex sockets; provide matching six/eight dense string labels and all/none rotations',
      );
    const n = t.rotations === 'none' ? 1 : 6,
      copies = t.reflections ? 2 : 1,
      weight = (t.weight ?? 1) / (n * copies);
    if (!Number.isFinite(weight) || weight <= 0 || out.length + n * copies > 4096)
      throw new RangeError('Invalid hex variants; keep positive finite split weights and at most 4096 variants');
    for (let mirror = 0; mirror < copies; mirror++)
      for (let k = 0; k < n; k++) {
        const labels = [...t.sockets];
        for (let d = 0; d < 6; d++) labels[ring.indexOf(((mirror ? -ring[d] : ring[d]) - k + 12) % 6)] = t.sockets[d];
        const angle = (k * Math.PI) / 3,
          c = Math.cos(angle),
          s = Math.sin(angle),
          sign = mirror ? -1 : 1;
        out.push({
          source,
          rotation: [c, 0, -s, 0, 1, 0, sign * s, 0, sign * c],
          sockets: labels,
          weight,
          neighbors: [],
        });
      }
  }
  for (const t of out)
    t.neighbors = t.sockets.map((s, d) => out.flatMap((other, i) => (other.sockets[d ^ 1] === s ? [i] : [])));
  return out;
}
