// Geometry that is not a part, drawn into the occluder depth of `CulledInstances`: core meshes, gltf-pro models, materials
// meshes and anything with `drawOccluder`, such as Terrain. An occluder must be a surface the frame really shows, or
// parts behind it would vanish: so only front faces draw (a double-sided surface just occludes less), and cut-out,
// blended, displaced and clipped primitives do not occlude at all.
import type { Mesh as PublicMesh } from '@margoengine/core';
import type { Engine, Geometry, PassContext } from '@margoengine/core/extension';
import { hiddenInTree } from '../../shared/visibility.js';
import { inView } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A caster record of a `shadowPrimitives` list; see `ShadowPrimitive` in @margoengine/shadows. */
export interface OccluderPrimitive {
  primitive?: object;
  node: { readonly id: number; readonly matrix: ArrayLike<number> };
  vertex: GPUBuffer;
  vertexOffset?: number;
  index: GPUBuffer;
  count: number;
  stride: number;
  topology?: string;
  cutoff?: number;
  alpha?: number;
  displacement?: object;
  clip?: object;
  instances?: { readonly count: number; readonly mirrored?: boolean; upload(device: GPUDevice): GPUBuffer };
}
/** What `drawOccluder` receives: draw into `pass` with this frame's camera, depth greater-equal, `samples` samples. */
export interface OccluderContext {
  device: GPUDevice;
  pass: GPURenderPassEncoder;
  samples: number;
}
/** Anything {@link CulledInstances.addOccluder} takes besides a core mesh. */
export interface OccluderSource {
  /** Opaque triangles of a model or materials mesh, as for `shadows.add`. */
  readonly shadowPrimitives?: readonly OccluderPrimitive[];
  /** Blended and transmissive primitives of `shadowPrimitives`, which do not occlude. */
  readonly tintPrimitives?: readonly { primitive?: object }[];
  /** Draws its own depth into the occluder pass, for geometry a vertex stage builds (`Terrain`). */
  drawOccluder?(context: OccluderContext): void;
  readonly disposed?: boolean;
}
/** A core mesh handle, as far as occluding goes. */
export interface OccluderMesh {
  readonly id: number;
  readonly geometry?: Geometry | null;
  readonly matrix: ArrayLike<number>;
}
/** What `addOccluder` takes: a mesh from `engine.createMesh()`, or anything {@link OccluderSource} lists. */
export type OccluderInput = OccluderMesh | PublicMesh | OccluderSource;

const shader = `
struct Occluder {camera:mat4x4f,model:mat4x4f}
@group(0) @binding(0) var<uniform> o:Occluder;
@vertex fn plain(@location(0) p:vec3f)->@builtin(position) vec4f {return o.camera*(o.model*vec4f(p,1));}
@vertex fn rows(@location(0) p:vec3f,@location(5) a:vec4f,@location(6) b:vec4f,@location(7) c:vec4f,@location(8) d:vec4f)->@builtin(position) vec4f {
  return o.camera*(o.model*(mat4x4f(a,b,c,d)*vec4f(p,1)));
}
`;
/** Bytes per occluder in the uniform: a dynamic offset must be a multiple of 256. */
const SLOT = 256;
const rowLayout: GPUVertexBufferLayout = {
  arrayStride: 96,
  stepMode: 'instance',
  attributes: [5, 6, 7, 8].map((shaderLocation, i) => ({ shaderLocation, offset: i * 16, format: 'float32x4' as const })),
};

interface Draw {
  vertex: GPUBuffer;
  offset: number;
  index: GPUBuffer;
  count: number;
  stride: number;
  mirrored: boolean;
  rows?: GPUBuffer;
  instances: number;
}

export class OccluderList {
  private readonly sources = new Set<OccluderMesh | OccluderSource>();
  private layout?: GPUBindGroupLayout;
  private module?: GPUShaderModule;
  private pipelines = new Map<string, GPURenderPipeline>();
  private uniform?: GPUBuffer;
  private group?: GPUBindGroup;
  private capacity = 0;
  private data = new Float32Array(0);
  private samples = 0;

