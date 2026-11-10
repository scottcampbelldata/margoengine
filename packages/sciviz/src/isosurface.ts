// Isosurfaces by marching cubes on the GPU, with the case table derived in cubes.ts. Three compute steps on the
// engine's device: classify every cell (its case and triangle count), an exclusive scan of the counts (each cell's
// first triangle), and generation (each triangle's vertices interpolated along the cut edges, normals from the field's
// central-difference gradient). The vertices stay on the GPU and are drawn from there; only the triangle total is read
// back, to size the buffer.
import type { ComputeContext, GpuArray } from '@margoengine/compute';
import { SRGBToLinear, hexColor } from '@margoengine/math/color';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { cubeTables } from './cubes.js';
import { isGpuArray, resolveColormap, sizeOf, type Bounds, type ColormapSource, type DataSource } from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Options for an isosurface. */
export interface IsosurfaceLayerOptions {
  /** Grid size [nx, ny, nz] (x fastest). Default: a GpuArray's shape [nz, ny, nx] reversed, else a cube. */
  readonly dims?: readonly [number, number, number];
  /** Data bounds of the grid: [xmin, xmax, ymin, ymax, zmin, zmax]. Default the voxel indices. */
  readonly bounds?: Bounds;
  /** Surface colour as `#rrggbb`. Default: the colour map at the level's place in `range`, or a light blue. */
  readonly color?: string;
  /** Colour map and range used for the default colour. */
  readonly colormap?: ColormapSource;
  readonly range?: readonly [number, number];
  /** Abandons the extraction. */
  readonly signal?: AbortSignal;
}

/** WGSL that classifies cells: case index and triangle count. */
const classifyShader = /* wgsl */ `struct Grid { nx: u32, ny: u32, nz: u32, cells: u32, level: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<storage, read> field: array<f32>;
@group(0) @binding(1) var<storage, read> caseCounts: array<u32>;
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;
@group(0) @binding(3) var<storage, read_write> cases: array<u32>;
@group(0) @binding(4) var<uniform> grid: Grid;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let cell = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (cell >= grid.cells) { return; }
  let cx = grid.nx - 1u;
  let cy = grid.ny - 1u;
  let x = cell % cx;
  let y = (cell / cx) % cy;
  let z = cell / (cx * cy);
  var mask = 0u;
  for (var c = 0u; c < 8u; c++) {
    let v = field[((z + (c >> 2u)) * grid.ny + y + ((c >> 1u) & 1u)) * grid.nx + x + (c & 1u)];
    if (v > grid.level) { mask |= 1u << c; }
  }
  cases[cell] = mask;
  counts[cell] = caseCounts[mask];
}`;

