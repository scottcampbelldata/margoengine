/// <reference lib="esnext.disposable" preserve="true" />
import { PbrMaterial, type EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { windShader, validateWind, type ScatterWind } from './wind.js';
import { sameBindings, snapshotBindings } from './bindings.js';

declare const GPUBufferUsage: { VERTEX: number; INDEX: number; INDIRECT: number; UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface ScatterBatch {
  name: string;
  /** Position, normal, tangent, UV0/UV1 and color, five vec4s (80 bytes). */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Column-major affine matrices, 16 floats per instance. */
  transforms: Float32Array;
  material: PbrMaterial;
  /** Linear HDR emission, added after lighting and baked occlusion. */
  emissive?: readonly [number, number, number];
  wind?: ScatterWind;
  /** Branch/foliage ripple, 0–1, layered over rooted wind. Defaults to 0. */
  windDetail?: number;
}
interface Batch {
  vertex: GPUBuffer;
  index: GPUBuffer;
  instance: GPUBuffer;
  command: GPUBuffer;
}
const vertexLayouts: GPUVertexBufferLayout[] = [
  {
    arrayStride: 80,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 16, format: 'float32x3' },
      { shaderLocation: 8, offset: 64, format: 'float32x4' },
    ],
  },
  {
    arrayStride: 128,
    stepMode: 'instance',
    attributes: [
      ...Array.from({ length: 6 }, (_, i) => ({ shaderLocation: i + 2, offset: i * 16, format: 'float32x4' as const })),
      { shaderLocation: 9, offset: 96, format: 'float32x3' },
      { shaderLocation: 10, offset: 112, format: 'float32x4' },
    ],
  },
];
const shadowShader =
  windShader +
  `
struct ShadowFrame {camera:mat4x4f,time:vec4f}
@group(0) @binding(0) var<uniform> frame:ShadowFrame;
struct Input {@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f,@location(10) wind:vec4f}
@vertex fn vertex(i:Input)->@builtin(position) vec4f {var p=mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);let bend=windDeformation(p.xyz,i.d.xyz,vec4f(i.wind.xyz,frame.time.x),i.wind.w);p=vec4f(p.x+bend.offset.x,p.y,p.z+bend.offset.y,1);return frame.camera*p;}
`;
let serial = 0;

