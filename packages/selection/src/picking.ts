/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { meshTriangles } from '../../shared/mesh-source.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type Mesh,
  type Geometry,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type DrawOptions,
  type RenderView,
} from '@margoengine/core/extension';
import type { Camera, Mesh as PublicMesh } from '@margoengine/core';
import { meshVertex } from '../../shared/gpu.js';
import { inView, layerRegistry, meshLayers } from '../../shared/view-rect.js';
import { PickingPrimitives, type PickingSource } from './picking-primitives.js';
import { coreMeshBuffers as buffers } from '../../shared/draw-cache.js';
export type { PickingSource, PickingPrimitive } from './picking-primitives.js';
import { instanceMatrix } from '../../shared/instances.js';
import {
  Models,
  ModelDraws,
  modelCode,
  modelPipeline,
  sphere,
  hidden,
  isModel,
  engineProxies,
  type ModelLike,
  type ModelPrimitiveLike,
  type PickProxy,
} from './models.js';
import { retire } from '../../shared/frame-resources.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number; VERTEX: number; INDEX: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** A view resolved by `engine.pick`: rectangles in drawing-buffer pixels. */
type PickView = RenderView & { pixels: true };
/** True when `rect` is absent or covers the whole target. */
const covers = (rect: readonly number[] | undefined, c: Context) =>
  !rect || (rect[0] === 0 && rect[1] === 0 && rect[2] === c.width && rect[3] === c.height);
const attachedPickers = new WeakMap<Engine, Picking>();
type Snapshot = { geometry: Geometry | null; values: Float32Array; visible: number };
const microShader =
  meshVertex
    .replace('id:u32}', 'id:u32,@location(1) position:vec3f,@location(2) material:vec4f}')
    .replace(
      'u32(i.factors.w))',
      'u32(i.factors.w),p.xyz,vec4f(i.factors.xyz,sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz)))))',
    ) +
  `
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) u32 {
 let facing=front==(i.material.w>0.0);if(!facing&&i.material.z<0.5){discard;}return i.id+1u;
}`;

function mrtShader(code: string): string {
  return (
    code
      .replace('@location(3) material:vec4f', '@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32')
      .replace('o.color=i.color.rgb', 'o.id=u32(i.factors.w);o.color=i.color.rgb')
      .replace(
        '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f',
        'fn shade(i:Output,front:bool)->vec4f',
      ) +
    `
struct PickPixel {@location(0) color:vec4f,@location(1) id:u32}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->PickPixel {return PickPixel(shade(i,front),i.id+1u);}`
  );
}

const idFragment = `@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) u32 {if(culled(i,front)){discard;}return i.info.x;}`;
/** Bytes of one point's 3 x 3 tile in a staging buffer, at WebGPU's 256-byte row pitch. */
const tileBytes = 768;
/** What one pick reads, taken before its first await. */
interface PickScene {
  device: GPUDevice;
  live: Engine['meshes'];
  meshes: Map<number, Mesh>;
  models: ModelLike[];
  starts: number[];
  total: number;
  list: readonly PickProxy[];
  capacity: number;
}
/** One point's tile in a staging buffer: where it starts (in u32s), the point in it and what its pass drew. */
interface PickTile {
  at: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  candidates: Map<Mesh, PickingSource[]> | undefined;
  instances: number[][];
}
/** A `pickMany` call waiting for its turn in `engine.pick`; `outside` lists points beyond the chosen view. */
interface PickBatch {
  points: readonly (readonly [number, number])[];
  out: (PickHit | null)[];
  outside: number[];
}
/** First ID of Picking's overlays, and the IDs each one owns: above every mesh, model and proxy ID. */
const overlayBase = 2 ** 31,
  overlayIds = 2 ** 28;
