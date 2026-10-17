/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
  type Vec3,
} from '@margoengine/core/extension';
import { instanceLayout, instancedDepth } from '../../shared/instances.js';
import { meshTriangles } from '../../shared/mesh-source.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

export interface ContactShadowOptions {
  /** Centre of the shadow on the ground; the ground is the plane y = position[1]. Default [0, 0, 0]. */
  position?: Vec3;
  /** Width (x) and depth (z) of the shadow plane in world units, or one number for a square. Default 4. */
  size?: number | readonly [number, number];
  /** Geometry up to this far above the ground casts; darkness fades linearly to zero at this height. Default 1. */
  height?: number;
  /** Blur radius in world units. Default 1.5% of the larger plane side. */
  blur?: number;
  /** Darkness where an object touches the ground, 0..1. Default 0.6. */
  opacity?: number;
  /** Shadow colour, written as-is to the scene target. Default black. */
  color?: Vec3;
  /** Texels per side of the shadow texture. Default 512. */
  resolution?: number;
  /** Re-render only when a transform, source or option changes (or after `invalidate()`); for scenes whose
   * meshes do not deform. Default false: every frame. */
  static?: boolean;
}
/** Same shape as `@margoengine/shadows`' ShadowPrimitive; gltf-pro `PBRModel` and materials meshes provide it. */
export interface ContactPrimitive {
  node: Mesh;
  vertex: GPUBuffer;
  index: GPUBuffer;
  count: number;
  stride: number;
  /** Index topology; omitted for triangle casters. Wireframe casters supply triangle-edge line indices. */
  topology?: 'triangle-list' | 'line-list';
  alphaTexture?: GPUTextureView;
  alphaSampler?: GPUSampler;
  alpha?: number;
  cutoff?: number;
  texCoord?: number;
  instances?: { readonly count: number; upload(device: GPUDevice): GPUBuffer };
}
export interface ContactSource {
  shadowPrimitives?: readonly ContactPrimitive[];
  disposed?: boolean;
}
interface Source {
  source: ContactSource | Mesh;
  primitive?: ContactPrimitive[];
}
interface Draw {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  values: Float32Array;
  vertex: GPUBuffer;
  pipeline: GPURenderPipeline;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
}

// Seen from the ground looking up: depth 0 at the ground, 1 at `height`; max blending keeps the lowest surface.
const occluderShader = (pbr: boolean) => /* wgsl */ `
struct Frame {camera:mat4x4f,model:mat4x4f,alpha:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var alphaMap:texture_2d<f32>;
@group(0) @binding(2) var alphaSampler:sampler;
struct In {@location(0) position:${pbr ? 'vec4f' : 'vec3f'},${pbr ? '@location(3) uv:vec4f,@location(4) color:vec4f' : ''}}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:In)->Out {var o:Out;o.clip=f.camera*f.model*vec4f(i.position.xyz,1);${pbr ? 'o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);o.alpha=i.color.a;' : 'o.uv=vec2f(0);o.alpha=1;'}return o;}
@fragment fn fragment(i:Out)->@location(0) vec4f {if(textureSampleLevel(alphaMap,alphaSampler,i.uv,0).a*f.alpha.x*i.alpha<f.alpha.y){discard;}return vec4f(1-i.clip.z,0,0,1);}
`;
const fullscreen =
  '@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(vec2f(f32((i<<1u)&2u),f32(i&2u))*2-1,0,1);}';