/** Fixed, indirect PBR instances. The factory runs only at upload/device restoration; CPU geometry is not retained. */
export class ScatterInstances implements EnginePlugin {
  readonly name = 'scatter:instances:' + ++serial;
  readonly batches: { name: string; vertices: number; indices: number; instances: number }[] = [];
  disposed = false;
  /** Multiplies all batch emission; a callback is sampled each render. */
  emissiveIntensity: number | (() => number) = 1;
  private engine?: Engine;
  private resources: Batch[] = [];
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(36);
  private readonly shadowValues = new Float32Array(20);
  private time = 0;
  private shadowPipeline?: GPURenderPipeline;
  private shadowUniforms: GPUBuffer[] = [];
  private shadowGroups: GPUBindGroup[] = [];
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private shader = '';
  private format = '';
  private bindings: GPUBindGroupEntry[] = [];
  private readonly color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.color],
    depthStencilAttachment: this.depth,
  };

  constructor(private readonly generate: () => readonly ScatterBatch[]) {
    if (typeof generate !== 'function') throw new TypeError('Expected an instance factory');
  }
  static attach(engine: EngineKernel, generate: () => readonly ScatterBatch[]): ScatterInstances {
    const effect = new ScatterInstances(generate);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('PBR scatter requires WebGPU');
    this.engine = engine;
    const d = engine.gpu;
    const upload = (data: Float32Array | Uint32Array, usage: number): GPUBuffer => {
      if (data.byteLength > d.limits.maxBufferSize) throw new RangeError('Instances exceed GPU buffer limit');
      const buffer = d.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      try {
        d.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      } catch (error) {
        buffer.destroy();
        throw error;
      }
      return buffer;
    };
    try {
      this.uniform = d.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      for (const b of this.generate()) {
        const count = b.vertices.length / 20,
          instances = b.transforms.length / 16;
        if (
          !(b.vertices instanceof Float32Array) ||
          !(b.indices instanceof Uint32Array) ||
          !(b.transforms instanceof Float32Array) ||
          !(b.material instanceof PbrMaterial) ||
          !Number.isInteger(count) ||
          count < 3 ||
          count > 1_000_000 ||
          !Number.isInteger(instances) ||
          instances < 1 ||
          instances > 1_000_000 ||
          !b.indices.length ||
          b.indices.length % 3 ||
          b.indices.some((i) => i >= count) ||
          b.vertices.some((v) => !Number.isFinite(v)) ||
          b.transforms.some((v) => !Number.isFinite(v))
        )
          throw new RangeError('Invalid PBR scatter batch');
        if (
          b.emissive !== undefined &&
          (b.emissive.length !== 3 ||
            [0, 1, 2].some((i) => !Number.isFinite(Math.fround(b.emissive![i])) || b.emissive![i] < 0))
        )
          throw new RangeError('Invalid scatter emission');
        const windLength = b.wind ? validateWind(b.wind) : 1;
        if (
          b.windDetail !== undefined &&
          (!b.wind || !Number.isFinite(b.windDetail) || b.windDetail < 0 || b.windDetail > 1)
        )
          throw new RangeError('Invalid scatter wind detail');
        const wind = b.wind ? [b.wind[0] / windLength, b.wind[1] / windLength, b.wind[2]] : undefined;
        const packed = new Float32Array(instances * 32);
        for (let i = 0; i < instances; i++) {
          const m = b.transforms.subarray(i * 16, i * 16 + 16);
          const det =
            m[0] * (m[5] * m[10] - m[6] * m[9]) -
            m[4] * (m[1] * m[10] - m[2] * m[9]) +
            m[8] * (m[1] * m[6] - m[2] * m[5]);
          if (m[3] || m[7] || m[11] || m[15] !== 1 || !Number.isFinite(det) || !det)
            throw new RangeError('Expected nonsingular affine instance transforms');
          packed.set(m, i * 32);
          packed.set(b.material.data, i * 32 + 16);
          packed[i * 32 + 23] = -1; // Fixed batches have no core mesh ID.
          if (b.emissive) packed.set(b.emissive, i * 32 + 24);
          if (wind) packed.set(wind, i * 32 + 28);
          packed[i * 32 + 31] = b.windDetail ?? 0;
        }
        const buffers: GPUBuffer[] = [];
        try {
          buffers.push(upload(b.vertices, GPUBufferUsage.VERTEX));
          buffers.push(upload(b.indices, GPUBufferUsage.INDEX));
          buffers.push(upload(packed, GPUBufferUsage.VERTEX));
          buffers.push(upload(new Uint32Array([b.indices.length, instances, 0, 0, 0]), GPUBufferUsage.INDIRECT));
        } catch (error) {
          for (const buffer of buffers) buffer.destroy();
          throw error;
        }
        this.resources.push({ vertex: buffers[0], index: buffers[1], instance: buffers[2], command: buffers[3] });
        this.batches.push({ name: b.name, vertices: count, indices: b.indices.length, instances });
      }
      const module = d.createShaderModule({ code: shadowShader });
      this.shadowPipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: vertexLayouts },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      for (let i = 0; i < 4; i++) {
        const buffer = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.shadowUniforms.push(buffer);
        this.shadowGroups.push(
          d.createBindGroup({
            layout: this.shadowPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer } }],
          }),
        );
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid scatter delta');
    this.time = this.time + delta;
  }
  private draw(c: Context): void {
    const intensity = typeof this.emissiveIntensity === 'function' ? this.emissiveIntensity() : this.emissiveIntensity;
    if (typeof intensity !== 'number' || !Number.isFinite(Math.fround(intensity)) || intensity < 0)
      throw new RangeError('Invalid scatter emissive intensity');
    const changed = !sameBindings(this.bindings, c.bindings);
    const format = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil!.format;
    if (this.shader !== c.shader || this.format !== format) {
      const code =
        windShader +
        c.shader
          .replace(/struct Frame \{[^}]+\}/, (frame) => frame.replace('}', ',windTime:vec4f }'))
          .replace(/struct Input \{[^}]+\}/, (input) =>
            input.replace(
              '}',
              ',@location(8) vertexColor:vec4f,@location(9) emissive:vec3f,@location(10) wind:vec4f }',
            ),
          )
          .replace(/struct Output \{[^}]+\}/, (output) =>
            output.replace('}', ',@location(4) emissive:vec3f,@location(5) occlusion:f32 }'),
          )
          .replace(
            'let p=model*vec4f(i.position,1);',
            'var p=model*vec4f(i.position,1);let wind=vec4f(i.wind.xyz,frame.windTime.x);let bend=windDeformation(p.xyz,i.m3.xyz,wind,i.wind.w);p=vec4f(p.x+bend.offset.x,p.y,p.z+bend.offset.y,1);',
          )
          .replace(
            'o.color=i.color.rgb;',
            'o.normal=windDetailNormal(o.normal,bend,wind);o.color=i.color.rgb*i.vertexColor.rgb;o.emissive=i.emissive*frame.windTime.y;o.occlusion=clamp(i.vertexColor.a,0.0,1.0);',
          )
          .replace('i.color*(1.0-i.material.y)*', 'i.color*(1.0-i.material.y)*i.occlusion*')
          .replace(/let linear=([^;]+);/, 'let linear=$1+i.emissive;');
      const module = c.device.createShaderModule({ code });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: vertexLayouts },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: { ...c.descriptor.depthStencil!, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      });
      this.group = undefined;
      this.shader = c.shader;
      this.format = format;
    }
    if (!this.group || changed) {
      this.group = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform! } }, ...c.bindings],
      });
      this.bindings = snapshotBindings(c.bindings);
    }
    this.values.set(c.camera.matrix);
    this.values.set(c.camera.position, 16);
    this.values.set(this.engine!.lighting.direction, 20);
    this.values.set(this.engine!.lighting.radiance, 24);
    this.values.fill(1, 28, 31);
    if (this.engine!.lighting.ambient) this.values.set(this.engine!.lighting.ambient, 28);
    this.values[32] = this.time;
    this.values[33] = intensity;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    this.color.view = c.color;
    this.depth.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    this.drawBatches(pass);
    pass.end();
  }
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: Context;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    this.shadowValues.set(matrix);
    this.shadowValues[16] = this.time;
    context.device.queue.writeBuffer(this.shadowUniforms[cascade], 0, this.shadowValues as Float32Array<ArrayBuffer>);
    pass.setPipeline(this.shadowPipeline!);
    pass.setBindGroup(0, this.shadowGroups[cascade]);
    this.drawBatches(pass);
  }
  private drawBatches(pass: GPURenderPassEncoder): void {
    // shortcut: draws every fixed instance, add GPU culling for large populations.
    for (let i = 0; i < this.resources.length; i++) {
      const b = this.resources[i];
      pass.setVertexBuffer(0, b.vertex);
      pass.setVertexBuffer(1, b.instance);
      pass.setIndexBuffer(b.index, 'uint32');
      pass.drawIndexedIndirect(b.command, 0);
    }
  }
  private release(): void {
    for (const b of this.resources) {
      b.vertex.destroy();
      b.index.destroy();
      b.instance.destroy();
      b.command.destroy();
    }
    for (const b of this.shadowUniforms) b.destroy();
    this.uniform?.destroy();
    this.resources.length = this.batches.length = this.shadowUniforms.length = this.shadowGroups.length = 0;
    this.uniform = undefined;
    this.pipeline = this.shadowPipeline = undefined;
    this.group = undefined;
    this.shader = this.format = '';
    this.bindings.length = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