/** What an overlay draws with in a pick: the 3 x 3 tile, already holding every mesh's IDs and depth. */
export interface PickingOverlayContext {
  encoder: GPUCommandEncoder;
  /** The r32uint ID tile; load it. */
  color: GPUTextureView;
  /** Its depth32float depth (reversed Z); load it and test with greater-equal to sort against the meshes. */
  depth: GPUTextureView;
  /** The view-projection matrix cropped to the tile. */
  matrix: Float32Array;
  camera: Camera;
  /** The picked view's rectangle in drawing-buffer pixels. */
  rect: readonly number[];
  /** The ID of the overlay's item 0; it owns the next 2^28. */
  firstId: number;
}
/** Something other than triangles (fat lines, points, splats) that picks in the same depth test as meshes; register it with `addOverlay`. */
export interface PickingOverlay {
  /** Draws item `n` as ID `firstId + n`, after every mesh. */
  drawPick(context: PickingOverlayContext): void;
  /** The hit for item `index` of the last `drawPick`, or null. `mesh` must be a live mesh of the picked scene. */
  pickHit(index: number): {
    mesh: PublicMesh;
    line?: object;
    segment?: number;
    cloud?: object;
    point?: number;
    position?: readonly number[];
    splats?: object;
    splat?: number;
  } | null;
}
/** A pick result: the core mesh, or for gltf-pro models the glTF node with its model and primitive. `approximate`: a pick proxy (imposter level) hit through its bounding sphere; `mesh` is the LOD anchor. */
export interface PickHit {
  mesh: Mesh;
  model?: ModelLike;
  primitive?: ModelPrimitiveLike;
  primitiveIndex?: number;
  approximate?: boolean;
  /** Instanced primitives (gltf-pro PBRInstances): the instance index. */
  instanceId?: number;
  /** A hit on `@margoengine/points/pick`'s overlay: the cloud. `mesh` is then the mesh it follows or its stand-in. */
  cloud?: object;
  /** A hit on `@margoengine/points/pick`'s overlay: the point's index in the cloud's arrays. */
  point?: number;
  /** A hit on `@margoengine/points/pick`'s overlay: the point's world position. */
  position?: readonly number[];
  /** A hit on `@margoengine/lines/pick`'s overlay: the line. `mesh` is then the mesh it follows or its stand-in. */
  line?: object;
  /** The line's segment index. */
  segment?: number;
  /** A hit on `@margoengine/splats/pick`'s overlay: the cloud. `mesh` is then its stand-in. */
  splats?: object;
  /** The splat's index in the cloud. */
  splat?: number;
}

/** UV sphere scaled so its faces enclose the unit sphere (proxy picks cover at least the bounding sphere the bvh Raycaster tests), as 20-float gltf-pro vertices. */
function proxySphere(device: GPUDevice): ModelPrimitiveLike {
  const rows = 8,
    cols = 16,
    p: number[] = [],
    index: number[] = [];
  for (let i = 0; i <= rows; i++)
    for (let j = 0; j <= cols; j++) {
      const a = (Math.PI * i) / rows,
        b = (2 * Math.PI * j) / cols;
      p.push(Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b));
    }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j,
        b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  let near = 1;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t + k] * 3),
      u = [0, 1, 2].map((k) => p[b + k] - p[a + k]),
      v = [0, 1, 2].map((k) => p[c + k] - p[a + k]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      l = Math.hypot(...n);
    if (l > 1e-9) near = Math.min(near, Math.abs(n[0] * p[a] + n[1] * p[a + 1] + n[2] * p[a + 2]) / l);
  }
  const vertices = new Float32Array((p.length / 3) * 20),
    indices = new Uint32Array(index);
  for (let i = 0; i < p.length / 3; i++) {
    for (let k = 0; k < 3; k++) vertices[i * 20 + k] = p[i * 3 + k] / near;
    vertices[i * 20 + 3] = 1;
  }
  const buffer = (data: Float32Array | Uint32Array, usage: number) => {
    const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
    return b;
  };
  return {
    node: undefined!,
    vertices,
    indices,
    material: { settings: [0, 0, 1] },
    buffers: { vertex: buffer(vertices, GPUBufferUsage.VERTEX), index: buffer(indices, GPUBufferUsage.INDEX) },
  };
}

function intersects(matrix: Float32Array, model: Float32Array, b: ArrayLike<number>, clip: Float64Array): boolean {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      clip[c * 4 + r] =
        matrix[r] * model[c * 4] +
        matrix[4 + r] * model[c * 4 + 1] +
        matrix[8 + r] * model[c * 4 + 2] +
        matrix[12 + r] * model[c * 4 + 3];
  // Pull each plane into local space so nonuniform scale, mirrors and hierarchy shear stay conservative.
  for (let plane = 0; plane < 6; plane++) {
    const row = plane >> 1,
      sign = plane % 2 === 0 ? 1 : -1;
    const a = plane === 4 ? clip[2] : clip[3] + sign * clip[row],
      d = plane === 4 ? clip[6] : clip[7] + sign * clip[4 + row],
      e = plane === 4 ? clip[10] : clip[11] + sign * clip[8 + row],
      f = plane === 4 ? clip[14] : clip[15] + sign * clip[12 + row];
    if (a * b[0] + d * b[1] + e * b[2] + f + b[3] * Math.hypot(a, d, e) < 0) return false;
  }
  return true;
}

