/// <reference lib="esnext.disposable" preserve="true" />
// Caustics for any scene, an HDR PostStack stage: the sun refracted through any surface mesh (a pool, a pond, the
// liquid in a tank, a rippled glass sheet) and thrown onto every opaque receiver below it, by the shared beam method of
// caustics-shader.ts that water/caustics also draws with. The mesh is one refracting interface: light enters it and
// the receivers are inside the medium.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { accumulateNormals } from '../../shared/normals.js';
import { group, render } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
import {
  type CausticSurfaceShader,
  causticBeams,
  causticCopy,
  causticPartials,
  causticProject,
  causticRange,
} from './caustics-shader.js';

export {
  causticBeams,
  causticCopy,
  causticPartials,
  causticProject,
  causticRange,
  type CausticMask,
  type CausticSurfaceShader,
} from './caustics-shader.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];

/** World-space triangles of the refracting surface. Copied on `attach` and `setGeometry`. */
export interface CausticSurfaceGeometry {
  /** xyz per vertex, world space. */
  positions: ArrayLike<number>;
  /** xyz per vertex, pointing out of the medium (up for a water surface). Default: area-weighted normals. */
  normals?: ArrayLike<number>;
  /** Three per triangle. Default: the vertices in order, three per triangle. */
  indices?: ArrayLike<number>;
}
/** A shadow map the beams and receivers read (`@margoengine/shadows`' `Shadows` fits). */
export interface CausticShadowSource {
  pbr(group: number): { readonly declarations: string };
  bindings(): GPUBindGroupEntry[];
}
/** Options of {@link SurfaceCaustics}; the object is kept and read every frame, except `geometry`, `resolution` and `layers`. */
export interface SurfaceCausticsOptions {
  /** The refracting surface. Required. */
  geometry: CausticSurfaceGeometry;
  /** Centre `[x, z]` of the square that receives light. Default the middle of the surface's bounds. */
  center?: readonly [number, number];
  /** Side of that square, 0.1 to 100000 m. Default twice the surface's larger horizontal extent. */
  size?: number;
  /** Lowest and highest receiver heights. Default from one `size` below the surface's lowest point up to that point. */
  heightRange?: readonly [number, number];
  /** Map side, a power of two from 32 to 2048. Default 256. */
  resolution?: number;
  /** Horizontal depth slices, a whole number from 2 to 32. Default 12. */
  layers?: number;
  /** Multiplier of the refracted sun light, 0 to 100. Default 1. */
  intensity?: number;
  /** Index of refraction of the medium under the surface, 1 to 3. Default 1.333 (water); 1.5 is glass. */
  refractiveIndex?: number;
  /** RGB absorption per metre in the medium, each 0 to 100. Default [0, 0, 0]. */
  absorption?: Vec3;
  /** Linear RGB tint of the light, each 0 to 100. Default [1, 1, 1]. */
  color?: Vec3;
  /** Shadows for the light entering the surface and reaching receivers. Default none. */
  shadows?: CausticShadowSource;
  /** False passes the picture through. Default true. */
  enabled?: boolean;
}

/** The mesh as the shared beam shaders read it: six floats per triangle corner (world position, then normal). */
const meshSurface = (triangles: number): CausticSurfaceShader => ({
  prelude: '',
  bindings: '@group(1) @binding(1) var<storage,read> corners:array<f32>;',
  sample:
    'let k=id*6u;let position=vec3f(corners[k],corners[k+1u],corners[k+2u]);' +
    'return Sample(position,vec3f(corners[k+3u],corners[k+4u],corners[k+5u]),position.xz);',
  dry: '',
  triangles,
});

