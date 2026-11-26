import type { Bed } from '@margoengine/math/fields';
import { BedChange, bedVertexCount } from '../earth/bed.js';
import { regionWords } from '../world/memory.js';
import type { Cell, Port, Region, SolverHost } from '../world/solver.js';

export type LayerRaster = (
  points: number,
  count: number,
  grid: number,
  columns: number,
  rows: number,
  volumes: number,
) => void;

/** Converts changes in the layer's material volume into shared bed-height changes. */
export class GranularLayer {
  private readonly change: BedChange;
  private readonly shape: Region;
  private readonly previous: Region;
  private readonly next: Region;
  private readonly installation: Region;

  constructor(
    private readonly host: SolverHost,
    private readonly bed: Bed,
    private readonly cellSize: number,
    private readonly raster: LayerRaster,
  ) {
    const count = bedVertexCount(bed);
    const allocate = (name: string, size: number) => host.allocate(name, 8 * size, 'f64', 1);
    this.change = new BedChange(host, bed, 'granular-layer-bedChange');
    this.shape = allocate('granular-layer-grid', 6);
    this.previous = allocate('granular-layer-prior-volume', count);
    this.next = allocate('granular-layer-volume-trial', count);
    this.installation = allocate('granular-layer-seeded', 1);
    this.words(this.shape).set([
      bed.centre[0] - bed.width / 2.0,
      bed.centre[1] - bed.depth / 2.0,
      bed.columns / bed.width,
      bed.rows / bed.depth,
      0,
      0,
    ]);
  }

  seed(points: Region, count: number, cell: Cell): void {
    if (this.words(this.installation)[0] !== 0) return;
    this.evaluate(points, count, cell, this.previous);
    this.words(this.installation)[0] = 1;
  }

  update(points: Region, count: number, cell: Cell): void {
    this.evaluate(points, count, cell, this.next);
    const current = this.words(this.next);
    const previous = this.words(this.previous);
    const delta = this.change.deltas;
    const area = this.change.area;
    for (let i = 0; i < area.length; i++) delta[i] = (current[i]! - previous[i]!) / area[i]!;
    previous.set(current);
  }

  port(tick: number): Port {
    return this.change.port(tick, this.bed.cell);
  }

  regions(): readonly Region[] {
    return [this.previous, this.installation, this.change.state];
  }

  private evaluate(points: Region, count: number, cell: Cell, volume: Region): void {
    const shape = this.words(this.shape);
    shape[4] = (cell[0] - this.bed.cell[0]) * this.cellSize;
    shape[5] = (cell[2] - this.bed.cell[2]) * this.cellSize;
    this.raster(points.byteOffset, count, this.shape.byteOffset, this.bed.columns, this.bed.rows, volume.byteOffset);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }
}
