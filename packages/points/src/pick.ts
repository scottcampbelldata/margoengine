/// <reference lib="esnext.disposable" preserve="true" />
// GPU picking of points, as an overlay of `@margoengine/selection`'s Picking: the points drawn in the picked view draw
// again into its 3 x 3 pick tile, after the meshes and over their depth, so one pick answers the nearest of both, and
// clipping planes, shapes, maps and alpha tests cut a pick exactly as they cut the picture. Nothing here imports selection.
import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { PointCloud } from './cloud.js';
import { fillFrame } from './frame.js';
import type { PointsPlugin } from './plugin.js';
import { FRAME_BYTES, pointShader } from './shaders.js';
import { beginPickPass, ensurePickBase } from '../../shared/pick-base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** What `Picking` hands an overlay for one pick. */
export interface PointPickContext {
  encoder: GPUCommandEncoder;
  /** The r32uint pick tile, 3 x 3 pixels around the picked pixel. */
  color: GPUTextureView;
  /** Its depth32float depth, holding the meshes already drawn. */
  depth: GPUTextureView;
  /** The camera's view-projection matrix, cropped to the tile. */
  matrix: Float32Array;
  camera: Camera;
  /** The picked view's rectangle in drawing-buffer pixels. */
  rect: readonly number[];
  /** The ID of this overlay's item 0. */
  firstId: number;
}

/** A point hit: `hit.mesh` is the mesh the cloud follows, or an empty stand-in mesh (see `cloudOf`). */
export interface PointPickHit {
  mesh: Mesh;
  /** The cloud the point belongs to. */
  cloud: PointCloud;
  /** Index of the point in the cloud's arrays. */
  point: number;
  /** World position of the point. */
  position: readonly [number, number, number];
}

/** What `PointPicking.attach` needs of `@margoengine/selection`'s Picking. */
export interface PointPickHost {
  addOverlay(overlay: {
    drawPick(context: PointPickContext): void;
    pickHit(index: number): PointPickHit | null;
  }): () => void;
}

/** One cloud's part of the IDs of the last pick. */
interface Entry {
  cloud: PointCloud;
  first: number;
  model: Float32Array;
}
interface Gpu {
  /** The plugin's GPU state these were made for; a restored device replaces it. */
  host: NonNullable<PointsPlugin['gpu']>;
  frame: GPUBuffer;
  frameGroup: GPUBindGroup;
  baseLayout: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
  module: GPUShaderModule;
  base?: GPUBuffer;
  baseGroup?: GPUBindGroup;
  pipelines: Map<string, GPURenderPipeline>;
}

/** Bytes between two clouds' ID bases: WebGPU's dynamic offset alignment. */
const BASE_STRIDE = 256;
/** IDs an overlay owns in Picking. A pick past this many points in all stops at the cloud that reaches it. */
const MAX_IDS = 2 ** 28;

const pickFragments = /* wgsl */ `
@group(2) @binding(0) var<uniform> pickBase:vec4u;
struct SpherePick{@location(0) id:u32,@builtin(frag_depth) depth:f32}
// A fragment hits where the point shows: fully transparent ones, such as a hidden class, do not.
@fragment fn pick(i:VOut)->@location(0) u32{
  let s=surface(i);
  if(s.color.a<=0.0){discard;}
  return pickBase.x+i.slot;
}
@fragment fn pickSphere(i:VOut)->SpherePick{
  let s=surface(i);
  if(s.color.a<=0.0){discard;}
  return SpherePick(pickBase.x+i.slot,sphereDepth(i,s.nz));
}`;

/** The point shader with each point's slot carried to the fragment, and fragments that write IDs. */
export function pointPickShader(): string {
  const field = '@location(3) @interpolate(flat) center:vec3f,',
    write = 'out.center=world.xyz;';
  if (!pointShader.includes(field) || !pointShader.includes(write))
    throw new MargoError('unsupported', 'Point picking needs the shader it was written for; update its edits with it');
  return (
    pointShader
      .replace(field, `${field}@location(5) @interpolate(flat) slot:u32,`)
      .replace(write, `${write}out.slot=slot;`) + pickFragments
  );
}

/**
 * Makes the points of a `PointsPlugin` pickable by `@margoengine/selection`'s `Picking`, and so by `engine.pick` once
 * Picking is attached. Points and meshes share one depth test, so a mesh in front blocks the pick; parts cut by clipping
 * planes do not hit. The picked points are those last drawn in that view, at their level of detail and transform.
 * `hit.cloud`, `hit.point` and `hit.position` name what was hit; `hit.mesh` is the mesh the cloud follows or else an
 * empty stand-in mesh, as `engine.pick` can only answer meshes (`cloudOf` maps it back).
 */
export class PointPicking {
  private gpu?: Gpu;
  private entries: Entry[] = [];
  private readonly standIns = new Map<PointCloud, Mesh>();
  private readonly owners = new Map<Mesh, PointCloud>();
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly view = new Float32Array(16);
  private remove?: () => void;

  /**
   * Registers `points` with `picking`; undo with `dispose`.
   * @throws MargoError `state` when `points` is not attached to an engine yet.
   */
  static attach(picking: PointPickHost, points: PointsPlugin): PointPicking {
    if (!points['engine']) throw new MargoError('state', 'Attach PointsPlugin to the engine before PointPicking.attach');
    const value = new PointPicking(points);
    value.remove = picking.addOverlay(value);
    points['watchers'].add(value);
    for (const cloud of points.pointClouds) value.added(cloud);
    return value;
  }
  private constructor(readonly points: PointsPlugin) {}

