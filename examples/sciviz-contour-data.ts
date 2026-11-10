import type { ContourGrid } from '@margoengine/sciviz/contour';

/** Original NASA TMR FUN3D x=0.3 slice, Tecplot BLOCK FEQuadrilateral. */
export function readBumpSlice(text: string): ContourGrid {
  const count = /Nodes=(\d+), Elements=(\d+)/.exec(text);
  if (!count) throw new TypeError('Expected the NASA bump FEQuadrilateral slice header');
  const n = Number(count[1]), m = Number(count[2]), header = text.indexOf('DT=(DOUBLE DOUBLE DOUBLE )');
  if (header < 0) throw new TypeError('Expected three NASA bump scalar blocks');
  const data = text.slice(text.indexOf('\n', header) + 1).trim().split(/\s+/).map(Number);
  if (data.length !== 3 * n + 4 * m || data.some(x => !Number.isFinite(x))) throw new TypeError('Invalid NASA bump block length');
  const points = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) points.set([data[i], data[n + i], 0], 3 * i);
  // Tecplot FEQuadrilateral encodes triangular boundary elements by repeating a corner.
  const connectivity: number[] = [], offsets: number[] = [], types: number[] = [];
  for (let c = 0; c < m; c++) {
    const ids = [...new Set(data.slice(3 * n + 4 * c, 3 * n + 4 * c + 4).map(id => id - 1))];
    if (ids.length < 3) throw new TypeError('NASA slice contains a collapsed element with fewer than three corners');
    connectivity.push(...ids); offsets.push(connectivity.length); types.push(ids.length === 3 ? 5 : 9);
  }
  return { points, pointData: new Float32Array(data.slice(2 * n, 3 * n)),
    connectivity: new Uint32Array(connectivity), offsets: new Uint32Array(offsets), types: new Uint8Array(types) };
}
