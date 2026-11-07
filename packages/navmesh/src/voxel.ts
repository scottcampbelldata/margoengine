// A navmesh straight from voxel chunks. The blocks are already what the build's first step makes of triangles, solid
// spans in columns, so a tile reads its columns from the chunks and joins the pipeline after voxelising: no triangles
// are made, and a changed block rebuilds only the tiles that can see it.
import { type BlockType, shapeOctants, type VoxelChunk, type VoxelWorld } from '@margoengine/voxel';
import { failed, type Built, polygonise, Spans } from './pipeline.js';
import { TiledNavMesh, type TiledNavMeshOptions } from './tiles.js';

/** Options of {@link VoxelNavMesh}: those of `./tiles`, with sizes that suit blocks. */
export interface VoxelNavMeshOptions extends Omit<TiledNavMeshOptions, 'origin'> {
  /** Cell size: one block over a whole number. Default 0.5, which sees half blocks. */
  cs?: number;
  /** Cell height: one block over a whole number. Default 0.25. */
  ch?: number;
  /** Which blocks can be stood on and bump a walker. Default `BlockType.solid`. */
  solid?: (type: BlockType, state: number) => boolean;
}

const CHUNK = 32;

/**
 * A `TiledNavMesh` that reads a `VoxelWorld`. Keep it beside the world: chunks that load or unload and blocks that
 * change mark their tiles, and {@link TiledNavMesh.update} rebuilds those, as many a frame as you allow. A slab or stair
 * counts as the half blocks it fills. Unloaded chunks are air. `dispose` stops listening.
 */
export class VoxelNavMesh extends TiledNavMesh {
  private readonly world: VoxelWorld;
  private readonly isSolid: (type: BlockType, state: number) => boolean;
  /** Loaded chunk rows by column, so a tile reads only those. */
  private readonly columns = new Map<string, Set<number>>();
  private readonly stops: (() => void)[] = [];

  /**
   * Reads what is loaded and builds it, unless `deferred`.
   * @throws RangeError for invalid options, or `cs` or `ch` that do not divide a block.
   */
  constructor(world: VoxelWorld, options: VoxelNavMeshOptions = {}) {
    const { solid, deferred = false, ...rest } = options ?? {},
      cs = rest.cs ?? 0.5,
      ch = rest.ch ?? 0.25;
    for (const size of [cs, ch])
      if (!(size > 0) || Math.abs(1 / size - Math.round(1 / size)) > 1e-9)
        throw new RangeError('Voxel navmesh cell sizes must divide a block; use 1, 0.5, 0.25 and so on.');
    super([], [], { ...rest, cs, ch, origin: [0, world.minY, 0], deferred: true });
    this.world = world;
    this.isSolid = solid ?? ((type) => type.solid);
    this.stops.push(
      world.onChunk((cx, cy, cz, chunk) => {
        const name = `${cx},${cz}`;
        let rows = this.columns.get(name);
        if (chunk) {
          if (!rows) this.columns.set(name, (rows = new Set()));
          rows.add(cy);
        } else if (rows) {
          rows.delete(cy);
          if (!rows.size) this.columns.delete(name);
        }
        this.mark(cx * CHUNK, cz * CHUNK, (cx + 1) * CHUNK, (cz + 1) * CHUNK);
      }),
      world.onChange((x, _y, z) => this.mark(x, z, x + 1, z + 1)),
    );
    if (deferred) return;
    this.update();
    if (!this.polygonCount) failed('no loaded block can be walked on');
  }

  /** Marks the tiles that see an XZ box, making those that do not exist yet. */
  private mark(x0: number, z0: number, x1: number, z1: number): void {
    const reach = this.margin * this.config.cs,
      c0 = Math.floor((x0 - reach) / this.span),
      c1 = Math.floor((x1 + reach) / this.span),
      r0 = Math.floor((z0 - reach) / this.span),
      r1 = Math.floor((z1 + reach) / this.span);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.ensureTile(c, r);
    this.touch(x0, z0, x1, z1);
  }

  /** The solid spans of one cell column, from one column of blocks. */
  private readColumn(spans: Spans, column: number, wx: number, wz: number, rows: Iterable<number>): void {
    const { world, isSolid } = this,
      { ch, walkableClimb } = this.config,
      bx = Math.floor(wx),
      bz = Math.floor(wz),
      // The half of the block this cell stands in, as octant bits.
      half = (wx - bx >= 0.5 ? 1 : 0) + (wz - bz >= 0.5 ? 4 : 0),
      lx = bx & (CHUNK - 1),
      lz = bz & (CHUNK - 1),
      cx = bx >> 5,
      cz = bz >> 5,
      perBlock = Math.round(1 / ch),
      add = (low: number, high: number) =>
        spans.add(column, (low - world.minY) * perBlock, (high - world.minY) * perBlock, 1, 0, walkableClimb);
    for (const cy of rows) {
      const chunk = world.getChunk(cx, cy, cz) as VoxelChunk;
      for (let y = 0; y < CHUNK; y++) {
        const state = chunk.get(lx, y, lz);
        if (!state) continue;
        const type = world.blocks.get(state & 0xffff);
        if (!isSolid(type, state)) continue;
        const mask = shapeOctants(type, state),
          base = cy * CHUNK + y,
          low = mask & (1 << half),
          high = mask & (1 << (half + 2));
        if (low && high) add(base, base + 1);
        else if (low) add(base, base + 0.5);
        else if (high) add(base + 0.5, base + 1);
      }
    }
  }

  protected override solveTile(tile: { x: number; z: number }): Built | null {
    const grid = this.gridOf(tile),
      { width, depth, cx, cz } = grid,
      { cs } = this.config,
      spans = new Spans(width * depth);
    let any = false;
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const wx = (cx + x + 0.5) * cs,
          wz = (cz + z + 0.5) * cs,
          rows = this.columns.get(`${Math.floor(wx) >> 5},${Math.floor(wz) >> 5}`);
        if (!rows) continue;
        any = true;
        this.readColumn(
          spans,
          z * width + x,
          wx,
          wz,
          [...rows].sort((a, b) => a - b),
        );
      }
    if (!any) return null;
    const built = polygonise(spans, this.config, grid, null, 0);
    return typeof built === 'string' ? null : built;
  }

  override dispose(): void {
    for (const stop of this.stops.splice(0)) stop();
    super.dispose();
  }
}