/** WGSL that writes each cell's triangles at its scanned offset. */
function generateShader(stride: number): string {
  /* Shader notes kept outside the uploaded source:
   * Edge e joins corners (a, b): x edges, then y, then z (cubes.ts).
   * The field rises inward, so the outward normal is minus the gradient.
   */
  return /* wgsl */ `struct Grid { nx: u32, ny: u32, nz: u32, cells: u32, level: f32, pad0: f32, pad1: f32, pad2: f32 }
struct Vertex { position: vec4f, normal: vec4f }
@group(0) @binding(0) var<storage, read> field: array<f32>;
@group(0) @binding(1) var<storage, read> caseEdges: array<u32>;
@group(0) @binding(2) var<storage, read> cases: array<u32>;
@group(0) @binding(3) var<storage, read> counts: array<u32>;
@group(0) @binding(4) var<storage, read> offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> vertices: array<Vertex>;
@group(0) @binding(6) var<uniform> grid: Grid;
fn at(p: vec3i) -> f32 {
  let q = clamp(p, vec3i(0), vec3i(i32(grid.nx) - 1, i32(grid.ny) - 1, i32(grid.nz) - 1));
  return field[(u32(q.z) * grid.ny + u32(q.y)) * grid.nx + u32(q.x)];
}
fn gradient(p: vec3i) -> vec3f {
  return vec3f(at(p + vec3i(1, 0, 0)) - at(p - vec3i(1, 0, 0)), at(p + vec3i(0, 1, 0)) - at(p - vec3i(0, 1, 0)), at(p + vec3i(0, 0, 1)) - at(p - vec3i(0, 0, 1)));
}
fn corner(c: u32) -> vec3i { return vec3i(i32(c & 1u), i32((c >> 1u) & 1u), i32((c >> 2u) & 1u)); }
fn edgeCorners(e: u32) -> vec2u {
  let bit = 1u << (e / 4u);
  var k = e % 4u;
  var c = 0u;
  for (var candidate = 0u; candidate < 8u; candidate++) {
    if ((candidate & bit) == 0u) {
      if (k == 0u) { c = candidate; break; }
      k--;
    }
  }
  return vec2u(c, c | bit);
}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let cell = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (cell >= grid.cells || counts[cell] == 0u) { return; }
  let cx = grid.nx - 1u;
  let cy = grid.ny - 1u;
  let base = vec3i(i32(cell % cx), i32((cell / cx) % cy), i32(cell / (cx * cy)));
  let mask = cases[cell];
  let first = offsets[cell] * 3u;
  for (var k = 0u; k < counts[cell] * 3u; k++) {
    let ends = edgeCorners(caseEdges[mask * ${stride}u + k]);
    let pa = base + corner(ends.x);
    let pb = base + corner(ends.y);
    let va = at(pa);
    let vb = at(pb);
    let t = clamp((grid.level - va) / (vb - va), 0.0, 1.0);
    let p = mix(vec3f(pa), vec3f(pb), t);
    let n = -mix(gradient(pa), gradient(pb), t);
    vertices[first + k] = Vertex(vec4f(p / vec3f(f32(grid.nx - 1u), f32(grid.ny - 1u), f32(grid.nz - 1u)), 1.0), vec4f(n, 0.0));
  }
}`;
}

/** WGSL of the isosurface draw. */
const isoShader = /* wgsl */ `${frameWGSL}
struct Vertex { position: vec4f, normal: vec4f }
struct Iso { model: mat4x4f, normalModel: mat4x4f, colour: vec4f }
@group(1) @binding(0) var<uniform> iso: Iso;
@group(1) @binding(1) var<storage, read> vertices: array<Vertex>;
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let v = vertices[index];
  let world = iso.model * v.position;
  var out: Out;
  out.world = world.xyz;
  out.clip = frame.clip * world;
  out.normal = (iso.normalModel * v.normal).xyz;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  var n = in.normal;
  if (dot(n, n) < 1e-12) { n = vec3f(0.0, 1.0, 0.0); }
  let colour = shade(iso.colour.rgb, normalize(n), normalize(frame.eye.xyz - in.world));
  return vec4f(toOutput(colour), 1.0);
}`;

const linearHex = (hex: string): [number, number, number] => {
  const rgba = hexColor(hex);
  if (!rgba) throw typeError(`Isosurface color ${hex} is not #rrggbb`, 'sciviz');
  return [SRGBToLinear(rgba[0]), SRGBToLinear(rgba[1]), SRGBToLinear(rgba[2])];
};

/** An isosurface layer. Create it with `await figure.isosurface(data, level, options)`; change the level with `update`. */
export class IsosurfaceLayer implements Drawable {
  /** False hides the layer. */
  visible = true;
  /** Opaque, writes depth. */
  readonly transparent = false;
  /** Grid size. */
  readonly dims: readonly [number, number, number];
  /** Data bounds of the grid. */
  readonly bounds: Bounds;
  readonly #renderer: SciRenderer;
  #gpu: ComputeContext;
  #field: GpuArray<'f32'>;
  #ownsField: boolean;
  readonly #cpu: Float32Array | undefined;
  #level = 0;
  #triangles = 0;
  #vertices: GPUBuffer | undefined;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  readonly #colour: [number, number, number];
  #tables: { counts: GpuArray<'u32'>; edges: GpuArray<'u32'>; stride: number };
  #model = new Float32Array(16);
  readonly #values = new Float32Array(36);
  #disposed = false;
  #updates: Promise<unknown> = Promise.resolve();
  #lifetime = new AbortController();
  #committed = false;