  /** The cloud `mesh` stands in for, from a `hit.mesh` or an `engine.pick` answer; null for any other mesh. */
  cloudOf(mesh: Mesh | null): PointCloud | null {
    return (mesh && this.owners.get(mesh)) ?? null;
  }

  private resources(device: GPUDevice, host: NonNullable<PointsPlugin['gpu']>): Gpu {
    if (this.gpu?.host === host) return this.gpu;
    this.gpu?.frame.destroy();
    this.gpu?.base?.destroy();
    const frame = device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      baseLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
          },
        ],
      });
    return (this.gpu = {
      host,
      frame,
      frameGroup: device.createBindGroup({
        layout: host.frameLayout,
        entries: [{ binding: 0, resource: { buffer: frame } }],
      }),
      baseLayout,
      layout: device.createPipelineLayout({ bindGroupLayouts: [host.frameLayout, host.cloudLayout, baseLayout] }),
      module: device.createShaderModule({ code: pointPickShader() }),
      pipelines: new Map(),
    });
  }

  private pipeline(device: GPUDevice, gpu: Gpu, sphere: boolean, depthTest: boolean): GPURenderPipeline {
    const key = `${sphere}|${depthTest}`;
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        layout: gpu.layout,
        vertex: { module: gpu.module, entryPoint: 'vertex' },
        fragment: { module: gpu.module, entryPoint: sphere ? 'pickSphere' : 'pick', targets: [{ format: 'r32uint' }] },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: depthTest ? 'greater-equal' : 'always',
        },
      });
      gpu.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** @internal A cloud joined: its stand-in is made now, because adding a mesh during a pick would void that pick's answer. */
  added(cloud: PointCloud): void {
    if (this.standIns.has(cloud)) return;
    const mesh = (this.points['engine'] as unknown as EngineKernel).createMesh();
    this.standIns.set(cloud, mesh);
    this.owners.set(mesh, cloud);
  }

  /** @internal A cloud left: its stand-in goes with it. */
  removed(cloud: PointCloud): void {
    const mesh = this.standIns.get(cloud);
    if (!mesh) return;
    this.standIns.delete(cloud);
    this.owners.delete(mesh);
    mesh.dispose();
  }

  /** @internal Picking's turn: draws the points last drawn in this view into the tile, with IDs from `firstId`. */
  drawPick(c: PointPickContext): void {
    const points = this.points,
      device = points['device'],
      host = points['gpu'];
    this.entries = [];
    if (!device || !host) return;
    let view: ReturnType<PointsPlugin['pickViews']['get']> | undefined;
    for (const candidate of points['pickViews'].drawn())
      if (candidate.rect.every((v, i) => v === c.rect[i])) view = candidate;
    if (!view) return;
    const drawn: { cloud: PointCloud; list: number[] }[] = [];
    for (const cloud of points.pointClouds) {
      const list = view.drawn.get(cloud);
      if (list?.length && points['cloudGpu'].get(cloud)?.group) drawn.push({ cloud, list });
    }
    if (!drawn.length) return;
    const gpu = this.resources(device, host),
      bases = new Uint32Array((drawn.length * BASE_STRIDE) / 4);
    ensurePickBase(device, gpu, bases.byteLength);
    // A 3 x 3 target under the cropped matrix: pixel sizes stay pixels, and world sizes use the view's own scale.
    const f = this.frameData;
    fillFrame(f, this.view, c.camera, c.rect[2], c.rect[3], 'rgba8unorm-srgb');
    f.set(c.matrix, 0);
    f[16] = f[17] = 3;
    device.queue.writeBuffer(gpu.frame, 0, f as Float32Array<ArrayBuffer>);
    const pass = beginPickPass(c, gpu.frameGroup);
    let next = 0,
      slot = 0;
    for (const { cloud, list } of drawn) {
      if (next + cloud.count > MAX_IDS) break;
      const r = points['cloudGpu'].get(cloud)!,
        m = cloud.material;
      pass.setPipeline(this.pipeline(device, gpu, m.shading === 'sphere', m.depthTest));
      bases[(slot * BASE_STRIDE) / 4] = c.firstId + next;
      this.entries.push({ cloud, first: next, model: r.model });
      pass.setBindGroup(1, r.group!);
      pass.setBindGroup(2, gpu.baseGroup!, [slot * BASE_STRIDE]);
      for (let i = 0; i < list.length; i += 2) pass.draw(4, list[i + 1], 0, cloud.blocks.starts[list[i]]);
      next += cloud.count;
      slot++;
    }
    device.queue.writeBuffer(gpu.base!, 0, bases);
    pass.end();
  }

  /** @internal The hit of ID `index` of the last `drawPick`. */
  pickHit(index: number): PointPickHit | null {
    const entries = this.entries;
    let low = 0,
      high = entries.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (entries[middle].first <= index) low = middle;
      else high = middle - 1;
    }
    const entry = entries[low];
    if (!entry) return null;
    const { cloud, model: m } = entry,
      slot = index - entry.first,
      point = cloud.direct ? slot : cloud.blocks.order[slot],
      mesh = cloud.attachedMesh ?? this.standIns.get(cloud);
    if (!mesh) return null;
    const x = cloud.positions[point * 3],
      y = cloud.positions[point * 3 + 1],
      z = cloud.positions[point * 3 + 2];
    return {
      mesh,
      cloud,
      point,
      position: [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ],
    };
  }

  /** Leaves Picking and frees the stand-in meshes and GPU buffers. */
  dispose(): void {
    this.remove?.();
    this.remove = undefined;
    this.points['watchers'].delete(this);
    for (const mesh of this.standIns.values()) mesh.dispose();
    this.standIns.clear();
    this.owners.clear();
    this.entries = [];
    this.gpu?.frame.destroy();
    this.gpu?.base?.destroy();
    this.gpu = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
