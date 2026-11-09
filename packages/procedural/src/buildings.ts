import { fault } from '../../shared/errors.js';
import { loadKernel } from './wasm.js';

/** Restricted split/repeat grammar for a rectangular footprint, in metres, Y up. */
export interface BuildingOptions {
  /** Footprint width on local X, 0.1..1000. Default 12. */
  width?: number;
  /** Footprint depth on local Z, 0.1..1000. Default 8. */
  depth?: number;
  /** Bottom centre XYZ, each within +/-10000. Default [0,0,0]. */
  origin?: readonly [number, number, number];
  /** Rotation about Y, radians within +/-2pi. Default 0. */
  yaw?: number;
  /** Absolute floor split heights, 1..64 entries of 0.1..100; sum <=5000. Default [3,3,3]. */
  floorHeights?: readonly number[];
  /** Repeat each facade into ceil(length/bayWidth) equal bays; 1..256 per side. Default 3. */
  bayWidth?: number;
  /** Centred window width and height as fractions of its bay, each 0.05..0.95. Default [0.55,0.6]. */
  window?: readonly [number, number];
  /** Roof production: horizontal cap or X-centred ridge running along local Z. Default 'flat'. */
  roof?: 'flat' | 'gable';
  /** Gable rise, 0.1..100 metres. Ignored for a flat roof. Default 2. */
  roofHeight?: number;
  /** Checked before synchronous work; use a worker for in-flight interruption. */
  signal?: AbortSignal;
}
/** Owned shell geometry and the scopes produced by the grammar. */
export interface BuildingMesh {
  /** World-space XYZ, separate vertices per planar face; windows are flush panes. */
  positions: Float64Array;
  /** Unit outward XYZ normals, one per vertex. */
  normals: Float32Array;
  /** Outward triangle indices. No interior floors, doors or thickness. */
  indices: Uint32Array;
  /** One material per triangle: 0 wall, 1 window, 2 roof (including gables), 3 base. */
  materials: Uint8Array;
  /** Packed bottom/height pairs, in local Y. */
  floors: Float64Array;
  /** Eight values per bay: floor, side, start, bottom, width, height, windowWidth, windowHeight.
   * Sides 0..3 run +X at -Z, +Z at +X, -X at +Z, -Z at -X, viewed from above.
   * Start is distance along that side from its first corner. At most 4096 bays total. */
  bays: Float64Array;
  /** Trigonometric evaluations for the shared oriented scope, always 2. */
  transformEvaluations: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  release(pointer: number, length: number): void;
  generate_building(pointer: number, length: number): number;
}
const invalid = () =>
  fault(
    'failed',
    'Invalid building rules; use a bounded rectangle, 1..64 positive floors and at most 4096 facade bays',
    'procedural',
  );
const range = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
/** One lazy feature-local Rust/Wasm generator, independent of rendering devices. */
export interface BuildingGenerator {
  /** Apply footprint -> floor splits -> facade components -> repeated bays -> window insets -> roof. */
  generate(options?: BuildingOptions): BuildingMesh;
  dispose(): void;
  [Symbol.dispose](): void;
}
class Generator implements BuildingGenerator {
  constructor(private kernel: Kernel | undefined) {}
  generate(options: BuildingOptions = {}): BuildingMesh {
    const k = this.kernel;
    if (!k) throw fault('disposed', 'BuildingGenerator is disposed; create a new generator', 'procedural');
    options?.signal?.throwIfAborted();
    const w = options?.width ?? 12,
      d = options?.depth ?? 8,
      origin = options?.origin ?? [0, 0, 0],
      yaw = options?.yaw ?? 0,
      floors = options?.floorHeights ?? [3, 3, 3],
      bay = options?.bayWidth ?? 3,
      win = options?.window ?? [0.55, 0.6],
      roof = options?.roof ?? 'flat',
      rise = options?.roofHeight ?? 2;
    if (
      !range(w, 0.1, 1000) ||
      !range(d, 0.1, 1000) ||
      !range(bay, 0.1, 1000) ||
      !Array.isArray(origin) ||
      origin.length !== 3 ||
      !Array.from(origin).every((v) => range(v, -10000, 10000)) ||
      !range(yaw, -2 * Math.PI, 2 * Math.PI) ||
      !Array.isArray(floors) ||
      floors.length < 1 ||
      floors.length > 64 ||
      !Array.from(floors).every((v) => range(v, 0.1, 100)) ||
      floors.reduce((a, b) => a + b, 0) > 5000 ||
      !Array.isArray(win) ||
      win.length !== 2 ||
      !Array.from(win).every((v) => range(v, 0.05, 0.95)) ||
      (roof !== 'flat' && roof !== 'gable') ||
      !range(rise, 0.1, 100)
    )
      throw invalid();
    const nx = Math.ceil(w / bay),
      nz = Math.ceil(d / bay);
    if (nx > 256 || nz > 256 || 2 * (nx + nz) * floors.length > 4096) throw invalid();
    const input = [w, d, ...origin, yaw, nx, nz, ...win, roof === 'gable' ? rise : 0, ...floors],
      p = k.allocate(input.length);
    let out: number;
    try {
      new Float64Array(k.memory.buffer, p, input.length).set(input);
      out = k.generate_building(p, input.length);
    } finally {
      k.release(p, input.length);
    }
    const h = new Float64Array(k.memory.buffer, out, 5),
      length = h[0];
    try {
      const data = new Float64Array(k.memory.buffer, out, length),
        vertices = h[1],
        triangles = h[2],
        bays = h[3];
      let at = 5;
      const positions = data.slice(at, (at += vertices * 3)),
        normals = Float32Array.from(data.subarray(at, (at += vertices * 3))),
        indices = Uint32Array.from(data.subarray(at, (at += triangles * 3))),
        materials = Uint8Array.from(data.subarray(at, (at += triangles))),
        floorData = data.slice(at, (at += floors.length * 2)),
        bayData = data.slice(at, at + bays * 8);
      return { positions, normals, indices, materials, floors: floorData, bays: bayData, transformEvaluations: h[4] };
    } finally {
      k.release(out, length);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Load only buildings.wasm on demand. Works identically with WebGPU and WebGL2. */
export async function createBuildingGenerator(options: { signal?: AbortSignal } = {}): Promise<BuildingGenerator> {
  const url = new URL(/* @vite-ignore */ './buildings.wasm?no-inline', import.meta.url);
  return new Generator(await loadKernel<Kernel>(url, 'Building', options.signal));
}
