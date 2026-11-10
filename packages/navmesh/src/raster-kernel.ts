import { Spans, type Grid, type NavigationOptions, type voxelise } from './pipeline.js';
import type { NavBuildWork } from './wasm.js';

interface Kernel {
  memory: WebAssembly.Memory;
  allocate(n: number): number;
  raster(input: number, triangles: number, settings: number): number;
  array(result: number, field: number): number;
  count(result: number): number;
  work(result: number, field: number): bigint;
  free_result(result: number): void;
}
/** Feature-local kernel instance and copied outputs. No memory aliases cross the worker boundary. */
export async function rasterKernel(bytes: ArrayBuffer, work: NavBuildWork): Promise<typeof voxelise> {
  const { instance } = await WebAssembly.instantiate(bytes),
    kernel = instance.exports as unknown as Kernel;
  return (points, indices, config, grid) => raster(kernel, points, indices, config, grid, work);
}

function raster(
  kernel: Kernel,
  points: Float32Array,
  indices: Uint32Array,
  config: Required<NavigationOptions>,
  grid: Grid,
  work: NavBuildWork,
): ReturnType<typeof voxelise> {
  const n = indices.length / 3,
    data = new Float64Array(n * 12),
    walkableTriangles: number[] = [],
    cosSlope = Math.cos((config.walkableSlopeAngle * Math.PI) / 180);
  let maxRise = 0;
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3] * 3,
      b = indices[t * 3 + 1] * 3,
      c = indices[t * 3 + 2] * 3,
      ux = points[b] - points[a],
      uy = points[b + 1] - points[a + 1],
      uz = points[b + 2] - points[a + 2],
      vx = points[c] - points[a],
      vy = points[c + 1] - points[a + 1],
      vz = points[c + 2] - points[a + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz),
      up = Math.abs(ny) / length,
      walk = length > 0 ? (up > cosSlope ? 1 : 0) : -1,
      rise =
        walk === 1 ? Math.min(65535, Math.ceil((config.cs * Math.hypot(nx, nz)) / Math.abs(ny) / config.ch - 1e-9)) : 0;
    for (let k = 0; k < 3; k++)
      for (let axis = 0; axis < 3; axis++) data[t * 12 + k * 3 + axis] = points[indices[t * 3 + k] * 3 + axis];
    data[t * 12 + 9] = walk;
    data[t * 12 + 10] = rise;
    data[t * 12 + 11] = up < 1e-3 ? 1 : 0;
    if (walk === 1) {
      walkableTriangles.push(t);
      maxRise = Math.max(maxRise, rise);
    }
  }
  const input = kernel.allocate(data.length),
    settings = kernel.allocate(12);
  // The second allocation may grow memory, so create views only after both allocations.
  new Float64Array(kernel.memory.buffer, input, data.length).set(data);
  new Float64Array(kernel.memory.buffer, settings, 12).set([
    grid.width,
    grid.depth,
    grid.ox,
    grid.oy,
    grid.oz,
    grid.cx,
    grid.cz,
    grid.floor,
    config.cs,
    config.ch,
    config.walkableClimb,
    grid.keep ? 1 : 0,
  ]);
  const result = kernel.raster(input, n, settings);
  try {
    const count = kernel.count(result),
      spans = new Spans(grid.width * grid.depth),
      field = (f: number, size = count) => new Int32Array(kernel.memory.buffer, kernel.array(result, f), size);
    spans.count = count;
    spans.head.set(field(0, spans.head.length));
    spans.bottom = field(1).slice();
    spans.top = field(2).slice();
    spans.next = field(3).slice();
    spans.walk = Uint8Array.from(field(4));
    spans.rise = Uint16Array.from(field(5));
    const intersections = Number(kernel.work(result, 0)),
      cells = Number(kernel.work(result, 1));
    work.intersections += intersections;
    work.cells += cells;
    work.vectorPairs += intersections;
    work.rasterCalls++;
    work.memoryBytes = Math.max(work.memoryBytes, kernel.memory.buffer.byteLength);
    return { spans, walkableTriangles, maxRise, intersections, cells };
  } finally {
    kernel.free_result(result);
  }
}
