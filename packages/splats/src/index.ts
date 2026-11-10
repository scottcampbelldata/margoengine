import { checkDitherRange, ditherWGSL } from '../../shared/screen-door.js';
/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { viewMatrix } from '../../shared/view.js';
import { orthographic } from '../../shared/projection.js';
import { validateSplats, type SplatData } from './data.js';
import { foggedProject, project, render, transparentRender } from './shader.js';
import { checkFog, FOG_BYTES, writeFog, type FogLike } from '../../shared/fog.js';
export type { FogLike } from '../../shared/fog.js';
import { histogram, scan, scanTotals, scatter } from './sort.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
import { alphaBlend, surfacePass, transparencySlot, type SurfaceTransparency } from '../../shared/pass.js';
import { loadCompatRoute } from '../../shared/compat.js';
export { parseSplat, validateSplats, type SplatData } from './data.js';
export {
  parsePly,
  encodeSplat,
  decomposeCovariance,
  splatsFromAttributes,
  attributesFromSplats,
  type GaussianAttributes,
} from './ply.js';
export {
  parseSpz,
  parseSog,
  encodeSpz,
  encodeSog,
  type ParseSpzOptions,
  type ParseSogOptions,
  type SogFiles,
  type EncodeSpzOptions,
} from './compressed.js';
export { cropSplats, filterSplats, transformSplats, mergeSplats, decimateSplats, type SplatRegion } from './edit.js';
declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  INDEX: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
let nextId = 0;
/**
 * A Gaussian splat cloud: GPU projection to screen ellipses, an 8-pass radix depth sort and far-to-near blending
 * against the scene depth, every frame with no CPU sorting. `Splats.attach(engine, data)`; WebGPU only.
 * @throws TypeError / RangeError from the constructor when `data` is invalid (see `validateSplats`); RangeError when
 * attaching a cloud that exceeds the adapter's compute or storage limits.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` from `gpuState`
 * before the cloud is attached.
 */
