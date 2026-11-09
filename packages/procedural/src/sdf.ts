import { fault } from '../../shared/errors.js';
import { loadKernel } from './wasm.js';

/** World-space XYZ, each coordinate finite and within +/-10000. */
export type SdfPoint = readonly [number, number, number];
/** Negative inside. CSG min/max fields keep the zero surface but are not exact distances everywhere. */
export type SdfShape =
  | { type: 'sphere'; center?: SdfPoint; radius: number }
  | { type: 'box'; center?: SdfPoint; halfSize: SdfPoint }
  | { type: 'union' | 'intersection' | 'difference'; a: SdfShape; b: SdfShape };
/** Uniform-grid modelling options. */
export interface SdfOptions {
  /** Cells on each axis, integer 4..64. Default 24. */
  resolution?: number;
  /** Strictly increasing corners, extent 0.0001..10000 per axis. Default analytic tree bounds plus 10% per-axis margin (at least 0.0001). */
  bounds?: readonly [SdfPoint, SdfPoint];
  /** Checked before synchronous work; use a worker to interrupt work in flight. */
  signal?: AbortSignal;
}
/** Owned dual vertices, analytic gradient normals and outward triangles. */
export interface SdfMesh {
  /** Packed world-space XYZ vertices, one per active cell. */
  positions: Float64Array;
  /** Unit outward SDF gradient at each vertex; deterministic branch/axis ties at CSG seams and box edges. */
  normals: Float64Array;
  /** Outward-wound triangle vertex indices, two triangles per dual quad. */
  indices: Uint32Array;
  /** Number of unique sign-changing grid edges solved. */
  edgeSolves: number;
  /** Edge solves required without sharing Hermite data among adjacent cells. */
  cellEdgeUses: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  contour(
    pointer: number,
    length: number,
    resolution: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): number;
}
const invalid = () =>
  fault(
    'failed',
    'Invalid SDF model: use at most 63 bounded shape nodes, positive sizes and resolution 4..64',
    'procedural',
  );
const point = (p: unknown): p is SdfPoint =>
  Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v) && Math.abs(v) <= 10000);
function encode(shape: SdfShape): number[] {
  const result: number[] = [];
  let nodes = 0;
  function visit(s: SdfShape): void {
    if (++nodes > 63 || !s || typeof s !== 'object') throw invalid();
    if (s.type === 'union' || s.type === 'intersection' || s.type === 'difference') {
      visit(s.a);
      visit(s.b);
      result.push(s.type === 'union' ? 2 : s.type === 'intersection' ? 3 : 4, 0, 0, 0, 0, 0, 0);
    } else if (s.type === 'box' || s.type === 'sphere') {
      const center = s.center ?? [0, 0, 0];
      if (!point(center)) throw invalid();
      if (s.type === 'sphere') {
        if (!Number.isFinite(s.radius) || s.radius < 0.0001 || s.radius > 10000) throw invalid();
        result.push(0, ...center, s.radius, 0, 0);
      } else {
        if (!point(s.halfSize) || !s.halfSize.every((v) => v >= 0.0001)) throw invalid();
        result.push(1, ...center, ...s.halfSize);
      }
    } else throw invalid();
  }
  visit(shape);
  return result;
}
// Work from the validated postfix tree so malformed/cyclic inputs never enter bounds traversal.
function enclosingBounds(code: number[]): number[][] {
  const stack: number[][][] = [];
  for (let i = 0; i < code.length; i += 7) {
    const op = code[i];
    if (op < 2) {
      const center = code.slice(i + 1, i + 4),
        size = op === 0 ? [code[i + 4], code[i + 4], code[i + 4]] : code.slice(i + 4, i + 7);
      stack.push([center.map((v, k) => v - size[k]), center.map((v, k) => v + size[k])]);
    } else {
      const b = stack.pop()!,
        a = stack.pop()!;
      if (op === 4)
        stack.push(a); // Subtraction cannot extend its minuend.
      else if (op === 2)
        stack.push([a[0].map((v, k) => Math.min(v, b[0][k])), a[1].map((v, k) => Math.max(v, b[1][k]))]);
      else {
        const lo = a[0].map((v, k) => Math.max(v, b[0][k])),
          hi = a[1].map((v, k) => Math.min(v, b[1][k]));
        // A disjoint (or just touching) intersection has no volume; sample either enclosing operand box.
        stack.push(lo.every((v, k) => v < hi[k]) ? [lo, hi] : a);
      }
    }
  }
  const [lo, hi] = stack[0],
    margin = lo.map((v, k) => Math.max((hi[k] - v) * 0.1, 0.0001));
  const bounds = [lo.map((v, k) => v - margin[k]), hi.map((v, k) => v + margin[k])];
  if (!bounds.every(point) || bounds[0].some((v, k) => bounds[1][k] - v > 10000))
    throw fault(
      'failed',
      'Cannot derive SDF bounds within the coordinate/extent limits; supply valid explicit bounds',
      'procedural',
    );
  return bounds;
}
/** Feature-local Rust/Wasm lifecycle; independent of rendering devices. */
export interface SdfModeler {
  /** Default model is a sharp box. Model must be strictly enclosed by the sampled bounds. */
  mesh(shape?: SdfShape, options?: SdfOptions): SdfMesh;
  dispose(): void;
  [Symbol.dispose](): void;
}
class Modeler implements SdfModeler {
  constructor(private kernel: Kernel | undefined) {}
  mesh(shape: SdfShape = { type: 'box', halfSize: [0.75, 0.75, 0.75] }, options: SdfOptions = {}): SdfMesh {
    const kernel = this.kernel;
    if (!kernel) throw fault('disposed', 'SdfModeler is disposed; create a new modeler', 'procedural');
    options?.signal?.throwIfAborted();
    const encoded = encode(shape),
      n = options?.resolution ?? 24,
      bounds = options?.bounds ?? enclosingBounds(encoded);
    if (
      !Number.isInteger(n) ||
      n < 4 ||
      n > 64 ||
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !point(bounds[0]) ||
      !point(bounds[1])
    )
      throw invalid();
    const step = bounds[1].map((v, k) => (v - bounds[0][k]) / n);
    if (!step.every((v) => v * n >= 0.0001 && v * n <= 10000)) throw invalid();
    const input = kernel.allocate(encoded.length);
    let output: number;
    try {
      new Float64Array(kernel.memory.buffer, input, encoded.length).set(encoded);
      output = kernel.contour(
        input,
        encoded.length,
        n,
        bounds[0][0],
        bounds[0][1],
        bounds[0][2],
        step[0],
        step[1],
        step[2],
      );
    } finally {
      kernel.release(input, encoded.length);
    }
    const header = new Float64Array(kernel.memory.buffer, output, 5),
      length = header[0];
    try {
      if (header[1] < 0) throw fault('failed', 'SDF surface touches the grid boundary; enlarge bounds', 'procedural');
      const data = new Float64Array(kernel.memory.buffer, output, length),
        count = header[1];
      return {
        positions: data.slice(5, 5 + count * 3),
        normals: data.slice(5 + count * 3, 5 + count * 6),
        indices: Uint32Array.from(data.subarray(5 + count * 6)),
        edgeSolves: header[3],
        cellEdgeUses: header[4],
      };
    } finally {
      kernel.release(output, length);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Load one optional asset lazily; no device, globals or import-time work. */
export async function createSdfModeler(options: { signal?: AbortSignal } = {}): Promise<SdfModeler> {
  const url = new URL(/* @vite-ignore */ './sdf.wasm?no-inline', import.meta.url);
  return new Modeler(await loadKernel<Kernel>(url, 'SDF', options.signal));
}
