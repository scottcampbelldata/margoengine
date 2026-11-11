// The voxel path tracer's route on the WebGL2 compatibility layer, loaded by import() only there (the WebGL2 roadmap,
// "Package routes"). `trace` stores four vec4 sums per pixel and adds to them, which would put it on the layer's CPU tier,
// and the scatter tier would run the whole path once per stored word. Here the WebGPU kernel's path loop runs as a
// sequence of fragment programs cut from its own text (compat-staged.ts: one traversal a program, which Direct3D's
// shader compiler needs), its state kept in rgba32uint pages between them; the last program adds the samples into four
// rgba32float targets, and a small kernel adds those into the image buffers, where the WebGPU kernel stores them. The
// CPU drives the loop: it reads a census back between windows of iterations (no synchronous read, so no GPU stall) and
// stops recording once every path of a part has finished. Every other kernel runs as it stands on the layer's own tiers.
import { FRAME, TRACE } from './shaders.js';
import { FLAG_SPLIT } from './layout.js';
import { loopLimit, stagedTrace, type Stage, type StagedTrace } from './compat-staged.js';

declare const GPUShaderStage: { FRAGMENT: number; COMPUTE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number; COPY_SRC: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number; QUERY_RESOLVE: number };
declare const GPUMapMode: { READ: number };

/** Adds one dispatch's sums into the image buffers as `trace` does on WebGPU: a run's first samples replace them. */
export const ADD = /* wgsl */ `${FRAME}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read_write> accum:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> albedo:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> normals:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> caustics:array<vec4f>;
@group(1) @binding(0) var sumC:texture_2d<f32>;
@group(1) @binding(1) var sumA:texture_2d<f32>;
@group(1) @binding(2) var sumN:texture_2d<f32>;
@group(1) @binding(3) var sumS:texture_2d<f32>;
@compute @workgroup_size(8,8) fn add(@builtin(global_invocation_id) g:vec3u) {
 if(g.x>=f.tile.x||g.y>=f.tile.y){return;}
 let slot=g.y*f.tile.x+g.x;
 let t=vec2i(g.xy);
 let first=f.tile.z==0u;
 accum[slot]=select(accum[slot],vec4f(0.0),first)+textureLoad(sumC,t,0);
 albedo[slot]=select(albedo[slot],vec4f(0.0),first)+textureLoad(sumA,t,0);
 normals[slot]=select(normals[slot],vec4f(0.0),first)+textureLoad(sumN,t,0);
 if((f.config.z&${FLAG_SPLIT}u)!=0u){caustics[slot]=select(caustics[slot],vec4f(0.0),first)+textureLoad(sumS,t,0);}
}
`;

/** What a trace bind group binds; the route binds the same buffers in its own layouts. */
export interface TraceInputs {
  readonly frame: GPUBufferBinding;
  readonly table0: GPUBuffer;
  readonly voxels: GPUBuffer;
  readonly scene: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly env: GPUBuffer;
  readonly tables: GPUBuffer;
  /** accum, albedo, normals, caustics. */
  readonly images: readonly GPUBufferBinding[];
}

/** The route's stand-in for the `trace` compute pipeline: its programs, `sums` the last. */
export interface RouteKernel {
  readonly sums: GPURenderPipeline;
  readonly stages: Readonly<Record<Stage, GPURenderPipeline>>;
}

const SUMS = 'rgba32float',
  STATE = 'rgba32uint',
  // Marks the paths every program skips (the census writes 1 where a path finished an iteration ago).
  MARK = 'stencil8',
  // Paths a part of a dispatch traces at once: its state is 2 x 6 pages x 128 bytes a path (about 200 MB). A program
  // costs about 12 microseconds of GPU time and 7 of JavaScript whatever its size (RTX A6000, ANGLE Vulkan), so a part
  // four times the 2^15 paths it had before draws a quarter of the programs for the same paths.
  PART_PATHS = 1 << 17,
  // Uniform slots for the parts' places, reused in turn (a submission holds far fewer parts than this).
  PART_SLOTS = 4096,
  SLOT = 256,
  // Iterations a part runs between censuses (a submission each).
  WINDOW = 8,
  // Censuses fall on multiples of this many iterations (WINDOW, and the loop's limit), one uniform slot each.
  STEP = 4,
  // Dispatches in a row whose paths all finished a window before the horizon that bring it down a window.
  SHRINK = 4,
  // Occlusion queries a set may hold (WebGPU's limit); a dispatch needing more reads a census after every window.
  MAX_QUERIES = 4096,
  CENSUS_SLOTS = Math.ceil(loopLimit(64) / STEP) + 1;

