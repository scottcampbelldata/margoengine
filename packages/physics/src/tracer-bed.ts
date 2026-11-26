import type { Bed } from '@margoengine/math/fields';
import { BedChange } from './earth/bed.js';
import { regionWords } from './world/memory.js';
import type { Port, Region, SolverHost } from './world/solver.js';

/** Conservative exchange between the mobile bed layer and the tracer's sediment parcels. */
export class TracerBedExchange {
  private readonly change: BedChange;
  private readonly stock: Region;
  private readonly x0: number;
  private readonly z0: number;

  constructor(
    private readonly host: SolverHost,
    private readonly bed: Bed,
    private readonly bulkDensity: number,
    thickness: number,
  ) {
    this.change = new BedChange(host, bed, 'tracer-bed-change');
    const area = this.change.area;
    this.stock = host.allocate('tracer-mobile-bed-mass', area.length * 8, 'f64', 1);
    this.x0 = bed.centre[0] - bed.width / 2;
    this.z0 = bed.centre[1] - bed.depth / 2;
    const available = this.available();
    for (let i = 0; i < area.length; i++) available[i] = bulkDensity * thickness * area[i]!;
  }

  clear(): void {
    this.change.clear();
  }

  erode(x: number, z: number, amount: number): number {
    return this.move(x, z, amount, -1);
  }

  deposit(x: number, z: number, amount: number): void {
    this.move(x, z, amount, 1);
  }

  port(tick: number): Port {
    return this.change.port(tick, this.bed.cell);
  }

  regions(): readonly Region[] {
    return [this.stock, this.change.state];
  }

  private available(): Float64Array {
    return regionWords(this.host.memory, this.stock) as Float64Array;
  }

  private move(x: number, z: number, amount: number, sign: -1 | 1): number {
    const { columns, rows, width, depth } = this.bed;
    const u = Math.min(columns, Math.max(0, ((x - this.x0) * columns) / width));
    const v = Math.min(rows, Math.max(0, ((z - this.z0) * rows) / depth));
    const column = Math.min(columns - 1, Math.floor(u));
    const row = Math.min(rows - 1, Math.floor(v));
    const a = u - column;
    const b = v - row;
    const base = (rows + 1) * column + row;
    const diagonal = a + b > 1;
    // Same two triangles as TerrainBed and the collision heightfield.
    const indices = [diagonal ? base + rows + 2 : base, base + rows + 1, base + 1];
    const weights = diagonal ? [a + b - 1, 1 - b, 1 - a] : [1 - (a + b), a, b];
    const available = this.available();
    let mass = amount;
    if (sign < 0)
      for (let i = 0; i < 3; i++) if (weights[i]! > 0) mass = Math.min(mass, available[indices[i]!]! / weights[i]!);
    const elevation = this.change.deltas;
    for (let i = 0; i < 3; i++) {
      const index = indices[i]!;
      const change = sign * mass * weights[i]!;
      available[index] = Math.max(0, available[index]! + change);
      elevation[index]! += change / (this.bulkDensity * this.change.area[index]!);
    }
    return mass;
  }
}