/** Optional mesh picking: forward-pass IDs, with a current-pose 3x3 pass for registered GPU sources. */
export class Picking implements EnginePlugin {
  readonly name = 'picking';
  private engine?: Engine;
  private device?: GPUDevice;
  private disposed = false;
  private pending = false;
  private readonly models = new Models();
  private readonly draws = new ModelDraws();
  private modelPipeline?: GPURenderPipeline;
  private last: PickHit | null = null;
  private sphere?: ModelPrimitiveLike;
  private readonly proxyMatrix = new Float32Array(16);
  private readonly instanceWorld = new Float32Array(16);
  private instanceHits: number[][] = [];
  private ids?: GPUTexture;
  private idsView?: GPUTextureView;
  private micro?: GPUTexture;
  private depth?: GPUTexture;
  private uniform?: GPUBuffer;
  private read?: GPUBuffer;
  private batch?: PickBatch;
  private instances?: GPUBuffer;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, { entries: GPUBindGroupEntry[]; group: GPUBindGroup }>();
  private readonly frame = new Float32Array(32);
  private readonly camera = new Float32Array(16);
  private readonly clip = new Float64Array(16);
  private readonly snapshot = new Map<Mesh, Snapshot>();
  private graphRevision = -1;
  private graph?: FrameGraph;
  private captured = false;
  private original?: Context['draw'];
  private context?: Context;
  private readonly primitives = new PickingPrimitives();
  /** Registered overlays by ID slot; a removed one leaves its slot empty. */
  private readonly overlays: (PickingOverlay | undefined)[] = [];
  /** `capture:false` skips the per-frame ID target and snapshot; every pick then uses the culled 3x3 pass. */
  constructor(readonly options: { capture?: boolean } = {}) {}
  static attach(engine: EngineKernel, options: { capture?: boolean } = {}): Picking {
    const picking = new Picking(options);
    engineRuntime(engine).use(picking);
    return picking;
  }
  /** Return the configured picker without attaching another plugin or taking its ownership. */
  static forEngine(engine: EngineKernel): Picking | undefined {
    return attachedPickers.get(engineRuntime(engine));
  }
  /** Register an optional model's GPU vertices, including its current skin and morph deformation. */
  add(source: PickingSource): () => void {
    if (this.disposed)
      throw new MargoError('disposed', 'Picking is disposed; create a new Picking to register sources.');
    return this.primitives.add(source);
  }
  /**
   * Registers something that is not triangles, such as `@margoengine/lines/pick`, to pick in one depth test with the
   * meshes. Picks then always use the 3 x 3 pass. Returns the function that removes it.
   * @throws RangeError past 8 overlays.
   */
  addOverlay(overlay: PickingOverlay): () => void {
    if (this.disposed)
      throw new MargoError('disposed', 'Picking is disposed; create a new Picking to register overlays.');
    if (this.engine && !this.device)
      throw new MargoError('unsupported', 'Picking overlays need WebGPU; the WebGL2 preview picks core meshes only.');
    let slot = this.overlays.indexOf(undefined);
    if (slot < 0) slot = this.overlays.length;
    if (slot >= 8) throw new RangeError('Picking takes at most 8 overlays; remove one first.');
    this.overlays[slot] = overlay;
    return () => {
      if (this.overlays[slot] === overlay) this.overlays[slot] = undefined;
    };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'Picking is disposed; create a new Picking to attach.');
    if (!engine.gpu) {
      if (!engine.hasPlugin('webgl-pick'))
        throw new MargoError(
          'unsupported',
          'Picking requires WebGPU; on the WebGL2 preview attach webglPicking from @margoengine/webgl2-compat/pick first.; see https://margoengine.com/errors#webgpu',
        );
      // The preview has no WebGPU target to draw into: its engine.pick is the whole route, and it finds core meshes.
      this.engine = engine;
      attachedPickers.set(engine, this);
      return;
    }
    this.engine = engine;
    this.device = engine.gpu;
    this.primitives.setup(engine);
    this.uniform = this.device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Three 12-byte rows use WebGPU's 256-byte copy pitch; padding is never resolved as IDs.
    this.read = this.device.createBuffer({ size: 768, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.micro = this.device.createTexture({
      size: [3, 3],
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.depth = this.device.createTexture({
      size: [3, 3],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    attachedPickers.set(engine, this);
  }
  registerPasses(graph: FrameGraph): void {
    if (this.options.capture === false || !this.device) return;
    graph.add({
      name: 'picking:capture',
      order: -1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'picking:restore',
      order: 0.01,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.original) {
          c.draw = this.original;
          this.original = undefined;
        }
      },
    });
  }
  private pipeline(c: Context, code: string, mrt: boolean): GPURenderPipeline {
    const key = code + ':' + mrt + ':' + c.format + ':' + c.descriptor.depthStencil!.format;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      if (this.pipelines.size >= 64)
        throw new RangeError('Too many picking shader variants; reduce distinct materials and formats to 64 or fewer.');
      const module = c.device.createShaderModule({ code });
      pipeline = c.device.createRenderPipeline({
        ...c.descriptor,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: mrt ? [{ format: c.format }, { format: 'r32uint' }] : [{ format: 'r32uint' }],
        },
        depthStencil: mrt
          ? c.descriptor.depthStencil
          : { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  private capture(c: Context): void {
    this.captured = false;
    this.context = c;
    // Only a full first view fills the ID attachment; later or partial views pick through the micro pass.
    if (c.view && (c.view.index || !covers(c.view.viewport, c) || !covers(c.view.scissor, c))) return;
    this.primitives.discover(this.engine!.meshes.values());
    if (this.primitives.hasSources) return;
    // Integer IDs cannot be resolved; retain the existing single-sample micro pass under MSAA. Scenes with models always pick through it too.
    if ((c.descriptor.multisample?.count ?? 1) > 1 || this.models.update(this.engine!).length) return;
    if (this.ids?.width !== c.width || this.ids.height !== c.height) {
      retire(this.device!, this.ids);
      this.ids = c.device.createTexture({
        size: [c.width, c.height],
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.idsView = this.ids.createView();
    }
    this.original = c.draw;
    const original = c.draw;
    let eligible = true;
    c.draw = (options: DrawOptions = {}) => {
      // A partial draw leaves the IDs incomplete for the rest of the frame.
      eligible &&= covers(options.viewport, c) && covers(options.scissor, c);
      if (
        !eligible ||
        options.pipeline ||
        !c.shader.includes('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f')
      ) {
        this.captured &&= eligible;
        original(options);
        return;
      }
      original({
        ...options,
        pipeline: this.pipeline(c, mrtShader(c.shader), true),
        partIds: true,
        colorAttachments: [
          { view: this.idsView!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      this.camera.set(c.camera.matrix);
      this.graph = this.engine!.frameGraph;
      this.graphRevision = this.graph.revision;
      for (const mesh of this.snapshot.keys())
        if (this.engine!.meshes.get(mesh.id) !== mesh) this.snapshot.delete(mesh);
      for (const mesh of this.engine!.meshes.values()) {
        let saved = this.snapshot.get(mesh);
        if (!saved) {
          saved = { geometry: mesh.geometry, values: new Float32Array(24), visible: 0 };
          this.snapshot.set(mesh, saved);
        }
        saved.values.set(mesh.matrix);
        saved.values.set(mesh.material.data, 16);
        saved.geometry = mesh.geometry;
        saved.visible = this.engine!.store.visible[mesh.id];
      }
      this.captured = true;
    };
  }
  private fresh(): boolean {
    const e = this.engine!;
    // shortcut: mutable clipping uniforms have no revision, use the micro pass while a `section` plugin is attached.
    if (
      this.primitives.hasSources ||
      this.overlays.some(Boolean) ||
      !this.captured ||
      e.hasPlugin('section') ||
      this.graph !== e.frameGraph ||
      this.graphRevision !== e.frameGraph.revision ||
      this.snapshot.size !== e.meshes.size ||
      this.ids?.width !== e.canvas.width ||
      this.ids.height !== e.canvas.height
    )
      return false;
    if (this.camera.some((v, i) => v !== e.camera.matrix[i])) return false;
    for (const mesh of e.meshes.values()) {
      const saved = this.snapshot.get(mesh);
      if (
        !saved ||
        saved.geometry !== mesh.geometry ||
        saved.visible !== e.store.visible[mesh.id] ||
        saved.values.some((v, i) => v !== (i < 16 ? mesh.matrix[i] : mesh.material.data[i - 16]))
      )
        return false;
    }
    return true;
  }
  /** `engine.pick` hook: the core mesh, or the glTF node of a gltf-pro model, at a canvas CSS pixel, in `view` when given. */
  async onPick(x: number, y: number, view?: PickView): Promise<Mesh | null> {
    const { batch } = this;
    if (batch) {
      this.batch = undefined;
      await this.resolveBatch(batch, view);
      return null;
    }
    const hit = await this.resolve(x, y, view);
    this.last = hit;
    return hit?.mesh ?? null;
  }
  /**
   * `engine.pick` (transforms and camera refreshed first), with the model and primitive for model hits. With `view`,
   * picks inside that view with its camera, scene and layers.
   */
  async pick(x: number, y: number, view?: RenderView): Promise<PickHit | null> {
    this.ready();
    this.last = null;
    const mesh = await this.engine!.pick(x, y, view),
      hit = this.last as PickHit | null;
    this.last = null;
    // The preview's pick does not go through `onPick`, so there is no fuller hit than the mesh.
    if (!this.device) return mesh ? { mesh } : null;
    return mesh && hit?.mesh === mesh ? hit : null;
  }
  /**
   * The picks of `engine.pick` for many canvas CSS pixels, answered from one readback: one turn in the engine's pick
   * queue (so overlapping picks keep their order), one refresh of the scene, then every point's pass submitted with no
   * wait between them. All points read the same scene. A point outside the canvas answers null. With several views on
   * the canvas and no `view`, points outside the first point's view are picked one at a time. On the WebGL2 preview
   * every point is a pick of its own.
   */
  async pickMany(points: readonly (readonly [number, number])[], view?: RenderView): Promise<(PickHit | null)[]> {
    this.ready();
    for (const [x, y] of points)
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new RangeError('Invalid pick coordinates; pass finite x and y in canvas pixels.');
    const out = new Array<PickHit | null>(points.length).fill(null),
      canvas = this.engine!.canvas,
      width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height,
      inside = ([x, y]: readonly [number, number]) => x >= 0 && y >= 0 && x < width && y < height,
      first = points.find(inside);
    if (!first) return out;
    if (!this.device) {
      for (const [i, point] of points.entries()) if (inside(point)) out[i] = await this.pick(point[0], point[1], view);
      return out;
    }
    const batch: PickBatch = { points, out, outside: [] };
    this.batch = batch;
    try {
      await this.engine!.pick(first[0], first[1], view);
    } finally {
      if (this.batch === batch) this.batch = undefined;
    }
    if (!view) for (const i of batch.outside) out[i] = await this.pick(points[i][0], points[i][1]);
    return out;
  }
  /** Throws unless a pick can run now. */
  private ready(): void {
    if (this.disposed) throw new MargoError('disposed', 'Picking is disposed; create a new Picking to pick.');
    if (!this.engine)
      throw new MargoError('state', 'Picking is not attached; call Picking.attach(engine) before picking.');
  }
  /** The scene one pick or batch reads, taken before its first await. */
  private scene(): PickScene {
    const e = this.engine!,
      // The picked scene's live meshes (engine.pick enters that scene until this first await) and a snapshot.
      live = e.meshes,
      meshes = new Map(live),
      models = this.models.update(e);
    return {
      device: this.device!,
      live,
      meshes,
      models,
      starts: this.models.starts,
      total: this.models.total,
      list: engineProxies(e),
      capacity: e.store.capacity,
    };
  }
  /** Submits the pass and copy of one point into `read` at `offset`, or returns null outside the pick's rectangle. */
  private submit(
    scene: PickScene,
    x: number,
    y: number,
    view: PickView | undefined,
    read: GPUBuffer,
    offset: number,
  ): PickTile | null {
    const e = this.engine!,
      { device, models, list } = scene,
      canvas = e.canvas,
      cssWidth = canvas.clientWidth || canvas.width,
      cssHeight = canvas.clientHeight || canvas.height,
      // The view's rectangle, clipped by its scissor; the whole canvas without a view.
      rect = view?.viewport ?? [0, 0, e.canvas.width, e.canvas.height],
      clip = view?.scissor ?? rect,
      left = Math.max(0, rect[0], clip[0]),
      top = Math.max(0, rect[1], clip[1]),
      right = Math.min(e.canvas.width, rect[0] + rect[2], clip[0] + clip[2]),
      bottom = Math.min(e.canvas.height, rect[1] + rect[3], clip[1] + clip[3]),
      px = Math.floor((x * e.canvas.width) / cssWidth),
      py = Math.floor((y * e.canvas.height) / cssHeight),
      x0 = Math.max(left, px - 1),
      y0 = Math.max(top, py - 1),
      width = Math.min(right, px + 2) - x0,
      height = Math.min(bottom, py + 2) - y0;
    if (px < left || px >= right || py < top || py >= bottom) return null;
    const encoder = device.createCommandEncoder();
    let texture: GPUTexture, origin: number[], candidates: Map<Mesh, PickingSource[]> | undefined;
    // ModelLike and proxy IDs are not in the forward pass (gltf-pro and imposters draw their own pipelines), so those scenes use the micro pass.
    if (!view && !models.length && !list.length && this.fresh()) {
      texture = this.ids!;
      origin = [x0, y0];
    } else {
      candidates = this.renderMicro(encoder, px, py, list, rect, view);
      texture = this.micro!;
      origin = [1 + x0 - px, 1 + y0 - py];
    }
    encoder.copyTextureToBuffer({ texture, origin }, { buffer: read, offset, bytesPerRow: 256 }, [width, height]);
    device.queue.submit([encoder.finish()]);
    return { at: offset / 4, cx: px - x0, cy: py - y0, width, height, candidates, instances: this.instanceHits };
  }
  /** The hit of one mapped tile: the center's ID, else the nearest neighbor's, resolved and checked against the scene. */
  private decode(scene: PickScene, data: Uint32Array, tile: PickTile, view: PickView | undefined): PickHit | null {
    const e = this.engine!,
      { device, live, meshes, models, starts, total, list, capacity } = scene,
      { at, cx, cy, width, height, candidates } = tile;
    let id = data[at + cy * 64 + cx];
    if (!id)
      for (const [dx, dy] of [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const nx = cx + dx,
          ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && data[at + ny * 64 + nx]) {
          id = data[at + ny * 64 + nx];
          break;
        }
      }
    let hit: PickHit | null = null;
    if (id >= overlayBase) {
      const slot = Math.floor((id - overlayBase) / overlayIds);
      hit = (this.overlays[slot]?.pickHit(id - overlayBase - slot * overlayIds) ?? null) as PickHit | null;
    } else if (id > capacity + total + list.length) {
      const [m, i, k] = tile.instances[id - capacity - total - list.length - 1] ?? [],
        model = models[m],
        primitive = model?.primitives[i];
      if (primitive && !model.disposed)
        hit = { mesh: primitive.node, model, primitive, primitiveIndex: i, instanceId: k };
    } else if (id > capacity + total) {
      const proxy = list[id - capacity - 1 - total];
      if (proxy)
        hit = { mesh: proxy.anchor, ...(isModel(proxy.model) ? { model: proxy.model } : {}), approximate: true };
    } else if (id > capacity) {
      // ModelLike slots follow the core slots: capacity + 1 + the model's first slot + primitive index.
      const slot = id - capacity - 1;
      let m = models.length - 1;
      while (m > 0 && starts[m] > slot) m--;
      const model = models[m],
        primitiveIndex = slot - (starts[m] ?? 0),
        primitive = model?.primitives[primitiveIndex];
      if (primitive && !model.disposed) hit = { mesh: primitive.node, model, primitive, primitiveIndex };
    } else {
      const mesh = meshes.get(id - 1);
      if (mesh) hit = { mesh };
    }
    if (
      this.disposed ||
      device !== this.device ||
      !hit ||
      live.get(hit.mesh.id) !== hit.mesh ||
      hidden(e, hit.mesh.id) ||
      !inView({ view }, hit.mesh)
    )
      return null;
    if (
      !hit.mesh.geometry &&
      candidates?.has(hit.mesh) &&
      !candidates.get(hit.mesh)!.some((source) => this.primitives.contains(source, hit.mesh))
    )
      return null;
    if (!hit.model) {
      const source = meshTriangles(hit.mesh);
      if (source?.kind === 'pbr') {
        const model = source.source.model as unknown as ModelLike,
          primitiveIndex = model.primitives.findIndex((p) => p.node === hit!.mesh);
        if (primitiveIndex >= 0)
          Object.assign(hit, { model, primitive: model.primitives[primitiveIndex], primitiveIndex });
      }
    }
    return hit;
  }
  private async resolve(x: number, y: number, view?: PickView): Promise<PickHit | null> {
    this.ready();
    if (this.pending)
      throw new MargoError('state', 'A pick is already pending; await the previous pick before starting another.');
    if (![x, y].every(Number.isFinite))
      throw new RangeError('Invalid pick coordinates; pass finite x and y in canvas pixels.');
    // CSS pixels; an OffscreenCanvas (worker) has no client size, so its coordinates are canvas pixels.
    const canvas = this.engine!.canvas,
      cssWidth = canvas.clientWidth || canvas.width,
      cssHeight = canvas.clientHeight || canvas.height;
    if (x < 0 || y < 0 || x >= cssWidth || y >= cssHeight) return null;
    this.pending = true;
    const e = this.engine!,
      read = this.read!,
      scene = this.scene(),
      { device } = scene;
    try {
      this.primitives.discover(e.meshes.values());
      const tile = this.submit(scene, x, y, view, read, 0);
      if (!tile) return null;
      await read.mapAsync(GPUMapMode.READ);
      try {
        return this.decode(scene, new Uint32Array(read.getMappedRange()), tile, view);
      } finally {
        read.unmap();
      }
    } catch (error) {
      if (this.disposed || device !== this.device || e.gpu !== device) return null;
      throw error;
    } finally {
      this.pending = false;
    }
  }
  /** `pickMany`'s turn: every point of `batch`, under the view `engine.pick` chose and the scene it just refreshed. */
  private async resolveBatch(batch: PickBatch, view?: PickView): Promise<void> {
    if (this.pending)
      throw new MargoError('state', 'A pick is already pending; await the previous pick before starting another.');
    this.pending = true;
    const e = this.engine!,
      scene = this.scene(),
      { device } = scene,
      canvas = e.canvas,
      cssWidth = canvas.clientWidth || canvas.width,
      cssHeight = canvas.clientHeight || canvas.height,
      // engine.pick answers with the same filter: the layers it set for this pick, from the camera or the view.
      layers = view?.layers ?? layerRegistry()?.cameras.get(view?.camera ?? e.camera),
      // One tile per point, for this call only: it outlives no device.
      read = device.createBuffer({
        size: batch.points.length * tileBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      tiles: (PickTile | null)[] = [];
    try {
      this.primitives.discover(e.meshes.values());
      batch.points.forEach(([x, y], i) => {
        const onCanvas = x >= 0 && y >= 0 && x < cssWidth && y < cssHeight,
          tile = onCanvas ? this.submit(scene, x, y, view, read, i * tileBytes) : null;
        tiles.push(tile);
        if (onCanvas && !tile) batch.outside.push(i);
      });
      await read.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(read.getMappedRange());
      tiles.forEach((tile, i) => {
        const hit = tile && this.decode(scene, data, tile, view);
        if (hit && (layers === undefined || layers === -1 || meshLayers(hit.mesh) & layers)) batch.out[i] = hit;
      });
    } catch (error) {
      if (this.disposed || device !== this.device || e.gpu !== device) return;
      throw error;
    } finally {
      this.pending = false;
      read.destroy();
    }
  }
  private renderMicro(
    encoder: GPUCommandEncoder,
    x: number,
    y: number,
    list: readonly PickProxy[],
    rect: readonly number[],
    view?: PickView,
  ): Map<Mesh, PickingSource[]> | undefined {
    const e = this.engine!,
      device = this.device!,
      camera = view?.camera ?? e.camera,
      scope = { view },
      shown = (mesh: Mesh) => !hidden(e, mesh.id) && inView(scope, mesh),
      matrix = camera.matrix.slice(),
      nx = (2 * (x - rect[0] + 0.5)) / rect[2] - 1,
      ny = 1 - (2 * (y - rect[1] + 0.5)) / rect[3];
    for (let c = 0; c < 4; c++) {
      matrix[c * 4] = ((matrix[c * 4] - nx * matrix[c * 4 + 3]) * rect[2]) / 3;
      matrix[c * 4 + 1] = ((matrix[c * 4 + 1] - ny * matrix[c * 4 + 3]) * rect[3]) / 3;
    }
    this.frame.set(matrix);
    this.frame.set(camera.position, 16);
    this.frame.set(e.lighting.direction, 20);
    this.frame.set(e.lighting.radiance, 24);
    this.frame.fill(1, 28, 31);
    if (e.lighting.ambient) this.frame.set(e.lighting.ambient, 28);
    device.queue.writeBuffer(this.uniform!, 0, this.frame as Float32Array<ArrayBuffer>);
    const c: Context = {
      backend: 'webgpu',
      device,
      encoder,
      camera,
      width: e.canvas.width,
      height: e.canvas.height,
      delta: 0,
      color: this.micro!.createView(),
      depth: this.depth!.createView(),
      format: 'r32uint',
      shader: microShader,
      bindings: [],
      indirect: false,
      descriptor: {
        layout: 'auto',
        vertex: { module: undefined!, entryPoint: 'vertex', buffers },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      },
      draw: () => {},
    };
    if (this.primitives.hasSources) this.primitives.prepare(c);
    e.frameGraph.prepare(c);
    const pipeline = this.pipeline(c, c.shader, false);
    let cached = this.groups.get(pipeline);
    if (
      !cached ||
      cached.entries.length !== c.bindings.length ||
      c.bindings.some((entry, i) => entry.resource !== cached!.entries[i].resource)
    ) {
      cached = {
        entries: c.bindings.slice(),
        group: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.uniform! } }, ...c.bindings],
        }),
      };
      this.groups.set(pipeline, cached);
    }
    const batches = new Map<Geometry, number[]>();
    for (const mesh of e.meshes.values())
      if (
        mesh.geometry?.indices.length &&
        e.store.visible[mesh.id] &&
        inView(scope, mesh) &&
        intersects(matrix, mesh.matrix, mesh.geometry.bounds, this.clip)
      ) {
        let values = batches.get(mesh.geometry);
        if (!values) {
          values = [];
          batches.set(mesh.geometry, values);
        }
        values.push(...mesh.matrix, ...mesh.material.data);
        values[values.length - 1] = mesh.id;
      }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, cached.group);
    // Own instance buffer: the core uploads its instance buffers only when they change, so they must not be overwritten here.
    const data = new Float32Array([...batches.values()].flat());
    if (data.length && (this.instances?.size ?? 0) < data.byteLength) {
      retire(this.device!, this.instances);
      this.instances = device.createBuffer({
        size: data.byteLength * 2,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (data.length) device.queue.writeBuffer(this.instances!, 0, data);
    let offset = 0;
    for (const [geometry, values] of batches) {
      const gpu = e.geometryBuffers(geometry)!;
      pass.setVertexBuffer(0, gpu.vertex);
      pass.setVertexBuffer(1, this.instances!, offset * 4);
      pass.setIndexBuffer(gpu.index, 'uint32');
      pass.drawIndexed(geometry.indices.length, values.length / 24);
      offset += values.length;
    }
    // gltf-pro primitives whose bounding sphere meets the micro frustum, alpha cut-outs and transparency ignored, deformed (skinned) buffers used.
    const draws = this.draws,
      models = this.models.list,
      starts = this.models.starts;
    draws.reset();
    this.instanceHits = [];
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      if (model.disposed) continue;
      for (let i = 0; i < model.primitives.length; i++) {
        const p = model.primitives[i],
          inst = p.instances;
        if (!p.buffers || !shown(p.node) || (!inst && meshTriangles(p.node)?.kind === 'pbr')) continue;
        // Instances meeting the micro frustum get IDs after the pick proxies' (one slot per hit candidate, not per instance).
        if (inst) {
          for (let k = 0; k < inst.count; k++) {
            const w = instanceMatrix(p.node.matrix, inst.data, k, this.instanceWorld);
            if (intersects(matrix, w, sphere(p), this.clip)) {
              this.instanceHits.push([m, i, k]);
              draws.add(p, e.store.capacity + this.models.total + list.length + this.instanceHits.length, w);
            }
          }
          continue;
        }
        if (intersects(matrix, p.node.matrix, sphere(p), this.clip)) draws.add(p, e.store.capacity + 1 + starts[m] + i);
      }
    }
    // Pick proxies (imposter levels): the enclosing sphere under the anchor's world matrix, slots after every model primitive.
    for (let i = 0; i < list.length; i++) {
      const { anchor, sphere: b } = list[i],
        m = anchor.matrix,
        k = this.proxyMatrix;
      if (e.meshes.get(anchor.id) !== anchor || !shown(anchor) || !intersects(matrix, m, b, this.clip)) continue;
      for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) k[c * 4 + r] = m[c * 4 + r] * b[3];
      for (let r = 0; r < 4; r++) k[12 + r] = m[r] * b[0] + m[4 + r] * b[1] + m[8 + r] * b[2] + m[12 + r];
      draws.add((this.sphere ??= proxySphere(device)), e.store.capacity + 1 + this.models.total + i, k);
    }
    if (draws.count) {
      this.modelPipeline ??= modelPipeline(device, modelCode(idFragment), 'r32uint', {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',
      });
      draws.draw(device, pass, this.modelPipeline, matrix);
    }
    pass.end();
    const candidates = !this.primitives.hasSources
      ? undefined
      : this.primitives.draw(c, matrix, {
          format: 'r32uint',
          depthFormat: 'depth32float',
          filter: (node, _primitive, source, index) => {
            const owner = models.indexOf(source as unknown as ModelLike),
              p = owner < 0 ? undefined : models[owner].primitives[index];
            return (
              inView(scope, node) &&
              !p?.instances &&
              (!p || !!p.deformed || intersects(matrix, node.matrix, sphere(p), this.clip))
            );
          },
          id: (node, source, index) => {
            const owner = models.indexOf(source as unknown as ModelLike);
            return owner < 0 ? node.id + 1 : e.store.capacity + 1 + starts[owner] + index;
          },
        });
    this.overlays.forEach((overlay, slot) =>
      overlay?.drawPick({
        encoder,
        color: c.color,
        depth: c.depth,
        matrix,
        camera,
        rect,
        firstId: overlayBase + slot * overlayIds,
      }),
    );
    return candidates;
  }
  private release(): void {
    if (this.engine && attachedPickers.get(this.engine) === this) attachedPickers.delete(this.engine);
    if (!this.device) return;
    this.primitives.release();
    for (const resource of [this.ids, this.micro, this.depth, this.uniform, this.read, this.instances])
      retire(this.device!, resource);
    this.ids = this.micro = this.depth = undefined;
    this.idsView = undefined;
    this.uniform = this.read = this.instances = undefined;
    this.pipelines.clear();
    this.draws.release();
    retire(this.device!, this.sphere?.buffers?.vertex);
    retire(this.device!, this.sphere?.buffers?.index);
    this.sphere = undefined;
    this.modelPipeline = undefined;
    this.groups.clear();
    this.snapshot.clear();
    this.captured = false;
    this.context = undefined;
    this.graph = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    if (this.original && this.context) this.context.draw = this.original;
    this.original = undefined;
    this.release();
    this.primitives.dispose();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