interface Pages {
  width: number;
  height: number;
  /** [page][0 | 1]: the two copies of each page. */
  textures: GPUTexture[][];
  /** Sampled views, [page][copy]. */
  views: GPUTextureView[][];
  /** Layer views to draw into, [page][copy][layer]. */
  layers: GPUTextureView[][][];
  /** Bind groups reading the current copies, by the mask of pages whose current copy is 1. */
  groups: Map<number, GPUBindGroup>;
  /** The census's bind group per copy of page 0. */
  census: GPUBindGroup[];
  /** 1 where a path has finished and both copies of its pages hold its final state: no program draws there. */
  mark: GPUTexture;
  markView: GPUTextureView;
}

/** Four rgba32float targets of a size: `finish` reads one set and draws into another, the add kernel reads them. */
interface SumsTargets {
  width: number;
  height: number;
  textures: GPUTexture[];
  views: GPUTextureView[];
  group: GPUBindGroup;
}

/** Runs `trace` on the WebGL2 layer: per dispatch of the WebGPU route, the staged programs and the add kernel. */
export class TraceRoute {
  readonly #device: GPUDevice;
  readonly #staged: StagedTrace;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #addLayout: GPUBindGroupLayout;
  readonly #sumsLayout: GPUBindGroupLayout;
  readonly #pagesLayout: GPUBindGroupLayout;
  readonly #stepLayout: GPUBindGroupLayout;
  readonly #modules: Record<Stage, GPUShaderModule>;
  readonly #groups = new WeakMap<TraceInputs, { draw: GPUBindGroup; add: GPUBindGroup }>();
  readonly #steps: GPUBuffer;
  readonly #parts: GPUBuffer;
  readonly #stepGroup: GPUBindGroup;
  readonly #censusLayout: GPUBindGroupLayout;
  readonly #censusModule: GPUShaderModule;
  /** The census's iteration per slot. */
  readonly #censusK: GPUBuffer;
  /** Census results, read back with mapAsync (the CPU waits for them without stalling the GPU). */
  #readback: GPUBuffer;
  /** The occlusion query counting a census's unmarked paths, and the buffer it resolves into. */
  #queries: GPUQuerySet;
  #resolved: GPUBuffer;
  /**
   * Per maxBounces, the iterations each part of a dispatch runs before its census is checked, and how many dispatches
   * in a row had every path finished a window earlier (SHRINK of them take the horizon a window lower).
   */
  readonly #horizons = new Map<number, { iterations: number; early: number }>();
  /** The census's two draws: the mark (stencil 1 where it passes) and the count of the paths left unmarked. */
  #census: { mark: GPURenderPipeline; count: GPURenderPipeline } | undefined;
  #slot = 0;
  #add: Promise<GPUComputePipeline> | undefined;
  #addPipeline: GPUComputePipeline | undefined;
  /** The sums each caller keeps until it adds them (by key), and those `finish` draws into before they are copied. */
  readonly #sums = new Map<number | string, SumsTargets>();
  #scratch: SumsTargets | undefined;
  /** The run in progress (runs share the pages, the census and the scratch sums, so each waits for the one before). */
  #queue: Promise<void> = Promise.resolve();
  #destroyed = false;
  #pages: Pages | undefined;