// Separable 9-tap Gaussian (sigma = 2 taps); `step` is the tap spacing in UV.
const blurShader = /* wgsl */ `
@group(0) @binding(0) var<uniform> blur:vec4f;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
${fullscreen}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let uv=p.xy/vec2f(textureDimensions(source));const w=array<f32,5>(0.2041637,0.1801738,0.1238315,0.0662822,0.0276306);
  var sum=textureSampleLevel(source,linearSampler,uv,0).r*w[0];
  for(var i=1;i<5;i++){let o=blur.xy*f32(i);sum+=(textureSampleLevel(source,linearSampler,uv+o,0).r+textureSampleLevel(source,linearSampler,uv-o,0).r)*w[i];}
  return vec4f(sum,0,0,1);
}`;
const planeShader = /* wgsl */ `
struct Plane {camera:mat4x4f,centre:vec4f,size:vec4f,color:vec4f}
@group(0) @binding(0) var<uniform> p:Plane;
@group(0) @binding(1) var shadowMap:texture_2d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  var o:Out;o.uv=vec2f(f32(i&1u),f32(i>>1u));
  o.clip=p.camera*vec4f(p.centre.x+(o.uv.x-0.5)*p.size.x,p.centre.y,p.centre.z+(0.5-o.uv.y)*p.size.y,1);return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {let a=textureSample(shadowMap,linearSampler,i.uv).r*p.color.a;return vec4f(p.color.rgb*a,a);}
`;

/**
 * Soft ground-contact shadow for product shots (three.js's ContactShadows pattern): the added meshes are drawn from
 * the ground looking up into a small texture (darker the closer to the ground), blurred, and laid on the ground as a
 * shadow-catcher plane over whatever is there. No light direction, no shadow map; independent of `@margoengine/shadows`.
 */