export class Splats implements EnginePlugin {
  readonly name = 'splats:' + nextId++;
  readonly count: number;
  private readonly positions: Float32Array;
  private readonly covariances: Float32Array;
  private readonly colors: Float32Array;
  private readonly sh: Float32Array;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffers: GPUBuffer[] = [];
  // positions, covariances, colors and SH on the GPU, for `write` and `clear`.
  private inputs: GPUBuffer[] = [];
  private uniform?: GPUBuffer;
  private fadeData?: Uint32Array;
  private fadeBuffer?: GPUBuffer;
  private index?: GPUBuffer;
  private projected?: GPUBuffer;
  private evaluated?: GPUBuffer;
  private keys: GPUBuffer[] = [];
  private projection?: GPUComputePipeline;
  private projectionGroup?: GPUBindGroup;
  private projectionBuffers: GPUBuffer[] = [];
  private fogSource: FogLike | null = null;
  private fogged?: { buffer: GPUBuffer; pipeline: GPUComputePipeline; group: GPUBindGroup };
  private readonly fogData = new Float32Array(12);
  private sortPipelines: GPUComputePipeline[] = [];
  private sortGroups: GPUBindGroup[][] = [];
  // The WebGL2 layer's route (./compat.js): the whole sort as one CPU-tier dispatch.
  private compatSort?: { pipeline: GPUComputePipeline; group: GPUBindGroup };
  private renders = new Map<string, { pipeline: GPURenderPipeline; group: GPUBindGroup }>();
  private disposed = false;
  private mip = false;
  private writes = 0;
  private readonly transparency = transparencySlot();
  // Reused each frame: the draw pass descriptor and the pipeline record for the current target formats.
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly plainDepth: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };
  private readonly stencilDepth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthReadOnly: true,
    stencilReadOnly: true,
  };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment],
    depthStencilAttachment: this.plainDepth,
  };
  private record?: { pipeline: GPURenderPipeline; group: GPUBindGroup };
  private recordSamples?: number;
  private recordFormat?: GPUTextureFormat;
  private recordDepth?: GPUTextureFormat;
  private readonly values = new Float32Array(48);
  private readonly integers = new Uint32Array(this.values.buffer);
  private readonly view = this.values.subarray(16, 32);
  constructor(data: SplatData) {
    this.count = validateSplats(data);
    this.positions = new Float32Array(this.count * 4);
    this.covariances = new Float32Array(this.count * 8);
    this.colors = data.colors.slice();
    this.sh = data.sphericalHarmonics?.slice() ?? new Float32Array(4);
    for (let i = 0; i < this.count; i++) {
      this.positions.set(data.positions.subarray(i * 3, i * 3 + 3), i * 4);
      this.positions[i * 4 + 3] = data.colors[i * 4 + 3];
      this.covariances.set(data.covariances.subarray(i * 6, i * 6 + 6), i * 8);
    }
  }
  /**
   * A cloud of `count` hidden splats (opacity 0) with `coefficients` SH coefficients per channel (0, 4, 9, 16 or 25), to
   * fill later with `write`: a pool for streamed or edited splats. Hidden splats are culled before the sort.
   * @throws RangeError for a count outside 1 to 3,000,000 or another coefficient count.
   */
  static reserve(count: number, coefficients = 0): Splats {
    if (![0, 4, 9, 16, 25].includes(coefficients))
      throw new RangeError('Splat SH coefficients must be 0, 4, 9, 16 or 25');
    if (!Number.isInteger(count) || count < 1 || count > 3_000_000)
      throw new RangeError('Splats.reserve needs 1 to 3,000,000 splats');
    const covariances = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) covariances[i * 6] = covariances[i * 6 + 3] = covariances[i * 6 + 5] = 1;
    return new Splats({
      positions: new Float32Array(count * 3),
      covariances,
      colors: new Float32Array(count * 4),
      ...(coefficients ? { sphericalHarmonics: new Float32Array(count * coefficients * 3) } : {}),
    });
  }
  /** SH coefficients per channel: 0, 4, 9, 16 or 25. */
  get coefficients(): number {
    return this.sh.length === 4 ? 0 : this.sh.length / this.count / 3;
  }
  /**
   * Replaces splats `first` to `first + n - 1` with the `n` splats of `data` (same SH coefficient count as the cloud),
   * in the copy kept for device restoration and, when attached, on the GPU before the next frame.
   * @throws RangeError when `data` is invalid, has another SH coefficient count or does not fit; MargoError
   * `'disposed'` after `dispose()`.
   */
  write(first: number, data: SplatData): this {
    const n = validateSplats(data),
      k = this.coefficients;
    if ((data.sphericalHarmonics ? data.sphericalHarmonics.length / n / 3 : 0) !== k)
      throw new RangeError(`Splats.write needs ${k} SH coefficients per channel, as the cloud has`);
    this.range(first, n);
    for (let i = 0; i < n; i++) {
      this.positions.set(data.positions.subarray(i * 3, i * 3 + 3), (first + i) * 4);
      this.positions[(first + i) * 4 + 3] = data.colors[i * 4 + 3];
      this.covariances.set(data.covariances.subarray(i * 6, i * 6 + 6), (first + i) * 8);
    }
    this.colors.set(data.colors, first * 4);
    if (k) this.sh.set(data.sphericalHarmonics!, first * k * 3);
    return this.upload(first, n, true);
  }
  /**
   * Hides splats `first` to `first + count - 1` (opacity 0), as `write` would.
   * @throws RangeError when the range does not fit; MargoError `'disposed'` after `dispose()`.
   */
  clear(first: number, count: number): this {
    this.range(first, count);
    for (let i = first; i < first + count; i++) this.positions[i * 4 + 3] = this.colors[i * 4 + 3] = 0;
    return this.upload(first, count, false);
  }
  private range(first: number, n: number): void {
    if (this.disposed) throw new MargoError('disposed', 'The splats were disposed; write to a live cloud');
    if (!Number.isInteger(first) || !Number.isInteger(n) || first < 0 || n < 0 || first + n > this.count)
      throw new RangeError(
        `Splats ${first} to ${first + n - 1} are outside this cloud of ${this.count}; keep first + count within the cloud`,
      );
  }
  private upload(first: number, n: number, all: boolean): this {
    this.writes++;
    const [positions, covariances, colors, sh] = this.inputs,
      q = this.device?.queue,
      k = this.coefficients;
    if (!q || !positions || !n) return this;
    q.writeBuffer(positions, first * 16, this.positions as Float32Array<ArrayBuffer>, first * 4, n * 4);
    q.writeBuffer(colors, first * 16, this.colors as Float32Array<ArrayBuffer>, first * 4, n * 4);
    if (all) q.writeBuffer(covariances, first * 32, this.covariances as Float32Array<ArrayBuffer>, first * 8, n * 8);
    if (all && k) q.writeBuffer(sh, first * k * 12, this.sh as Float32Array<ArrayBuffer>, first * k * 3, n * k * 3);
    return this;
  }
  /** GPU bytes of the optional per-splat screen-door intervals; zero until enabled. */
  get ditherFadeBytes(): number {
    return this.fadeData?.byteLength ?? 0;
  }
  /** Sets coverage [lower,upper] for an original-order content range. Default full coverage; no opacity or sort edits. */
  setDitherFade(first: number, count: number, lower = 0, upper = 1): this {
    this.range(first, count);
    checkDitherRange([lower, upper]);
    if (!this.fadeData) {
      this.fadeData = new Uint32Array(this.count).fill(4096);
      this.record = undefined;
      this.renders.clear();
    }
    const a = Math.ceil(Math.fround(lower) * 16 - 0.5),
      b = Math.ceil(Math.fround(upper) * 16 - 0.5),
      packed = Math.max(0, a) | (Math.max(0, b) << 8);
    this.fadeData.fill(packed, first, first + count);
    if (this.device) {
      if (!this.fadeBuffer) this.prepareFade();
      else if (count)
        this.device.queue.writeBuffer(
          this.fadeBuffer,
          first * 4,
          this.fadeData as Uint32Array<ArrayBuffer>,
          first,
          count,
        );
    }
    return this;
  }
  private prepareFade(): void {
    if (!this.fadeData || !this.device || this.fadeBuffer) return;
    const d = this.device;
    this.fadeBuffer = d.createBuffer({
      size: this.fadeData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(this.fadeBuffer);
    d.queue.writeBuffer(this.fadeBuffer, 0, this.fadeData as Uint32Array<ArrayBuffer>);
  }
  /**
   * The cloud as data, after any edits or poses made on the GPU (`./edit`, `./animate`): when attached, centres,
   * covariances, opacities, colours and SH are read back into the copy kept for device restoration first. For export
   * (`encodeSplat`, `encodeSpz`, `encodeSog`) and to keep GPU edits through a device loss.
   * @throws MargoError `'disposed'` after `dispose()`; the GPU's error when the device is lost during the read.
   */
  async read(): Promise<SplatData> {
    this.range(0, 0);
    const d = this.device,
      [positions, covariances, colors, sh] = this.inputs;
    // A write or clear during the read reaches both copies after the GPU copy was taken: read again.
    for (let writes = -1; d && positions && writes !== this.writes; ) {
      writes = this.writes;
      const parts: Array<[GPUBuffer, Float32Array]> = [
          [positions, this.positions],
          [covariances, this.covariances],
          [colors, this.colors],
          [sh, this.sh],
        ],
        e = d.createCommandEncoder(),
        staging = parts.map(([b, a]) => {
          const s = d.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          e.copyBufferToBuffer(b, 0, s, 0, a.byteLength);
          return s;
        });
      d.queue.submit([e.finish()]);
      try {
        await Promise.all(staging.map((s) => s.mapAsync(GPUMapMode.READ)));
        if (writes === this.writes) staging.forEach((s, k) => parts[k][1].set(new Float32Array(s.getMappedRange())));
      } finally {
        for (const s of staging) s.destroy();
      }
    }
    const n = this.count,
      data: SplatData = {
        positions: new Float32Array(n * 3),
        covariances: new Float32Array(n * 6),
        colors: this.colors.slice(),
      };
    for (let i = 0; i < n; i++) {
      data.positions.set(this.positions.subarray(i * 4, i * 4 + 3), i * 3);
      data.covariances.set(this.covariances.subarray(i * 8, i * 8 + 6), i * 6);
    }
    if (this.coefficients) data.sphericalHarmonics = this.sh.slice();
    return data;
  }
  /**
   * Anti-aliasing (Mip-Splatting's 2D filter): when true, each splat's opacity is scaled by
   * sqrt(det(S) / det(S + 0.3 I)) of its screen covariance S, so a splat smaller than a pixel fades with its true
   * coverage instead of drawing as a 0.3 px^2 blob at full opacity, and distant or small captures stop shimmering.
   * Default false (the look trained 3DGS files were made with). Live: read each frame, no recompile.
   */
  get antialias(): boolean {
    return this.mip;
  }
  set antialias(on: boolean) {
    this.mip = !!on;
  }
  /** The fog the splats are drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }
  /**
   * Fogs the cloud: `fog` is `@margoengine/environment`'s `Fog` or any object with its fields, read every frame, with
   * Fog's maths (linear near/far, exp2 density, height falloff). Each splat's colour fades toward the fog colour by the
   * fog at its centre, in the projection pass (so `gpuState.colors` holds fogged colours); its opacity is unchanged.
   * `null` (the default) draws exactly as without fog. The first fogged frame compiles a second projection shader;
   * changing the fog or its `enabled` flag never does.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }
  static attach(instance: EngineKernel, data: SplatData): Splats {
    const effect = new Splats(data);
    engineRuntime(instance).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Splats require WebGPU and a live cloud; attach a new Splats to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    const d = this.device,
      groups = Math.ceil(this.count / 256),
      blocks = Math.ceil(groups / 256);
    if (
      blocks * 16 > 1024 ||
      groups > d.limits.maxComputeWorkgroupsPerDimension ||
      d.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      d.limits.maxComputeWorkgroupSizeX < 256 ||
      d.limits.maxStorageBuffersPerShaderStage < 7
    )
      throw new RangeError(
        'Splat compute exceeds device limits; use fewer splats or a device with larger compute limits.',
      );
    for (const size of [
      this.positions.byteLength,
      this.covariances.byteLength,
      this.colors.byteLength,
      this.sh.byteLength,
      this.count * 32,
      this.count * 16,
      this.count * 8,
      groups * 16 * 4,
    ])
      if (size > d.limits.maxBufferSize || size > d.limits.maxStorageBufferBindingSize)
        throw new RangeError('Splat attributes exceed device storage limits; use fewer splats.');
    const buffer = (size: number, usage: number, data?: Float32Array | Uint32Array) => {
      const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
      this.buffers.push(b);
      if (data) d.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    this.prepareFade();
    this.uniform = buffer(192, GPUBufferUsage.UNIFORM);
    this.index = buffer(24, GPUBufferUsage.INDEX, new Uint32Array([0, 1, 2, 2, 1, 3]));
    // Positions, colours and SH can be read back (`read`) after GPU edits such as ./edit's brush.
    const editable = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      positions = buffer(this.positions.byteLength, editable, this.positions),
      covariances = buffer(this.covariances.byteLength, editable, this.covariances),
      colors = buffer(this.colors.byteLength, editable, this.colors),
      sh = buffer(this.sh.byteLength, editable, this.sh);
    this.inputs = [positions, covariances, colors, sh];
    this.projected = buffer(this.count * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.evaluated = buffer(this.count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.keys = [0, 1].map(() => buffer(this.count * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC));
    const hist = buffer(groups * 16 * 4, GPUBufferUsage.STORAGE),
      offsets = buffer(groups * 16 * 4, GPUBufferUsage.STORAGE),
      totals = buffer(blocks * 16 * 4, GPUBufferUsage.STORAGE),
      bases = buffer(blocks * 16 * 4, GPUBufferUsage.STORAGE);
    const compute = (code: string) =>
        d.createComputePipeline({
          layout: 'auto',
          compute: { module: d.createShaderModule({ code }), entryPoint: 'main' },
        }),
      bind = (pipeline: GPUComputePipeline, list: GPUBuffer[]) =>
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: list.map((b, binding) => ({ binding, resource: { buffer: b } })),
        });
    this.projection = compute(project);
    this.projectionBuffers = [
      this.uniform,
      positions,
      covariances,
      colors,
      sh,
      this.projected,
      this.evaluated,
      this.keys[0],
    ];
    this.projectionGroup = bind(this.projection, this.projectionBuffers);
    this.sortPipelines = [histogram, scan, scanTotals, scatter].map(compute);
    const settings: GPUBuffer[] = [];
    for (let pass = 0; pass < 8; pass++) {
      const parameters = buffer(16, GPUBufferUsage.UNIFORM, new Uint32Array([this.count, groups, blocks, pass * 4])),
        front = pass % 2;
      settings.push(parameters);
      this.sortGroups.push([
        bind(this.sortPipelines[0], [parameters, this.keys[front], hist]),
        bind(this.sortPipelines[1], [parameters, hist, offsets, totals]),
        bind(this.sortPipelines[2], [parameters, totals, bases]),
        bind(this.sortPipelines[3], [parameters, this.keys[front], this.keys[1 - front], offsets, bases]),
      ]);
    }
    const keys = this.keys;
    loadCompatRoute(d, () => import('./compat.js'))?.then(({ splatCompatSort }) => {
      if (this.keys === keys) this.compatSort = splatCompatSort(d, settings[0], keys);
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':project-sort',
      order: -7,
      execute: (c) => {
        if (c.backend === 'webgpu') this.sort(c);
      },
    });
    graph.add({
      name: this.name + ':draw',
      order: 3,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private sort(c: Context): void {
    this.values.set(c.camera.matrix);
    viewMatrix(this.view, c.camera);
    this.values.set(c.camera.position, 32);
    const focal = c.height / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    const v = this.values,
      n = this.integers,
      e = c.encoder;
    v[36] = c.width;
    v[37] = c.height;
    v[38] = v[39] = focal;
    v[40] = c.camera.near;
    v[41] = c.camera.far;
    v[42] = +(c.format === 'rgba16float');
    v[43] = 0;
    // Orthographic clip matrix (e.g. @margoengine/cameras): affine Jacobian in pixels per world unit, signed near/far.
    const o = orthographic(c.camera.matrix, c.camera.position);
    if (o) {
      v[38] = (o.sx * c.width) / 2;
      v[39] = (o.sy * c.height) / 2;
      v[40] = o.near;
      v[41] = o.far;
      v[43] = 1;
    }
    n[44] = this.count;
    n[45] = this.sh.length === 4 ? 0 : this.sh.length / this.count / 3;
    n[46] = +this.mip;
    n[47] = 0;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    const fog = this.fogSource && this.fogResources(c.device);
    if (fog) {
      writeFog(this.fogSource!, c.camera.position, this.fogData);
      c.device.queue.writeBuffer(fog.buffer, 0, this.fogData);
    }
    const groups = Math.ceil(this.count / 256),
      blocks = Math.ceil(groups / 256);
    // Storage writes are visible to later dispatches in the same compute pass, so the radix stages share one pass.
    const pass = e.beginComputePass();
    try {
      if (fog) this.dispatch(pass, fog.pipeline, fog.group, groups, 1);
      else this.dispatch(pass, this.projection!, this.projectionGroup!, groups, 1);
      // Under a transparency hook the pass orders the layers, so the draw takes the keys as projected.
      if (this.transparency.hook) return;
      if (this.compatSort) this.dispatch(pass, this.compatSort.pipeline, this.compatSort.group, 1, 1);
      else
        for (let stage = 0; stage < 8; stage++) {
          const binds = this.sortGroups[stage];
          this.dispatch(pass, this.sortPipelines[0], binds[0], groups, 1);
          this.dispatch(pass, this.sortPipelines[1], binds[1], blocks, 16);
          this.dispatch(pass, this.sortPipelines[2], binds[2], 1, 1);
          this.dispatch(pass, this.sortPipelines[3], binds[3], groups, 1);
        }
    } finally {
      pass.end();
    }
  }
  /** The fog uniform and the fogged projection pipeline and group, made on the first fogged frame. */
  private fogResources(d: GPUDevice): NonNullable<Splats['fogged']> {
    if (this.fogged) return this.fogged;
    const buffer = d.createBuffer({ size: FOG_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.buffers.push(buffer);
    const pipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: foggedProject() }), entryPoint: 'main' },
    });
    return (this.fogged = {
      buffer,
      pipeline,
      group: d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...this.projectionBuffers, buffer].map((b, i) => ({ binding: i, resource: { buffer: b } })),
      }),
    });
  }
  private dispatch(
    pass: GPUComputePassEncoder,
    pipeline: GPUComputePipeline,
    group: GPUBindGroup,
    x: number,
    y: number,
  ): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(x, y);
  }
  /** Pipeline and group 0 for this target, and for `hook` when given. */
  private fadeShader(code: string): string {
    if (!this.fadeData) return code;
    return (
      ditherWGSL +
      '\n@group(0) @binding(4) var<storage,read> fadeRanges:array<u32>;\n' +
      code
        .replace('@location(1) color:vec4f}', '@location(1) color:vec4f,@location(3) @interpolate(flat) margoFade:u32}')
        .replace(
          '@location(1) color:vec4f,@location(2) margoDepth:f32}',
          '@location(1) color:vec4f,@location(2) margoDepth:f32,@location(3) @interpolate(flat) margoFade:u32}',
        )
        .replace('o.corner=corner;', 'o.corner=corner;o.margoFade=fadeRanges[index];')
        .replace(
          'let power=-4.5*dot(i.corner,i.corner);',
          'let fade=margoDitherRank(i.clip.xy);if(fade<(i.margoFade&255u)||fade>=(i.margoFade>>8u)){discard;}let power=-4.5*dot(i.corner,i.corner);',
        )
    );
  }
  private pipeline(c: Context, key: string, hook?: SurfaceTransparency): NonNullable<Splats['record']> {
    key += this.fadeData ? '|dither' : '';
    let record = this.renders.get(key);
    if (record) return record;
    const declarations = hook?.surface(1),
      module = c.device.createShaderModule({
        code: this.fadeShader(declarations ? transparentRender(declarations) : render),
      }),
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: hook ? 'transparent' : 'fragment',
          ...(hook?.blends ? { constants: { margoKind: 0 } } : {}),
          targets: hook ? [...hook.targets] : [{ format: c.format, blend: alphaBlend }],
        },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
        },
      });
    record = {
      pipeline,
      group: c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          this.uniform!,
          this.projected!,
          this.evaluated!,
          this.keys[0],
          ...(this.fadeBuffer ? [this.fadeBuffer] : []),
        ].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
    };
    this.renders.set(key, record);
    return record;
  }
  private draw(c: Context): void {
    if (this.transparency.hook) return;
    const samples = c.descriptor.multisample?.count,
      depthFormat = c.descriptor.depthStencil!.format;
    let record = this.record;
    if (
      !record ||
      this.recordSamples !== samples ||
      this.recordFormat !== c.format ||
      this.recordDepth !== depthFormat
    ) {
      record = this.pipeline(c, samples + ':' + c.format + ':' + depthFormat);
      this.record = record;
      this.recordSamples = samples;
      this.recordFormat = c.format;
      this.recordDepth = depthFormat;
      this.presentation.depthStencilAttachment = depthFormat.includes('stencil') ? this.stencilDepth : this.plainDepth;
    }
    // shortcut: clouds sort independently, combine overlapping clouds into one data set.
    this.attachment.view = c.color;
    this.presentation.depthStencilAttachment!.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(record.pipeline);
    pass.setBindGroup(0, record.group);
    pass.setIndexBuffer(this.index!, 'uint32');
    pass.drawIndexed(6, this.count);
    pass.end();
    this.engine!.stats.drawCalls++;
  }
  /**
   * Leaves the frame's draw (order 3) and the depth sort to an order-independent pass, which calls `drawTransparent`. Use
   * `addEffect` from `@margoengine/oit/vfx`. `gpuState.sorted` then holds the keys unsorted. Returns a remover; `released`
   * runs if this cloud is disposed first.
   */
  setTransparency(hook: SurfaceTransparency, released?: () => void): () => void {
    return this.transparency.set(hook, released);
  }
  /** Draws the cloud into `hook`'s pass, depth tested and not written. */
  drawTransparent(c: Context, hook: SurfaceTransparency): void {
    if (!this.uniform) return;
    const declarations = hook.surface(1),
      { pipeline, group } = this.pipeline(
        c,
        c.descriptor.multisample?.count + ':' + c.format + ':' + c.descriptor.depthStencil!.format + declarations,
        hook,
      ),
      pass = surfacePass(c.device, hook, pipeline, group);
    pass.setIndexBuffer(this.index!, 'uint32');
    pass.drawIndexed(6, this.count);
    this.engine!.stats.drawCalls++;
  }
  /** Whether the cloud is attached to a live engine, so `gpuState` holds its buffers. */
  get attached(): boolean {
    return !!this.projected;
  }
  /**
   * The cloud's GPU buffers, for entries that draw or edit it: `sorted` keys, projected `ellipses`, evaluated `colors`
   * (rgb, opacity) and the inputs `positions` (xyz, opacity), `covariances` (two vec4f per splat), `inputColors` (rgb,
   * opacity) and `sh` (SH coefficients, RGB interleaved; 4 unused floats without SH).
   */
  get gpuState(): {
    sorted: GPUBuffer;
    ellipses: GPUBuffer;
    colors: GPUBuffer;
    positions: GPUBuffer;
    covariances: GPUBuffer;
    inputColors: GPUBuffer;
    sh: GPUBuffer;
  } {
    if (!this.projected || !this.evaluated || !this.keys.length)
      throw new MargoError('state', 'Splats are not attached; attach them to an engine first');
    const [positions, covariances, inputColors, sh] = this.inputs;
    return {
      sorted: this.keys[0],
      ellipses: this.projected,
      colors: this.evaluated,
      positions,
      covariances,
      inputColors,
      sh,
    };
  }
  private release(): void {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.inputs = [];
    this.keys = [];
    this.sortGroups = [];
    this.sortPipelines = [];
    this.compatSort = undefined;
    this.renders.clear();
    this.record = undefined;
    this.fadeBuffer = undefined;
    this.uniform = this.index = this.projected = this.evaluated = undefined;
    this.projection = undefined;
    this.projectionGroup = undefined;
    this.projectionBuffers = [];
    this.fogged = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transparency.released?.();
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
