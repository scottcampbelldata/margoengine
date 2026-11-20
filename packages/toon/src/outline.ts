/// <reference lib="esnext.disposable" preserve="true" />
// One mesh's inverted-hull outline (Raskar & Cohen, "Image Precision Silhouette Edges", I3D 1999; Gooch, Sloan, Gooch,
// Shirley and Riesenfeld, "Interactive Technical Illustration", I3D 1999): the mesh is drawn a second time with its
// front faces culled and every vertex pushed out along a hull normal, so only the rim of the pushed shell shows behind
// the mesh. The hull normal follows a crease angle (Thurmer and Wuthrich, "Computing Vertex Normals from Polygonal
// Facets", JGT 1998, for the per-vertex sum): copies of a vertex at one position whose normals lie within `angle` of
// each other are averaged, so `angle` pi closes the shell over every hard edge and 0 keeps each face's own normal.
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Geometry,
  type Mesh,
  type PassContext,
} from '@margoengine/core/extension';
import { hiddenInTree } from '../../shared/visibility.js';
import { applyView, inView, viewSize } from '../../shared/view-rect.js';
import { retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { beginScenePass } from '../../shared/scene-pass.js';
import { pbrNeutral } from '../../shared/display.js';
import { fault, rangeError } from '../../shared/errors.js';
import { positionRings } from './rings.js';
import { pixelHull } from './pixel-hull.js';

declare const GPUBufferUsage: { VERTEX: number; INDEX: number; UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link MeshOutline}. Every field but `mesh` is live as a property of the same name. */
export interface MeshOutlineOptions {
  /** The mesh to outline; its world matrix and visibility are read every frame. Required. */
  mesh: MeshHandle;
  /**
   * Triangles of the hull: a core geometry (24-byte vertices, position then normal). Default the mesh's own geometry;
   * pass one when another package draws the mesh (a materials mesh keeps it on its React binding).
   */
  geometry?: Geometry | null;
  /** Line colour, linear RGB 0 or more. Default [0, 0, 0]. */
  color?: readonly [number, number, number];
  /** Line alpha 0..1, blended only when `transparent`. Default 1. */
  opacity?: number;
  /** Blend the line over the scene by `opacity` and leave depth unwritten. Default false. */
  transparent?: boolean;
  /** Width: world units, or drawing-buffer pixels when `screenspace`. 0 or more, at most 1024. Default 0.05. */
  thickness?: number;
  /** Measure `thickness` in drawing-buffer pixels, so the line keeps its width at every distance and zoom. Default false. */
  screenspace?: boolean;
  /** Tone map the colour like a lit surface (Khronos PBR Neutral); false clamps it like unlit output. Default true. */
  toneMapped?: boolean;
  /** Push the hull's depth back by `polygonOffsetFactor` times its depth slope. Default false. */
  polygonOffset?: boolean;
  /** Slope factor of `polygonOffset`, finite. Default 0. */
  polygonOffsetFactor?: number;
  /** Draw order among outlines: a higher value draws later, -1000..1000. Default 0. Fixed at construction. */
  renderOrder?: number;
  /** Crease angle in radians, 0..pi: copies of a vertex whose normals differ by less are averaged. Default pi. */
  angle?: number;
}

const code = `${pixelHull}
struct Frame {camera:mat4x4f,model:mat4x4f,color:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> u:Frame;
@vertex fn vertex(@location(0) position:vec3f,@location(1) hull:vec3f)->@builtin(position) vec4f{
  let m=u.model;let a=m[0].xyz;let b=m[1].xyz;let c=m[2].xyz;
  let n=mat3x3f(cross(b,c),cross(c,a),cross(a,b))*hull*select(-1.0,1.0,dot(a,cross(b,c))>=0.0);
  let l=length(n);let dir=select(vec3f(0),n/l,l>0.0);
  if(u.params.y>0.5){return pixelHull(u.camera*m*vec4f(position,1),u.camera*vec4f(dir,0),u.params.zw,u.params.x);}
  return u.camera*(m*vec4f(position,1)+vec4f(dir*u.params.x,0));
}
@fragment fn fragment()->@location(0) vec4f{return u.color;}`;

/**
 * For core vertices (6 floats: position, normal), the hull normal of each vertex: the sum of the normals of every copy
 * at its position within `angle` radians of its own (itself included), or its own normal where that sum vanishes.
 */
export function creasedNormals(vertices: Float32Array, angle: number): Float32Array {
  const count = Math.floor(vertices.length / 6),
    ring = positionRings(vertices, 6),
    out = new Float32Array(count * 3),
    unit = (i: number) => {
      const o = i * 6,
        x = vertices[o + 3],
        y = vertices[o + 4],
        z = vertices[o + 5],
        l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    },
    // Copies whose unit normals' dot product is at least cos(angle) join; a tiny slack keeps equal normals together.
    limit = angle >= Math.PI ? -Infinity : Math.cos(angle) - 1e-6;
  for (let i = 0; i < count; i++) {
    const own = unit(i);
    let sx = own[0],
      sy = own[1],
      sz = own[2];
    for (let k = ring[i], steps = 0; k !== i && steps < count; k = ring[k], steps++) {
      const other = unit(k);
      if (own[0] * other[0] + own[1] * other[1] + own[2] * other[2] < limit) continue;
      sx += other[0];
      sy += other[1];
      sz += other[2];
    }
    const l = Math.hypot(sx, sy, sz),
      keep = l < 1e-6;
    out[i * 3] = keep ? own[0] : sx / l;
    out[i * 3 + 1] = keep ? own[1] : sy / l;
    out[i * 3 + 2] = keep ? own[2] : sz / l;
  }
  return out;
}

/** The colour written for `color`: tone mapped (or clamped), then sRGB encoded, as core writes a surface. */
export function outlineColor(color: readonly number[], toneMapped: boolean): [number, number, number] {
  const mapped = toneMapped ? pbrNeutral([color[0], color[1], color[2]]) : color.map((v) => Math.min(v, 1));
  return [0, 1, 2].map((i) => {
    const x = Math.max(0, mapped[i]);
    return x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }) as [number, number, number];
}

let nextOutline = 0;
const finite = (v: unknown, low: number, high: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;

/**
 * drei-style `Outlines` for one mesh: an inverted hull in `color`, `thickness` world units (or pixels with
 * `screenspace`) wide, drawn after the opaque scene. `MeshOutline.attach(engine, { mesh })`; WebGPU or the WebGL2
 * compatibility layer.
 * @throws RangeError when an option is out of range or `mesh` is missing.
 * @throws MargoError `'unsupported'` on native WebGL2, `'disposed'` after `dispose()`.
 */
export class MeshOutline implements EnginePlugin {
  readonly name = 'toon:outline:' + nextOutline++;
  readonly mesh: MeshHandle;
  geometry: Geometry | null | undefined;
  color: readonly [number, number, number];
  opacity: number;
  transparent: boolean;
  thickness: number;
  screenspace: boolean;
  toneMapped: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  angle: number;
  readonly renderOrder: number;
  private engine?: Engine;
  private hull?: { geometry: Geometry; angle: number; vertex: GPUBuffer; index: GPUBuffer; count: number };
  private uniform?: GPUBuffer;
  /** Bind groups by pipeline: layout 'auto' gives each pipeline its own layout. */
  private readonly groups = new Map<GPURenderPipeline, { get(copy?: GPUBufferBinding): GPUBindGroup }>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly values = new Float32Array(40);
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined as unknown as GPUTextureView,
  };
  private disposed = false;

  constructor(options: MeshOutlineOptions) {
    if (!options || typeof options !== 'object' || !options.mesh || typeof options.mesh !== 'object')
      throw rangeError('MeshOutline needs { mesh }; pass the mesh to outline', 'arguments');
    this.mesh = options.mesh;
    this.geometry = options.geometry;
    this.color = options.color ?? [0, 0, 0];
    this.opacity = options.opacity ?? 1;
    this.transparent = options.transparent ?? false;
    this.thickness = options.thickness ?? 0.05;
    this.screenspace = options.screenspace ?? false;
    this.toneMapped = options.toneMapped ?? true;
    this.polygonOffset = options.polygonOffset ?? false;
    this.polygonOffsetFactor = options.polygonOffsetFactor ?? 0;
    this.renderOrder = options.renderOrder ?? 0;
    this.angle = options.angle ?? Math.PI;
    this.validate();
  }

  static attach(engine: EngineKernel, options: MeshOutlineOptions): MeshOutline {
    const outline = new MeshOutline(options);
    engineRuntime(engine).use(outline);
    return outline;
  }

  private validate(): void {
    const c = this.color;
    if (
      !Array.isArray(c) ||
      c.length !== 3 ||
      !c.every((v) => finite(v, 0, 1e6)) ||
      !finite(this.opacity, 0, 1) ||
      !finite(this.thickness, 0, 1024) ||
      !finite(this.angle, 0, Math.PI) ||
      !finite(this.polygonOffsetFactor, -1e6, 1e6) ||
      !finite(this.renderOrder, -1000, 1000)
    )
      throw rangeError(
        'Invalid MeshOutline options; use color three finite numbers 0 or more, opacity 0..1, thickness 0..1024, angle 0..pi, a finite polygonOffsetFactor and renderOrder -1000..1000',
        'arguments',
      );
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed
          ? 'MeshOutline was disposed; attach a new MeshOutline'
          : 'MeshOutline requires WebGPU or the WebGL2 compatibility layer; create the engine with one of those backends',
      );
    this.engine = engine;
  }

  registerPasses(graph: FrameGraph): void {
    // After the opaque draws (order 1) so the hull is depth tested against them; renderOrder sorts outlines.
    graph.add({
      name: this.name,
      order: 1.25 + this.renderOrder * 1e-5,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  /** The hull buffers of the current geometry and angle, rebuilt when either changes. */
  private buffers(device: GPUDevice, geometry: Geometry) {
    const h = this.hull;
    if (h && h.geometry === geometry && h.angle === this.angle) return h;
    if (h) {
      retire(device, h.vertex);
      retire(device, h.index);
    }
    const count = geometry.vertices.length / 6,
      normals = creasedNormals(geometry.vertices, this.angle),
      data = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      data.set(geometry.vertices.subarray(i * 6, i * 6 + 3), i * 6);
      data.set(normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    const vertex = device.createBuffer({
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
      index = device.createBuffer({
        size: Math.max(16, Math.ceil(geometry.indices.byteLength / 4) * 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    device.queue.writeBuffer(vertex, 0, data);
    device.queue.writeBuffer(index, 0, geometry.indices as Uint32Array<ArrayBuffer>);
    return (this.hull = { geometry, angle: this.angle, vertex, index, count: geometry.indices.length });
  }

  private pipeline(c: Context, mirrored: boolean): GPURenderPipeline {
    const depth = c.descriptor.depthStencil!,
      reversed = depth.depthCompare?.startsWith('greater') ?? false,
      slope = this.polygonOffset ? this.polygonOffsetFactor * (reversed ? -1 : 1) : 0,
      key = [
        c.format,
        c.descriptor.multisample?.count ?? 1,
        depth.format,
        depth.depthCompare,
        mirrored,
        this.transparent,
        slope,
      ].join(':');
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const device = c.device,
      module = device.createShaderModule({ code }),
      over = { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' } as const;
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [{ format: c.format, ...(this.transparent ? { blend: { color: over, alpha: over } } : {}) }],
      },
      // Front faces are culled; a mirrored matrix turns the winding round, so its pipeline culls back faces.
      primitive: { topology: 'triangle-list', cullMode: mirrored ? 'back' : 'front' },
      depthStencil: {
        format: depth.format,
        depthCompare: depth.depthCompare,
        depthWriteEnabled: !this.transparent,
        depthBiasSlopeScale: slope,
      },
      multisample: c.descriptor.multisample,
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private draw(c: Context): void {
    const engine = this.engine!,
      mesh = this.mesh as unknown as Mesh;
    this.validate();
    if (
      this.disposed ||
      !(this.thickness > 0) ||
      engine.meshes.get(mesh.id) !== mesh ||
      hiddenInTree(engine.store, mesh.id) ||
      !inView(c, mesh)
    )
      return;
    const geometry = this.geometry === undefined ? mesh.geometry : this.geometry;
    if (!geometry || !geometry.indices.length) return;
    const device = c.device,
      hull = this.buffers(device, geometry),
      m = mesh.matrix,
      mirrored =
        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) <
        0;
    if (!this.uniform) {
      this.uniform = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.groups.clear();
    }
    const pipeline = this.pipeline(c, mirrored),
      v = this.values,
      rgb = outlineColor(this.color, this.toneMapped),
      size = viewSize(c);
    v.set(c.camera.matrix);
    v.set(m, 16);
    v.set(rgb, 32);
    v[35] = this.transparent ? this.opacity : 1;
    v[36] = this.thickness;
    v[37] = +this.screenspace;
    v[38] = size[0];
    v[39] = size[1];
    const copy = writeUniform(device, this.uniform, v as Float32Array<ArrayBuffer>, c.view ?? c),
      uniform = this.uniform;
    let groups = this.groups.get(pipeline);
    if (!groups) {
      const layout = pipeline.getBindGroupLayout(0);
      groups = uniformGroups(uniform, (binding) =>
        device.createBindGroup({ layout, entries: [{ binding: 0, resource: binding }] }),
      );
      this.groups.set(pipeline, groups);
    }
    const pass = beginScenePass(c, this.colorAttachment, this.depthAttachment);
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, groups.get(copy));
    pass.setVertexBuffer(0, hull.vertex);
    pass.setIndexBuffer(hull.index, 'uint32');
    pass.drawIndexed(hull.count);
    pass.end();
  }

  private release(): void {
    const device = this.engine?.gpu;
    if (device) {
      retire(device, this.uniform);
      retire(device, this.hull?.vertex);
      retire(device, this.hull?.index);
    }
    this.uniform = this.hull = undefined;
    this.groups.clear();
    this.pipelines.clear();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Removes the plugin and releases its buffers; repeat calls are safe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