  constructor(device: GPUDevice, source = TRACE) {
    this.#device = device;
    this.#staged = stagedTrace(source);
    const F = GPUShaderStage.FRAGMENT,
      C = GPUShaderStage.COMPUTE,
      buffer = (binding: number, type: GPUBufferBindingType, visibility: number) => ({
        binding,
        visibility,
        buffer: { type },
      });
    this.#drawLayout = device.createBindGroupLayout({
      entries: [
        buffer(0, 'uniform', F),
        buffer(1, 'uniform', F),
        buffer(2, 'read-only-storage', F),
        buffer(3, 'read-only-storage', F),
        buffer(4, 'read-only-storage', F),
        buffer(5, 'read-only-storage', F),
        buffer(9, 'uniform', F),
      ],
    });
    this.#addLayout = device.createBindGroupLayout({
      entries: [buffer(0, 'uniform', C), ...[1, 2, 3, 4].map((b) => buffer(b, 'storage', C))],
    });
    this.#sumsLayout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: C | F,
        texture: { sampleType: 'unfilterable-float' as const },
      })),
    });
    this.#pagesLayout = device.createBindGroupLayout({
      entries: [...Array(this.#staged.pages).keys()].map((binding) => ({
        binding,
        visibility: F,
        texture: { sampleType: 'uint' as const, viewDimension: '2d-array' as const },
      })),
    });
    this.#stepLayout = device.createBindGroupLayout({
      entries: [0, 1].map((binding) => ({
        binding,
        visibility: F,
        buffer: { type: 'uniform' as const, hasDynamicOffset: true },
      })),
    });
    this.#modules = Object.fromEntries(
      Object.entries(this.#staged.modules).map(([stage, code]) => [stage, device.createShaderModule({ code })]),
    ) as Record<Stage, GPUShaderModule>;
    // Slot (q, page): the light kind and the page a program writes.
    const steps = new Uint32Array((this.#staged.kinds * this.#staged.pages * SLOT) / 4);
    for (let q = 0; q < this.#staged.kinds; q++)
      for (let p = 0; p < this.#staged.pages; p++) steps.set([q, p], ((q * this.#staged.pages + p) * SLOT) / 4);
    this.#steps = device.createBuffer({ size: steps.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.#steps, 0, steps);
    this.#parts = device.createBuffer({ size: PART_SLOTS * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#stepGroup = device.createBindGroup({
      layout: this.#stepLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#steps, size: 16 } },
        { binding: 1, resource: { buffer: this.#parts, size: 32 } },
      ],
    });
    this.#censusLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'uint' as const, viewDimension: '2d-array' as const } },
        { binding: 1, visibility: F, buffer: { type: 'uniform' as const, hasDynamicOffset: true } },
      ],
    });
    this.#censusModule = device.createShaderModule({ code: this.#staged.census });
    const ks = new Uint32Array((CENSUS_SLOTS * SLOT) / 4);
    for (let j = 0; j < CENSUS_SLOTS; j++) ks[(j * SLOT) / 4] = j * STEP;
    this.#censusK = device.createBuffer({ size: ks.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.#censusK, 0, ks);
    this.#readback = device.createBuffer({
      label: 'voxel-pathtracer census',
      size: 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.#queries = device.createQuerySet({ label: 'voxel-pathtracer census', type: 'occlusion', count: 1 });
    this.#resolved = device.createBuffer({
      label: 'voxel-pathtracer census query',
      size: 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  /** Compiles the programs (with `TABLES` when the scene has model tables) and, once, the add kernel. */
  async kernel(tables: boolean): Promise<RouteKernel> {
    const device = this.#device;
    this.#add ??= device.createComputePipelineAsync({
      label: 'voxel-pathtracer add',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#addLayout, this.#sumsLayout] }),
      compute: { module: device.createShaderModule({ code: ADD }), entryPoint: 'add' },
    });
    const skipMarked: GPUDepthStencilState = {
        format: MARK,
        stencilFront: { compare: 'equal' },
        stencilBack: { compare: 'equal' },
        stencilReadMask: 1,
        stencilWriteMask: 0,
      },
      stages = Object.keys(this.#modules) as Stage[],
      pipelines = await Promise.all(
        stages.map((stage) => {
          const finish = stage === 'finish',
            module = this.#modules[stage];
          return device.createRenderPipelineAsync({
            label: `voxel-pathtracer ${stage}`,
            layout: device.createPipelineLayout({
              bindGroupLayouts: [
                this.#drawLayout,
                this.#pagesLayout,
                this.#stepLayout,
                ...(finish ? [this.#sumsLayout] : []),
              ],
            }),
            vertex: { module, entryPoint: 'fill' },
            fragment: {
              module,
              entryPoint: 'stage',
              targets: finish
                ? [{ format: SUMS }, { format: SUMS }, { format: SUMS }, { format: SUMS }]
                : Array.from({ length: 8 }, () => ({ format: STATE as GPUTextureFormat })),
              ...(tables ? { constants: { TABLES: 1 } } : {}),
            },
            // Every program of the loop skips the marked paths; `start` (which clears the marks) and `finish` draw all.
            ...(finish || stage === 'start' ? {} : { depthStencil: skipMarked }),
          });
        }),
      ),
      add = await this.#add;
    this.#addPipeline = add;
    if (!this.#census) {
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#censusLayout] }),
        vertex = { module: this.#censusModule, entryPoint: 'fill' },
        [mark, count] = await Promise.all([
          device.createRenderPipelineAsync({
            label: 'voxel-pathtracer census',
            layout,
            vertex,
            fragment: { module: this.#censusModule, entryPoint: 'census', targets: [] },
            depthStencil: {
              format: MARK,
              stencilFront: { compare: 'always', passOp: 'replace' },
              stencilBack: { compare: 'always', passOp: 'replace' },
              stencilReadMask: 1,
              stencilWriteMask: 1,
            },
          }),
          device.createRenderPipelineAsync({
            label: 'voxel-pathtracer census count',
            layout,
            vertex,
            depthStencil: {
              format: MARK,
              stencilFront: { compare: 'equal' },
              stencilBack: { compare: 'equal' },
              stencilReadMask: 1,
              stencilWriteMask: 0,
            },
          }),
        ]);
      this.#census = { mark, count };
    }
    const all = Object.fromEntries(stages.map((s, i) => [s, pipelines[i]])) as Record<Stage, GPURenderPipeline>;
    return { sums: all.finish, stages: all };
  }

  // An occlusion query set of at least `count` queries, with the buffers its results go through.
  #querySet(count: number): GPUQuerySet {
    if (this.#queries.count >= count) return this.#queries;
    const device = this.#device;
    for (const o of [this.#queries, this.#resolved, this.#readback]) o.destroy();
    this.#queries = device.createQuerySet({ label: 'voxel-pathtracer census', type: 'occlusion', count });
    this.#resolved = device.createBuffer({
      label: 'voxel-pathtracer census query',
      size: count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.#readback = device.createBuffer({
      label: 'voxel-pathtracer census',
      size: count * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    return this.#queries;
  }

  // Four sums targets of at least `width` x `height`, made again when `held` is smaller.
  #sumsTargets(held: SumsTargets | undefined, width: number, height: number): SumsTargets {
    if (held && held.width >= width && held.height >= height) return held;
    const device = this.#device,
      w = Math.max(width, held?.width ?? 0),
      h = Math.max(height, held?.height ?? 0);
    for (const t of held?.textures ?? []) t.destroy();
    const textures = [0, 1, 2, 3].map(() =>
        device.createTexture({
          label: 'voxel-pathtracer sums',
          size: [w, h],
          format: SUMS,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST,
        }),
      ),
      views = textures.map((t) => t.createView());
    return {
      width: w,
      height: h,
      textures,
      views,
      group: device.createBindGroup({
        layout: this.#sumsLayout,
        entries: views.map((resource, binding) => ({ binding, resource })),
      }),
    };
  }

  // The state pages for parts of `width` x `height` virtual pixels.
  #paged(width: number, height: number): Pages {
    const held = this.#pages;
    if (held && held.width >= width && held.height >= height) return held;
    const device = this.#device,
      w = Math.max(width, held?.width ?? 0),
      h = Math.max(height, held?.height ?? 0);
    for (const t of held?.textures.flat() ?? []) t.destroy();
    held?.mark.destroy();
    const mark = device.createTexture({
      label: 'voxel-pathtracer finished paths',
      size: [w, h],
      format: MARK,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const textures = [...Array(this.#staged.pages).keys()].map(() =>
      [0, 1].map(() =>
        device.createTexture({
          label: 'voxel-pathtracer path state',
          size: [w, h, 8],
          format: STATE,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
    );
    this.#pages = {
      width: w,
      height: h,
      textures,
      views: textures.map((copies) => copies.map((t) => t.createView({ dimension: '2d-array' }))),
      layers: textures.map((copies) =>
        copies.map((t) =>
          [...Array(8).keys()].map((layer) =>
            t.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          ),
        ),
      ),
      groups: new Map(),
      census: textures[0].map((t) =>
        device.createBindGroup({
          layout: this.#censusLayout,
          entries: [
            { binding: 0, resource: t.createView({ dimension: '2d-array' }) },
            { binding: 1, resource: { buffer: this.#censusK, size: 16 } },
          ],
        }),
      ),
      mark,
      markView: mark.createView(),
    };
    return this.#pages;
  }

  #pageGroup(pages: Pages, mask: number): GPUBindGroup {
    let group = pages.groups.get(mask);
    if (!group) {
      group = this.#device.createBindGroup({
        layout: this.#pagesLayout,
        entries: pages.views.map((copies, binding) => ({ binding, resource: copies[(mask >> binding) & 1] })),
      });
      pages.groups.set(mask, group);
    }
    return group;
  }

  #bound(i: TraceInputs) {
    let groups = this.#groups.get(i);
    if (!groups) {
      const device = this.#device,
        buffer = (binding: number, b: GPUBuffer) => ({ binding, resource: { buffer: b } });
      groups = {
        draw: device.createBindGroup({
          layout: this.#drawLayout,
          entries: [
            { binding: 0, resource: i.frame },
            buffer(1, i.table0),
            buffer(2, i.voxels),
            buffer(3, i.scene),
            buffer(4, i.materials),
            buffer(5, i.env),
            buffer(9, i.tables),
          ],
        }),
        add: device.createBindGroup({
          layout: this.#addLayout,
          entries: [
            { binding: 0, resource: i.frame },
            ...i.images.map((resource, k) => ({ binding: k + 1, resource })),
          ],
        }),
      };
      this.#groups.set(i, groups);
    }
    return groups;
  }

  /**
   * One dispatch of `trace`: `count` samples of `width` x `rows` pixels, the path loop run for `maxBounces` (the
   * frame's), in parts of at most PART_PATHS paths, the sums kept under `key`; with `add`, the last submission also
   * adds them into the image buffers (otherwise `add` does that later). `check` runs between windows and may throw to
   * give up (an aborted render, a disposed tracer); runs wait for one another. Resolves once the last submission is
   * made.
   *
   * Each part runs its loop WINDOW iterations at a time, a submission each. After every window a census marks, in a
   * stencil, the paths that finished an iteration before: their programs only copy their state from one copy of each
   * page to the other, and the iteration after a path finished has written every page (vertex writes them all), so
   * both copies hold its final state, and every later program skips the marked paths by the stencil test without
   * changing a value `finish` reads. Reading a census back takes the browser about a frame (WebGL2 makes query and
   * fence results available only in a later task, measured at 15 ms in Chromium whatever the work), so the route does
   * not wait for one per window: each part runs for the iterations the dispatch before needed (the horizon), every part
   * back to back, and their last censuses are read together once all are submitted. A part with a path still running at
   * the horizon makes the dispatch run again, reading a census after every window, which sets the horizon anew; the
   * values are the same either way.
   */
  run(
    kernel: RouteKernel,
    inputs: TraceInputs,
    width: number,
    rows: number,
    count: number,
    maxBounces: number,
    check: () => void,
    key: number | string,
    add: boolean,
  ): Promise<void> {
    const job = this.#queue.then(() => this.#run(kernel, inputs, width, rows, count, maxBounces, check, key, add));
    this.#queue = job.then(
      () => {},
      () => {},
    );
    return job;
  }

  async #run(
    kernel: RouteKernel,
    inputs: TraceInputs,
    width: number,
    rows: number,
    count: number,
    maxBounces: number,
    check: () => void,
    key: number | string,
    add: boolean,
  ): Promise<void> {
    const live = () => {
      check();
      if (this.#destroyed) throw new DOMException('The trace route was destroyed', 'AbortError');
    };
    live();
    const limit = loopLimit(maxBounces),
      // Test switch (browser-check's determinism case): every iteration of the loop recorded, as the loop without the
      // early stop does, to prove the stop changes no value.
      whole = (this.#device as unknown as { voxelTraceWholeLoop?: boolean }).voxelTraceWholeLoop === true,
      dispatch = (adaptive: boolean, horizon: number) =>
        this.#dispatch(kernel, inputs, width, rows, count, live, key, adaptive, horizon, limit);
    if (whole) await dispatch(false, limit);
    else {
      const horizon = this.#horizons.get(maxBounces),
        checked = horizon && (await dispatch(false, horizon.iterations));
      if (!checked) {
        // No horizon yet, or a path was still running at it: again, reading a census after every window.
        const needed = (await dispatch(true, limit)) as { iterations: number };
        this.#horizons.set(maxBounces, { iterations: needed.iterations, early: 0 });
      } else if (horizon) {
        const early = checked.early ? horizon.early + 1 : 0;
        this.#horizons.set(
          maxBounces,
          early >= SHRINK ? { iterations: horizon.iterations - WINDOW, early: 0 } : { iterations: horizon.iterations, early },
        );
      }
    }
    if (add) {
      const e = this.#device.createCommandEncoder({ label: 'voxel-pathtracer add' });
      this.add(e, inputs, width, rows, key);
      this.#device.queue.submit([e.finish()]);
    }
  }

  /**
   * Submits the dispatch's parts, each for at most `horizon` iterations. `adaptive`: after every window the census is
   * read back (it goes to the GPU in its own submission, ahead of the window after it, and is read while that window
   * runs) and the part stops at the first census that finds every path finished. Otherwise each part runs to the
   * horizon, and the censuses at its last two window bounds are read once every part is submitted. Resolves to the
   * horizon for the next dispatch (adaptive: the latest census point at which a part's paths had all finished, plus a
   * window) and whether every part had finished a window early, or to undefined when a part still had a path running
   * at `horizon` short of the loop's `limit`: its sums are not the loop's, and the dispatch must run again.
   */
  async #dispatch(
    kernel: RouteKernel,
    inputs: TraceInputs,
    width: number,
    rows: number,
    count: number,
    live: () => void,
    key: number | string,
    asked: boolean,
    horizon: number,
    limit: number,
  ): Promise<{ iterations: number; early: boolean } | undefined> {
    const device = this.#device,
      staged = this.#staged,
      sums = this.#sumsTargets(this.#sums.get(key), width, rows),
      scratch = (this.#scratch = this.#sumsTargets(this.#scratch, width, rows)),
      groups = this.#bound(inputs),
      maxSide = device.limits.maxTextureDimension2D,
      window = WINDOW,
      partRows = Math.max(1, Math.min(rows, Math.floor(PART_PATHS / width))),
      perPart = Math.max(1, Math.min(count, Math.floor(PART_PATHS / (width * partRows)))),
      sx = Math.max(1, Math.min(perPart, Math.floor(maxSide / width))),
      sy = Math.ceil(perPart / sx),
      pages = this.#paged(width * sx, partRows * sy),
      parts = Math.ceil(rows / partRows) * Math.ceil(count / perPart),
      // Short of the loop's limit, a part run to the horizon counts the paths left at its last two window bounds.
      // More parts than a query set holds cannot count them, so they read their censuses as they go up to the loop's
      // limit: stopping them at the horizon would cut paths still running there.
      unchecked = horizon < limit && 2 * parts > MAX_QUERIES,
      adaptive = asked || unchecked,
      counting = !adaptive && horizon < limit,
      // Adaptive: one census in flight. Otherwise two a part.
      queries = this.#querySet(counting ? 2 * parts : 1),
      current = new Array<number>(staged.pages).fill(0),
      mask = () => current.reduce((m, c, p) => m | (c << p), 0);
    if (unchecked) horizon = limit;
    this.#sums.set(key, sums);
    let encoder: GPUCommandEncoder | undefined,
      part = 0,
      // Adaptive: the latest census point at which a part had finished. Otherwise: the census point before the horizon.
      needed = 0;
    const record = () => (encoder ??= device.createCommandEncoder({ label: 'voxel-pathtracer trace' })),
      submit = () => {
        if (encoder) device.queue.submit([encoder.finish()]);
        encoder = undefined;
      },
      // Whether any path was left at each of the first `n` queries (resolved, copied out and read with mapAsync).
      read = async (n: number): Promise<boolean[]> => {
        const e = record();
        e.resolveQuerySet(queries, 0, n, this.#resolved, 0);
        e.copyBufferToBuffer(this.#resolved, 0, this.#readback, 0, n * 8);
        submit();
        await this.#readback.mapAsync(GPUMapMode.READ, 0, n * 8);
        const words = new Uint32Array(this.#readback.getMappedRange(0, n * 8).slice(0));
        this.#readback.unmap();
        return Array.from({ length: n }, (_, i) => (words[2 * i] | words[2 * i + 1]) !== 0);
      };
    for (let row0 = 0; row0 < rows; row0 += partRows) {
      const h = Math.min(partRows, rows - row0);
      for (let s0 = 0; s0 < count; s0 += perPart, part++) {
        const n = Math.min(perPart, count - s0),
          slot = this.#slot,
          vw = width * Math.min(n, sx),
          vh = h * Math.ceil(n / sx);
        this.#slot = (slot + 1) % PART_SLOTS;
        device.queue.writeBuffer(this.#parts, slot * SLOT, new Uint32Array([sx, s0, row0, h, n, vw, vh, 0]));
        const run = (stage: Stage, q = 0) => {
          const read = this.#pageGroup(pages, mask()),
            loop = stage !== 'start';
          for (const page of staged.writes[stage]) {
            const pass = record().beginRenderPass({
              label: `voxel-pathtracer ${stage}`,
              colorAttachments: pages.layers[page][1 - current[page]].map((view) => ({
                view,
                loadOp: 'load' as const,
                storeOp: 'store' as const,
              })),
              ...(loop ? { depthStencilAttachment: { view: pages.markView, stencilReadOnly: true } } : {}),
            });
            pass.setPipeline(kernel.stages[stage]);
            pass.setBindGroup(0, groups.draw);
            pass.setBindGroup(1, read);
            pass.setBindGroup(2, this.#stepGroup, [(q * staged.pages + page) * SLOT, slot * SLOT]);
            pass.setViewport(0, 0, vw, vh, 0, 1);
            pass.setScissorRect(0, 0, vw, vh);
            pass.draw(3);
            pass.end();
          }
          // A program reads the state before it, whichever pages it writes: flip them once all are written.
          for (const page of staged.writes[stage]) current[page] = 1 - current[page];
        };
        const iterations = (count: number) => {
          for (let k = 0; k < count; k++) {
            run('hit');
            run('vertex');
            run('surface');
            for (let q = 0; q < staged.kinds; q++) {
              run('sample', q);
              run('shadow', q);
              run('gather', q);
            }
            run('post');
          }
        };
        // The census before iteration `it`: marks the paths that finished an iteration before and, given a query,
        // counts those left (an occlusion query, nonzero while any is).
        const census = (it: number, query?: number) => {
          const census = this.#census!,
            pass = record().beginRenderPass({
              label: 'voxel-pathtracer census',
              colorAttachments: [],
              depthStencilAttachment: { view: pages.markView, stencilLoadOp: 'load', stencilStoreOp: 'store' },
              ...(query === undefined ? {} : { occlusionQuerySet: queries }),
            });
          pass.setViewport(0, 0, vw, vh, 0, 1);
          pass.setScissorRect(0, 0, vw, vh);
          pass.setBindGroup(0, pages.census[current[0]], [(it / STEP) * SLOT]);
          pass.setPipeline(census.mark);
          pass.setStencilReference(1);
          pass.draw(3);
          if (query !== undefined) {
            pass.setPipeline(census.count);
            pass.setStencilReference(0);
            pass.beginOcclusionQuery(query);
            pass.draw(3);
            pass.endOcclusionQuery();
          }
          pass.end();
        };
        // A new part starts with no path marked.
        record()
          .beginRenderPass({
            label: 'voxel-pathtracer marks',
            colorAttachments: [],
            depthStencilAttachment: {
              view: pages.markView,
              stencilClearValue: 0,
              stencilLoadOp: 'clear',
              stencilStoreOp: 'store',
            },
          })
          .end();
        run('start');
        let it = Math.min(window, horizon);
        iterations(it);
        if (adaptive) {
          let finished = false;
          while (it < horizon) {
            census(it, 0);
            const at = it,
              left = read(1),
              more = Math.min(window, horizon - it);
            // The window after the census runs while the census is read: when it finds every path finished, that
            // window drew nothing (every path marked).
            iterations(more);
            it += more;
            submit();
            const running = (await left)[0];
            live();
            if (!running) {
              needed = Math.max(needed, at);
              finished = true;
              break;
            }
          }
          // A part that ran the whole loop needed all of it.
          if (!finished) needed = horizon;
        } else
          for (;;) {
            submit();
            live();
            if (it >= horizon) {
              if (counting) census(it, 2 * part + 1);
              break;
            }
            const more = Math.min(window, horizon - it);
            census(it, counting && it + more >= horizon ? 2 * part : undefined);
            iterations(more);
            it += more;
          }
        // The sums: this part's samples added to those of the parts before, read from `sums` and drawn into `scratch`.
        const e = record(),
          pass = e.beginRenderPass({
            label: 'voxel-pathtracer finish',
            colorAttachments: scratch.views.map((view) => ({
              view,
              loadOp: 'load' as const,
              storeOp: 'store' as const,
            })),
          });
        pass.setPipeline(kernel.stages.finish);
        pass.setBindGroup(0, groups.draw);
        pass.setBindGroup(1, this.#pageGroup(pages, mask()));
        pass.setBindGroup(2, this.#stepGroup, [0, slot * SLOT]);
        pass.setBindGroup(3, sums.group);
        pass.setViewport(0, row0, width, h, 0, 1);
        pass.setScissorRect(0, row0, width, h);
        pass.draw(3);
        pass.end();
        // The rows just written go back to `sums`.
        for (let k = 0; k < 4; k++)
          e.copyTextureToTexture(
            { texture: scratch.textures[k], origin: [0, row0, 0] },
            { texture: sums.textures[k], origin: [0, row0, 0] },
            [width, h, 1],
          );
        submit();
      }
    }
    if (adaptive) return { iterations: Math.min(limit, needed + window), early: false };
    // A part run to the loop's limit always ends as the loop does.
    if (!counting) return { iterations: horizon, early: false };
    const left = await read(2 * parts);
    live();
    let early = true;
    for (let i = 0; i < parts; i++) {
      if (left[2 * i + 1]) return undefined;
      if (left[2 * i]) early = false;
    }
    // Whether every part had finished a window early too (the horizon may come down a window).
    return { iterations: horizon, early: early && horizon > window };
  }

  /** Adds the sums kept under `key` (a finished `run` of `width` x `rows` pixels) into the image buffers. */
  add(encoder: GPUCommandEncoder, inputs: TraceInputs, width: number, rows: number, key: number | string): void {
    const sums = this.#sums.get(key);
    if (!sums) return;
    const pass = encoder.beginComputePass({ label: 'voxel-pathtracer add' });
    pass.setPipeline(this.#addPipeline as GPUComputePipeline);
    pass.setBindGroup(0, this.#bound(inputs).add);
    pass.setBindGroup(1, sums.group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8));
    pass.end();
  }

  destroy(): void {
    this.#destroyed = true;
    for (const t of [...this.#sums.values(), this.#scratch].flatMap((s) => s?.textures ?? [])) t.destroy();
    for (const t of this.#pages?.textures.flat() ?? []) t.destroy();
    this.#pages?.mark.destroy();
    this.#sums.clear();
    this.#scratch = undefined;
    this.#pages = undefined;
    this.#steps.destroy();
    this.#parts.destroy();
    this.#censusK.destroy();
    this.#readback.destroy();
    this.#resolved.destroy();
    this.#queries.destroy();
  }
}