  /** @internal Use `figure.isosurface()`. */
  constructor(renderer: SciRenderer, gpu: ComputeContext, data: DataSource, options: IsosurfaceLayerOptions = {}) {
    this.#renderer = renderer;
    // A GpuArray is worked on in its own compute context (on the same device as the engine); CPU data in the figure's.
    this.#gpu = isGpuArray(data) ? data.context : gpu;
    const size = sizeOf(data),
      shape = isGpuArray(data) ? data.shape : undefined,
      side = Math.round(Math.cbrt(size));
    const dims = options.dims ?? (shape?.length === 3 ? [shape[2], shape[1], shape[0]] : [side, side, side]);
    if (dims.some((d) => !Number.isInteger(d) || d < 2))
      throw rangeError(
        `Isosurface dims [${dims.join(', ')}] need an integer of at least 2 samples on each axis; a single slice is an image, use a 2D figure.heatmap(values, { nx, ny })`,
        'sciviz',
      );
    if (dims[0] * dims[1] * dims[2] !== size)
      throw rangeError(
        `Isosurface dims [${dims.join(', ')}] do not hold ${size} values; pass dims: [nx, ny, nz]`,
        'sciviz',
      );
    this.dims = [dims[0], dims[1], dims[2]];
    this.bounds = options.bounds ? ([...options.bounds] as Bounds) : [0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1];
    if (isGpuArray(data)) {
      if (data.context.device !== renderer.device)
        throw typeError('Isosurface GpuArray must live on the engine device: createCompute({ engine })', 'sciviz');
      this.#field = (
        data.dtype === 'f32' && data.contiguous && !data.offset ? data : data.astype('f32').eval()
      ) as GpuArray<'f32'>;
      this.#ownsField = this.#field !== data;
    } else {
      this.#cpu = Float32Array.from(data as ArrayLike<number>);
      this.#field = gpu.array(this.#cpu, 'f32');
      this.#ownsField = true;
    }
    const tables = cubeTables();
    this.#tables = {
      counts: this.#gpu.array(tables.counts, 'u32'),
      edges: this.#gpu.array(tables.edges, 'u32'),
      stride: tables.stride,
    };
    this.#colour = linearHex(options.color ?? '#9cc9ff');
    this.#build();
  }

  #build(): void {
    const device = this.#renderer.device!;
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
  }

  /** @internal Recreates CPU-backed data and the last committed surface on the replacement device. */
  restore(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const reason = fault('state', 'Device replaced; request the isosurface again', 'sciviz');
    this.#lifetime.abort(reason);
    this.#lifetime = new AbortController();
    this.#vertices?.destroy();
    this.#uniform?.destroy();
    this.#vertices = undefined;
    this.#uniform = undefined;
    this.#layout = undefined;
    this.#group = undefined;
    const signal = this.#lifetime.signal;
    const run = this.#updates.then(async () => {
      signal.throwIfAborted();
      this.#tables.counts.dispose();
      this.#tables.edges.dispose();
      if (this.#ownsField) this.#field.dispose();
      if (!this.#cpu) {
        // Caller-owned GPU data is lost with its device. Never submit its old bindings on the new one.
        this.visible = false;
        return;
      }
      const gpu = await this.#renderer.compute();
      signal.throwIfAborted();
      this.#gpu = gpu;
      this.#field = gpu.array(this.#cpu, 'f32');
      this.#ownsField = true;
      const tables = cubeTables();
      this.#tables = {
        counts: gpu.array(tables.counts, 'u32'),
        edges: gpu.array(tables.edges, 'u32'),
        stride: tables.stride,
      };
      this.#build();
      if (this.#committed) await this.#extract(this.#level, signal);
    });
    this.#updates = run.catch(() => {});
    // Removing a layer deliberately cancels its reconstruction, without failing the remaining figure.
    return run.catch((error: unknown) => {
      if (!this.#disposed || error !== this.#lifetime.signal.reason) throw error;
    });
  }

  /** The iso level of the current surface. */
  get level(): number {
    return this.#level;
  }

  /** Triangles in the current surface. */
  get triangles(): number {
    return this.#triangles;
  }

  /**
   * Extracts the surface at `level` (values above it are inside). Resolves the triangle count once the vertices are
   * on the GPU. Overlapping calls run in request order. The previous surface stays visible until the new vertices
   * and count are ready together; an aborted or failed extraction leaves it unchanged.
   */
  async update(level: number, options: { readonly signal?: AbortSignal } = {}): Promise<number> {
    if (this.#disposed) throw typeError('Isosurface disposed; create a new one', 'sciviz');
    if (!Number.isFinite(level)) throw rangeError(`Isosurface level must be finite, got ${level}`, 'sciviz');
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    signal.throwIfAborted();
    const run = this.#updates.then(() => {
      signal.throwIfAborted();
      return this.#extract(level, signal);
    });
    // Only the queue tail recovers; each caller receives its own failure.
    this.#updates = run.catch(() => {});
    return run;
  }

  async #extract(level: number, signal: AbortSignal): Promise<number> {
    if (this.#gpu.device && this.#gpu.device !== this.#renderer.device)
      throw fault('state', 'Device replaced; request the isosurface again', 'sciviz');
    if (this.#renderer.cpuIsosurface) {
      const device = this.#renderer.device!;
      const data = this.#cpu ?? await this.#field.read({ signal });
      const result = await this.#renderer.cpuIsosurface(data, level, {
        dims: this.dims,
        maxTriangles: Math.floor(device.limits.maxStorageBufferBindingSize / 96),
        signal,
      });
      signal.throwIfAborted();
      let vertices: GPUBuffer | undefined;
      try {
        vertices = result.triangles ? device.createBuffer({
          size: result.vertices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }) : undefined;
        if (vertices) device.queue.writeBuffer(vertices, 0, result.vertices as Float32Array<ArrayBuffer>);
        const group = vertices ? device.createBindGroup({
          layout: this.#layout!, entries: [
            { binding: 0, resource: { buffer: this.#uniform! } },
            { binding: 1, resource: { buffer: vertices } },
          ],
        }) : undefined;
        signal.throwIfAborted();
        this.#vertices?.destroy();
        this.#vertices = vertices;
        vertices = undefined;
        this.#group = group;
        this.#triangles = result.triangles;
        this.#level = level;
        this.#committed = true;
        return result.triangles;
      } finally { vertices?.destroy(); }
    }
    const gpu = this.#gpu,
      [nx, ny, nz] = this.dims,
      cells = (nx - 1) * (ny - 1) * (nz - 1);
    const grid = new DataView(new ArrayBuffer(32));
    [nx, ny, nz, cells].forEach((v, k) => grid.setUint32(k * 4, v, true));
    grid.setFloat32(16, level, true);
    const params = new Uint8Array(grid.buffer);
    const counts = gpu.zeros(cells, 'u32'),
      cases = gpu.zeros(cells, 'u32');
    const workgroups = gpu.grid(Math.ceil(cells / 256));
    gpu
      .kernel(classifyShader)
      .run({ field: this.#field, caseCounts: this.#tables.counts, counts, cases, grid: params }, { workgroups });
    const offsets = gpu.scan(counts, { exclusive: true });
    const total = counts.sum();
    let vertices: GPUBuffer | undefined;
    try {
      const triangles = await total.item({ signal });
      signal.throwIfAborted();
      if (triangles * 3 * 32 > this.#renderer.device!.limits.maxStorageBufferBindingSize)
        throw rangeError(
          `Isosurface of ${triangles} triangles is over this GPU's storage limit; use a coarser grid`,
          'sciviz',
        );
      // Never generate into the displayed buffer: draws can run while done() is pending, even without overlap.
      if (triangles) {
        vertices = this.#renderer.device!.createBuffer({
          size: triangles * 3 * 32,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
      }
      const group = vertices
        ? this.#renderer.device!.createBindGroup({
            layout: this.#layout!,
            entries: [
              { binding: 0, resource: { buffer: this.#uniform! } },
              { binding: 1, resource: { buffer: vertices } },
            ],
          })
        : undefined;
      if (triangles)
        gpu.kernel(generateShader(this.#tables.stride)).run(
          {
            field: this.#field,
            caseEdges: this.#tables.edges,
            cases,
            counts,
            offsets,
            vertices: vertices!,
            grid: params,
          },
          { workgroups },
        );
      await gpu.done({ signal });
      signal.throwIfAborted();
      this.#vertices?.destroy();
      this.#vertices = vertices;
      vertices = undefined;
      this.#group = group;
      this.#triangles = triangles;
      this.#level = level;
      this.#committed = true;
      return triangles;
    } finally {
      vertices?.destroy();
      for (const a of [counts, cases, offsets, total]) a.dispose();
    }
  }

  /** Owned data-coordinate snapshot of the last committed isosurface for publication output. */
  async vectorGeometry(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<import('./vector-types.js').VectorGeometry> {
    options.signal?.throwIfAborted();
    if (this.#disposed) throw fault('disposed', 'Isosurface is disposed; create a new layer before export', 'sciviz');
    const { isoSnapshot } = await import('./vector-snapshot.js');
    options.signal?.throwIfAborted();
    return isoSnapshot(
      this.#renderer.device!,
      this.#vertices,
      this.#triangles,
      this.bounds,
      this.#colour,
      options.signal,
    );
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(figure: Float32Array): void {
    const [x0, x1, y0, y1, z0, z1] = this.bounds,
      box = [x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, x0, y0, z0, 1];
    multiplyMatrices(figure, box, this.#model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const m = this.#model;
    return [m[12], m[13], m[14]];
  }

  /** @internal */
  prepare(): void {
    if (!this.#uniform) return;
    const v = this.#values;
    v.set(this.#model, 0);
    const inverse = new Float32Array(16);
    invertMatrix(this.#model, inverse);
    // Normals in box coordinates go through the inverse transpose; gradients are per voxel, so scale by the grid.
    const [nx, ny, nz] = this.dims,
      scale = [nx - 1, ny - 1, nz - 1];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) v[16 + c * 4 + r] = inverse[r * 4 + c] * scale[c];
    v[31] = 1;
    v.set([...this.#colour, 1], 32);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#triangles || !this.#group) return;
    const pipeline = renderer.pipeline('isosurface', context, (target) => {
      const module = renderer.device!.createShaderModule({ code: isoShader, label: 'sciviz isosurface' });
      return {
        label: 'sciviz isosurface',
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    pass.draw(this.#triangles * 3);
  }

  /** Frees the GPU resources (not a GpuArray you passed in). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort(typeError('Isosurface disposed; create a new one', 'sciviz'));
    this.#renderer.remove(this);
    this.#vertices?.destroy();
    this.#uniform?.destroy();
    this.#tables.counts.dispose();
    this.#tables.edges.dispose();
    if (this.#ownsField) this.#field.dispose();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The default isosurface colour: the colour map at the level's place in the range. */
export function levelColour(
  level: number,
  range: readonly [number, number] | undefined,
  map: ColormapSource | undefined,
): string | undefined {
  if (!range) return undefined;
  const t = (level - range[0]) / (range[1] - range[0] || 1),
    rgb = resolveColormap(map).sample(t);
  return `#${rgb
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
