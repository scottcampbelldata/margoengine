import { serve } from '../../shared/worker.js';
import { HeapWFC } from './heap.js';
import type { CellPosition } from './constraints.js';
import type { Tile } from './index.js';
import type { WorkerSolveOptions } from './worker.js';

let asset: URL;
class ReportingHeap extends HeapWFC {
  protected static override wasmURL(): URL {
    return asset;
  }
  protected override report(decisions: number, updates: number, intersections: number, attempts: number): void {
    self.postMessage({ progress: { backend: this.backend, decisions, updates, intersections, attempts } });
  }
}
serve(async (data: { dimensions: CellPosition; tiles: Tile[]; options: WorkerSolveOptions; wasmURL: string }) => {
  asset = new URL(data.wasmURL);
  const model = await ReportingHeap.create(data.dimensions, data.tiles, data.options);
  const cells = model.solve(data.options);
  self.postMessage({ progress: { backend: model.backend, ...model.stats } });
  return cells;
});