const fail = (message: string): never => {
  throw new RangeError(`SurfaceCaustics ${message}`);
};
/** Corners of the triangles, six floats each, and the bounds `[minX, minY, minZ, maxX, maxY, maxZ]`. */
function corners(geometry: CausticSurfaceGeometry): { data: Float32Array; bounds: number[] } {
  const p = geometry?.positions;
  if (!p || p.length % 3 || !p.length) fail('geometry needs xyz positions');
  const vertices = p.length / 3,
    indices = geometry.indices ?? Array.from({ length: vertices - (vertices % 3) }, (_, i) => i);
  if (indices.length % 3 || !indices.length) fail('geometry needs whole triangles');
  for (let i = 0; i < indices.length; i++)
    if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= vertices)
      fail(`index ${indices[i]} is outside 0..${vertices - 1}`);
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) fail('positions must be finite');
  let n = geometry.normals;
  if (n && n.length !== p.length) fail('normals need one xyz per position');
  n ??= accumulateNormals(p, indices, new Float32Array(p.length));
  const data = new Float32Array(indices.length * 6),
    bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3,
      length = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    for (let a = 0; a < 3; a++) {
      data[i * 6 + a] = p[v + a];
      data[i * 6 + 3 + a] = n[v + a] / length;
      bounds[a] = Math.min(bounds[a], p[v + a]);
      bounds[a + 3] = Math.max(bounds[a + 3], p[v + a]);
    }
  }
  return { data, bounds };
}

/**
 * Sun caustics from any refracting surface onto every opaque receiver under it: each surface triangle is refracted at
 * its corners' normals and traced down as a beam into `layers` horizontal slices of a map over the receiving square;
 * a receiver pixel reads the slices at its height and adds the flux through its own normal times its own colour. The
 * same beams water's `Caustics` draws, on a mesh you give. Join a scene's PostStack with `SurfaceCaustics.attach`.
 * @example
 * const pool = SurfaceCaustics.attach(engine, { geometry: waterSurface, refractiveIndex: 1.333 });
 * pool.setGeometry(nextWaves); // when the surface moves
 */
export class SurfaceCaustics implements EnginePlugin {
  readonly name = 'post:surface-caustics';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private readonly resolution: number;
  private readonly layers: number;
  private data: Float32Array;
  private bounds: number[];
  private dirty = true;
  private readonly values = new Float32Array(96);
  private readonly workspace = new Float64Array(52);
  private uniform?: GPUBuffer;
  private surface?: GPUBuffer;
  private range?: GPUBuffer;
  private weights?: GPUBuffer;
  private partials?: GPUBuffer;
  private sampler?: GPUSampler;
  private maps: GPUTexture[] = [];
  private beam?: GPURenderPipeline;
  private measure?: GPUComputePipeline;
  private chunks?: GPUComputePipeline;
  private reduce?: GPUComputePipeline;
  private beamKey = '';
  private readonly pipelines = new Map<string, GPURenderPipeline>();