export class ContactShadows implements EnginePlugin {
  readonly name = 'contact-shadows';
  /** Shadow-texture updates and frames that reused the previous texture (`static`). */
  readonly stats = { updates: 0, cacheHits: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private sampler?: GPUSampler;
  private white?: GPUTexture;
  private whiteView?: GPUTextureView;
  private blurUniform?: GPUBuffer;
  private planeUniform?: GPUBuffer;
  private blurGroups: GPUBindGroup[] = [];
  private planeGroup?: GPUBindGroup;
  private blurPipeline?: GPURenderPipeline;
  private occluders = new Map<number, GPURenderPipeline>();
  private planes = new Map<string, GPURenderPipeline>();
  private draws = new Map<Mesh, Map<GPUBuffer, Draw>>();
  private readonly previousCasters: { draw: Draw; count: number; instances: number }[] = [];
  private sources: Source[] = [];
  private readonly matrix = new Float32Array(16);
  private readonly previous = new Float64Array(20);
  private readonly plane = new Float32Array(28);
  private dirty = true;
  private disposed = false;
  private count = 0;
  private readonly occluderPass: GPURenderPassDescriptor = {
    colorAttachments: [{ view: undefined!, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
  };
  constructor(readonly options: ContactShadowOptions = {}) {
    this.validate();
  }
  static attach(instance: EngineKernel, options: ContactShadowOptions = {}): ContactShadows {
    const effect = new ContactShadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** Centres the plane under `[minX, minY, minZ, maxX, maxY, maxZ]` (`model.bounds`): ground at minY, size = the larger
   * footprint side × `spread`, height = the box height. */
  fit(bounds: ArrayLike<number>, spread = 2): this {
    const b = Array.from(bounds);
    if (b.length !== 6 || !b.every(Number.isFinite) || b[0] > b[3] || b[1] > b[4] || b[2] > b[5] || !(spread >= 1))
      throw new RangeError('Invalid contact shadow bounds');
    Object.assign(this.options, {
      position: [(b[0] + b[3]) / 2, b[1], (b[2] + b[5]) / 2],
      size: Math.max(b[3] - b[0], b[5] - b[2], 1e-6) * spread,
      height: Math.max(b[4] - b[1], 1e-6),
    });
    this.validate();
    return this;
  }
  /** Includes a core mesh, gltf-pro model or materials mesh. Returns a function that removes it. */
  add(source: ContactSource | MeshHandle): () => void {
    if (this.disposed || !source) throw new TypeError('Invalid contact shadow source');
    if ((source as ContactSource).disposed === true) throw new Error('Contact shadow source is disposed');
    const runtime = 'id' in source ? meshRuntime(source as MeshHandle) : (source as ContactSource);
    if ('id' in runtime) {
      runtime.check();
      if (this.engine && runtime.engine !== this.engine)
        throw new Error('Contact shadow mesh belongs to another engine');
    } else if (!('shadowPrimitives' in runtime)) throw new TypeError('Invalid contact shadow source');
    if (this.sources.some((r) => r.source === runtime)) throw new Error('Duplicate contact shadow source');
    const r: Source = { source: runtime };
    this.sources.push(r);
    this.dirty = true;
    return () => {
      const i = this.sources.indexOf(r);
      if (i >= 0) {
        this.sources.splice(i, 1);
        this.dirty = true;
        this.clearDraws();
      }
    };
  }
  /** Re-render a `static` shadow on the next frame (e.g. after a skinned pose change). */
  invalidate(): void {
    this.dirty = true;
  }
  private validate(): void {
    const o = this.options,
      size = typeof o.size === 'number' ? [o.size, o.size] : (o.size ?? [4, 4]),
      position = o.position ?? [0, 0, 0],
      color = o.color ?? [0, 0, 0],
      resolution = o.resolution ?? 512;
    if (
      size.length !== 2 ||
      position.length !== 3 ||
      color.length !== 3 ||
      ![...size, ...position, ...color, o.height ?? 1, o.blur ?? 0, o.opacity ?? 0.6].every(Number.isFinite) ||
      size.some((v) => v <= 0) ||
      (o.height ?? 1) <= 0 ||
      (o.blur ?? 0) < 0 ||
      (o.opacity ?? 0.6) < 0 ||
      (o.opacity ?? 0.6) > 1 ||
      !Number.isInteger(resolution) ||
      resolution < 16 ||
      resolution > 4096 ||
      typeof (o.static ?? false) !== 'boolean'
    )
      throw new RangeError('Invalid contact shadow options');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Contact shadows require WebGPU and a live effect');
    for (const r of this.sources)
      if ('id' in r.source && r.source.engine !== engine)
        throw new Error('Contact shadow mesh belongs to another engine');
    const device = (this.device = engine.gpu);
    this.engine = engine;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.white = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.white },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.whiteView = this.white.createView();
    // Four blur steps at 256-byte offsets, then the plane.
    this.blurUniform = device.createBuffer({ size: 784, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.planeUniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: blurShader });
    this.blurPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r16float' }] },
    });
    this.dirty = true;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 0.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
  }
  private targets(device: GPUDevice, resolution: number): void {
    if (this.textures[0]?.width === resolution) return;
    for (const t of this.textures) t.destroy();
    this.textures = [0, 1].map(() =>
      device.createTexture({
        size: [resolution, resolution],
        format: 'r16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.views = this.textures.map((t) => t.createView());
    // Blur A→B (x), B→A (y), then again at 0.4× radius, as three.js does, to hide the tap pattern.
    this.blurGroups = [0, 1, 0, 1].map((from, i) =>
      device.createBindGroup({
        layout: this.blurPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.blurUniform!, offset: i * 256, size: 16 } },
          { binding: 1, resource: this.views[from] },
          { binding: 2, resource: this.sampler! },
        ],
      }),
    );
    this.planeGroup = undefined;
    this.dirty = true;
  }
  private render(c: Context): void {
    this.validate();
    const o = this.options,
      device = this.device!,
      engine = this.engine!,
      resolution = o.resolution ?? 512,
      [x, y, z] = o.position ?? [0, 0, 0],
      [w, d] = typeof o.size === 'number' ? [o.size, o.size] : (o.size ?? [4, 4]),
      height = o.height ?? 1;
    this.targets(device, resolution);
    // World x → clip x, z → clip y, height above ground → depth 0..1.
    const m = this.matrix;
    m[0] = 2 / w;
    m[9] = 2 / d;
    m[6] = 1 / height;
    m[12] = (-2 * x) / w;
    m[13] = (-2 * z) / d;
    m[14] = -y / height;
    m[15] = 1;
    const blur = o.blur ?? 0.015 * Math.max(w, d),
      texels = (blur / Math.max(w, d)) * resolution;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const s = this.sources[i].source;
      if (('disposed' in s && s.disposed === true) || ('id' in s && engine.meshes.get(s.id) !== s)) {
        this.sources.splice(i, 1);
        this.clearDraws();
        this.dirty = true;
      }
    }
    let changed = !o.static;
    const settings = [...m, blur, w, d, resolution];
    for (let i = 0; i < 20; i++)
      if (this.previous[i] !== settings[i]) {
        this.previous[i] = settings[i];
        changed = true;
      }
    const list: [Draw, ContactPrimitive][] = [];
    for (const r of this.sources) {
      let primitives: readonly ContactPrimitive[];
      if ('id' in r.source) {
        const node = r.source,
          triangles = meshTriangles(node);
        if (!triangles) continue;
        if (triangles.kind === 'pbr') primitives = triangles.source.shadowPrimitives;
        else {
          const buffers = engine.geometryBuffers(triangles.geometry);
          if (!buffers) continue;
          r.primitive ??= [{ node, vertex: buffers.vertex, index: buffers.index, count: 0, stride: 24 }];
          Object.assign(r.primitive[0], {
            vertex: buffers.vertex,
            index: buffers.index,
            count: triangles.geometry.indices.length,
          });
          primitives = r.primitive;
        }
      } else primitives = r.source.shadowPrimitives ?? [];
      for (const p of primitives) {
        const node = p.node;
        node.check();
        if (node.engine !== engine) throw new Error('Contact shadow source belongs to another engine');
        let visible = true;
        for (let id = node.id; id !== -1; id = engine.store.parents[id]) if (engine.store.hidden[id]) visible = false;
        if (!visible || (p.instances && !p.instances.count)) continue;
        const draw = this.record(p),
          v = draw.values,
          before = v.slice();
        v.set(m);
        v.set(node.matrix, 16);
        v[32] = p.alpha ?? 1;
        v[33] = p.cutoff ?? 0;
        v[34] = p.texCoord ?? 0;
        for (let i = 0; i < 35 && !changed; i++) if (v[i] !== before[i]) changed = true;
        const instances = p.instances?.count ?? 1,
          previous = this.previousCasters[list.length];
        if (!previous) this.previousCasters[list.length] = { draw, count: p.count, instances };
        else {
          if (previous.draw !== draw || previous.count !== p.count || previous.instances !== instances) changed = true;
          previous.draw = draw;
          previous.count = p.count;
          previous.instances = instances;
        }
        list.push([draw, p]);
      }
    }
    changed ||= this.dirty || list.length !== this.count;
    this.count = list.length;
    this.previousCasters.length = list.length;
    if (changed) {
      this.stats.updates++;
      this.dirty = false;
      (this.occluderPass.colorAttachments as GPURenderPassColorAttachment[])[0].view = this.views[0];
      const pass = c.encoder.beginRenderPass(this.occluderPass);
      try {
        for (const [draw, p] of list) {
          device.queue.writeBuffer(draw.uniform, 0, draw.values as Float32Array<ArrayBuffer>);
          pass.setPipeline(draw.pipeline);
          pass.setBindGroup(0, draw.group);
          pass.setVertexBuffer(0, p.vertex);
          pass.setIndexBuffer(p.index, 'uint32');
          if (p.instances) {
            pass.setVertexBuffer(1, p.instances.upload(device));
            pass.drawIndexed(p.count, p.instances.count);
          } else pass.drawIndexed(p.count);
        }
      } catch (error) {
        try {
          pass.end();
        } catch {}
        throw error;
      }
      pass.end();
      const steps = new Float32Array(196);
      for (let i = 0; i < 4; i++) steps[i * 64 + (i & 1)] = ((texels / 4) * (i < 2 ? 1 : 0.4)) / resolution;
      device.queue.writeBuffer(this.blurUniform!, 0, steps);
      for (let i = 0; i < 4; i++) {
        const blurPass = c.encoder.beginRenderPass({
          colorAttachments: [
            { view: this.views[1 - (i & 1)], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          ],
        });
        blurPass.setPipeline(this.blurPipeline!);
        blurPass.setBindGroup(0, this.blurGroups[i]);
        blurPass.draw(3);
        blurPass.end();
      }
    } else this.stats.cacheHits++;
    // Seen from below the ground there is nothing to catch.
    if (c.camera.position[1] <= y) return;
    const key = c.format + c.descriptor.multisample?.count + c.descriptor.depthStencil!.format;
    let pipeline = this.planes.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: planeShader });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        primitive: { topology: 'triangle-strip' },
        multisample: c.descriptor.multisample,
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
        },
      });
      this.planes.set(key, pipeline);
      this.planeGroup = undefined;
    }
    this.planeGroup ??= device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.planeUniform! } },
        { binding: 1, resource: this.views[0] },
        { binding: 2, resource: this.sampler! },
      ],
    });
    // Lifted a hair so it does not z-fight with a floor mesh at the same height.
    const p = this.plane,
      color = o.color ?? [0, 0, 0];
    p.set(c.camera.matrix);
    p[16] = x;
    p[17] = y + 1e-4 * Math.max(w, d);
    p[18] = z;
    p[20] = w;
    p[21] = d;
    p.set(color, 24);
    p[27] = o.opacity ?? 0.6;
    device.queue.writeBuffer(this.planeUniform!, 0, p);
    const stencil = c.descriptor.depthStencil!.format.includes('stencil')
      ? { stencilLoadOp: 'load' as const, stencilStoreOp: 'store' as const }
      : {};
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', ...stencil },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.planeGroup);
    pass.draw(4);
    pass.end();
  }
  private record(p: ContactPrimitive): Draw {
    const inst = !!p.instances,
      lines = p.topology === 'line-list',
      key = p.stride + (inst ? 1 : 0) + (lines ? 2 : 0);
    let pipeline = this.occluders.get(key);
    const device = this.device!;
    if (!pipeline) {
      if ((p.stride !== 24 && p.stride !== 80) || (inst && p.stride !== 80))
        throw new RangeError('Unsupported contact shadow vertex stride');
      const code = occluderShader(p.stride === 80),
        module = device.createShaderModule({ code: inst ? instancedDepth(code) : code });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: p.stride,
              attributes:
                p.stride === 80
                  ? [
                      { shaderLocation: 0, offset: 0, format: 'float32x4' },
                      { shaderLocation: 3, offset: 48, format: 'float32x4' },
                      { shaderLocation: 4, offset: 64, format: 'float32x4' },
                    ]
                  : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
            ...(inst ? [instanceLayout] : []),
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: 'r16float',
              blend: {
                color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
                alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
              },
            },
          ],
        },
        ...(lines ? { primitive: { topology: 'line-list' as const } } : {}),
      });
      this.occluders.set(key, pipeline);
    }
    let records = this.draws.get(p.node);
    if (!records) {
      records = new Map();
      this.draws.set(p.node, records);
    }
    let draw = records.get(p.index);
    if (
      !draw ||
      draw.vertex !== p.vertex ||
      draw.pipeline !== pipeline ||
      draw.alpha !== p.alphaTexture ||
      draw.sampler !== p.alphaSampler
    ) {
      draw?.uniform.destroy();
      records.delete(p.index);
      this.dirty = true;
      const uniform = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      try {
        draw = {
          uniform,
          values: new Float32Array(36),
          vertex: p.vertex,
          pipeline,
          alpha: p.alphaTexture,
          sampler: p.alphaSampler,
          group: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: p.alphaTexture ?? this.whiteView! },
              { binding: 2, resource: p.alphaSampler ?? this.sampler! },
            ],
          }),
        };
      } catch (error) {
        uniform.destroy();
        throw error;
      }
      records.set(p.index, draw);
    }
    return draw;
  }
  private clearDraws(): void {
    for (const records of this.draws.values()) for (const r of records.values()) r.uniform.destroy();
    this.draws.clear();
    this.previousCasters.length = 0;
  }
  private release(): void {
    this.clearDraws();
    for (const t of [...this.textures, this.white]) t?.destroy();
    this.blurUniform?.destroy();
    this.planeUniform?.destroy();
    this.textures = [];
    this.views = [];
    this.blurGroups = [];
    this.white =
      this.whiteView =
      this.blurUniform =
      this.planeUniform =
      this.planeGroup =
      this.blurPipeline =
      this.sampler =
        undefined;
    this.occluders.clear();
    this.planes.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.sources.length = 0;
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