  add(input: OccluderInput): void {
    // A public Mesh is the runtime mesh behind a narrower type.
    const source = input as OccluderMesh | OccluderSource;
    if (!source || typeof source !== 'object' || !('id' in source || 'shadowPrimitives' in source || 'drawOccluder' in source))
      throw new TypeError('Invalid occluder; pass a core mesh, a model, a materials mesh or a Terrain');
    this.sources.add(source);
  }
  remove(input: OccluderInput): void {
    const source = input as OccluderMesh | OccluderSource;
    this.sources.delete(source);
  }
  get size(): number {
    return this.sources.size;
  }
  // The frame's triangle draws, each with its model matrix at its slot in `data`.
  private collect(c: Context, engine: Engine, d: GPUDevice): { draws: Draw[]; models: ArrayLike<number>[] } {
    const draws: Draw[] = [],
      models: ArrayLike<number>[] = [],
      shown = (node: OccluderPrimitive['node']) => !hiddenInTree(engine.store, node.id) && inView(c, node),
      flipped = (m: ArrayLike<number>) =>
        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) < 0;
    for (const source of this.sources) {
      if ('disposed' in source && source.disposed) {
        this.sources.delete(source);
        continue;
      }
      if ('id' in source) {
        const geometry = source.geometry,
          buffers = geometry && engine.geometryBuffers(geometry);
        if (buffers && shown(source)) {
          models.push(source.matrix);
          draws.push({
            vertex: buffers.vertex,
            offset: 0,
            index: buffers.index,
            count: geometry.indices.length,
            stride: 24,
            mirrored: flipped(source.matrix),
            instances: 1,
          });
        }
        continue;
      }
      const list = (source as OccluderSource).shadowPrimitives;
      if (!list) continue;
      const blended = new Set((source as OccluderSource).tintPrimitives?.map((p) => p.primitive));
      for (const p of list) {
        if (
          p.topology === 'line-list' ||
          p.cutoff ||
          (p.alpha !== undefined && p.alpha < 1) ||
          p.displacement ||
          p.clip ||
          (p.primitive && blended.has(p.primitive)) ||
          p.instances?.mirrored ||
          !shown(p.node)
        )
          continue;
        const count = p.instances ? p.instances.count : 1;
        if (!count) continue;
        models.push(p.node.matrix);
        draws.push({
          vertex: p.vertex,
          offset: p.vertexOffset ?? 0,
          index: p.index,
          count: p.count,
          stride: p.stride,
          mirrored: flipped(p.node.matrix),
          rows: p.instances?.upload(d),
          instances: count,
        });
      }
    }
    return { draws, models };
  }
  private pipeline(d: GPUDevice, draw: Draw): GPURenderPipeline {
    const key = `${draw.stride}:${+!!draw.rows}:${+draw.mirrored}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = d.createRenderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
        vertex: {
          module: this.module!,
          entryPoint: draw.rows ? 'rows' : 'plain',
          buffers: [
            { arrayStride: draw.stride, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            ...(draw.rows ? [rowLayout] : []),
          ],
        },
        primitive: { cullMode: 'back', frontFace: draw.mirrored ? 'cw' : 'ccw' },
        multisample: { count: this.samples },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  /** Draws every source into the occluder pass, with `c`'s camera. */
  draw(pass: GPURenderPassEncoder, c: Context, engine: Engine, samples: number): void {
    const d = c.device;
    if (samples !== this.samples) {
      this.pipelines.clear();
      this.samples = samples;
    }
    this.layout ??= d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    });
    this.module ??= d.createShaderModule({ code: shader });
    const { draws, models } = this.collect(c, engine, d);
    if (draws.length > this.capacity) {
      this.uniform?.destroy();
      this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(draws.length)));
      this.uniform = d.createBuffer({
        size: this.capacity * SLOT,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.group = d.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: { buffer: this.uniform, size: 128 } }],
      });
      this.data = new Float32Array((this.capacity * SLOT) / 4);
    }
    if (draws.length) {
      for (let i = 0; i < models.length; i++) {
        this.data.set(c.camera.matrix, (i * SLOT) / 4);
        this.data.set(models[i], (i * SLOT) / 4 + 16);
      }
      d.queue.writeBuffer(this.uniform!, 0, this.data as Float32Array<ArrayBuffer>, 0, (draws.length * SLOT) / 4);
    }
    draws.forEach((draw, i) => {
      pass.setPipeline(this.pipeline(d, draw));
      pass.setBindGroup(0, this.group!, [i * SLOT]);
      pass.setVertexBuffer(0, draw.vertex, draw.offset);
      if (draw.rows) pass.setVertexBuffer(1, draw.rows);
      pass.setIndexBuffer(draw.index, 'uint32');
      pass.drawIndexed(draw.count, draw.instances);
    });
    for (const source of this.sources)
      if ('drawOccluder' in source) source.drawOccluder?.({ device: d, pass, samples });
  }
  /** Frees the GPU side; the sources stay. */
  release(): void {
    this.uniform?.destroy();
    this.uniform = this.group = this.layout = this.module = undefined;
    this.pipelines.clear();
    this.capacity = this.samples = 0;
  }
}