  constructor(readonly options: SurfaceCausticsOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('SurfaceCaustics needs options.geometry');
    ({ data: this.data, bounds: this.bounds } = corners(options.geometry));
    this.resolution = options.resolution ?? 256;
    this.layers = options.layers ?? 12;
    this.validate();
  }
  /** Adds a new SurfaceCaustics to the scene's PostStack after its last HDR effect, or to a new PostStack. */
  static attach(engine: EngineKernel, options: SurfaceCausticsOptions): SurfaceCaustics {
    const effect = new SurfaceCaustics(options);
    effect.stack = PostStack.join(engine, effect);
    return effect;
  }
  /** Replaces the surface (moving waves, a sloshing tank); copied at once, uploaded on the next frame. */
  setGeometry(geometry: CausticSurfaceGeometry): void {
    if (this.disposed) throw new MargoError('disposed', 'SurfaceCaustics is disposed; create a new SurfaceCaustics');
    const next = corners(geometry);
    if (next.data.length !== this.data.length) this.beamKey = '';
    ({ data: this.data, bounds: this.bounds } = next);
    this.options.geometry = geometry;
    this.dirty = true;
  }
  private validate(): void {
    const o = this.options;
    for (const [name, min, max, integer] of [
      ['size', 0.1, 100000, false],
      ['resolution', 32, 2048, true],
      ['layers', 2, 32, true],
      ['intensity', 0, 100, false],
      ['refractiveIndex', 1, 3, false],
    ] as const) {
      const value = o[name];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      )
        fail(`${name} must be ${integer ? 'a whole number' : 'finite'} from ${min} to ${max}`);
    }
    if (o.resolution !== undefined && o.resolution & (o.resolution - 1)) fail('resolution must be a power of two');
    const range = o.heightRange;
    if (
      range !== undefined &&
      (range.length !== 2 || !range.every(Number.isFinite) || !(Math.fround(range[0]) < Math.fround(range[1])))
    )
      fail('heightRange needs a finite bottom below its top');
    if (o.center !== undefined && (o.center.length !== 2 || !o.center.every(Number.isFinite)))
      fail('center needs finite [x, z]');
    for (const name of ['absorption', 'color'] as const) {
      const value = o[name];
      if (value !== undefined && (value.length !== 3 || value.some((v) => !Number.isFinite(v) || v < 0 || v > 100)))
        fail(`${name} needs three finite channels from 0 to 100`);
    }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('SurfaceCaustics enabled must be a boolean');
    if (o.shadows !== undefined && (typeof o.shadows.pbr !== 'function' || typeof o.shadows.bindings !== 'function'))
      throw new TypeError('SurfaceCaustics shadows must have pbr and bindings, as Shadows does');
  }
  private joinStack(host: StackHost): StackStage {
    if (this.disposed) throw new MargoError('disposed', 'SurfaceCaustics is disposed; create a new SurfaceCaustics');
    if (this.stacked)
      throw new MargoError('attached', 'SurfaceCaustics is already attached; create a new SurfaceCaustics');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'SurfaceCaustics is disposed; create a new SurfaceCaustics');
    if (!this.stacked)
      throw new MargoError(
        'state',
        'SurfaceCaustics runs inside a PostStack; use SurfaceCaustics.attach(engine, options)',
      );
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'SurfaceCaustics requires a GPU device (WebGPU or the WebGL2 compatibility layer)',
      );
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    for (let i = 0; i < 3; i++)
      this.maps.push(
        device.createTexture({ size: [this.resolution, this.resolution, this.layers], format: 'rgba16float', usage }),
      );
    this.range = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
    this.partials = device.createBuffer({ size: causticPartials * 4, usage: GPUBufferUsage.STORAGE });
    this.dirty = true;
  }
  /** Settings of this frame: the receiving square, slices and the sun from the scene's lighting. */
  private write(c: Context): void {
    const o = this.options,
      v = this.values,
      b = this.bounds,
      light = this.engine!.lighting,
      size = o.size ?? Math.max(0.1, 2 * Math.max(b[3] - b[0], b[5] - b[2])),
      center = o.center ?? [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2],
      heights = o.heightRange ?? [b[1] - size, b[1]];
    v.fill(0);
    v.set(c.camera.matrix);
    if (!invertMatrixStable(c.camera.matrix, v.subarray(16, 32), this.workspace))
      throw new MargoError('state', 'SurfaceCaustics needs an invertible camera');
    v.set([center[0], 0, center[1], 0], 32);
    const length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
    v.set([light.direction[0] / length, light.direction[1] / length, light.direction[2] / length, size / 2], 48);
    v.set([light.radiance[0], light.radiance[1], light.radiance[2], light.direction[3]], 52);
    v.set(c.view?.viewport ?? [0, 0, c.width, c.height], 56);
    v.set([heights[0], heights[1], this.layers, o.intensity ?? 1], 80);
    v.set([o.refractiveIndex ?? 1.333, this.resolution, 0, 0], 84);
    v.set(o.absorption ?? [0, 0, 0], 88);
    v.set(o.color ?? [1, 1, 1], 92);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
  }
  private build(c: Context, shadow: string): void {
    const triangles = this.data.length / 18,
      key = `${triangles}:${shadow}`;
    if (this.dirty || !this.surface || this.surface.size < Math.max(4, this.data.byteLength)) {
      if (!this.surface || this.surface.size < this.data.byteLength) {
        this.surface?.destroy();
        this.surface = c.device.createBuffer({
          size: Math.max(4, this.data.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      }
      c.device.queue.writeBuffer(this.surface, 0, this.data as Float32Array<ArrayBuffer>);
      this.dirty = false;
    }
    if (key === this.beamKey) return;
    const surface = meshSurface(triangles),
      module = c.device.createShaderModule({ code: causticBeams(surface, shadow) }),
      blend = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      } as const;
    this.beam = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'beamVertex' },
      fragment: {
        module,
        entryPoint: 'beamFragment',
        targets: Array.from({ length: 3 }, () => ({ format: 'rgba16float', blend })),
      },
      primitive: { cullMode: 'none' },
    });
    const range = c.device.createShaderModule({ code: causticRange(surface) });
    this.measure = c.device.createComputePipeline({
      layout: 'auto',
      compute: { module: range, entryPoint: 'measure' },
    });
    this.chunks = c.device.createComputePipeline({ layout: 'auto', compute: { module: range, entryPoint: 'chunks' } });
    this.reduce = c.device.createComputePipeline({ layout: 'auto', compute: { module: range, entryPoint: 'reduce' } });
    this.weights?.destroy();
    this.weights = c.device.createBuffer({ size: Math.max(4, triangles * 4), usage: GPUBufferUsage.STORAGE });
    this.beamKey = key;
  }
  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      device = c.device,
      encode = !output.hdr,
      on = o.enabled !== false && o.intensity !== 0,
      shadow = o.shadows?.pbr(2).declarations ?? '',
      receive = o.shadows?.pbr(1).declarations ?? '',
      key = `${output.format}:${output.multisample?.count ?? 1}:${+encode}:${on ? receive : 'copy'}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = on
        ? render(device, causticProject(receive, { composite: true, encode }), output.format, {
            multisample: output.multisample,
          })
        : render(device, causticCopy(encode), output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    if (on) this.illuminate(c, shadow);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      on
        ? device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: this.uniform! } },
              { binding: 1, resource: input },
              { binding: 2, resource: this.host!.depthTexture!.createView({ aspect: 'depth-only' }) },
              ...this.maps.map((map, i) => ({ binding: 3 + i, resource: map.createView({ dimension: '2d-array' }) })),
              { binding: 7, resource: this.sampler! },
              { binding: 8, resource: { buffer: this.range! } },
            ],
          })
        : group(device, pipeline, [input]),
    );
    if (on && o.shadows)
      pass.setBindGroup(
        1,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: o.shadows.bindings() }),
      );
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  /** The flux bound, then the beams into every slice. */
  private illuminate(c: Context, shadow: string): void {
    this.write(c);
    this.build(c, shadow);
    const device = c.device,
      triangles = this.data.length / 18,
      settings = [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: { buffer: this.surface! } },
      ];
    const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], groups: number) => {
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries }));
      pass.dispatchWorkgroups(groups);
      pass.end();
    };
    run(this.measure!, [...settings, { binding: 3, resource: { buffer: this.weights! } }], Math.ceil(triangles / 64));
    run(
      this.chunks!,
      [
        { binding: 3, resource: { buffer: this.weights! } },
        { binding: 4, resource: { buffer: this.partials! } },
      ],
      causticPartials / 64,
    );
    run(
      this.reduce!,
      [
        { binding: 2, resource: { buffer: this.range! } },
        { binding: 4, resource: { buffer: this.partials! } },
      ],
      1,
    );
    const beams = device.createBindGroup({
      layout: this.beam!.getBindGroupLayout(1),
      entries: [...settings, { binding: 2, resource: { buffer: this.range! } }],
    });
    for (let layer = 0; layer < this.layers; layer++) {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: this.maps.map((map) => ({
          view: map.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
        })),
      });
      pass.setPipeline(this.beam!);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.beam!.getBindGroupLayout(0), entries: [] }));
      pass.setBindGroup(1, beams);
      if (this.options.shadows)
        pass.setBindGroup(
          2,
          device.createBindGroup({
            layout: this.beam!.getBindGroupLayout(2),
            entries: this.options.shadows.bindings(),
          }),
        );
      pass.draw(triangles * 6, 1, 0, layer);
      pass.end();
    }
  }
  private release(): void {
    for (const texture of this.maps) texture.destroy();
    for (const buffer of [this.uniform, this.surface, this.range, this.weights, this.partials]) buffer?.destroy();
    this.maps = [];
    this.uniform = this.surface = this.range = this.weights = this.partials = undefined;
    this.sampler = this.beam = this.measure = this.chunks = this.reduce = undefined;
    this.beamKey = '';
    this.pipelines.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  /** Removes the effect and frees its GPU resources; a stack `attach` made for it goes with it. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.removeEffect(this);
    this.stack = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
